'use strict';

/**
 * 冒烟测试「临时场景清理判定」的单元测试
 * ---------------------------------------------------------------------------
 * 第 7 轮独立复审抓到的 bug：
 *   第一次删除失败 → 先记一条 leftover → 兜底清理成功 → **那条记录不会撤回**
 *   ⇒ 明明已经删干净了，汇总却报「残留 1，需要人工清理」并 exit 3。
 *
 *   这是**误报**，而且会让 CI 在引擎偶发缺陷时常态红灯 ——
 *   一个常态红灯的信号等于没有信号。
 *
 * 要守住的核心性质：**判定只取决于最终还剩几个**，与中间失败无关。
 *
 * 运行：node --test test/smoke-cleanup.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { cleanupVerdict } = require('./smoke-cleanup');

test('★ 清理干净了 → ok（不报残留）', () => {
    const v = cleanupVerdict(0, '__smoke_scene_abc');
    assert.strictEqual(v.ok, true);
    assert.strictEqual(v.status, 'ok');
    assert.strictEqual(v.detail, '已清理');
});

test('★ 真的还剩东西 → leftover，并点名要删哪个文件', () => {
    const v = cleanupVerdict(1, '__smoke_scene_abc');
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.status, 'leftover');
    assert.match(v.detail, /仍有 1 个残留/);
    assert.match(v.detail, /db:\/\/assets\/scenes\/__smoke_scene_abc\.scene/);
});

test('★ 剩多个也要说清数量', () => {
    const v = cleanupVerdict(3, 'x');
    assert.match(v.detail, /仍有 3 个残留/);
});

test('★ 判定只看最终状态：中间失败过但最后干净了 → 不报残留', () => {
    // 这就是那个 bug 的形状 ——
    // 「第一次删失败」不是残留，「最后还剩 0 个」才是事实。
    const afterFallback = cleanupVerdict(0, '__smoke_scene_abc');
    assert.strictEqual(afterFallback.ok, true, '★ 兜底删成功后不得再报残留');
    assert.strictEqual(afterFallback.status, 'ok');
});

test('cleanupVerdict 对异常入参不崩', () => {
    assert.strictEqual(cleanupVerdict(undefined, 'x').ok, true);
    assert.strictEqual(cleanupVerdict(null, 'x').ok, true);
    assert.strictEqual(cleanupVerdict(0, undefined).ok, true);
});
