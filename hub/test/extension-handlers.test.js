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

const { createHandlers, ASSET_PATH_FIELDS, NOT_ASSET_PATH_FIELDS } = require('../../extension/bridge/handlers');
const { EDITOR_TOOLS } = require('../src/tools/editor-tools');
const { fieldsOfSchema } = require('../src/util/path-fields');

/**
 * 「带路径字段的扩展端 op」—— **从 hub 侧工具表结构化推导**。
 *
 * ⚠️ 为什么只取带 `op` 字段的工具：
 *    工具表里分两类 —— 带 `op` 的是**扩展端 op**（真的会调引擎），
 *    带 `handler` 的是 **hub 侧合成工具**（自己不动引擎，转手调扩展端 op）。
 *    后者的路径参数最终会流到扩展端 op，由那边的护栏接管，
 *    在这一层再单独立一份口径 = 两份真相。
 *
 * ⚠️ 判定口径来自**共享模块** `hub/src/util/path-fields`（全仓库唯一一份）：
 *    这里曾经自己写了一套「精确匹配 9 个词」的**窄**口径，
 *    与离线层的「子串匹配」宽口径漂移 ——
 *    结果 `srcPath` / `paths` 这类字段**根本进不了推导范围**，
 *    护栏对它们**静默不存在**，而全套测试一片绿
 *    （第 11 轮复审 H-1 实测：越界路径原样直达引擎）。
 *    ⇒ 「什么算路径」只能有一份。
 */
function pathishFieldsByOp() {
    const map = new Map();
    for (const t of EDITOR_TOOLS) {
        if (!t.op) continue;
        const { pathish } = fieldsOfSchema(t.inputSchema);
        if (pathish.length) map.set(t.op, pathish);
    }
    return map;
}

/**
 * 每个扩展端 op 的**全部**字符串类字段（含数组）。
 *
 * ⚠️ 用途是**反向核对**：两张表里的每一项都必须指向一个**真实存在**的字段，
 *    否则就是拼错了名字 → 护栏永远不会被触发 = 空转。
 *    （这里刻意用「全部字符串字段」而不是「路径字段」——
 *      豁免表里可以显式声明一个**不是**路径词的字段，
 *      比如 `asset.query.pattern`（查询通配符），
 *      让「它是有意豁免的」变成显式表态，而不是压根没人看见。）
 */
function stringFieldsByOp() {
    const map = new Map();
    for (const t of EDITOR_TOOLS) {
        if (!t.op) continue;
        map.set(t.op, fieldsOfSchema(t.inputSchema).strings);
    }
    return map;
}

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

test('★ 资源类 op 越界都要被拒（**从表推导**，不能有漏网的）', async () => {
    // ⚠️ 第 10 轮复审 G-7：这份用例原来是一份**手写枚举**（写死 5 条），
    //    标题却写着「不能有漏网的」——
    //    将来加一个带路径字段的 op（例：asset.rename）→ 不在表里 → 这条断言照样绿。
    //    而它**当时就已经漏了一个**：asset.isImported 同样过 requireAssetUrl，却没被写进去。
    //
    // ⇒ 改成从 **ASSET_PATH_FIELDS 表**推导（require 求值，不扫源码）。
    //    表是护栏的唯一真相（扩展端由它自动施加护栏），
    //    这里再从表出发**逐条真的打一遍**，证明「表说有护栏 = 真的有护栏」。
    const { handlers, sent } = makeCtx();
    const cases = [];
    for (const [op, fields] of Object.entries(ASSET_PATH_FIELDS)) {
        for (const f of fields) {
            cases.push([op, f, { [f]: '/etc/x' }]);
        }
    }
    assert.ok(cases.length >= 8, `★ 表里只有 ${cases.length} 条，护栏覆盖 suspiciously 少`);
    for (const [op, field, args] of cases) {
        sent.length = 0;
        await assert.rejects(
            () => handlers[op](args),
            /db:\/\/assets\//,
            `★ ${op}.${field} 必须拒绝越界路径`
        );
        assert.strictEqual(sent.length, 0, `${op}.${field} 越界时不得发出任何消息`);
    }
});

test('★ 两张表必须覆盖所有「带路径字段的扩展端 op」（漏表态就红）', () => {
    // ⚠️ 判据必须来自**源头**（hub 侧工具表声明的参数），
    //    不能是手写的一份 op 名单 —— 否则新加 op 时两张表会一起漏。
    //
    //    口径：
    //      · 只看**扩展端 op**（工具表里带 op 字段的）——
    //        hub 侧合成的工具（如 scene.create）不直接碰引擎，
    //        它们转手调用的扩展端 op 才在口径里；
    //      · 「路径字段」= 参数名像路径（url/from/to/path/…）且类型是 string。
    const declared = new Map();
    for (const [op, fields] of Object.entries(ASSET_PATH_FIELDS)) {
        for (const f of fields) {
            const key = `${op}.${f}`;
            assert.ok(!declared.has(key), `★ ${key} 重复表态`);
            declared.set(key, 'need');
        }
    }
    for (const key of Object.keys(NOT_ASSET_PATH_FIELDS)) {
        assert.ok(!declared.has(key), `★ ${key} 同时出现在两张表里（要护栏就别在豁免表里）`);
        assert.ok(
            String(NOT_ASSET_PATH_FIELDS[key]).trim().length >= 4,
            `★ ${key} 的豁免理由太短 —— 必须写清为什么不需要护栏`
        );
        declared.set(key, 'skip');
    }

    // ① 正向：每个带路径字段的扩展端 op 都必须**表态**
    for (const [op, fields] of pathishFieldsByOp()) {
        for (const f of fields) {
            assert.ok(
                declared.has(`${op}.${f}`),
                `★ ${op}.${f} 带路径字段，但两张表里都没表态：` +
                '要护栏就进 ASSET_PATH_FIELDS，不要就进 NOT_ASSET_PATH_FIELDS 并写明理由'
            );
        }
    }

    // ② 反向：两张表里的每一项都必须真的存在于工具表里
    //    （拼错的名字 = 护栏永远不会被触发 = 空转）
    const real = stringFieldsByOp();
    for (const key of declared.keys()) {
        const dot = key.lastIndexOf('.');
        const op = key.slice(0, dot);
        const field = key.slice(dot + 1);
        assert.ok(real.has(op), `★ ${key} 的 op "${op}" 不在工具表里（拼错了？）`);
        assert.ok(
            (real.get(op) || []).includes(field),
            `★ ${key} 的字段 "${field}" 不是 ${op} 的字符串类字段（拼错了？）`
        );
    }
});

test('★ 护栏**由表自动施加**（不是每个 handler 自己记得写）', async () => {
    // ⚠️ 这一条守住「表驱动」这个机制本身：
    //    如果哪天有人改回「每个 handler 手写一行 requireAssetUrl」，
    //    护栏会立刻从「自动」变成「靠人记得」——
    //    而上面那条用例是**看不出**这个差别的（表还在、护栏也还在）。
    //
    //    做法：把**表里的一个 op 换掉**（塞一个不存在的字段名），
    //    护栏就**不再施加**到它身上 ⇒ 那条 op 的越界路径会漏过去。
    //    ⇒ 这能证明「护栏确实是从表来的」。
    const sent = [];
    const ctx = {
        projectPath: '/tmp/proj',
        msg(channel, message, ...args) {
            sent.push({ channel, message, args });
            return Promise.resolve({});
        },
    };
    const saved = ASSET_PATH_FIELDS['asset.copy'];
    try {
        ASSET_PATH_FIELDS['asset.copy'] = ['__nonexistent_field__'];
        const h2 = createHandlers(ctx);
        sent.length = 0;
        await h2['asset.copy']({ from: '/etc/x', to: 'db://assets/y' });
        assert.strictEqual(sent.length, 1, '★ 表里换掉字段名后，护栏就不该再拦这个 op（说明护栏确实来自表）');
        assert.strictEqual(sent[0].message, 'copy-asset');
    } finally {
        ASSET_PATH_FIELDS['asset.copy'] = saved;
    }
    // 还原后护栏必须恢复
    const h3 = createHandlers(ctx);
    await assert.rejects(
        () => h3['asset.copy']({ from: '/etc/x', to: 'db://assets/y' }),
        /db:\/\/assets\//,
        '★ 表还原后护栏必须恢复'
    );
});
