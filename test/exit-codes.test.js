'use strict';

/**
 * 退出码词汇表的单元测试
 * ---------------------------------------------------------------------------
 * 退出码是**自动 CI 唯一能看到的东西**。同一个码在不同脚本里表示两件事，
 * CI 就读不出来 —— 第 7 轮独立复审实测到两处碰撞：
 *   - 2：e2e 里是「检测到多编辑器实例」，冒烟里是「有跳过、本轮没跑完」
 *   - 3：e2e 的异常处理里是「测试中断」，冒烟里是「有残留」
 *
 * ⇒ 所有真机脚本必须用**同一张表**（test/exit-codes.js）。
 *
 * 运行：node --test test/exit-codes.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { EXIT, EXIT_MEANING } = require('./exit-codes');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('★ 退出码的取值是固定且互不相同的', () => {
    const codes = Object.values(EXIT);
    assert.deepStrictEqual(codes.slice().sort(), [0, 1, 2, 3, 4], '退出码取值必须固定');
    assert.strictEqual(new Set(codes).size, codes.length, '退出码不能重复');
});

test('★ 每个退出码都有说明（CI 要知道它什么意思）', () => {
    for (const code of Object.values(EXIT)) {
        assert.ok(EXIT_MEANING[code], `退出码 ${code} 缺说明`);
    }
});

test('★ 语义分层不能错：失败 / 没跑完 / 残留 / 崩溃 必须分得开', () => {
    // 这四个含义不同，混了 CI 就读不出来。
    assert.strictEqual(EXIT.OK, 0, '全通过');
    assert.strictEqual(EXIT.FAILURE, 1, '有真失败（真回归）');
    assert.strictEqual(EXIT.INCOMPLETE, 2, '本轮没跑完（环境/引擎问题，可重试）');
    assert.strictEqual(EXIT.LEFTOVER, 3, '有残留（要人工清理）');
    assert.strictEqual(EXIT.CRASH, 4, '测试自身中断（脚本坏了）');
});

test('★ 各真机脚本必须用这张表，不许自己写裸数字', () => {
    for (const f of ['test/tool-smoke.js', 'test/e2e.js', 'test/real-behavior.test.js']) {
        const src = read(f);
        assert.match(src, /require\('\.\/exit-codes'\)/, `${f} 没有引用退出码词汇表`);
        // 裸的 process.exit(<数字>) 就是绕过词汇表
        const bare = src.match(/process\.exit\(\s*\d+\s*\)/g) || [];
        assert.deepStrictEqual(bare, [], `${f} 里有绕过词汇表的裸退出码：${bare.join(', ')}`);
    }
});
