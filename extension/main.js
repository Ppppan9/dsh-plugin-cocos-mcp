'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createBridge } = require('./bridge/server');
const { createHandlers, resetSceneHealth } = require('./bridge/handlers');
const { listChannels } = require('./bridge/messages');

/**
 * Cocos Creator 扩展主进程
 * ---------------------------------------------------------------------------
 * 职责：
 *   1. 起一个本机 Bridge（私有 JSON-RPC over HTTP，只绑 127.0.0.1）
 *   2. 把「我在哪、我是什么、我拿着什么 token」写进 ~/.cocos-mcp/editors/<pid>.json
 *   3. 心跳续约，进程死了 hub 自动剔除
 *
 * hub（Node 侧 stdio MCP Server）靠扫描这个目录发现所有打开的 Cocos 实例。
 */

const PKG_NAME = 'cocos-mcp';
const REGISTRY_DIR = path.join(os.homedir(), '.cocos-mcp', 'editors');
const HEARTBEAT_MS = 30000;

let bridge = null;
let token = null;
let shortName = null;
let registryFile = null;
let heartbeatTimer = null;
let refreshWatcher = null;
let refreshTimer = null;

function log(...args) {
    console.log(`[${PKG_NAME}]`, ...args);
}

/** 反查扩展包的真实安装路径（兼容扁平与嵌套两种布局）。 */
function resolvePackagePath() {
    try {
        const info = Editor.Package.getInfo && Editor.Package.getInfo(PKG_NAME);
        if (info && info.path) return info.path;
    } catch (_) {
        /* 拿不到就退回 __dirname */
    }
    return __dirname;
}

/** 项目目录名 → 安全的短名（用于多开时的工具名前缀）。 */
function deriveShortName(projectPath) {
    const base = path.basename(projectPath || 'cocos').replace(/[^A-Za-z0-9_-]/g, '_');
    return base || 'cocos';
}

function ensureRegistryDir() {
    try {
        fs.mkdirSync(REGISTRY_DIR, { recursive: true, mode: 0o700 });
        // ⚠️ Node 的 mkdirSync(recursive) **不会**对已存在目录套用 mode ——
        //    实测目录曾是 0755。意图（0700）没达成的话要显式 chmod。
        try {
            fs.chmodSync(REGISTRY_DIR, 0o700);
        } catch (_) {
            /* 权限不足就算了 */
        }
    } catch (e) {
        log('创建注册目录失败:', e.message);
    }
}

/** 原子写（tmp + rename），避免 hub 读到半截 JSON。 */
function writeRegistry(payload) {
    ensureRegistryDir();
    const file = path.join(REGISTRY_DIR, `${process.pid}.json`);
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return file;
}

function removeRegistry() {
    if (!registryFile) return;
    try {
        fs.unlinkSync(registryFile);
    } catch (_) {
        /* ignore */
    }
    registryFile = null;
}

/**
 * 找出 hub 的真实位置。
 *
 * ⚠️ 之前用的是 `path.join(__dirname, '..', 'hub', 'bin.js')` ——
 * 扩展装到 <项目>/extensions/cocos-mcp/ 后，那个路径是
 * <项目>/extensions/hub/bin.js，**并不存在**；
 * 而且 `process.execPath` 在编辑器里 = CocosCreator 可执行文件（不是 node），
 * 客户端照抄这份配置会去启动编辑器 GUI，MCP server 根本起不来。
 *
 * 现在优先用安装器写进来的 hub-path.txt，其次环境变量，最后才回退到相对路径。
 */
function resolveHubPath() {
    const fromFile = path.join(__dirname, 'hub-path.txt');
    try {
        const p = fs.readFileSync(fromFile, 'utf8').trim();
        if (p && fs.existsSync(p)) return p;
    } catch (_) {
        /* 没有这个文件 */
    }
    if (process.env.COCOS_MCP_HUB && fs.existsSync(process.env.COCOS_MCP_HUB)) {
        return process.env.COCOS_MCP_HUB;
    }
    // 兜底：扩展包内自带的 hub（如果发行版把 hub 一起打进扩展目录）
    const bundled = path.join(__dirname, 'hub', 'bin.js');
    return fs.existsSync(bundled) ? bundled : null;
}

function buildClientConfig() {
    const hub = resolveHubPath();
    const args = hub ? [hub] : [];
    const cfg = {
        mcpServers: {
            'cocos-mcp': {
                // 必须是 node —— process.execPath 在编辑器里是 CocosCreator 可执行文件
                command: 'node',
                args,
            },
        },
    };
    if (shortName) {
        // env 是**追加**不是整体替换（替换会丢掉 PATH / HOME）
        cfg.mcpServers['cocos-mcp'].env = { COCOS_MCP_EDITOR_FILTER: shortName };
    }
    if (!hub) {
        cfg.mcpServers['cocos-mcp']._note =
            '找不到 hub/bin.js —— 请重新运行 node scripts/install-extension.js <项目路径>，' +
            '或设置环境变量 COCOS_MCP_HUB 指向 hub/bin.js 的绝对路径。';
    }
    return cfg;
}

async function startBridge() {
    token = crypto.randomBytes(32).toString('hex');
    shortName = deriveShortName(Editor.Project.path);

    const ctx = {
        msg: (channel, message, ...args) => Editor.Message.request(channel, message, ...args),
        // 官方 Logger API：query() 同步返回 ILogInfo[]，clear() 清空控制台
        logger: () => {
            try {
                return Editor.Logger.query() || [];
            } catch (e) {
                return [];
            }
        },
        clearLogs: () => {
            try {
                Editor.Logger.clear();
            } catch (e) {
                /* ignore */
            }
        },
        editorVersion: Editor.App.version,
        projectPath: Editor.Project.path,
        projectUuid: Editor.Project.uuid,
        appPath: Editor.App.path,
        log,
    };
    const handlers = createHandlers(ctx);
    handlers['bridge.channels'] = async () => listChannels();

    bridge = await createBridge({ msg: ctx.msg, handlers, token, basePort: 7523, log });
    log(`Bridge 已启动：${bridge.url}`);

    registryFile = writeRegistry({
        pid: process.pid,
        url: bridge.url,
        token,
        shortName,
        projectPath: Editor.Project.path,
        projectUuid: Editor.Project.uuid,
        editorVersion: Editor.App.version,
        appPath: Editor.App.path,
        ts: Date.now(),
    });
    log(`已注册到 ${registryFile}（shortName=${shortName}）`);

    heartbeatTimer = setInterval(() => {
        try {
            writeRegistry({
                pid: process.pid,
                url: bridge.url,
                token,
                shortName,
                projectPath: Editor.Project.path,
                projectUuid: Editor.Project.uuid,
                editorVersion: Editor.App.version,
                appPath: Editor.App.path,
                ts: Date.now(),
            });
        } catch (e) {
            log('心跳写入失败:', e.message);
        }
    }, HEARTBEAT_MS);
    if (heartbeatTimer.unref) heartbeatTimer.unref();

    return bridge;
}

async function stopBridge() {
    if (refreshWatcher) {
        clearInterval(refreshWatcher);
        refreshWatcher = null;
    }
    if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
    }
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
    removeRegistry();
    if (bridge) {
        try {
            await bridge.close();
        } catch (_) {
            /* ignore */
        }
        bridge = null;
    }
    log('Bridge 已停止');
}

exports.load = async function load() {
    try {
        await startBridge();
        startRefreshWatcher();
    } catch (err) {
        log('Bridge 启动失败：', err && err.stack ? err.stack : err);
        Editor.Message.broadcast('cocos-mcp:error', { message: String(err && err.message ? err.message : err) });
    }
};

/**
 * `.dev/refresh` 文件信号协议
 * ---------------------------------------------------------------------------
 * 改了扩展的代码后，编辑器不会自动重新 require（Node 的 require 缓存 + 扩展沙箱）。
 * 往 <项目>/.dev/refresh 写一行命令即可：
 *
 *   echo "restart-package" > <项目>/.dev/refresh
 *
 * 扩展会禁用再启用自己，整个沙箱重建，所有 JS 重新加载。
 * 这是从 cc-3-8-x-mcp 学来的轻量跨进程触发通道 —— 不用重启整个编辑器。
 */
function startRefreshWatcher() {
    const devDir = path.join(Editor.Project.path, '.dev');
    const signalFile = path.join(devDir, 'refresh');
    // timer 提升为模块级 —— 否则 stopBridge 清不掉它，
    // 禁用扩展后这个 80ms 定时器仍可能触发 check() → 把已禁用的扩展重新启用。

    const check = () => {
        // ⚠️ 必须是 refreshTimer —— 之前误写成已删除的 timer，
        //    严格模式下这里会抛 ReferenceError，整个 .dev/refresh 通道失效。
        refreshTimer = null;
        let content = '';
        try {
            content = fs.readFileSync(signalFile, 'utf8').trim();
        } catch (_) {
            return;
        }
        if (!content) return;
        // 读完清空，避免重复执行
        try {
            fs.writeFileSync(signalFile, '');
        } catch (_) {
            /* ignore */
        }
        for (const cmd of content.split('\n').map((s) => s.trim()).filter(Boolean)) {
            log(`收到刷新指令：${cmd}`);
            if (cmd === 'restart-package') {
                // 必须在 setImmediate 里调：当前上下文即将被卸载
                setImmediate(() => {
                    try {
                        // ⚠️ 包根不能写死 <项目>/extensions/cocos-mcp ——
                        //    安装器也支持嵌套布局（extensions/cocos-mcp/cocos-mcp/）。
                        //    用 Editor.Package 反查真实路径最稳。
                        const pkgPath = resolvePackagePath();
                        Editor.Package.disable(pkgPath);
                        setTimeout(() => {
                            Editor.Package.enable(pkgPath);
                        }, 300);
                    } catch (err) {
                        log('重启扩展失败：', err && err.message);
                    }
                });
            }
        }
    };

    try {
        fs.mkdirSync(devDir, { recursive: true });
    } catch (_) {
        /* ignore */
    }
    // 轮询：500ms 一次，只在文件 mtime 变化时才去读（避免无意义 IO）
    let lastMtime = 0;
    const timer2 = setInterval(() => {
        try {
            const st = fs.statSync(signalFile);
            if (st.mtimeMs && st.mtimeMs !== lastMtime) {
                lastMtime = st.mtimeMs;
                if (!refreshTimer) refreshTimer = setTimeout(check, 80);
            }
        } catch (_) {
            /* no signal file */
        }
    }, 500);
    if (timer2.unref) timer2.unref();
    refreshWatcher = timer2;
}

exports.unload = async function unload() {
    await stopBridge();
};

/** 供面板与其它扩展调用的方法。 */
exports.methods = {
    async openPanel() {
        Editor.Panel.open(PKG_NAME);
        return { ok: true };
    },
    async copyClientConfig() {
        const cfg = JSON.stringify(buildClientConfig(), null, 2);
        Editor.Clipboard.write('text', cfg);
        return { ok: true, config: cfg };
    },
    /** 面板要显示 hub 路径，用户才知道配置为什么连不上。 */
    async getHubInfo() {
        const hub = resolveHubPath();
        return { hub, found: !!hub, exists: hub ? fs.existsSync(hub) : false };
    },
    async getBridgeStatus() {
        return {
            ok: true,
            running: !!bridge,
            url: bridge ? bridge.url : null,
            shortName,
            projectPath: Editor.Project.path,
            editorVersion: Editor.App.version,
            token: token ? `${token.slice(0, 6)}…${token.slice(-4)}` : null,
        };
    },
    async restartBridge() {
        await stopBridge();
        await startBridge();
        // ⚠️ .dev/refresh 的热重载 watcher 之前只在 exports.load 里启动，
        //    stopBridge 会把它清掉 → 重启 Bridge 后热重载通道永久失效。
        startRefreshWatcher();
        // ⚠️ 必须清掉「场景频道已中毒」的闸门状态 ——
        //    它是 handlers.js 的**模块级**状态，而 restartBridge 只重启了
        //    HTTP 服务、**没有重新加载模块** → 不清的话点了「重启 Bridge」
        //    场景工具仍然全部报「场景频道不可用」，用户会以为这个按钮没用。
        resetSceneHealth();
        return { ok: true, url: bridge ? bridge.url : null };
    },
};
