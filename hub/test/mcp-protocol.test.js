'use strict';

/**
 * MCP 协议层的**单元测试**（进程内跑，不用真编辑器）
 * ---------------------------------------------------------------------------
 * 为什么要有这一层：协议层此前只被 `test/e2e.js` 端到端覆盖 ——
 * 而 e2e 要开着 Cocos Creator 才跑得了，于是「协议实现对不对」
 * 这件事在 CI 上根本没有回归保护。
 *
 * 这里用 PassThrough 当输入输出，把 McpServer 跑起来，逐条核对协议契约：
 *   · 版本协商（支持的回显、不支持的用服务器默认）
 *   · 错误码（未知工具 -32602 / 未知方法 -32601 / 非法 JSON -32700）
 *   · 「工具执行失败」要走 result + isError（**不是** JSON-RPC error）——
 *     这是 MCP 规范里最容易搞错的一处：协议级问题才用 error。
 *   · notification 不产生响应
 *   · 批量请求返回数组
 *
 * 运行：node --test hub/test/mcp-protocol.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('node:stream');

const { McpServer } = require('../src/mcp/server');

/**
 * 起一个进程内的 MCP server，返回 { ask, notifications, outputs }。
 * @param {object} [callTool] 假的 callTool 实现
 */
function makeServer(callTool, extraProviders) {
    const input = new PassThrough();
    const output = new PassThrough();
    let buf = '';
    const outputs = [];
    output.on('data', (c) => {
        buf += c.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (line) outputs.push(JSON.parse(line));
        }
    });
    const server = new McpServer({
        serverInfo: { name: 'test', version: '0.0.0' },
        providers: {
            tools: async () => [{ name: 'ok.tool', description: '成功', inputSchema: { type: 'object', properties: {} } }],
            callTool: callTool || (async () => ({ ok: true })),
            // ⚠️ 默认**给上** prompts / resources 的 provider ——
            //    没有的话，「实现被删掉」和「本来就没有」在断言里长得一样，
            //    变异就抓不到（第 10 轮复审的教训）。
            prompts: async () => [{ name: 'demo.prompt', description: '示例 prompt' }],
            getPrompt: async (name) => ({ description: '示例', messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }] }),
            resources: async () => [{ uri: 'demo://x', name: '示例资源' }],
            readResource: async (uri) => ({ contents: [{ uri, text: 'demo' }] }),
            ...(extraProviders || {}),
        },
        input,
        output,
    });
    server.start();
    const ask = (msg) => {
        input.write(JSON.stringify(msg) + '\n');
        return new Promise((r) => setTimeout(r, 30));
    };
    return { server, ask, outputs, input };
}

test('★ initialize：支持的协议版本原样回显', async () => {
    const { ask, outputs } = makeServer();
    await ask({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    assert.strictEqual(outputs.length, 1);
    assert.strictEqual(outputs[0].result.protocolVersion, '2024-11-05');
});

test('★ initialize：不支持的协议版本 → 用服务器默认（而不是原样回显）', async () => {
    const { ask, outputs } = makeServer();
    await ask({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    assert.strictEqual(outputs.length, 1);
    assert.strictEqual(outputs[0].result.protocolVersion, '2025-06-18', '不支持的版本应回落到服务器默认');
});

test('★ provider 抛「协议级」错误 → server 转成 JSON-RPC error（不是 isError）', async () => {
    // ⚠️ 「未知工具」/「参数非法」这类**调用本身**有问题的情况，
    //    由 registry 抛带 protocolCode 的错误，server 据此转成 JSON-RPC error。
    //    （未知工具的判定在 registry 层，不在 server 层 —— 这里测的是 server 的**映射**。）
    const { ask, outputs } = makeServer(async () => {
        const e = new Error('未知工具 "no.such.tool"');
        e.protocolCode = -32602;
        throw e;
    });
    await ask({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'no.such.tool', arguments: {} } });
    assert.strictEqual(outputs.length, 1);
    assert.ok(outputs[0].error, '★ 协议级错误必须是 JSON-RPC error');
    assert.strictEqual(outputs[0].error.code, -32602);
    assert.match(outputs[0].error.message, /未知工具/);
});

test('★ 工具执行失败 → result + isError:true（**不是** JSON-RPC error）', async () => {
    // ⚠️ 这是 MCP 规范里最容易搞错的一处：
    //    「工具跑了但失败」必须是 result{isError:true}，
    //    只有「调用本身有问题」才走 JSON-RPC error。
    //    搞反了客户端就会把一次正常的失败当成协议错误去重试。
    const { ask, outputs } = makeServer(async () => {
        throw new Error('引擎炸了');
    });
    await ask({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ok.tool', arguments: {} } });
    assert.strictEqual(outputs.length, 1);
    assert.ok(!outputs[0].error, '★ 工具执行失败不该是 JSON-RPC error');
    assert.strictEqual(outputs[0].result.isError, true);
    assert.match(outputs[0].result.content[0].text, /引擎炸了/);
});

test('★ notification 不产生任何响应', async () => {
    const { ask, outputs } = makeServer();
    await ask({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await ask({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
    assert.strictEqual(outputs.length, 0, '★ notification 不该有响应');
});

test('★ 未知 method → -32601', async () => {
    const { ask, outputs } = makeServer();
    await ask({ jsonrpc: '2.0', id: 1, method: 'nonexistent/method', params: {} });
    assert.strictEqual(outputs[0].error.code, -32601);
});

test('★ 非法 JSON → -32700（且 id 为 null）', async () => {
    const { ask, outputs, input } = makeServer();
    input.write('{ 这不是 JSON\n');
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(outputs.length, 1);
    assert.strictEqual(outputs[0].error.code, -32700);
    assert.strictEqual(outputs[0].id, null);
});

test('★ 批量请求 → 返回数组，每个元素对应一个 id', async () => {
    const { ask, outputs, input } = makeServer();
    input.write(JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'ping' }]) + '\n');
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(outputs.length, 1, '批量应合并成一个数组响应');
    assert.ok(Array.isArray(outputs[0]), '★ 批量响应必须是数组');
    assert.deepStrictEqual(outputs[0].map((x) => x.id), [1, 2]);
});

test('★ registry 层：未知工具必须抛协议级错误（-32602），server 才能映射成 JSON-RPC error', async () => {
    // ⚠️ 「未知工具」的判定在 **registry**（hub/src/tools/index.js），不在 server。
    //    server 只是把带 protocolCode 的错误转成 JSON-RPC error。
    //    这条守住 registry 那一侧 —— 两边都在，协议行为才完整。
    const { ToolRegistry } = require('../src/tools/index');
    const reg = new ToolRegistry({ getClient: () => null, listEditors: () => [] });
    let err = null;
    try {
        await reg.call('no.such.tool', {});
    } catch (e) {
        err = e;
    }
    assert.ok(err, '★ 未知工具必须抛错，不能静默当成成功');
    assert.strictEqual(err.protocolCode, -32602, '★ 必须是协议级错误（否则客户端会当成「工具跑了但失败」去重试）');
    assert.match(err.message, /未知工具/);
});

// ────────────────────────────── resources / prompts ──────────────────────────────
// ⚠️ 这两支此前**零覆盖**（第 10 轮复审实测：4 个变异 —— 形状写错 / 错误码写错 /
//    prompts/list 不实现 —— **全部变绿**）。
//    它们同样是 MCP 规范的一部分，不能没有回归保护。

test('★ resources/list 与 resources/read 的形状和错误码', async () => {
    const { ask, outputs } = makeServer();
    await ask({ jsonrpc: '2.0', id: 1, method: 'resources/list', params: {} });
    assert.strictEqual(outputs.length, 1);
    assert.ok(Array.isArray(outputs[0].result.resources), '★ resources/list 必须返回数组');
    // ★ 还要核对**内容**：只断言「是个数组」的话，
    //    「实现被删掉」和「本来就返回空数组」在断言里长得一样 → 变异抓不到。
    assert.strictEqual(outputs[0].result.resources.length, 1, '★ 资源清单不能是空的（实现被删了？）');
    assert.strictEqual(outputs[0].result.resources[0].uri, 'demo://x');

    // 真的没有 provider → 方法不存在
    const s2 = makeServer(undefined, { resources: undefined, readResource: undefined });
    await s2.ask({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'x://y' } });
    assert.strictEqual(s2.outputs[0].error.code, -32601, '★ 没有 provider 时应是 method not found');
});

test('★ resources/read 读失败要用「参数非法」而不是别的错误码', async () => {
    const { ask, outputs } = makeServer();
    // 造一个会抛错的 readResource
    const s = makeServer();
    s.server.providers.readResource = async () => {
        throw new Error('资源不存在');
    };
    await s.ask({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'x://y' } });
    assert.ok(s.outputs[0].error, '★ 失败必须是 JSON-RPC error');
    assert.strictEqual(s.outputs[0].error.code, -32602, '★ 资源读失败应是 invalid params');
    assert.match(s.outputs[0].error.message, /资源不存在/);
});

test('★ prompts/list 与 prompts/get 的形状和错误码', async () => {
    const { ask, outputs } = makeServer();
    await ask({ jsonrpc: '2.0', id: 1, method: 'prompts/list', params: {} });
    assert.ok(Array.isArray(outputs[0].result.prompts), '★ prompts/list 必须返回数组');
    // ★ 核对内容（否则「实现被删掉」抓不到）
    assert.strictEqual(outputs[0].result.prompts.length, 1, '★ prompt 清单不能是空的（实现被删了？）');
    assert.strictEqual(outputs[0].result.prompts[0].name, 'demo.prompt');

    // 没有 getPrompt provider → 方法不存在
    const s2 = makeServer(undefined, { getPrompt: undefined });
    await s2.ask({ jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'x' } });
    assert.strictEqual(s2.outputs[0].error.code, -32601);
});

test('★ prompts/get 成功时要把 provider 给的内容原样返回（形状不能被改）', async () => {
    const s = makeServer();
    await s.ask({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'demo.prompt' } });
    assert.ok(s.outputs[0].result, '★ 成功必须是 result');
    assert.ok(Array.isArray(s.outputs[0].result.messages), '★ messages 必须在');
    assert.strictEqual(s.outputs[0].result.messages[0].content.text, 'hi');
});

test('★ prompts/get 取不到时要用「参数非法」', async () => {
    const s = makeServer();
    s.server.providers.getPrompt = async () => {
        throw new Error('没有这个 prompt');
    };
    await s.ask({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'x' } });
    assert.ok(s.outputs[0].error);
    assert.strictEqual(s.outputs[0].error.code, -32602);
});
