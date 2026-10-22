'use strict';

/**
 * 扩展端（extension/bridge/handlers.js）的**单元测试**
 * ---------------------------------------------------------------------------
 * 为什么需要这一层：扩展端是**真正操作编辑器**的那一层，
 * 此前只被 `test/e2e.js` 端到端覆盖 —— 而 e2e 要开着 Cocos Creator 才跑得了。
 * 于是「扩展端的行为对不对」在 CI 上没有回归保护。
 *
 * 这里用**假 ctx**（只实现 `ctx.msg`）驱动**真实的 handler**，
 * 观察它到底往引擎发了什么消息、带什么参数。
 * 这能抓到一类特别隐蔽的病：**声明了参数、校验了参数、却没把它传下去**。
 *
 * 运行：node --test hub/test/extension-handlers.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { createHandlers } = require('../../extension/bridge/handlers');

/** 造一套假 ctx，记录发往引擎的每一条消息。 */
function makeCtx(behaviors) {
    const sent = [];
    const ctx = {
        projectPath: '/tmp/proj',
        msg(channel, message, ...args) {
            sent.push({ channel, message, args });
            const b = behaviors && behaviors[`${channel}:${message}`];
            if (typeof b === 'function') return b(...args);
            if (b !== undefined) return Promise.resolve(b);
            return Promise.resolve({});
        },
    };
    return { ctx, sent, handlers: createHandlers(ctx) };
}

test('★ build.start：platform 必须真的下传给引擎（之前被校验完就丢了）', async () => {
    // ⚠️ 之前：req() 校验了 platform，引擎收到的 options 却是空的
    //    ⇒ 实际构建的是编辑器当前配置的平台，而返回值回显 platform:"android"
    //    ⇒ 模型据此汇报一个**假结果**。
    const { handlers, sent } = makeCtx();
    const r = await handlers['build.start']({ platform: 'android' });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].channel + ':' + sent[0].message, 'builder:add-task');
    const options = sent[0].args[0];
    assert.strictEqual(options.platform, 'android', '★ platform 必须进 options');
    assert.strictEqual(r.platform, 'android');
});

test('★ build.start：options 里同名 platform 不能覆盖必填的 platform', async () => {
    const { handlers, sent } = makeCtx();
    await handlers['build.start']({ platform: 'ios', options: { platform: 'android' } });
    assert.strictEqual(sent[0].args[0].platform, 'ios', '★ 必填的 platform 应覆盖 options');
});

test('★ build.start：shouldWait 缺省是 false（异步），描述与实现必须一致', async () => {
    const { handlers, sent } = makeCtx();
    const r = await handlers['build.start']({ platform: 'web-desktop' });
    assert.strictEqual(sent[0].args[1], false, '默认应是不等待');
    assert.strictEqual(r.shouldWait, false);
    // 显式传 true 才等
    const { handlers: h2, sent: s2 } = makeCtx();
    await h2['build.start']({ platform: 'web-desktop', shouldWait: true });
    assert.strictEqual(s2[0].args[1], true);
});

test('★ build.platforms：不能无视参数、永远只查一个平台', async () => {
    const { handlers, sent } = makeCtx();
    const r = await handlers['build.platforms']({});
    assert.ok(sent.length >= 2, `★ 不传参数时应查多个平台，实际只查了 ${sent.length} 个`);
    const platforms = sent.map((s) => s.args[0]);
    assert.ok(platforms.includes('web-desktop'));
    assert.ok(platforms.includes('android'));
    assert.ok(Array.isArray(r.platforms));
});

test('★ build.platforms：指定平台时只查那一个', async () => {
    const { handlers, sent } = makeCtx();
    await handlers['build.platforms']({ platform: 'ios' });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].args[0], 'ios');
});

test('★ build.platforms：查不到的平台要被跳过（不能整个失败）', async () => {
    const { handlers, sent } = makeCtx({
        'builder:query-platform-config': (platform) => {
            if (platform === 'android') throw new Error('该平台不可用');
            return { platform };
        },
    });
    const r = await handlers['build.platforms']({});
    assert.strictEqual(sent.length, 4, '四个平台都该试过');
    assert.ok(!r.platforms.some((p) => p.platform === 'android'), '★ 查不到的平台不该出现在结果里');
    assert.ok(r.platforms.some((p) => p.platform === 'web-desktop'));
});

test('★ asset.copy：越界路径必须被拒（同族的 move/create/save/delete 都拦）', async () => {
    const { handlers, sent } = makeCtx();
    await assert.rejects(
        () => handlers['asset.copy']({ from: '/etc/passwd', to: 'db://assets/x.png' }),
        /db:\/\/assets\//,
        '★ from 越界必须被拒'
    );
    await assert.rejects(
        () => handlers['asset.copy']({ from: 'db://assets/a.png', to: '/tmp/out.png' }),
        /db:\/\/assets\//,
        '★ to 越界必须被拒'
    );
    await assert.rejects(
        () => handlers['asset.copy']({ from: 'db://assets/../etc/passwd', to: 'db://assets/x.png' }),
        /\.\./,
        '★ 含 ".." 必须被拒'
    );
    assert.strictEqual(sent.length, 0, '★ 越界时不得发出任何消息');
});

test('★ asset.copy：合法的 db:// 路径要能正常发出去', async () => {
    const { handlers, sent } = makeCtx();
    await handlers['asset.copy']({ from: 'db://assets/a.png', to: 'db://assets/b.png' });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].message, 'copy-asset');
    assert.deepStrictEqual(sent[0].args, ['db://assets/a.png', 'db://assets/b.png']);
});

test('★ asset.copy：缺参数要报清楚缺哪个', async () => {
    const { handlers } = makeCtx();
    await assert.rejects(() => handlers['asset.copy']({}), /from|to/, '缺参数必须说清');
});

test('★ 资源类 op 越界都要被拒（逐个过一遍，不能有漏网的）', async () => {
    const { handlers, sent } = makeCtx();
    const cases = [
        ['asset.create', { url: '/etc/x', content: '{}' }],
        ['asset.save', { url: '/etc/x', content: '{}' }],
        ['asset.move', { from: '/etc/x', to: 'db://assets/y' }],
        ['asset.delete', { url: '/etc/x' }],
        ['asset.copy', { from: '/etc/x', to: 'db://assets/y' }],
    ];
    for (const [op, args] of cases) {
        sent.length = 0;
        await assert.rejects(() => handlers[op](args), /db:\/\/assets\//, `${op} 必须拒绝越界路径`);
        assert.strictEqual(sent.length, 0, `${op} 越界时不得发出任何消息`);
    }
});
