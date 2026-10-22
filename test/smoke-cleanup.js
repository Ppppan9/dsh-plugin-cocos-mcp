'use strict';

/**
 * 冒烟测试的**临时场景清理判定**（单独抽出来是为了能对它写单测）。
 *
 * ⚠️ 核心性质：**判定只取决于「删完之后还剩几个」**，
 *    与中间某一次删除失败**无关**。
 *
 *    之前实现是「第一次删除失败就先记一条 leftover，兜底成功也不撤回」
 *    → 明明已经删干净了，汇总却报「残留 1，需要人工清理」并 exit 3。
 *    那是**误报**，而且会让 CI 在引擎偶发缺陷时常态红灯 ——
 *    一个常态红灯的信号等于没有信号。
 *
 * 另一个要守住的性质：**「第一次删失败」不等于「有残留」**。
 * 中间失败只说明要再试一次，最终状态才是事实。
 */

/**
 * @param {number} remainCount 清理之后**还剩几个**临时场景
 * @param {string} sceneName 本轮临时场景的名字
 * @returns {{ok: boolean, status: 'ok'|'leftover', detail: string}}
 */
function cleanupVerdict(remainCount, sceneName) {
    const remain = Number(remainCount) || 0;
    if (remain === 0) {
        return { ok: true, status: 'ok', detail: '已清理' };
    }
    return {
        ok: false,
        status: 'leftover',
        detail: `⚠️ 仍有 ${remain} 个残留，请手动删除：db://assets/scenes/${sceneName}.scene`,
    };
}

module.exports = { cleanupVerdict };
