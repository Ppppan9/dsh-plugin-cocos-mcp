'use strict';

/**
 * EditorClient 的**单元测试**（只连本机临时起的 HTTP 服务，不连真编辑器）
 * ---------------------------------------------------------------------------
 * 重点是「响应体超上限」这条路径：
 * 之前靠 `req.destroy(err)` 触发 `'error'` 事件来 reject，
 * 但**响应已经开始流式返回**时那个事件还派不派发并不确定 ——
 * 不确定就可能留下一个**悬挂的 promise**：调用方既等不到结果、
 * 也不会超时（外层超时只管 socket，不管 promise）。
 *
 * 这类「悬挂」是最难查的一类：没有报错、没有超时、就是永远不返回。
 *
 * 运行：node --test hub/test/editor-client.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { EditorClient, BridgeError } = require('../src/editor-client');

/** 起一个本机 HTTP 服务，返回 { url, close }。 */
function startServer(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                url: `http://127.0.0.1:${port}`,
                close: () => new Promise((r) => server.close(r)),
            });
        });
    });
}

function clientFor(url) {
    return new EditorClient({ url, token: 'x'.repeat(20), shortName: 't' });
}

test('★ 响应体超上限 → 必须 reject（不能留下悬挂的 promise）', async () => {
    const srv = await startServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // 分块慢慢吐，模拟「响应已经开始流式返回」的情形 ——
        // 这正是原先 destroy(err) 派发不确定的那种情况。
        let sent = 0;
        const tick = () => {
            if (sent >= 40) {
                res.end();
                return;
            }
            sent += 1;
            res.write('x'.repeat(1024));
            setTimeout(tick, 2);
        };
        tick();
    });
    try {
        const c = clientFor(srv.url);
        // ⚠️ 加超时保护：万一真的悬挂，测试不能永远挂着
        const p = c.invoke('bridge/invoke', {}, { maxResponseBytes: 4 * 1024, timeoutMs: 5000 });
        const outcome = await Promise.race([
            p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })),
            new Promise((r) => setTimeout(() => r({ ok: false, e: new Error('★ 悬挂了：5 秒既没 resolve 也没 reject') }), 6000)),
        ]);
        assert.ok(!outcome.ok, '★ 超上限必须 reject');
        assert.ok(outcome.e instanceof BridgeError, `应该是 BridgeError，实际 ${outcome.e && outcome.e.name}`);
        assert.strictEqual(outcome.e.code, 'RESPONSE_TOO_LARGE');
        assert.match(outcome.e.message, /超过/, '错误信息要说清是超上限');
    } finally {
        await srv.close();
    }
});

test('★ 正常响应照常返回', async () => {
    const srv = await startServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // Bridge 的响应形状：{jsonrpc, id, result:{ok:true, data:{...}}}
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true, data: { hello: '世界' } } }));
    });
    try {
        const c = clientFor(srv.url);
        const r = await c.invoke('bridge/invoke', { a: 1 });
        assert.deepStrictEqual(r, { hello: '世界' });
    } finally {
        await srv.close();
    }
});

test('★ 连接失败 / 超时要 reject（不能悬挂）', async () => {
    // 连一个没在监听的端口
    const c = clientFor('http://127.0.0.1:1');
    await assert.rejects(() => c.invoke('bridge/invoke', {}, { timeoutMs: 2000 }));

    // 服务端接了连接但不回话 → 必须靠 timeout 结束
    const srv = await startServer(() => {
        /* 故意什么都不回 */
    });
    try {
        const c2 = clientFor(srv.url);
        // ⚠️ **必须带兜底超时** ——
        //    这条测的正是「超时机制本身」：万一实现里的超时被去掉，
        //    没有兜底的 await 会**永远挂着** —— CI 不会立刻红，
        //    而是挂到作业超时才红（实测能挂 45 秒以上）。
        //    ⇒ 用 Promise.race 给一个上限，超了就明确报错。
        const outcome = await Promise.race([
            c2.invoke('bridge/invoke', {}, { timeoutMs: 800 }).then(
                (v) => ({ ok: true, v }),
                (e) => ({ ok: false, e })
            ),
            new Promise((r) => setTimeout(() => r({ ok: false, e: new Error('★ 悬挂了：超时机制没生效') }), 5000)),
        ]);
        assert.ok(!outcome.ok, '★ 不该成功返回');
        assert.ok(
            outcome.e instanceof BridgeError && outcome.e.code === 'TIMEOUT',
            `应该是 TIMEOUT 的 BridgeError，实际 ${outcome.e && outcome.e.message}`
        );
    } finally {
        await srv.close();
    }
});
