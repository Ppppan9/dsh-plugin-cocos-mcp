'use strict';

/**
 * 「scene 频道不可用」判据的单元测试
 * ---------------------------------------------------------------------------
 * 两条特征**不是一回事，理由也必须分开** ——
 *   「已经卡死」= 引擎侧彻底死了（调研报告 6.14）；
 *   「暂时无响应」= 编辑器正忙（启动时 auto refresh / 构建 / 批量导入），
 *   它自己的文案就写着「编辑器可能正忙…稍后重试即可」。
 *
 * 把暂态报成「引擎缺陷」是**报告不准**：人看到「引擎缺陷」就不会再查了。
 * 第 7 轮独立复审指出：把两条理由改成同一句，用例**全绿** ——
 * 也就是说这个修复当时没有任何回归保护。
 *
 * 运行：node --test test/smoke-poison.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { POISON_PATTERNS, poisonReason, isSceneChannelUnusable } = require('./smoke-poison');

test('★ 两条特征的判据都命中，而且理由**必须不同**', () => {
    const transient = poisonReason('场景频道**暂时无响应**（健康检查失败：…）');
    const dead = poisonReason('打开场景失败，并且场景频道随后不再回应 —— Cocos 的场景频道已经卡死（…）');

    assert.ok(transient, '暂态特征必须被认出来');
    assert.ok(dead, '彻底卡死的特征必须被认出来');
    assert.notStrictEqual(
        transient.reason,
        dead.reason,
        '★ 两条理由不能是同一句 —— 暂态不是引擎缺陷'
    );
});

test('★ 理由要与消息原文对得上（不能把暂态说成引擎缺陷）', () => {
    const transient = poisonReason('场景频道**暂时无响应**（健康检查失败：…；刚刚开始）');
    const dead = poisonReason('Cocos 的场景频道已经卡死（场景状态查询不再回应）。');

    assert.match(transient.reason, /暂态|暂时/, '暂态的理由要说清是暂态');
    assert.match(transient.reason, /正忙|自动刷新/, '暂态的理由要点明「编辑器正忙」');
    assert.ok(
        !/引擎缺陷/.test(transient.reason),
        '★ 暂态不得报成「引擎缺陷」—— 那会让人以为不用再查了'
    );

    assert.match(dead.reason, /引擎缺陷/, '彻底卡死的理由要点明是引擎缺陷');
});

test('★ 普通错误不能被当成「频道不可用」（放宽就会把真 bug 放过去）', () => {
    const notPoison = [
        '工具 "component.set" 执行失败：Cannot read properties of undefined',
        '参数校验失败：缺少必填参数 node',
        '引擎拒绝关闭当前场景',
        '工具 "prefab 路径" 执行失败：不在任何一个已注册的 Cocos 项目目录内',
        '',
        undefined,
    ];
    for (const t of notPoison) {
        assert.strictEqual(poisonReason(t), null, `不该被当成频道不可用：${t}`);
        assert.strictEqual(isSceneChannelUnusable(t), false);
    }
});

test('★ 特征表本身只有两条（加多了就会误伤）', () => {
    assert.strictEqual(POISON_PATTERNS.length, 2, '特征表只应有两条精确特征');
    const kinds = new Set(POISON_PATTERNS.map((p) => p.kind));
    assert.deepStrictEqual([...kinds].sort(), ['dead', 'transient'], '两种根因都要能区分');
});
