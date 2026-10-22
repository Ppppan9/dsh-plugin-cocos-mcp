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
/**
 * ⚠️ spawn 时必须**去掉 NODE_TEST_CONTEXT** ——
 *    那个标记表示「我是被 test runner 自动发现拉起来的」。
 *    脚本里有守卫：带着这个标记就立刻退出（那正是守卫的用途）。
 *    而这里要的是「把它**当脚本**跑」，所以要把标记摘掉。
 */
function scriptEnv() {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    return env;
}

function runSmokeExit(failed, skipped, leftover) {
    const r = spawnSync(
        process.execPath,
        [SMOKE, `--selftest-exit=${failed},${skipped},${leftover}`],
        { encoding: 'utf8', timeout: 30000, env: scriptEnv() }
    );
    return r;
}

test('★ 冒烟脚本真的用上了退出码函数（接线没断）', () => {
    // 这组断言是**执行**出来的 —— 不是读源码、不是测纯函数。
    assert.strictEqual(runSmokeExit(0, 0, 0).status, 0, '全部通过 → 0');
    assert.strictEqual(runSmokeExit(1, 0, 0).status, 1, '有真失败 → 1（真回归必须让 CI 变红）');
    assert.strictEqual(runSmokeExit(0, 1, 0).status, 2, '有跳过 → 2（本轮没跑完，不能当成通过）');
    assert.strictEqual(runSmokeExit(0, 0, 1).status, 3, '有残留 → 3（文件留在用户工程里）');
});

test('★ 退出前必须调用 cleanup（关掉 MCP 客户端，CI 上漏了会留进程）', () => {
    // ⚠️ cleanup 后面紧跟 process.exit，所以**漏掉它不影响退出码** ——
    //    光看退出码测不出来，只能靠它打的标记。
    const r = runSmokeExit(0, 0, 0);
    assert.match(
        String(r.stderr || ''),
        /SELFTEST_CLEANUP_CALLED/,
        '★ finish() 必须调用 cleanup'
    );
});

test('★ 优先级：有真失败时退出码必须是 1（不能被跳过/残留盖掉）', () => {
    assert.strictEqual(runSmokeExit(3, 10, 0).status, 1);
    assert.strictEqual(runSmokeExit(3, 10, 1).status, 1);
});

test('★ 频道中毒这个场景**绝不能**退出 0（H1 的核心）', () => {
    // 「scene 频道不可用」会被记成 skip（引擎缺陷），不是 fail。
    // 如果退出码只看 fail，就会退出 0 → CI 判绿 → 真回归被淹没。
    const code = runSmokeExit(0, 28, 0).status;
    assert.notStrictEqual(code, 0, '★ 有跳过时退出码绝不能是 0');
    assert.strictEqual(code, 2);
});

test('★ 真实调用点必须把 client.close() 作为 cleanup 传进去（漏了会漏进程）', () => {
    // ⚠️ 真实调用点是 `finish(results, declared, () => client.close())`。
    //    把那个实参改成 null → 客户端永远不被关掉（CI 上漏进程），
    //    而**退出码不变**（process.exit 紧跟其后）→ 光看退出码测不出来。
    //    假客户端 close() 时会往 stderr 打标记，靠它来验。
    const r = spawnSync(process.execPath, [SMOKE, '--selftest-wire'], { encoding: 'utf8', timeout: 60000, env: scriptEnv() });
    assert.match(
        String(r.stderr || ''),
        /FAKE_CLIENT_CLOSED/,
        '★ 真实调用点必须把「关客户端」作为 cleanup 传进去'
    );
});

test('★ 自测模式必须**最先**执行（挪到 main() 之后会先干等真机）', () => {
    // 靠「标记是不是第一行」做行为验证，不必解析源码。
    const r = spawnSync(process.execPath, [SMOKE, '--selftest-exit=0,0,0'], {
        encoding: 'utf8',
        timeout: 60000,
        env: scriptEnv(),
    });
    const first = String(r.stdout || '').split('\n').map((x) => x.trim()).filter(Boolean)[0];
    assert.strictEqual(first, 'SELFTEST_EXIT_MODE', '★ 自测模式必须是第一件事（否则会先跑一遍真实流程）');
});

test('★ 假载荷不能太假：真实流程必须真的跑到大部分工具', () => {
    // ⚠️ 载荷太假的危害：asset.query 返回空数组 → 冒烟脚本里「场景生命周期」
    //    那一整段被跳过 → 10 个工具在「真实流程」模式下**根本没被跑到**，
    //    而接线看着被测了、真实路径的行为却没被测到（假货）。
    //    ⇒ 假客户端在 close() 时报告跑到了几个工具，这里给一条下限。
    const r = spawnSync(process.execPath, [SMOKE, '--selftest-wire'], {
        encoding: 'utf8',
        timeout: 60000,
        env: scriptEnv(),
    });
    const m = String(r.stderr || '').match(/FAKE_CALLED_TOOLS:(\d+)/);
    assert.ok(m, '★ 假客户端应当报告跑到的工具数（否则这条断言会空转）');
    const n = Number(m[1]);
    assert.ok(n >= 65, `★ 真实流程只跑到了 ${n} 个工具 —— 假载荷太假，大段真实路径没被测到`);
});

test('★ 真实流程里那个 finish() 调用不能被删（不然脚本不打印汇总、退出码 0）', () => {
    // ⚠️ 第 8 轮复审实测过的缺口 ——
    //    `--selftest-exit` 直接调 finish() 这个**函数**，
    //    于是「main() 末尾那个真实的 finish() 调用」本身没有保护：
    //    把它删掉，用例**一片绿**，而真实运行时脚本根本不打印汇总、退出码 0 → CI 判绿。
    //
    // ⇒ 这里用**假 MCP 客户端**（test/fake-mcp-client.js）让真实的 main() 流程跑一遍，
    //    走的就是真实路径里那个调用。
    const r = spawnSync(process.execPath, [SMOKE, '--selftest-wire'], { encoding: 'utf8', timeout: 60000, env: scriptEnv() });
    assert.notStrictEqual(r.status, 0, '★ 真实流程这一轮应当以非 0 结束（假客户端让 expectError 检查失败）');
    assert.strictEqual(r.status, 1, '★ 应当是「有真失败」的退出码 1');
    assert.match(String(r.stdout || ''), /通过 \d+ \/ 失败 \d+/, '★ 必须真的打印了汇总');
});
