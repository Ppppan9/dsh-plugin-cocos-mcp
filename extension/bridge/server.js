'use strict';

const http = require('http');
const crypto = require('crypto');

/**
 * 编辑器侧 Bridge —— 私有 JSON-RPC over HTTP
 * ---------------------------------------------------------------------------
 * 刻意**不**把 Bridge 做成 MCP endpoint：
 *   - MCP 协议只在 hub（stdio 入口）实现一次，多编辑器聚合、工具面、安全策略都在那边；
 *   - Bridge 只是本机进程间的一条窄通道，用独立方法名 + Bearer token，
 *     避免任何第三方把它误当成 MCP 服务注册。
 *
 * 安全护栏（全部来自实测其它实现的漏洞）：
 *   - 只绑 127.0.0.1
 *   - Host 头必须是 loopback（挡 DNS rebinding）
 *   - 拒绝带 Origin 的浏览器请求（挡任意网页驱动编辑器）
 *   - Bearer token 用 timingSafeEqual 比较
 *   - 请求体上限 4 MiB
 */

const MAX_BODY = 4 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function timingSafeEqualStr(a, b) {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

function isLoopbackHost(hostHeader) {
    if (!hostHeader) return false;
    const raw = String(hostHeader).trim();
    // IPv6 字面量：[::1]:7523 → ::1
    if (raw.startsWith('[')) {
        const end = raw.indexOf(']');
        if (end < 0) return false;
        return LOOPBACK_HOSTS.has(raw.slice(1, end));
    }
    // 裸 IPv6（无端口）：::1 —— 不能直接 replace(/:\d+$/)，
    // 那会把 "::1" 剥成 ":"，导致 IPv6 loopback 被误拒。
    if ((raw.match(/:/g) || []).length > 1) {
        return LOOPBACK_HOSTS.has(raw);
    }
    // host:port
    const h = raw.replace(/:\d+$/, '');
    return LOOPBACK_HOSTS.has(h);
}

function findFreePort(startPort, host = '127.0.0.1', maxTries = 200) {
    return new Promise((resolve, reject) => {
        let port = startPort;
        let tries = 0;
        const attempt = () => {
            const srv = http.createServer();
            srv.once('error', (err) => {
                srv.close(() => {});
                if (err.code === 'EADDRINUSE' && tries < maxTries) {
                    port += 1;
                    tries += 1;
                    attempt();
                } else {
                    reject(err);
                }
            });
            srv.once('listening', () => {
                const p = srv.address().port;
                srv.close(() => resolve(p));
            });
            srv.listen(port, host);
        };
        attempt();
    });
}

/**
 * @param {object} opts
 * @param {(channel:string, message:string, args:any[])=>Promise<any>} opts.msg
 * @param {object} opts.handlers  op 名 → 处理函数
 * @param {string} opts.token
 * @param {number} opts.basePort
 * @param {(msg:string)=>void} [opts.log]
 */
async function createBridge(opts) {
    const { msg, handlers, token, basePort = 7523, log = () => {} } = opts;

    const server = http.createServer((req, res) => {
        handle(req, res).catch((err) => {
            log(`[bridge] 未捕获异常: ${err && err.stack ? err.stack : err}`);
            try {
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: String(err && err.message ? err.message : err) } }));
                }
            } catch (_) {
                /* ignore */
            }
        });
    });

    async function handle(req, res) {
        // 1) Host 校验（挡 DNS rebinding）
        if (!isLoopbackHost(req.headers.host)) {
            return json(res, 403, { jsonrpc: '2.0', error: { code: -32000, message: 'Host 头不是 loopback，拒绝请求。' } });
        }
        // 2) Origin 校验：浏览器发起的请求一律拒绝
        const origin = req.headers.origin;
        if (origin) {
            return json(res, 403, {
                jsonrpc: '2.0',
                error: { code: -32000, message: '拒绝带 Origin 的跨源请求（防网页驱动编辑器）。' },
            });
        }
        // 3) 鉴权
        const auth = req.headers.authorization || '';
        const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : req.headers['x-cocos-bridge-token'];
        if (!bearer || !timingSafeEqualStr(bearer, token)) {
            return json(res, 401, { jsonrpc: '2.0', error: { code: -32001, message: 'Bridge 鉴权失败。' } });
        }
        // 4) 路由
        if (req.method !== 'POST') {
            return json(res, 405, { jsonrpc: '2.0', error: { code: -32600, message: '仅支持 POST。' } });
        }
        const url = (req.url || '/').split('?')[0];
        if (url !== '/bridge') {
            return json(res, 404, { jsonrpc: '2.0', error: { code: -32601, message: `未知端点 ${url}` } });
        }

        let body;
        try {
            body = await readBody(req);
        } catch (err) {
            // ⚠️ 超限时 readBody 已经 destroy 了连接 —— 这时再写 413 客户端也收不到
            //    （实测拿到的是 EPIPE）。所以先把 413 响应写出去，再让它断开。
            if (err.code === 'BODY_TOO_LARGE') {
                try {
                    res.writeHead(413, { 'Content-Type': 'application/json' });
                    res.end(
                        JSON.stringify({
                            jsonrpc: '2.0',
                            error: { code: -32700, message: err.message },
                        })
                    );
                } catch (_) {
                    /* ignore */
                }
                return;
            }
            return json(res, 400, {
                jsonrpc: '2.0',
                error: { code: -32700, message: err.message },
            });
        }

        const { id = null, method, params } = body || {};
        try {
            const result = await dispatch(method, params || {});
            return json(res, 200, { jsonrpc: '2.0', id, result });
        } catch (err) {
            return json(res, 200, {
                jsonrpc: '2.0',
                id,
                error: {
                    code: err.code === 'MESSAGE_NOT_AVAILABLE' ? -32010 : -32000,
                    message: err && err.message ? err.message : String(err),
                },
            });
        }
    }

    async function dispatch(method, params) {
        switch (method) {
            case 'bridge/ping':
                return { pong: true, ts: Date.now() };
            case 'bridge/describe':
                return { ops: Object.keys(handlers).sort() };
            case 'bridge/invoke': {
                const op = params.op;
                const fn = handlers[op];
                if (!fn) {
                    throw new Error(`未知操作 "${op}"。可用操作：${Object.keys(handlers).sort().join('、')}`);
                }
                const data = await fn(params.args || {});
                return { ok: true, data: data === undefined ? null : data };
            }
            case 'bridge/message': {
                // 受控透传：handlers 内部已做白名单校验
                const { op, args } = params;
                const fn = handlers[op];
                if (!fn) throw new Error(`未知操作 "${op}"`);
                return { ok: true, data: (await fn(args || {})) ?? null };
            }
            default:
                throw new Error(`未知 Bridge 方法 "${method}"。支持：bridge/ping、bridge/describe、bridge/invoke。`);
        }
    }

    function readBody(req) {
        return new Promise((resolve, reject) => {
            let size = 0;
            const chunks = [];
            req.on('data', (c) => {
                size += c.length;
                if (size > MAX_BODY) {
                    const err = new Error(`请求体超过 ${MAX_BODY} 字节上限`);
                    err.code = 'BODY_TOO_LARGE';
                    req.destroy();
                    reject(err);
                    return;
                }
                chunks.push(c);
            });
            req.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                if (!raw) return resolve({});
                try {
                    resolve(JSON.parse(raw));
                } catch (e) {
                    reject(new Error('请求体不是合法 JSON'));
                }
            });
            req.on('error', reject);
        });
    }

    function json(res, status, payload) {
        const data = JSON.stringify(payload);
        res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(data),
            'Cache-Control': 'no-store',
        });
        res.end(data);
    }

    const port = await findFreePort(basePort);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
    });
    const actualPort = server.address().port;

    return {
        port: actualPort,
        url: `http://127.0.0.1:${actualPort}/bridge`,
        /**
         * 关闭服务。
         *
         * ⚠️ 必须加超时兜底：Node 的 server.close(cb) 会**等所有连接关闭**才回调。
         * 只要有一个 HTTP 请求还挂着（例如 builder:add-task 在等整个构建结束），
         * close() 永不返回 → exports.unload() 永不 resolve → Cocos 的「禁用扩展」卡死。
         */
        async close() {
            await new Promise((resolve) => {
                let done = false;
                const finish = () => {
                    if (done) return;
                    done = true;
                    resolve();
                };
                const timer = setTimeout(finish, 1500);
                if (timer.unref) timer.unref();
                server.close(() => {
                    clearTimeout(timer);
                    finish();
                });
                // Node ≥18.2：强制断开还在 keep-alive 的连接
                if (typeof server.closeAllConnections === 'function') {
                    try {
                        server.closeAllConnections();
                    } catch (_) {
                        /* ignore */
                    }
                }
            });
        },
    };
}

module.exports = { createBridge, findFreePort, timingSafeEqualStr, isLoopbackHost };
