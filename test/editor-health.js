'use strict';

/**
 * 真机测试的**场景频道健康**前置检查
 * ---------------------------------------------------------------------------
 * 为什么需要：
 *   真机测试跑在真实打开的 Cocos Creator 上。引擎有个已知缺陷 ——
 *   一次 `scene:open-scene` 挂死之后，**整个 scene 频道就不再回应**
 *   （调研报告 6.8 / 6.11 / 6.14），而且**再也回不来**。
 *
 *   这种状态下跑真机测试，得到的是一堆**同源失败**，
 *   更有甚者会直接崩在某个 `.find` 上（`data.nodes` 是 undefined），
 *   报出来的错跟真实原因完全无关 —— 看着像代码回归，其实是环境坏了。
 *
 *   ⇒ 前置检查：先探活，频道不可用就**明确说清是环境问题**并退出，
 *     让「环境坏了」和「代码回归了」在结果上就分得开。
 *
 * 退出码约定（与 test/tool-smoke.js 一致）：
 *   0 = 全部通过
 *   1 = 有真失败（真回归）
 *   2 = 环境不可用（编辑器没开 / 频道中毒 / 多实例）—— 不是本项目的 bug
 */

/**
 * ⚠️ 判据来自**共享模块** `test/smoke-poison.js` ——
 *    冒烟与本守卫必须用同一套。两边各写一份的话，迟早漂移：
 *    一边认、一边不认 → 「真机前置守卫说环境没问题，冒烟说整个频道都废了」。
 */
const { POISON_PATTERNS, isSceneChannelUnusable } = require('./smoke-poison');

/**
 * 探一次场景频道。
 * @param {Function} callTool 形如 (name, args) => Promise<{isError, data, text}>
 * @returns {Promise<{usable: boolean, reason: string}>}
 */
async function probeSceneChannel(callTool) {
    let res;
    try {
        res = await callTool('scene.tree', {});
    } catch (e) {
        return {
            usable: false,
            reason: `探活调用本身抛错：${String(e && e.message ? e.message : e).slice(0, 160)}`,
        };
    }
    if (res && res.isError) {
        const text = String(res.text || '');
        if (isSceneChannelUnusable(text)) {
            return {
                usable: false,
                reason:
                    'Cocos 的 scene 频道不可用（引擎侧卡死或正忙）。' +
                    '这是 **Cocos 引擎自身的缺陷**（调研报告 6.8 / 6.11 / 6.14），不是本项目的 bug。' +
                    '请重启 Cocos Creator 后重跑。',
            };
        }
        return {
            usable: false,
            reason: `scene.tree 返回错误（不是频道中毒）：${text.slice(0, 200)}`,
        };
    }
    if (!res || !res.data) {
        return { usable: false, reason: 'scene.tree 没有返回数据（场景频道可能已不回应）' };
    }
    return { usable: true, reason: '' };
}

/**
 * 真机测试的前置守卫：频道不可用就**明确退出**，不要让它跑出一堆同源失败。
 * @returns {Promise<boolean>} true = 可以继续跑
 */
async function requireSceneChannel(callTool, scriptName) {
    const p = await probeSceneChannel(callTool);
    if (p.usable) return true;
    console.error('');
    console.error(`❌ ${scriptName} 无法继续：${p.reason}`);
    console.error('   （这不算本项目的失败 —— 是环境/引擎的问题。修好环境后重跑即可。）');
    console.error('');
    process.exit(2);
    return false;
}

module.exports = { POISON_PATTERNS, isSceneChannelUnusable, probeSceneChannel, requireSceneChannel };
