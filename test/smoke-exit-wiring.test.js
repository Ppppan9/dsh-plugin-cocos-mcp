'use strict';

/**
 * 冒烟脚本**退出码接线**的执行验证
 * ---------------------------------------------------------------------------
 * 第 7 轮独立复审抓到的 H1：
 *   「skip 不影响退出码 → scene 频道中毒时退出码 0 → CI 判绿」。
 *
 *   补上退出码逻辑之后，复审又指出一个更隐蔽的缺口：
 *   **纯函数有测试，接线没有** ——
 *   把 `test/tool-smoke.js` 里的 `process.exit(...)` 改回旧写法，
 *   178 条用例**一片绿**，而 H1 的 bug 原样复活。
 *
 *   ⇒ 光测 `exitCodeFor` 这个纯函数是不够的。
 *   本文件直接 **spawn 本脚本**看退出码 —— 接线断了就会红。
 *
 * 运行：node --test test/smoke-exit-wiring.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SMOKE = path.join(__dirname, 'tool-smoke.js');

/**
 * 让冒烟脚本只走「汇总 + 退出码」这条路径（不连编辑器），
 * 返回它的退出码。
 * @param {number} failed 失败条数
 * @param {number} skipped 跳过条数
 * @param {number} leftover 残留条数
 */
function runSmokeExit(failed, skipped, leftover) {
    const r = spawnSync(
        process.execPath,
        [SMOKE, `--selftest-exit=${failed},${skipped},${leftover}`],
        { encoding: 'utf8', timeout: 30000 }
    );
    return r.status;
}

test('★ 冒烟脚本真的用上了退出码函数（接线没断）', () => {
    // 这组断言是**执行**出来的 —— 不是读源码、不是测纯函数。
    assert.strictEqual(runSmokeExit(0, 0, 0), 0, '全部通过 → 0');
    assert.strictEqual(runSmokeExit(1, 0, 0), 1, '有真失败 → 1（真回归必须让 CI 变红）');
    assert.strictEqual(runSmokeExit(0, 1, 0), 2, '有跳过 → 2（本轮没跑完，不能当成通过）');
    assert.strictEqual(runSmokeExit(0, 0, 1), 3, '有残留 → 3（文件留在用户工程里）');
});

test('★ 优先级：有真失败时退出码必须是 1（不能被跳过/残留盖掉）', () => {
    assert.strictEqual(runSmokeExit(3, 10, 0), 1);
    assert.strictEqual(runSmokeExit(3, 10, 1), 1);
});

test('★ 频道中毒这个场景**绝不能**退出 0（H1 的核心）', () => {
    // 「scene 频道不可用」会被记成 skip（引擎缺陷），不是 fail。
    // 如果退出码只看 fail，就会退出 0 → CI 判绿 → 真回归被淹没。
    const code = runSmokeExit(0, 28, 0);
    assert.notStrictEqual(code, 0, '★ 有跳过时退出码绝不能是 0');
    assert.strictEqual(code, 2);
});
