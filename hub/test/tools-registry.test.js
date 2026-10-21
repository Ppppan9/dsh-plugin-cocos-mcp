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
