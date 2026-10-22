'use strict';

/**
 * 冒烟测试的**退出码**决策 —— 单独抽出来是为了能对它写单测。
 *
 * ⚠️ 为什么退出码要区分三件事 ——
 *    冒烟测试把「scene 频道不可用」记成 skip（引擎缺陷），
 *    而 skip **不计入失败**。如果退出码只看失败数，
 *    频道一中毒就退出 0 → **CI 判绿**。
 *
 *    而「scene 频道不可用」这两条特征是**本项目自己的健康闸门**打出来的，
 *    闸门**不区分死因** —— 引擎自己挂死，和「本项目的 bug 把引擎搞挂」，
 *    打出来的是**完全相同的一句话**。
 *    ⇒ 如果不把 skip 单独编码，本项目 bug 造成的中毒会被一起吞掉，
 *      而 CI 看到的仍然是绿的。
 *
 *    「本轮没测到」和「测了没问题」必须能被区分开。
 */

const { EXIT } = require('./exit-codes');

/**
 * @param {number} failedCount 真失败数
 * @param {number} skippedCount 跳过数（引擎缺陷导致本轮没跑完的检查）
 * @param {number} leftoverCount 残留数（文件留在用户工程里，需要人工清理）
 * @returns {number} 0=全部通过 / 1=有真失败 / 2=无失败但没跑完 / 3=有残留
 */
function exitCodeFor(failedCount, skippedCount, leftoverCount) {
    const failed = Number(failedCount) || 0;
    const skipped = Number(skippedCount) || 0;
    const leftover = Number(leftoverCount) || 0;
    // ⚠️ 码值必须**引用词汇表**，不能自己写死数字 ——
    //    `test/exit-codes.js` 才是「唯一真相」，
    //    这里再写一份 0/1/2/3 的话，改表时就不会联动。
    if (failed > 0) return EXIT.FAILURE;
    if (leftover > 0) return EXIT.LEFTOVER;
    if (skipped > 0) return EXIT.INCOMPLETE;
    return EXIT.OK;
}

module.exports = { exitCodeFor };
