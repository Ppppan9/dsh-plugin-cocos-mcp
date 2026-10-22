'use strict';

/**
 * 全局工具（`hub/src/tools/global-tools.js`）的**行为**回归测试
 * ---------------------------------------------------------------------------
 * 第 11 轮独立复审在这一层抓到的两类病，都是本项目反复强调要消灭的形态：
 *
 *   **G-4「声明 ≠ 能用」**
 *     `cocos_knowledge` 的 `index` 直接返回 `Object.keys(KNOWLEDGE)`，
 *     把知识库 JSON 里的 `version` 也列了出来 ——
 *     而 enum 不接受它 ⇒ 模型照着 index 调 `topic=version` 就被拒。
 *     （自己列出来的 topic 自己查不到。）
 *
 *   **G-5「假成功」**
 *     查不到组件时，工具**不抛错**，而是把 `error` 塞进返回体 ——
 *     MCP 层照常标 `isError=false`，脚本只判 isError 就把失败当成功。
 *     （本项目专门为离线工具写过 `assertOfflineOk` ��的就是防这个。）
 *
 * 运行：node --test hub/test/global-tools.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { GLOBAL_TOOLS } = require('../src/tools/global-tools');

const knowledge = GLOBAL_TOOLS.find((t) => t.name === 'cocos_knowledge');
assert.ok(knowledge, 'cocos_knowledge 必须存在');

const TOPIC_ENUM = knowledge.inputSchema.properties.topic.enum;

test('★ index 列出来的 topic，enum 必须都接受（自己列的自己要能查）', async () => {
    const r = await knowledge.handler({ topic: 'index' });
    assert.ok(Array.isArray(r.topics), 'index 必须返回 topic 数组');
    assert.ok(r.topics.length > 0, 'index 不能是空的');
    const bad = r.topics.filter((t) => !TOPIC_ENUM.includes(t));
    assert.strictEqual(
        bad.length,
        0,
        `★ index 列出了 ${JSON.stringify(bad)}，但 enum 不接受 —— 模型照着 index 调就会被拒（「声明 ≠ 能用」）`
    );
});

test('★ index 列出来的每个 topic，都必须真的查得到内容', async () => {
    const r = await knowledge.handler({ topic: 'index' });
    for (const t of r.topics) {
        if (t === 'index') continue; // index 自己就是入口
        const res = await knowledge.handler({ topic: t });
        assert.ok(res && typeof res === 'object', `★ topic="${t}" 必须能查到内容`);
        assert.ok(
            !('error' in res) || t === 'components',
            `★ topic="${t}" 返回了 error 字段（不能「成功 + error」）`
        );
    }
});

test('★ 查不到组件必须**抛错**（不能「成功 + 一个 error 字段」= 假成功）', async () => {
    let threw = null;
    try {
        await knowledge.handler({ topic: 'components', component: 'cc.__不存在的组件__' });
    } catch (e) {
        threw = e;
    }
    assert.ok(threw, '★ 查不到组件必须抛错（抛了 MCP 层才会标 isError=true）');
    assert.match(String(threw.message), /没有组件/, '错误信息要说清是哪个组件找不到');
});

test('★ 组件名支持 cc.Label / Label / label 三种写法', async () => {
    const full = await knowledge.handler({ topic: 'components', component: 'cc.Label' });
    assert.ok(full.component, '★ 应当返回组件的完整键名');
    for (const variant of ['Label', 'label', 'LABEL']) {
        const r = await knowledge.handler({ topic: 'components', component: variant });
        assert.strictEqual(r.component, full.component, `★ component="${variant}" 必须能查到同一个组件`);
    }
});
