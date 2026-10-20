'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * 编辑器实例注册表
 * ---------------------------------------------------------------------------
 * 每个打开的 Cocos Creator 扩展都会往 ~/.cocos-mcp/editors/<pid>.json 写一条心跳记录：
 *   { pid, url, token, shortName, projectPath, editorVersion, ts }
 *
 * hub 定期扫描这个目录来发现/剔除编辑器实例。
 *
 * 三条必要的设计（都来自实测踩坑）：
 *   1. **心跳超时判死**：ts 超过 STALE_MS 没更新就当进程死了。
 *      前人实现曾因死实例文件堆积到 1100+ 个。
 *   2. **pid 存活校验**：`process.kill(pid, 0)`。心跳文件可能是编辑器崩溃前的最后一笔，
 *      文件还新鲜但进程已经没了。
 *   3. **短名去重两级**：同项目双开 / 不同项目同名，都要有唯一前缀，
 *      否则工具名会撞车，agent 调错实例。
 */

const REGISTRY_DIR = path.join(os.homedir(), '.cocos-mcp', 'editors');
const STALE_MS = 120000;
const SCAN_INTERVAL_MS = 15000;

function readAll() {
    let files = [];
    try {
        files = fs.readdirSync(REGISTRY_DIR).filter((f) => f.endsWith('.json'));
    } catch (_) {
        return [];
    }
    const out = [];
    for (const f of files) {
        const full = path.join(REGISTRY_DIR, f);
        try {
            const stat = fs.statSync(full);
            const data = JSON.parse(fs.readFileSync(full, 'utf8'));
            out.push({ ...data, _file: full, _mtime: stat.mtimeMs });
        } catch (_) {
            // 半截文件 / 解析失败 → 忽略（下一轮扫描会自然淘汰）
        }
    }
    return out;
}

function isPidAlive(pid) {
    if (!pid || typeof pid !== 'number') return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === 'EPERM';
    }
}

function isLoopbackUrl(url) {
    try {
        const u = new URL(url);
        return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1';
    } catch (_) {
        return false;
    }
}

/**
 * 校验一条注册记录。任何一项不通过就整条丢弃（而不是保留一个坏实例）。
 */
function validate(entry, now = Date.now()) {
    const reasons = [];
    if (!entry || typeof entry !== 'object') reasons.push('记录不是对象');
    else {
        if (!entry.url) reasons.push('缺少 url');
        else if (!isLoopbackUrl(entry.url)) reasons.push('url 不是 loopback');
        if (!entry.token || typeof entry.token !== 'string' || entry.token.length < 16) reasons.push('token 缺失或过短');
        if (!isPidAlive(entry.pid)) reasons.push('进程已退出');
        const ts = Number(entry.ts) || 0;
        if (!ts) reasons.push('缺少心跳时间戳');
        else if (now - ts > STALE_MS) reasons.push(`心跳超时（${Math.round((now - ts) / 1000)}s）`);
    }
    return { ok: reasons.length === 0, reasons };
}

/**
 * 两级短名去重：
 *   1. 同一个 projectPath 出现多份 → 保留 startedAt/心跳最新的那个当代表，
 *      其余改名 `<base>-dup<pid>`（spawn 竞态双开是真实事故）。
 *   2. 不同项目 shortName 相同 → 改成 `<base>-<项目目录名>`，仍撞则加序号。
 */
function dedupeShortNames(entries) {
    const byProject = new Map();
    for (const e of entries) {
        const key = e.projectPath || e.url;
        const list = byProject.get(key) || [];
        list.push(e);
        byProject.set(key, list);
    }

    const result = [];
    const used = new Set();

    for (const [, list] of byProject) {
        list.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
        const [representative, ...extras] = list;
        result.push({ ...representative, shortName: representative.shortName || 'cocos' });
        for (const extra of extras) {
            result.push({ ...extra, shortName: `${representative.shortName || 'cocos'}-dup${extra.pid}` });
        }
    }

    // 第二级：跨项目同名
    const counts = new Map();
    for (const e of result) counts.set(e.shortName, (counts.get(e.shortName) || 0) + 1);
    for (const e of result) {
        if (counts.get(e.shortName) > 1) {
            const dirName = path.basename(e.projectPath || '').replace(/[^A-Za-z0-9_-]/g, '_');
            let candidate = `${e.shortName}-${dirName || e.pid}`;
            let i = 2;
            while (used.has(candidate) || result.some((x) => x !== e && x.shortName === candidate)) {
                candidate = `${e.shortName}-${dirName || e.pid}-${i++}`;
            }
            e.shortName = candidate;
        }
        used.add(e.shortName);
    }

    return result;
}

class EditorRegistry {
    constructor(opts = {}) {
        this.dir = opts.dir || REGISTRY_DIR;
        this.staleMs = opts.staleMs || STALE_MS;
        this._cache = [];
        this._listeners = [];
        this._timer = null;
        this._log = opts.log || ((m) => process.stderr.write(`[cocos-mcp] ${m}\n`));
    }

    onChange(fn) {
        this._listeners.push(fn);
    }

    _emit() {
        for (const fn of this._listeners) {
            try {
                fn(this._cache);
            } catch (_) {
                /* ignore */
            }
        }
    }

    /**
     * 扫描 + 校验 + 去重，返回可用实例列表。
     * 顺带清理「进程已死」的僵尸注册文件 —— 编辑器被强杀（SIGKILL / 崩溃）时
     * 扩展来不及删自己那条记录，文件会一直堆着（某开源实现历史上攒到 1100+ 个）。
     * 只在 pid 确认死亡时删除；pid 还活着但心跳超时的只忽略不删（可能只是编辑器忙）。
     */
    scan() {
        const now = Date.now();
        const raw = readAll();
        const valid = [];
        let reaped = 0;
        for (const e of raw) {
            const v = validate(e, now);
            if (v.ok) {
                valid.push(e);
                continue;
            }
            const dead = !e || typeof e.pid !== 'number' || !isPidAlive(e.pid);
            if (dead && e && e._file) {
                try {
                    fs.unlinkSync(e._file);
                    reaped++;
                } catch (_) {
                    /* ignore */
                }
            }
        }
        if (reaped) this._log(`已清理 ${reaped} 个僵尸注册文件`);
        this._cache = dedupeShortNames(valid);
        this._emit();
        return this._cache;
    }

    /** 启动周期扫描。 */
    start(intervalMs = SCAN_INTERVAL_MS) {
        this.scan();
        this._timer = setInterval(() => this.scan(), intervalMs);
        if (this._timer.unref) this._timer.unref();
        return this;
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    list() {
        if (!this._cache.length) this.scan();
        return this._cache;
    }

    /**
     * 解析工具名前缀 → 具体实例。
     * 无前缀（单实例）或前缀不匹配时按「唯一实例」处理。
     */
    resolve(prefix) {
        const editors = this.list();
        if (!editors.length) return { error: '没有检测到正在运行的 Cocos Creator 实例。请先打开项目并启用 cocos-mcp 扩展。' };
        if (!prefix) {
            if (editors.length === 1) return { editor: editors[0] };
            return {
                error:
                    `检测到 ${editors.length} 个 Cocos Creator 实例：${editors.map((e) => `${e.shortName}(${path.basename(e.projectPath || '')})`).join('、')}。` +
                    '请在工具名后加前缀，例如 `forest__scene.tree`。',
                editors: editors.map((e) => e.shortName),
            };
        }
        const hit = editors.find((e) => e.shortName === prefix);
        if (!hit) {
            return { error: `没有名为 "${prefix}" 的编辑器实例。当前可用：${editors.map((e) => e.shortName).join('、') || '(无)'}` };
        }
        return { editor: hit };
    }
}

module.exports = { EditorRegistry, validate, dedupeShortNames, isPidAlive, isLoopbackUrl, REGISTRY_DIR, STALE_MS };
