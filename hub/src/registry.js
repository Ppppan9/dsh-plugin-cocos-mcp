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
/**
 * stale 实例的**宽限期**（毫秒）。
 *
 * ⚠️ 为什么要有上限：stale 记录会被**保留**（编辑器只是正忙），
 *    但如果那个 pid 其实已经被系统回收并分配给别的进程，
 *    这条记录就成了「幽灵实例」—— 永远不会被回收（pid 还活着），
 *    于是 hub 以为有 2 个编辑器，**逼着模型给工具名加前缀**，
 *    而真实情况只有一个编辑器。
 *
 *    真实的编辑器一旦不忙，心跳立刻恢复 → 记录变回 fresh。
 *    所以给一个**有界**的宽限期：宽限期内按「正忙」处理（快速失败 + 提示），
 *    超过宽限期仍然没有心跳 → 判定为幽灵，丢弃。
 */
const STALE_GRACE_MS = 180000;
const SCAN_INTERVAL_MS = 15000;

function readAll(dir = REGISTRY_DIR) {
    let files = [];
    try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch (_) {
        return [];
    }
    const out = [];
    for (const f of files) {
        const full = path.join(dir, f);
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
 * 校验一条注册记录。
 *
 * ⚠️ **心跳超时 ≠ 实例已死** ——
 *    心跳是扩展主进程写的定时器；编辑器正忙时（在做资产导入、构建、
 *    或者场景频道已经卡死），主进程被阻塞、心跳就停了。
 *    实测踩过：编辑器只是忙，实例就被整条丢弃，
 *    于是调用方收到「当前没有连接到任何 Cocos Creator 实例。
 *    请先打开项目并启用 cocos-mcp 扩展」—— **扩展明明在跑**，这句话完全误导。
 *
 *    所以分成两种：
 *      - **进程已退出**（pid 不在了）→ 真的没了，整条丢弃；
 *      - **进程还在、只是心跳超时** → 保留，但标记 `stale`，
 *        让上层报「编辑器无响应，可能正在忙」而不是「没装扩展」。
 */
function validate(entry, now = Date.now(), staleMs = STALE_MS, graceMs = STALE_GRACE_MS) {
    const reasons = [];
    let stale = false;
    if (!entry || typeof entry !== 'object') reasons.push('记录不是对象');
    else {
        if (!entry.url) reasons.push('缺少 url');
        else if (!isLoopbackUrl(entry.url)) reasons.push('url 不是 loopback');
        if (!entry.token || typeof entry.token !== 'string' || entry.token.length < 16) reasons.push('token 缺失或过短');
        const alive = isPidAlive(entry.pid);
        if (!alive) reasons.push('进程已退出');
        const ts = Number(entry.ts) || 0;
        if (!ts) reasons.push('缺少心跳时间戳');
        else if (now - ts > staleMs) {
            // 进程还在 → 只是没心跳（编辑器忙 / 场景频道卡死），不是「实例没了」
            if (alive && now - ts <= staleMs + graceMs) stale = true;
            else if (alive) {
                // 超过宽限期仍无心跳 → 大概率是「幽灵实例」（pid 被回收后复用）
                reasons.push(`心跳超时过久（${Math.round((now - ts) / 1000)}s）`);
            } else {
                reasons.push(`心跳超时（${Math.round((now - ts) / 1000)}s）`);
            }
        }
    }
    // ⚠️ **stale 只在「除心跳外没有其它问题」时才成立** ——
    //    否则一条「url 不是 loopback / token 太短」的坏记录，
    //    只要心跳旧就会被标成 stale 而**被保留**，
    //    于是 hub 会带着 Bearer token 把请求发到**非 loopback 地址**（SSRF + 凭据泄露）。
    //    这是本轮引入的真实安全回归，判据必须严格。
    if (stale && reasons.length) stale = false;
    return { ok: reasons.length === 0, reasons, stale };
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
        // 返回退订函数，避免长跑进程里监听器只增不减
        return () => {
            const i = this._listeners.indexOf(fn);
            if (i >= 0) this._listeners.splice(i, 1);
        };
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
        const raw = readAll(this.dir);
        const valid = [];
        let reaped = 0;
        for (const e of raw) {
            const v = validate(e, now, this.staleMs);
            if (v.ok || v.stale) {
                // stale = 进程还在、只是心跳停了（编辑器正忙）→ **保留**，
                // 标记出来让上层说人话（"无响应" 而不是 "没装扩展"）。
                valid.push(v.stale ? { ...e, stale: true } : e);
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

module.exports = {
    EditorRegistry,
    validate,
    dedupeShortNames,
    isPidAlive,
    isLoopbackUrl,
    REGISTRY_DIR,
    STALE_MS,
    STALE_GRACE_MS,
};
