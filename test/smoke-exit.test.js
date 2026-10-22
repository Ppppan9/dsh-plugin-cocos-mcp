'use strict';

/**
 * 冒烟测试退出码的单元测试
 * ---------------------------------------------------------------------------
 * 这一条是第 6 轮独立复审的 H1：
 *   「skip 不影响退出码 → scene 频道中毒时退出码 0 → CI 判绿」。
 *
 * 它值得单独一条测试，因为退出码是**自动 CI 唯一能看到的东西** ——
 * 输出里的跳过明细要有人去看，退出码不用。
 *
 * 运行：node --test test/smoke-exit.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { exitCodeFor } = require('./smoke-exit');

test('★ 全部通过 → 退出码 0', () => {
    assert.strictEqual(exitCodeFor(0, 0), 0);
});

test('★ 有真失败 → 退出码 1（真回归必须让 CI 变红）', () => {
    assert.strictEqual(exitCodeFor(1, 0), 1);
    assert.strictEqual(exitCodeFor(5, 0), 1);
});

test('★ 没有失败但有跳过 → 退出码 2（本轮没跑完，不能当成通过）', () => {
    // ★ 这一条就是 H1 的核心 ——
    //   之前 skip 不影响退出码，频道一中毒就退出 0，
    //   而健康闸门不区分死因 → 本项目 bug 造成的中毒也会被一起吞掉。
    assert.strictEqual(exitCodeFor(0, 1), 2, '有跳过时必须用独立退出码');
    assert.strictEqual(exitCodeFor(0, 28), 2);
});

test('★ 同时有失败和跳过 → 退出码 1（真失败优先）', () => {
    assert.strictEqual(exitCodeFor(3, 10), 1);
});

test('exitCodeFor 对异常入参不崩', () => {
    assert.strictEqual(exitCodeFor(undefined, undefined), 0);
    assert.strictEqual(exitCodeFor(null, null), 0);
    assert.strictEqual(exitCodeFor(0, 'x'), 0);
});
