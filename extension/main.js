'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createBridge } = require('./bridge/server');
const { createHandlers } = require('./bridge/handlers');
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

function log(...args) {
    console.log(`[${PKG_NAME}]`, ...args);
}

/** 项目目录名 → 安全的短名（用于多开时的工具名前缀）。 */
function deriveShortName(projectPath) {
    const base = path.basename(projectPath || 'cocos').replace(/[^A-Za-z0-9_-]/g, '_');
    return base || 'cocos';
}

function ensureRegistryDir() {
    try {
        fs.mkdirSync(REGISTRY_DIR, { recursive: true, mode: 0o700 });
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

function buildClientConfig() {
    const cmd = process.execPath;
    const args = [path.join(__dirname, '..', 'hub', 'bin.js')];
    return {
        mcpServers: {
            'cocos-mcp': {
                command: cmd,
                args,
                env: {
                    COCOS_MCP_EDITOR_FILTER: shortName || '',
                },
            },
        },
    };
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
    let timer = null;

    const check = () => {
        timer = null;
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
                        Editor.Package.disable(path.join(Editor.Project.path, 'extensions', PKG_NAME));
                        setTimeout(() => {
                            Editor.Package.enable(path.join(Editor.Project.path, 'extensions', PKG_NAME));
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
                if (!timer) timer = setTimeout(check, 80);
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
        return { ok: true, url: bridge ? bridge.url : null };
    },
};
