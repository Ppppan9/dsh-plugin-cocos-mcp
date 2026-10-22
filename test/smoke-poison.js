'use strict';

/**
 * 「scene 频道不可用」的判据（冒烟与真机前置守卫**共用**一套）。
 * ---------------------------------------------------------------------------
 * ⚠️ 为什么要共用 ——
 *    这两条特征是**本项目自己的健康闸门**打出来的，闸门**不区分死因**：
 *    引擎自己挂死，和「本项目的 bug 把引擎搞挂」，打出来的是**完全相同的一句话**。
 *    两边各写一份，迟早会漂移 —— 一边认、一边不认，
 *    结果就是「真机前置守卫说环境没问题，冒烟说整个频道都废了」这种自相矛盾。
 *
 * ⚠️ 两条特征**不是一回事，理由也必须分开** ——
 *    「已经卡死」= 引擎侧彻底死了（调研报告 6.14）；
 *    「暂时无响应」= 编辑器正忙（启动时 auto refresh / 构建 / 批量导入），
 *    它自己的文案就写着「稍后重试即可」。
 *    把暂态报成「引擎缺陷」是**报告不准**：人看到「引擎缺陷」就不会再查了。
 */

/** 精确特征 —— 只认这两个，别放宽（放宽了会把真 bug 一起吞掉）。 */
const POISON_PATTERNS = [
    {
        re: /场景频道\*\*暂时无响应\*\*/,
        reason: '暂态：scene 频道暂时无响应（编辑器正忙，如启动时自动刷新），本轮未跑完',
        kind: 'transient',
    },
    {
        re: /场景频道已经卡死/,
        reason: '引擎缺陷：scene 频道已卡死（调研报告 6.14），本轮未跑完',
        kind: 'dead',
    },
];

/**
 * 命中哪个特征 → 返回它的理由；一个都不命中 → null（是真失败）。
 * @param {string} text 工具返回的错误文本
 * @returns {{reason: string, kind: string}|null}
 */
function poisonReason(text) {
    const s = String(text || '');
    for (const p of POISON_PATTERNS) {
        if (p.re.test(s)) return { reason: p.reason, kind: p.kind };
    }
    return null;
}

/** 判断一条错误是不是「频道不可用」。 */
function isSceneChannelUnusable(text) {
    return poisonReason(text) !== null;
}

/**
 * 错误文本是不是「超时」。
 *
 * ⚠️ 认的是「超时」这一个**形态**，不是泛泛的失败 ——
 *    「超时」正是引擎挂死时最常见的表现（客户端等不到回应），
 *    但它也可能来自别的原因，所以**不能只凭这一条**就判成引擎缺陷
 *    （必须再用探针确认，见冒烟脚本里的用法）。
 */
function isTimeoutText(text) {
    return /超时/.test(String(text || ''));
}

/**
 * 这个工具是不是走 **scene 频道**（引擎挂死时整条频道都不响应）。
 *
 * ⚠️ 这几个前缀是按扩展端的实现列的：
 *    `scene.*` 直接用 scene 频道，`node.*` / `component.*` 也经由它。
 *    其它频道（asset-db / preferences / …）挂了**不是**这个引擎缺陷。
 */
function isSceneChannelTool(name) {
    return /^(scene|node|component)\./.test(String(name || ''));
}

module.exports = {
    POISON_PATTERNS,
    poisonReason,
    isSceneChannelUnusable,
    isTimeoutText,
    isSceneChannelTool,
};
