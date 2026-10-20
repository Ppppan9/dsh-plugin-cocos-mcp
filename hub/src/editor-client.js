'use strict';

const http = require('http');

/**
 * Bridge HTTP 客户端
 * ---------------------------------------------------------------------------
 * 走原生 http 模块，不用 fetch —— Node 18+ 的 fetch 对 loopback + 短超时场景
 * 没有额外收益，而且原生 http 更容易精确控制超时与连接复用。
 */

const DEFAULT_TIMEOUT_MS = 45000;
const LONG_OP_TIMEOUT_MS = 120000;

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
            res = await this._request(body, timeoutMs);
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

    _request(body, timeoutMs) {
        return new Promise((resolve, reject) => {
            const u = new URL(this.url);
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
                    res.on('data', (c) => chunks.push(c));
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

module.exports = { EditorClient, BridgeError, DEFAULT_TIMEOUT_MS, LONG_OP_TIMEOUT_MS };
