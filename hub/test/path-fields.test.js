'use strict';

/**
 * 「什么算路径字段」的**共享判定模块**的守卫测试
 * ---------------------------------------------------------------------------
 * 为什么要有这一层：
 *   这个判定是**两道护栏的地基** ——
 *   离线层（OP_PATH_FIELDS）和扩展端（ASSET_PATH_FIELDS）都用它推导
 *   「哪些 op/字段必须表态」。
 *
 *   ⚠️ 地基一旦被改窄，后果是**静默**的：
 *   推导范围变小 → 新加的路径字段进不了范围 → 护栏对它不存在 → CI 全绿。
 *   第 11 轮复审 H-1 实测过这个形态：
 *   扩展端一度用「精确匹配 9 个词」的窄口径，
 *   新增一个带 `srcPath` 的 op 时全套测试一片绿，
 *   而 `/etc/passwd` 原样直达了引擎。
 *
 *   ⇒ 所以这个模块的行为本身必须被钉住：
 *   **宽口径**（子串匹配）+ **数组也算** + **明确不是路径的名字不误伤**。
 *
 * 运行：node --test hub/test/path-fields.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { isPathishField, isPathCarrier, fieldsOfSchema } = require('../src/util/path-fields');

test('★ 判定必须是**子串**匹配（新名字不能静默逃逸）', () => {
    // ⚠️ 这几个名字**都不在**任何「事先想到的清单」里 ——
    //    精确匹配的口径会让它们全部逃逸（第 11 轮复审 H-1 的原始形态）。
    for (const name of ['srcPath', 'assetUrl', 'rootDir', 'destPath', 'prefabPath', 'fileList', 'folderName']) {
        assert.ok(isPathishField(name), `★ "${name}" 明显是路径字段，必须被认出来`);
    }
});

test('★ 明确**不是**路径的名字不能误伤', () => {
    // 这些在业务上是节点名 / 组件名 / 动作名 —— 误判会让表越滚越大、失去意义。
    for (const name of ['name', 'target', 'action', 'method', 'component', 'node', 'type', 'mode']) {
        assert.ok(!isPathishField(name), `★ "${name}" 不是路径字段，不该被认成路径`);
    }
});

test('★ from / to / src / dest 单独列出来（它们不含路径词，但语义就是路径）', () => {
    for (const name of ['from', 'to', 'src', 'dest', 'source', 'root']) {
        assert.ok(isPathishField(name), `★ "${name}" 是资源移动/复制的源与目标，必须算路径`);
    }
    // ⚠️ 但它们是**精确**匹配：`fromNode`（节点名）不能被误伤。
    assert.ok(!isPathishField('fromNode'), '★ fromNode 是节点名，不是路径');
});

test('★ **数组**字段也要算（paths: string[] 同样是路径）', () => {
    assert.ok(isPathCarrier({ type: 'string' }), 'string 字段承载路径');
    assert.ok(isPathCarrier({ type: 'array', items: { type: 'string' } }), '★ string[] 字段同样承载路径');
    assert.ok(!isPathCarrier({ type: 'number' }), 'number 不承载路径');
    assert.ok(!isPathCarrier({ type: 'boolean' }), 'boolean 不承载路径');
    assert.ok(!isPathCarrier({ type: 'array', items: { type: 'number' } }), 'number[] 不承载路径');
    assert.ok(!isPathCarrier(undefined), '没有 schema 不承载路径');
});

test('★ fieldsOfSchema：路径字段与全部字符串字段都要给出来', () => {
    const { pathish, strings } = fieldsOfSchema({
        type: 'object',
        properties: {
            url: { type: 'string' },
            paths: { type: 'array', items: { type: 'string' } },
            content: { type: 'string' },
            overwrite: { type: 'boolean' },
            waitMs: { type: 'number' },
        },
    });
    assert.deepStrictEqual(pathish.sort(), ['paths', 'url'], '路径字段：url 与数组 paths');
    assert.deepStrictEqual(strings.sort(), ['content', 'paths', 'url'], '字符串类字段（含数组）');
});

test('★ 没有 schema / 没有 properties 时不许抛异常', () => {
    assert.deepStrictEqual(fieldsOfSchema(undefined), { pathish: [], strings: [] });
    assert.deepStrictEqual(fieldsOfSchema({ type: 'object' }), { pathish: [], strings: [] });
    assert.deepStrictEqual(fieldsOfSchema({ properties: null }), { pathish: [], strings: [] });
});
