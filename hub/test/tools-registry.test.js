'use strict';

/**
 * 工具注册表的**行为**测试
 * ---------------------------------------------------------------------------
 * 这一层测的是「注册表 → 工具路由」的联动，
 * 而不是单个函数。真实踩过的坑都属于这一类：
 *   - stale 标记**没进 _rebuild 签名** → 编辑器从健康变忙时，
 *     缓存的 entry 还是当初那个没有 stale 标记的对象 →
 *     「编辑器正忙就立刻失败」这道闸门**永远不触发**。
 *   - stale 判定**没排除其它问题** → 坏记录被保留 → hub 带着 token
 *     把请求发到非 loopback 地址。
 */

const test = require('node:test');
const assert = require('node:assert');

const { ToolRegistry } = require('../src/tools');

function makeRegistry(editors) {
    return new ToolRegistry({
        getClient: () => ({ invoke: async () => ({ ok: true }) }),
        listEditors: () => editors,
    });
}

test('编辑器从「健康」变成「正忙」时，stale 标记必须传到工具路由里', () => {
    // ⚠️ 这是本轮踩过的真 bug：_rebuild 的签名里没有 stale，
    //    所以编辑器变忙后 entry 仍然是旧对象（没有 stale 标记），
    //    闸门永远不触发 → 「秒回的错误答案」变成「干等 60 秒的错误答案」。
    const healthy = { shortName: 'p', pid: 1, url: 'http://127.0.0.1:7523/bridge', token: 't'.repeat(32) };
    const busy = { ...healthy, stale: true };

    const reg = makeRegistry([healthy]);
    reg._rebuild(true);
    const before = reg._byName.get('scene.tree');
    assert.ok(before, '拿不到 scene.tree 的 entry');
    assert.strictEqual(before.editor.stale, undefined, '健康时不该有 stale 标记');

    // 换成正忙的实例 → 必须触发重建
    const reg2 = makeRegistry([busy]);
    reg2._rebuild(true);
    const after = reg2._byName.get('scene.tree');
    assert.strictEqual(after.editor.stale, true, '编辑器变忙后 entry 里必须带 stale 标记');

    // ⚠️ 关键：**不强制重建**时也要能更新。
    //    真实流程是 registry 每隔几秒 scan 一次，listEditors() 返回的对象变了，
    //    _rebuild 靠**签名**判断要不要重建 —— 签名里必须带 stale。
    const shared = [];
    const reg3 = new ToolRegistry({
        getClient: () => ({ invoke: async () => ({ ok: true }) }),
        listEditors: () => shared,
    });
    shared.push({ ...healthy });
    reg3._rebuild(false);
    assert.strictEqual(reg3._byName.get('scene.tree').editor.stale, undefined);

    shared[0] = { ...busy }; // 心跳掉了 → 变成正忙
    reg3._rebuild(false); // ← 不 force，靠签名变化触发
    assert.strictEqual(
        reg3._byName.get('scene.tree').editor.stale,
        true,
        '签名必须包含 stale，否则编辑器变忙时缓存的 entry 不会更新（闸门永远不触发）'
    );
});

test('编辑器正忙时，工具调用**立刻失败**并说清是「正忙」', async () => {
    const busy = {
        shortName: 'p',
        pid: process.pid,
        url: 'http://127.0.0.1:7523/bridge',
        token: 't'.repeat(32),
        stale: true,
    };
    const reg = makeRegistry([busy]);
    reg._rebuild(true);
    const t0 = Date.now();
    await assert.rejects(
        () => reg.call('scene.tree', {}),
        /没有响应|正忙/,
        '编辑器正忙时要立刻失败并说清原因，而不是报「没装扩展」'
    );
    assert.ok(Date.now() - t0 < 3000, '应该立刻失败，不该等超时');
});

test('没有编辑器实例时，提示要说「先打开项目并启用扩展」', async () => {
    const reg = makeRegistry([]);
    await assert.rejects(
        () => reg.call('scene.tree', {}),
        /启用 cocos-mcp 扩展/,
        '真没实例时的提示要能指导用户'
    );
});

test('参数校验：null / 非法类型 / 越界 / 未知键都要明确报错', async () => {
    const reg = makeRegistry([
        { shortName: 'p', pid: process.pid, url: 'http://127.0.0.1:7523/bridge', token: 't'.repeat(32) },
    ]);
    reg._rebuild(true);

    // null 不是「没传」—— 它会一路变成 0 / NaN，让「等 90 秒」变成「一次都不等」
    await assert.rejects(() => reg.call('scene.create', { name: 'x', waitMs: null }), /不能是 null/);
    await assert.rejects(() => reg.call('scene.create', { name: 'x', waitMs: 'abc' }), /应为数字/);
    await assert.rejects(() => reg.call('scene.create', { name: 'x', waitMs: -1 }), /不能小于 0/);
    await assert.rejects(() => reg.call('scene.create', { name: 'x', waitSeconds: 5 }), /未知参数/);
    await assert.rejects(() => reg.call('scene.create', {}), /缺少必填参数/);
});

test('waitMs=0 应当被如实尊重（不等，立即返回当前状态）', async () => {
    // ⚠️ 0 与「非法值静默变成 0」是两回事：
    //    前者是用户的明确要求（不等），后者是会误导人的静默错误。
    const fake = { invoke: async () => ({ imported: false, reason: '测试' }) };
    const reg = new ToolRegistry({
        getClient: () => fake,
        listEditors: () => [{ shortName: 'p', pid: process.pid, url: 'http://127.0.0.1:7523/bridge', token: 't'.repeat(32) }],
    });
    reg._rebuild(true);
    const t0 = Date.now();
    const r = await reg.call('scene.create', { name: 'x', waitMs: 0 });
    assert.ok(Date.now() - t0 < 3000, 'waitMs=0 应该立即返回，不该等 90 秒');
    assert.strictEqual(r.imported, false, '没等到导入完成就该如实返回 false');
});
