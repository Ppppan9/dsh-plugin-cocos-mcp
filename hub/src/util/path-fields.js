'use strict';

/**
 * 「哪些字段算路径」的**唯一判定口径**（离线层与扩展端共用同一份）
 * ---------------------------------------------------------------------------
 * ⚠️ 为什么必须只有一份：
 *    两层各有一套口径时，两套一定会漂移 ——
 *    扩展端一度用「精确匹配 9 个词」的窄口径，
 *    离线层用的是「子串匹配」的宽口径。
 *    后果实测过（第 11 轮复审 H-1）：
 *    新增一个带 `srcPath` 的 op（名字不在那 9 个词里）⇒
 *      · 它**进不了**推导范围；
 *      · 于是它既不必进护栏表、也不必进豁免表；
 *      · 护栏对它**完全不存在**，而全套测试**一片绿**；
 *      · 实测越界路径 `/etc/passwd` 原样直达引擎的 `asset-db` 频道。
 *    ⇒ 判定逻辑收敛到这一个模块，两层都 require 它。
 *
 * ⚠️ 两条硬要求（都是踩出来的）：
 *    ① 字段名必须按**子串**匹配 —— 精确匹配只能覆盖事先想到的那几个名字，
 *       换个名字（srcPath / assetUrl / rootDir）就静默逃逸；
 *    ② **数组**字段（`paths: string[]`）也要算 ——
 *       只认 `type === 'string'` 会让整类数组字段逃逸。
 */

/**
 * 字段名里含这些**片段**，就当作「路径类字段」。
 * （与离线层原先的口径一致 —— 那一套是经过多轮复审的，不该被改窄。）
 */
const PATHISH_SUBSTRING = /path|file|url|dir|prefab|asset|folder|uri/i;

/**
 * 这些名字**本身**就是路径语义，却不含上面任何片段 —— 单独列出来。
 * `from` / `to` 是资源移动与复制的源和目标；`src` / `dest` 同理。
 * ⚠️ 单独列而不是塞进上面的正则：`from` 若进正则，
 *    将来出现 `fromNode`（节点名，不是路径）就会误伤。
 */
const PATHISH_EXACT = new Set(['from', 'to', 'src', 'dest', 'source', 'root']);

/**
 * 字段名是否算「路径类」。
 * @param {string} name
 */
function isPathishField(name) {
    return PATHISH_EXACT.has(name) || PATHISH_SUBSTRING.test(name);
}

/**
 * schema 里的一个字段是不是「承载路径的字符串」。
 * ⚠️ **数组也要算** —— `paths`（string[]）同样是路径。
 * @param {object} schema 字段的 schema 片段
 */
function isPathCarrier(schema) {
    if (!schema || typeof schema !== 'object') return false;
    if (schema.type === 'string') return true;
    return schema.type === 'array' && !!schema.items && schema.items.type === 'string';
}

/**
 * 从一个工具的 inputSchema 里取出「路径类字段」与「全部字符串类字段」。
 *
 * ⚠️ 两个都要：
 *    · `pathish` 用来要求「必须表态」（护栏表 or 豁免表）；
 *    · `strings` 用来反向核对「表里的项必须指向真实存在的字段」（防拼错）。
 *
 * @param {object} inputSchema
 * @returns {{pathish: string[], strings: string[]}}
 */
function fieldsOfSchema(inputSchema) {
    const props = (inputSchema && inputSchema.properties) || {};
    const names = Object.keys(props);
    return {
        pathish: names.filter((n) => isPathishField(n) && isPathCarrier(props[n])),
        strings: names.filter((n) => isPathCarrier(props[n])),
    };
}

module.exports = {
    PATHISH_SUBSTRING,
    PATHISH_EXACT,
    isPathishField,
    isPathCarrier,
    fieldsOfSchema,
};
