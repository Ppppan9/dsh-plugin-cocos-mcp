'use strict';

/**
 * 工具 schema 的**唯一**定义处
 * ---------------------------------------------------------------------------
 * ⚠️ 为什么要单独抽出来：
 *    之前 `T()` 在 editor-tools.js 和 global-tools.js 里各有一份，
 *    而 `toSchema()`（对外暴露时补 confirm）又只在一处 ——
 *    于是仓库里存在**两份 schema**（原始的 vs 对外的）。
 *    真实踩过的坑：参数校验按**原始** schema 判，
 *    把合法的 `confirm: true` 当成「未知参数」拒掉了；
 *    一致性断言按原始 schema 判，也报「danger 工具的 required 里没有 confirm」。
 *
 *    现在：破坏性工具的 confirm 在 `T()` 里就写进原始 schema，
 *    `toSchema()` 只负责把它原样对外暴露 —— 两边永远一致。
 */

const DANGER = 'danger';

/** 破坏性操作的确认位。 */
const CONFIRM_SPEC = {
    type: 'boolean',
    const: true,
    description: '破坏性操作确认位。必须显式传 true 才会执行。',
};

/**
 * 工具定义工厂。
 *
 * @param {string} name 工具名
 * @param {object} spec 工具定义（title / description / inputSchema / safety / op / handler …）
 */
function T(name, spec) {
    const tool = { name, safety: 'read', ...spec };
    if (tool.safety === DANGER) {
        const base = tool.inputSchema || { type: 'object', properties: {} };
        const properties = { ...(base.properties || {}) };
        // 工具自己写过 confirm 的，保留自己的描述
        if (!properties.confirm) properties.confirm = { ...CONFIRM_SPEC };
        const required = [...(base.required || [])];
        if (!required.includes('confirm')) required.push('confirm');
        tool.inputSchema = { ...base, type: 'object', properties, required };
    }
    return tool;
}

/**
 * 转成对外暴露的 MCP schema。
 * ⚠️ 这里**不再**补 confirm —— `T()` 已经写进原始 schema 了，
 *    两边保持一致，不要在这里制造第二份真相。
 */
function toSchema(tool) {
    return {
        type: 'object',
        properties: { ...(tool.inputSchema.properties || {}) },
        required: [...(tool.inputSchema.required || [])],
    };
}

module.exports = { T, toSchema, DANGER, CONFIRM_SPEC };
