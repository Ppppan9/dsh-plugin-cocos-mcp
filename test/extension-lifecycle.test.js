'use strict';

/**
 * 扩展端 **Bridge 生命周期**的回归测试（`extension/main.js`）
 * ---------------------------------------------------------------------------
 * 第 11 轮独立复审 G-7 实测到的病：
 *   `load()` **不幂等** —— 第二次 load 会把第一个 watcher 的 interval
 *   覆盖成**孤儿**（模块级变量只记最后一个）。
 *   那个孤儿仍在跑、仍在读 `.dev/refresh`，
 *   于是 **unload 之后**它还能触发 `restart-package`
 *   → `Editor.Package.disable()` + `enable()`
 *   → **把已经禁用的扩展重新启用**。
 *
 *   实测：两次 load 后 unload，仍残留 2 个 interval，
 *   且卸载态真的调到了 Editor.Package.disable/enable。
 *
 * 这里用**假 Editor + 假 Bridge** 驱动**真实的 extension/main.js**，
 * 断言：
 *   ① 两次 load + 一次 unload 之后，**不再有存活的 interval**；
 *   ② unload 之后写 `.dev/refresh`，**不会**触发 disable/enable。
 *
 * ⚠️ 必须把 `os.homedir()` 指到临时目录 ——
 *    main.js 在**模块加载时**就把注册目录算成 `~/.cocos-mcp/editors`，
 *    不改就会往用户真实目录里写一个假注册项。
 *
 * 运行：node --test test/extension-lifecycle.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EXT = path.join(__dirname, '..', 'extension');

/**
 * 起一套「假 Editor + 假 Bridge」环境，驱动真实的 extension/main.js。
 *
 * @returns {Promise<{main: object, liveIntervals: Set, pkgCalls: Array, cleanup: Function}>}
 */
async function withFakeEditor(fn) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-mcp-lifecycle-'));
    const fakeProj = path.join(tmp, 'proj');
    fs.mkdirSync(fakeProj, { recursive: true });

    // ① registry 目录必须落在临时目录里（main.js 在模块加载时就算好了）
    const realHomedir = os.homedir;
    os.homedir = () => tmp;

    // ② 假 Bridge：不真的起 HTTP 服务
    const srvPath = require.resolve(path.join(EXT, 'bridge', 'server.js'));
    const realSrv = require.cache[srvPath];
    require.cache[srvPath] = {
        id: srvPath,
        filename: srvPath,
        loaded: true,
        exports: {
            createBridge: async () => ({
                url: 'http://127.0.0.1:19999',
                closed: false,
                async close() {
                    this.closed = true;
                },
            }),
        },
    };

    // ③ 假 Editor
    const pkgCalls = [];
    global.Editor = {
        Project: { path: fakeProj, uuid: 'u-1' },
        App: { version: '3.8.8', path: '/App' },
        Message: { request: async () => ({}), broadcast: () => {} },
        Logger: { query: () => [], clear: () => {} },
        Package: {
            getInfo: () => ({ path: path.join(fakeProj, 'extensions', 'cocos-mcp') }),
            disable: (p) => pkgCalls.push(['disable', p]),
            enable: (p) => pkgCalls.push(['enable', p]),
        },
        Panel: { open: () => {} },
        Clipboard: { write: () => {} },
    };

    // ④ 统计存活的 interval
    const realSetInterval = global.setInterval;
    const realClearInterval = global.clearInterval;
    const liveIntervals = new Set();
    global.setInterval = (f, ms) => {
        const h = realSetInterval(f, ms);
        liveIntervals.add(h);
        if (h.unref) h.unref();
        return h;
    };
    global.clearInterval = (h) => {
        liveIntervals.delete(h);
        realClearInterval(h);
    };

    // ⑤ 重新加载 main.js（让新的 homedir 生效）
    const mainPath = require.resolve(path.join(EXT, 'main.js'));
    delete require.cache[mainPath];
    const main = require(mainPath);

    const cleanup = () => {
        os.homedir = realHomedir;
        global.setInterval = realSetInterval;
        global.clearInterval = realClearInterval;
        delete global.Editor;
        if (realSrv) require.cache[srvPath] = realSrv;
        else delete require.cache[srvPath];
        delete require.cache[mainPath];
        try {
            fs.rmSync(tmp, { recursive: true, force: true });
        } catch (_) {
            /* ignore */
        }
    };

    try {
        await fn({ main, liveIntervals, pkgCalls, fakeProj, tmp });
    } finally {
        cleanup();
    }
}

test('★ 两次 load 之后 unload，不能留下存活的 interval（否则孤儿 watcher 会复活扩展）', async () => {
    await withFakeEditor(async ({ main, liveIntervals }) => {
        await main.load();
        await main.load(); // 第二次 load：最容易泄漏的场景
        assert.ok(liveIntervals.size > 0, '★ 加载后应当有存活的 interval（心跳 + watcher）');

        await main.unload();
        assert.strictEqual(
            liveIntervals.size,
            0,
            `★ unload 后仍残留 ${liveIntervals.size} 个 interval —— 它们会继续读 .dev/refresh，` +
            '卸载之后能把**已禁用的扩展重新启用**（第 11 轮复审 G-7）'
        );
    });
});

test('★ unload 之后写 .dev/refresh，不得触发 disable/enable（扩展不能自己把自己启用回来）', async () => {
    await withFakeEditor(async ({ main, pkgCalls, fakeProj }) => {
        await main.load();
        await main.load();
        await main.unload();

        // 卸载之后才写信号文件 —— 模拟「扩展已被禁用，但残留的 watcher 还在」
        fs.mkdirSync(path.join(fakeProj, '.dev'), { recursive: true });
        fs.writeFileSync(path.join(fakeProj, '.dev', 'refresh'), 'restart-package');

        await new Promise((r) => setTimeout(r, 1500));
        assert.strictEqual(
            pkgCalls.length,
            0,
            `★ 卸载后仍触发了 ${JSON.stringify(pkgCalls)} —— 泄漏的 watcher 把已禁用的扩展重新启用了`
        );
    });
});

test('★ 单次 load + unload 也必须干净（不能只看二次 load 的场景）', async () => {
    await withFakeEditor(async ({ main, liveIntervals }) => {
        await main.load();
        await main.unload();
        assert.strictEqual(liveIntervals.size, 0, '★ unload 后不该残留 interval');
    });
});
