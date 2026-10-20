'use strict';

/**
 * MCP（Model Context Protocol）stdio 服务器 —— 零依赖实现
 * ---------------------------------------------------------------------------
 * 为什么手写而不用 @modelcontextprotocol/sdk？
 *   - 现存三个家族里，listar 用官方 SDK 做得最规范，但带来 npm 依赖与安装摩擦；
 *   - harady 与 DaxianLee 都手写了 JSON-RPC，但都没实现完整协议
 *     （harady 缺 initialize 协商、tools/list_changed 通知；
 *      DaxianLee 只有 3 个 method，连 resources/prompts 都没有）。
 *   - 我们要的形态是「**零配置 stdio**」：用户只要把一条命令写进 MCP 客户端配置就能用，
 *     不需要 npm install、不需要起 HTTP 服务、不需要配 token。
 * 所以这里手写一个**完整且严格**的协议实现：协议版本协商、能力声明、
 * 工具/资源/提示词三件套、list_changed 通知、错误契约，全部按 MCP 规范来。
 *
 * 传输：stdio + 换行分隔的 JSON-RPC 2.0 消息（MCP stdio 传输的规范形态）。
 */

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;
const JSONRPC_INTERNAL_ERROR = -32603;

class McpServer {
    /**
     * @param {object} opts
     * @param {{name:string, version:string, instructions?:string}} opts.serverInfo
     * @param {{tools: Function, resources?: Function, prompts?: Function}} opts.providers
     * @param {NodeJS.ReadableStream} [opts.input]
     * @param {NodeJS.WritableStream} [opts.output]
     */
    constructor(opts) {
        this.serverInfo = opts.serverInfo;
        this.providers = opts.providers;
        this.input = opts.input || process.stdin;
        this.output = opts.output || process.stdout;
        this.initialized = false;
        this.clientInfo = null;
        this.buffer = '';
        this._handlers = new Map();
        this._toolListChanged = () => {};
        this._resourceListChanged = () => {};
    }

    onToolListChanged(fn) {
        this._toolListChanged = fn;
    }

    onResourceListChanged(fn) {
        this._resourceListChanged = fn;
    }

    start() {
        this.input.setEncoding('utf8');
        this.input.on('data', (chunk) => this._onData(chunk));
        this.input.on('end', () => process.exit(0));
        this.input.on('close', () => process.exit(0));
    }

    _onData(chunk) {
        this.buffer += chunk;
        let idx;
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, idx).trim();
            this.buffer = this.buffer.slice(idx + 1);
            if (!line) continue;
            this._handleLine(line);
        }
    }

    async _handleLine(line) {
        let msg;
        try {
            msg = JSON.parse(line);
        } catch (e) {
            this._send({ jsonrpc: '2.0', id: null, error: { code: JSONRPC_PARSE_ERROR, message: 'Parse error' } });
            return;
        }
        // 批量请求
        if (Array.isArray(msg)) {
            const out = [];
            for (const m of msg) {
                const r = await this._dispatch(m);
                if (r) out.push(r);
            }
            if (out.length) this._send(out);
            return;
        }
        const res = await this._dispatch(msg);
        if (res) this._send(res);
    }

    async _dispatch(msg) {
        if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
            return { jsonrpc: '2.0', id: msg && msg.id !== undefined ? msg.id : null, error: { code: JSONRPC_INVALID_REQUEST, message: 'Invalid Request' } };
        }
        const isNotification = msg.id === undefined || msg.id === null;

        try {
            switch (msg.method) {
                case 'initialize':
                    return await this._onInitialize(msg);
                case 'notifications/initialized':
                case 'initialized':
                    this.initialized = true;
                    return null;
                case 'notifications/cancelled':
                case 'notifications/progress':
                case 'notifications/roots/list_changed':
                    return null;
                case 'ping':
                    return isNotification ? null : { jsonrpc: '2.0', id: msg.id, result: {} };
                case 'tools/list':
                    return await this._onToolsList(msg);
                case 'tools/call':
                    return await this._onToolsCall(msg);
                case 'resources/list':
                    return await this._onResourcesList(msg);
                case 'resources/read':
                    return await this._onResourcesRead(msg);
                case 'resources/templates/list':
                    return { jsonrpc: '2.0', id: msg.id, result: { resourceTemplates: [] } };
                case 'prompts/list':
                    return await this._onPromptsList(msg);
                case 'prompts/get':
                    return await this._onPromptsGet(msg);
                case 'logging/setLevel':
                    return isNotification ? null : { jsonrpc: '2.0', id: msg.id, result: {} };
                case 'completion/complete':
                    return { jsonrpc: '2.0', id: msg.id, result: { completion: { values: [], total: 0, hasMore: false } } };
                default:
                    if (isNotification) return null;
                    return { jsonrpc: '2.0', id: msg.id, error: { code: JSONRPC_METHOD_NOT_FOUND, message: `Method not found: ${msg.method}` } };
            }
        } catch (err) {
            if (isNotification) return null;
            return {
                jsonrpc: '2.0',
                id: msg.id,
                error: { code: JSONRPC_INTERNAL_ERROR, message: err && err.message ? err.message : String(err), data: err && err.stack ? err.stack : undefined },
            };
        }
    }

    async _onInitialize(msg) {
        const params = msg.params || {};
        const requested = params.protocolVersion;
        this.clientInfo = params.clientInfo || null;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION;
        this.initialized = true;
        return {
            jsonrpc: '2.0',
            id: msg.id,
            result: {
                protocolVersion,
                capabilities: {
                    tools: { listChanged: true },
                    resources: { listChanged: true, subscribe: false },
                    prompts: { listChanged: false },
                    logging: {},
                },
                serverInfo: this.serverInfo,
                instructions: this.providers.instructions ? this.providers.instructions() : undefined,
            },
        };
    }

    async _onToolsList(msg) {
        const tools = await this.providers.tools();
        return { jsonrpc: '2.0', id: msg.id, result: { tools } };
    }

    async _onToolsCall(msg) {
        const params = msg.params || {};
        const name = params.name;
        const args = params.arguments || {};
        try {
            const result = await this.providers.callTool(name, args);
            return { jsonrpc: '2.0', id: msg.id, result };
        } catch (err) {
            // 工具执行错误按 MCP 约定走 isError 的 content，而不是 JSON-RPC error，
            // 这样客户端能把它当作模型可读的失败信息。
            const message = err && err.message ? err.message : String(err);
            return {
                jsonrpc: '2.0',
                id: msg.id,
                result: {
                    content: [{ type: 'text', text: `工具 "${name}" 执行失败：${message}` }],
                    isError: true,
                },
            };
        }
    }

    async _onResourcesList(msg) {
        const resources = this.providers.resources ? await this.providers.resources() : [];
        return { jsonrpc: '2.0', id: msg.id, result: { resources } };
    }

    async _onResourcesRead(msg) {
        const params = msg.params || {};
        const uri = params.uri;
        if (!this.providers.readResource) {
            return { jsonrpc: '2.0', id: msg.id, error: { code: JSONRPC_METHOD_NOT_FOUND, message: '本服务不提供 resources/read' } };
        }
        try {
            const contents = await this.providers.readResource(uri);
            return { jsonrpc: '2.0', id: msg.id, result: { contents } };
        } catch (err) {
            return {
                jsonrpc: '2.0',
                id: msg.id,
                error: { code: JSONRPC_INVALID_PARAMS, message: err && err.message ? err.message : String(err) },
            };
        }
    }

    async _onPromptsList(msg) {
        const prompts = this.providers.prompts ? await this.providers.prompts() : [];
        return { jsonrpc: '2.0', id: msg.id, result: { prompts } };
    }

    async _onPromptsGet(msg) {
        const params = msg.params || {};
        if (!this.providers.getPrompt) {
            return { jsonrpc: '2.0', id: msg.id, error: { code: JSONRPC_METHOD_NOT_FOUND, message: '本服务不提供 prompts/get' } };
        }
        try {
            const prompt = await this.providers.getPrompt(params.name, params.arguments || {});
            return { jsonrpc: '2.0', id: msg.id, result: prompt };
        } catch (err) {
            return {
                jsonrpc: '2.0',
                id: msg.id,
                error: { code: JSONRPC_INVALID_PARAMS, message: err && err.message ? err.message : String(err) },
            };
        }
    }

    _send(payload) {
        const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
        try {
            this.output.write(text + '\n');
        } catch (_) {
            /* ignore */
        }
    }

    notifyToolListChanged() {
        this._send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    }

    notifyResourceListChanged() {
        this._send({ jsonrpc: '2.0', method: 'notifications/resources/list_changed' });
    }
}

module.exports = { McpServer, PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS };
