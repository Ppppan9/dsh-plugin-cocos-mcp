'use strict';

const http = require('http');

/**
 * Bridge HTTP 客户端
 * ---------------------------------------------------------------------------
 * 走原生 http 模块，不用 fetch —— Node 18+ 的 fetch 对 loopback + 短超时场景
 * 没有额外收益，而且原生 http 更容易精确控制超时与连接复用。
 */

const DEFAULT_TIMEOUT_MS = 60000;
// 长任务（构建等）用的超时
const LONG_OP_TIMEOUT_MS = 600000;
// 响应体上限：防止大场景/大资源库把内存吃光
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

class BridgeError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'BridgeError';
        this.code = code;
    }
}

class EditorClient {
    /**
     * @param {{url:string, token:string, shortName:string, projectPath?:string}} entry
     */
    constructor(entry) {
        this.entry = entry;
        this.url = entry.url;
        this.token = entry.token;
        this.shortName = entry.shortName;
        this.projectPath = entry.projectPath;
        this._seq = 0;
    }

    /** 同步最新注册信息（扩展重启 Bridge 会换 url/token，pid 不变）。 */
    sync(entry) {
        this.entry = entry;
        if (entry.url) this.url = entry.url;
        if (entry.token) this.token = entry.token;
        if (entry.shortName) this.shortName = entry.shortName;
        if (entry.projectPath) this.projectPath = entry.projectPath;
    }

    /**
     * 调用 Bridge 上的一个操作。
     * @param {string} op
     * @param {object} args
     * @param {{timeoutMs?:number}} [opts]
     */
    async invoke(op, args = {}, opts = {}) {
        const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
        const body = JSON.stringify({
            jsonrpc: '2.0',
            id: ++this._seq,
            method: 'bridge/invoke',
            params: { op, args },
        });

        let res;
        let raw;
        try {
            res = await this._request(body, timeoutMs, opts);
            raw = res.body;
        } catch (err) {
            if (err instanceof BridgeError) throw err;
            throw new BridgeError(
                `连接 Cocos 编辑器 "${this.shortName}" 失败：${err.message}。` +
                '（编辑器是否已关闭？扩展是否被禁用？）',
                'BRIDGE_UNREACHABLE'
            );
        }

        let payload;
        try {
            payload = JSON.parse(raw);
        } catch (_) {
            throw new BridgeError(`Bridge 返回了非 JSON 响应：${String(raw).slice(0, 200)}`, 'BAD_RESPONSE');
        }

        if (payload.error) {
            const msg = payload.error.message || '未知错误';
            const err = new BridgeError(msg, payload.error.code === -32010 ? 'MESSAGE_NOT_AVAILABLE' : 'BRIDGE_ERROR');
            throw err;
        }
        const result = payload.result || {};
        if (result.ok === false) {
            throw new BridgeError(result.error || '操作失败', 'BRIDGE_ERROR');
        }
        return result.data;
    }

    async ping(timeoutMs = 3000) {
        const body = JSON.stringify({ jsonrpc: '2.0', id: ++this._seq, method: 'bridge/ping', params: {} });
        const res = await this._request(body, timeoutMs);
        return JSON.parse(res.body).result;
    }

    async describe(timeoutMs = 5000) {
        const body = JSON.stringify({ jsonrpc: '2.0', id: ++this._seq, method: 'bridge/describe', params: {} });
        const res = await this._request(body, timeoutMs);
        return JSON.parse(res.body).result;
    }

    _request(body, timeoutMs, opts = {}) {
        return new Promise((resolve, reject) => {
            const u = new URL(this.url);
            // ⚠️ 可配置（测试与特殊场景用）—— 默认仍是 64MB 上限。
            const limit = opts.maxResponseBytes || MAX_RESPONSE_BYTES;
            const req = http.request(
                {
                    hostname: u.hostname,
                    port: u.port,
                    path: u.pathname,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(body),
                        Authorization: `Bearer ${this.token}`,
                        'X-Cocos-Bridge-Version': '1',
                    },
                },
                (res) => {
                    const chunks = [];
                    let size = 0;
                    res.on('data', (c) => {
                        size += c.length;
                        // 响应体无上限地全量拼进内存 → 大场景的 scene.tree / 大库的 asset.query
                        // 能把 hub 的内存吃光。超限就断开并报错。
                        if (size > limit) {
                            const err = new BridgeError(
                                `编辑器响应超过 ${Math.round(limit / 1048576)}MB 上限（已收 ${size} 字节），已中止。` +
                                '试试缩小查询范围（如给 scene.tree 加 maxDepth）。',
                                'RESPONSE_TOO_LARGE'
                            );
                            // ⚠️ **显式 reject**，不要只靠 req.destroy(err) 触发 'error' 事件 ——
                            //    响应**已经开始流式返回**时，那个事件还派不派发到 req 上并不确定；
                            //    不确定就可能留下一个**悬挂的 promise** ——
                            //    调用方既等不到结果、也不会超时（外层的超时只管 socket，不管 promise）。
                            reject(err);
                            res.destroy();
                            req.destroy();
                            return;
                        }
                        chunks.push(c);
                    });
                    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
                }
            );
            req.setTimeout(timeoutMs, () => {
                req.destroy(new BridgeError(`请求超时（${timeoutMs}ms）`, 'TIMEOUT'));
            });
            req.on('error', (err) => reject(err));
            req.write(body);
            req.end();
        });
    }
}

module.exports = { EditorClient, BridgeError, DEFAULT_TIMEOUT_MS, LONG_OP_TIMEOUT_MS, MAX_RESPONSE_BYTES };
