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

const { POISON_PATTERNS, poisonReason, isSceneChannelUnusable, isTimeoutText, isSceneChannelTool } = require('./smoke-poison');

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

test('★ 判据只能有**一份**定义（两份各写一份迟早漂移）', () => {
    // ⚠️ 标记用**短片段**（`无响应` / `卡死`）而不是整句话 ——
    //    整句话里的 `**` 可以被写成字符类（`[*][*]`）绕��字面量 grep，
    //    而短片段很难绕（要匹配消息就必须含这些字）。
    //    诚实地说：这不是万无一失的检查（`已\\s*经卡死` 仍能绕），
    //    但它能挡住**真实发生过的**那种意外重复。
    // ⚠️ 第 8 轮复审前就是**两份** ——
    //    tool-smoke.js 改了用共享模块，editor-health.js 却还留着自己的副本。
    //    两边行为一旦漂移，就会出现「真机前置守卫说环境没问题、
    //    冒烟却说整个频道都废了」这种自相矛盾。
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = __dirname;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));
    // 特征片段在**非测试文件**里只能出现在 smoke-poison.js 一处
    // ⚠️ 扫描前必须**剥掉注释** —— 否则文档里提到「暂时无响应」也会被当成实现。
    const stripComments = (src) =>
        src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    // ⚠️ 标记是**正则字面量的开头** `/场景频道` ——
    //    用词（`卡死` / `无响应`）太粗：错误消息的**字符串**里就有这些词，
    //    会被误判成「又抄了一份」。
    //    而要匹配「场景频道**暂时无响应**…」这条消息，正则必然以 `/场景频道` 开头。
    const MARKS = ['/场景频道'];
    const hits = [];
    for (const f of files) {
        const src = stripComments(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (MARKS.some((m) => src.includes(m))) hits.push(f);
    }
    assert.deepStrictEqual(
        hits,
        ['smoke-poison.js'],
        `判据的特征串出现在多个文件里：${hits.join(', ')} —— 必须只有 smoke-poison.js 一份`
    );
    // 并且 editor-health 必须**引用**共享模块，而不是自己抄一份
    const eh = fs.readFileSync(path.join(dir, 'editor-health.js'), 'utf8');
    assert.match(eh, /require\('\.\/smoke-poison'\)/, 'editor-health.js 必须引用共享判据模块');
});

// ─────────────────── 超时的判定（第 11 轮复审带出来的） ───────────────────
// ⚠️ 背景：引擎挂死时，冒烟脚本有时收到健康闸门那两句特征（⇒ 记成「跳过」），
//    有时收到的是「请求超时（150000ms）」（⇒ 认不出来，被记成「**真失败**」）。
//    同一个引擎挂死，两种记法 —— 报告不准，人看到「失败」就会去查自己的代码。
//    ⇒ 超时也要能被识别，但**必须再用探针确认**（见 tool-smoke.js 的 check()）。

test('★ 超时能被认出来（它是引擎挂死最常见的表现）', () => {
    assert.ok(isTimeoutText('请求超时（150000ms）'), '★ 客户端超时必须被认出');
    assert.ok(isTimeoutText('编辑器消息 "scene:open-scene" 超时（90000ms 未返回）。'), '★ 引擎侧超时也要被认出');
    assert.ok(!isTimeoutText('没有组件 "cc.Nope" 的属性表。'), '普通错误不是超时');
    assert.ok(!isTimeoutText(''), '空文本不是超时');
});

test('★ 只有走 scene 频道的工具，超时才算「引擎挂死」（其它频道挂了不是它）', () => {
    for (const t of ['scene.tree', 'scene.open', 'node.create', 'component.add']) {
        assert.ok(isSceneChannelTool(t), `★ ${t} 走 scene 频道`);
    }
    for (const t of ['asset.query', 'preferences.get', 'editor.logs', 'build.platforms']) {
        assert.ok(!isSceneChannelTool(t), `★ ${t} 不走 scene 频道`);
    }
});
