'use strict';

/**
 * 场景频道健康前置检查的单元测试
 * ---------------------------------------------------------------------------
 * 这个模块决定真机测试在「编辑器中毒」时是**清楚退出**还是**崩在别处**。
 * 它的判据是一组精确的错误特征 —— 放宽了就会把真 bug 当成环境问题放过去。
 *
 * 运行：node --test test/editor-health.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { isSceneChannelUnusable, probeSceneChannel } = require('./editor-health');

/** 构造一个 callTool 替身。 */
function fakeCall(res) {
    return async () => {
        if (res.throw) throw new Error(res.throw);
        return res.value;
    };
}

test('★ 频道中毒的两条特征都要被认出来', () => {
    assert.ok(isSceneChannelUnusable('工具 "scene.tree" 执行失败：场景频道**暂时无响应**（健康检查失败：…）'));
    assert.ok(isSceneChannelUnusable('打开场景失败，并且场景频道随后不再回应 —— Cocos 的场景频道已经卡死（场景状态查询不再回应）。'));
});

test('★ 普通错误不能被当成「频道不可用」（放宽就会把真 bug 放过去）', () => {
    assert.strictEqual(isSceneChannelUnusable('工具 "component.set" 执行失败：Cannot read properties of undefined'), false);
    assert.strictEqual(isSceneChannelUnusable('参数校验失败：缺少必填参数 node'), false);
    assert.strictEqual(isSceneChannelUnusable('引擎拒绝关闭当前场景'), false);
    assert.strictEqual(isSceneChannelUnusable(''), false);
    assert.strictEqual(isSceneChannelUnusable(undefined), false);
});

test('★ 探活：频道正常 → usable', async () => {
    const p = await probeSceneChannel(fakeCall({ value: { isError: false, data: { count: 3, nodes: [] } } }));
    assert.strictEqual(p.usable, true);
    assert.strictEqual(p.reason, '');
});

test('★ 探活：频道中毒 → 不可用，且说清是引擎缺陷不是本项目的 bug', async () => {
    const p = await probeSceneChannel(
        fakeCall({ value: { isError: true, text: '场景频道**暂时无响应**（健康检查失败：…）' } })
    );
    assert.strictEqual(p.usable, false);
    assert.match(p.reason, /引擎/);
    assert.match(p.reason, /不是本项目的 bug/);
});

test('★ 探活：别的错误要说清是「不是频道中毒」（别把真 bug 说成环境问题）', async () => {
    const p = await probeSceneChannel(
        fakeCall({ value: { isError: true, text: '工具 "component.set" 执行失败：TypeError: x is not a function' } })
    );
    assert.strictEqual(p.usable, false);
    assert.match(p.reason, /不是频道中毒/);
    assert.match(p.reason, /TypeError/);
});

test('★ 探活：没有返回数据也算不可用', async () => {
    const p1 = await probeSceneChannel(fakeCall({ value: { isError: false, data: null } }));
    assert.strictEqual(p1.usable, false);
    const p2 = await probeSceneChannel(fakeCall({ value: { isError: false } }));
    assert.strictEqual(p2.usable, false);
});

test('★ 探活：调用本身抛错要说清（不能当成「没问题」）', async () => {
    const p = await probeSceneChannel(fakeCall({ throw: 'ECONNRESET' }));
    assert.strictEqual(p.usable, false);
    assert.match(p.reason, /抛错/);
});
