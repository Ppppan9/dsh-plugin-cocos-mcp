'use strict';

/**
 * 注册表（编辑器实例发现）的行为测试
 * ---------------------------------------------------------------------------
 * 为什么要单独测：注册表决定「哪些 Cocos 实例可用」。
 * 一旦判错，后果完全不同：
 *   - 把**活着但正忙**的实例剔除 → 用户收到「请先打开项目并启用 cocos-mcp 扩展」，
 *     而扩展明明在跑 —— 排查方向会被完全带偏（真实踩过）。
 *   - 把**已死**的实例留下 → 每次调用都干等到超时。
 */

const test = require('node:test');
const assert = require('node:assert');

const { validate, isPidAlive, dedupeShortNames } = require('../src/registry');

const STALE_MS = 120000;

function entry(overrides = {}) {
    return {
        url: 'http://127.0.0.1:7523/bridge',
        token: 'x'.repeat(32),
        pid: process.pid, // 测试进程自己，一定活着
        ts: Date.now(),
        shortName: 'proj',
        projectPath: '/tmp/proj',
        ...overrides,
    };
}

test('validate：进程活着 + 心跳新鲜 → 正常', () => {
    const v = validate(entry(), Date.now(), STALE_MS);
    assert.strictEqual(v.ok, true, `不该被判无效：${v.reasons.join('、')}`);
    assert.strictEqual(v.stale, false);
});

test('validate：进程活着但心跳超时 → 标记 stale（不是「实例没了」）', () => {
    // ⚠️ 这是本轮的真实 bug：编辑器正忙 → 主进程阻塞 → 心跳停 →
    //    实例被整条剔除 → 用户被告知「没装扩展」。
    const old = Date.now() - STALE_MS - 5000;
    const v = validate(entry({ ts: old }), Date.now(), STALE_MS);
    assert.strictEqual(v.ok, true, '进程还活着就不该判无效');
    assert.strictEqual(v.stale, true, '心跳超时要标成 stale');
    assert.ok(v.reasons.length === 0, `stale 不应该算作错误原因：${v.reasons.join('、')}`);
});

test('validate：进程已退出 → 真的无效（要剔除）', () => {
    const deadPid = 999999999; // 基本不可能存在的 pid
    assert.strictEqual(isPidAlive(deadPid), false, '这个 pid 应该被判为已死');
    const v = validate(entry({ pid: deadPid }), Date.now(), STALE_MS);
    assert.strictEqual(v.ok, false, '进程死了必须判无效');
    assert.strictEqual(v.stale, false);
    assert.ok(v.reasons.some((r) => /进程已退出/.test(r)), `原因里应有「进程已退出」：${v.reasons.join('、')}`);
});

test('validate：进程死了 + 心跳超时 → 判无效，不是 stale', () => {
    const v = validate(
        entry({ pid: 999999999, ts: Date.now() - STALE_MS - 5000 }),
        Date.now(),
        STALE_MS
    );
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.stale, false);
});

test('validate：url 非 loopback / token 太短 → 无效', () => {
    assert.strictEqual(validate(entry({ url: 'http://evil.com/x' }), Date.now(), STALE_MS).ok, false);
    assert.strictEqual(validate(entry({ token: 'short' }), Date.now(), STALE_MS).ok, false);
    assert.strictEqual(validate(entry({ url: '' }), Date.now(), STALE_MS).ok, false);
});

test('validate：stale 只在「除心跳外没有其它问题」时才成立（安全）', () => {
    // ⚠️ 这是本轮引入的真实**安全回归**：
    //    曾经写成 `if (v.ok || v.stale)` —— 一条「url 不是 loopback / token 太短」
    //    的坏记录，只要心跳旧就会被标成 stale 而**保留**，
    //    于是 hub 会带着 Bearer token 把请求发到**非 loopback 地址**（SSRF + 凭据泄露）。
    //    判据必须严格：stale 只表示「只是没心跳」。
    const old = Date.now() - STALE_MS - 5000;

    const badUrl = validate(entry({ ts: old, url: 'http://evil.example.com/x' }), Date.now(), STALE_MS);
    assert.strictEqual(badUrl.stale, false, 'url 非 loopback 时不能标 stale（会被保留并被发请求）');
    assert.strictEqual(badUrl.ok, false, 'url 非 loopback 必须判无效');

    const badToken = validate(entry({ ts: old, token: 'short' }), Date.now(), STALE_MS);
    assert.strictEqual(badToken.stale, false, 'token 太短时不能标 stale');

    // 对照：只有心跳旧、其它都没问题 → 才算 stale
    const good = validate(entry({ ts: old }), Date.now(), STALE_MS);
    assert.strictEqual(good.stale, true, '只有心跳超时时才标 stale');
});

test('dedupeShortNames：同项目多份注册 → 一个当代表，其余改名 -dup<pid>', () => {
    // 真实场景：编辑器 spawn 竞态双开 → 同一个项目注册了两份。
    // 设计不是「丢掉一个」（那样就有一个实例调不到了），而是
    // 「保留一个当代表，其余改名成 <base>-dup<pid>」——两个都还能用，只是名字不同。
    const out = dedupeShortNames([
        entry({ pid: 111, ts: 1000, shortName: 'proj' }),
        entry({ pid: 222, ts: 2000, shortName: 'proj' }),
    ]);
    assert.strictEqual(out.length, 2, '两份注册都要保留（不能丢掉一个）');
    const names = out.map((e) => e.shortName).sort();
    assert.ok(names.includes('proj'), `应有一个保留原名：${names.join('、')}`);
    assert.ok(
        names.some((n) => /-dup\d+$/.test(n)),
        `另一个应改名为 <base>-dup<pid>：${names.join('、')}`
    );
    assert.strictEqual(new Set(names).size, 2, '改名后不能重名');
});
