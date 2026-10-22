'use strict';

/**
 * op 路径白名单的**结构性一致性**测试
 * ---------------------------------------------------------------------------
 * `OP_PATH_FIELDS` 是一份**手工维护的白名单**：
 *   - hub 层用它决定哪些 op 的路径字段要过目录护栏；
 *   - 离线层在每个 op 的处理函数里单独调 assertOpPathAllowed。
 *
 * 两层**各自独立**，必须同步改。新增一个带路径字段的 op 却忘了加进白名单，
 * 就会复现本轮修掉的那种病：**「看着有、其实没有」的护栏** ——
 * 代码里有护栏、注释也写着有，但实际从来没生效。
 *
 * 所以这里用两条自动断言把「漏项」变成会自己变红的东西：
 *   1. OP_DEFS 里所有「看起来像路径」的字段，必须都出现在 OP_PATH_FIELDS 里；
 *   2. OP_PATH_FIELDS 里不能有 OP_DEFS 中不存在的项（拼错的名字 = 护栏空转）。
 *
 * ⚠️ 不用解析源码文本做断言（那条路有实测过的静默失效）——
 *    这里全部走 require 求值 + 结构比对。
 *
 * 运行：node --test hub/test/*.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { OP_DEFS, NOT_PATH_FIELDS } = require('../src/offline/ops');
const { ANIM_OP_DEFS } = require('../src/offline/anim');
const offline = require('../src/offline/index');
const { GLOBAL_TOOLS, OP_PATH_FIELDS } = require('../src/tools/global-tools');

/** 字段名里带这些词，就当作「路径类字段」。 */
// ⚠️ 正则要覆盖将来可能出现的路径类字段名 ——
//    命中不了的靠「二选一」也兜不住（那只会强制表态，不会自动拦）。
const PATHISH = /path|file|url|dir|prefab|asset|folder|uri/i;

function tmpdir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-mcp-opfields-'));
}

/** 最小可用的 prefab（一个根节点 + 一个子节点）。 */
function makePrefab() {
    return [
        { __type__: 'cc.Prefab', data: { __id__: 1 }, optimizationPolicy: 0 },
        {
            __type__: 'cc.Node',
            _name: 'Root',
            _children: [{ __id__: 2 }],
            _components: [],
            _prefab: { __id__: 3 },
            _active: true,
            _lpos: { x: 0, y: 0, z: 0 },
        },
        {
            __type__: 'cc.Node',
            _name: 'Child',
            _children: [],
            _components: [],
            _prefab: { __id__: 3 },
            _active: true,
            _lpos: { x: 0, y: 0, z: 0 },
        },
        {
            __type__: 'cc.PrefabInfo',
            root: { __id__: 1 },
            asset: { __uuid__: '12345678-1234-5678-1234-567812345678', __expectedType__: 'cc.Prefab' },
            fileId: 'ZmFrZS1maWxlLUlkLTEwMDAwMDAw',
        },
    ];
}

function writeJson(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function fakeCtx(projectDir) {
    return {
        listEditors: () => [{ projectPath: projectDir }],
        extraRoots: [],
    };
}

/** OP_DEFS + ANIM_OP_DEFS 里**所有**字段（op.field 形式）。 */
function allDefFields() {
    const out = [];
    for (const [op, def] of Object.entries(OP_DEFS)) {
        for (const f of [...(def.required || []), ...(def.optional || [])]) out.push(`${op}.${f}`);
    }
    for (const [op, def] of Object.entries(ANIM_OP_DEFS)) {
        for (const f of [...(def.required || []), ...(def.optional || [])]) out.push(`${op}.${f}`);
    }
    return out;
}

/** OP_DEFS 里所有路径类字段（op.field 形式）。 */
function pathishFields() {
    const out = [];
    for (const [opName, def] of Object.entries(OP_DEFS)) {
        for (const field of [...(def.required || []), ...(def.optional || [])]) {
            if (PATHISH.test(field)) out.push(`${opName}.${field}`);
        }
    }
    for (const [opName, def] of Object.entries(ANIM_OP_DEFS)) {
        for (const field of [...(def.required || []), ...(def.optional || [])]) {
            if (PATHISH.test(field)) out.push(`${opName}.${field}`);
        }
    }
    return out;
}

test('★ 「看起来像路径」的字段必须**显式表态**：要么进路径表，要么进「明确不是路径」表', () => {
    // ⚠️ 这一条治的是「新增一个带 `prefab` / `asset` 这类字段的 op，
    //    忘了加进白名单 → 护栏对新 op 静默失效」——
    //    靠字段名正则自动推导是**兜不住**的（正则命中不了的名字就是命中不了）。
    //    ⇒ 改成**二选一**：不在路径表里，就必须进 NOT_PATH_FIELDS 并写明理由。
    //    新增 op 时测试会逼着人做一次表态。
    const pathish = pathishFields();
    const listed = new Set(OP_PATH_FIELDS.map((r) => `${r.op}.${r.field}`));
    const notPath = new Set(Object.keys(NOT_PATH_FIELDS));
    for (const key of pathish) {
        assert.ok(
            listed.has(key) || notPath.has(key),
            `"${key}" 既不在 OP_PATH_FIELDS（要过目录护栏），也不在 NOT_PATH_FIELDS（要写明为什么不是路径）` +
            ' —— 新增带这类字段的 op 时必须显式表态，否则护栏会静默失效。'
        );
    }
    // 反向：两张表里都不能有 OP_DEFS 中不存在的项 ——
    // 拼错的 op 名/字段名会让规则**空转**（看起来在守，实际什么都没守）。
    const allDefs = new Set([...pathishFields(), ...allDefFields()]);
    for (const key of listed) {
        assert.ok(allDefs.has(key), `OP_PATH_FIELDS 里的 "${key}" 在 OP_DEFS 里不存在 —— 白名单拼错了。`);
    }
    for (const key of notPath) {
        assert.ok(allDefs.has(key), `NOT_PATH_FIELDS 里的 "${key}" 在 OP_DEFS 里不存在 —— 这条注释已过时。`);
    }
    // NOT_PATH_FIELDS 每条都要写明理由（空理由等于没表态）
    for (const [key, why] of Object.entries(NOT_PATH_FIELDS)) {
        assert.ok(typeof why === 'string' && why.trim().length > 0, `NOT_PATH_FIELDS["${key}"] 必须写明理由`);
    }
});

test('★ 白名单里的每个 op，路径字段都必须真的被拒（不是只有名字对）', async () => {
    // 每个 op 造一个「最小可用」参数集，路径字段一律指向项目外。
    // ⚠️ 必须带 `op` 字段 —— 护栏是按 `op.op` 匹配的，
    //    漏了它就会「看起来在测、其实整条规则被跳过」。
    const project = tmpdir();
    const outside = tmpdir();
    const victim = path.join(outside, 'victim');
    const base = {
        'ensure-meta': { op: 'ensure-meta', path: victim },
        'add-nested-prefab': { op: 'add-nested-prefab', parent: 'Root', prefabUuid: 'x', prefabPath: victim },
        'replace-nested-prefab': { op: 'replace-nested-prefab', node: 'Root', prefabUuid: 'x', prefabPath: victim },
    };

    const tool = GLOBAL_TOOLS.find((t) => t.name === 'cocos_prefab_edit');
    assert.ok(tool, 'cocos_prefab_edit 必须存在');

    for (const rule of OP_PATH_FIELDS) {
        const op = base[rule.op];
        assert.ok(op, `测试数据缺了 op "${rule.op}" 的参数构造`);
        assert.ok(!fs.existsSync(victim), '受害文件不该存在');
        let threw = null;
        try {
            await tool.handler({ filePath: path.join(project, 'a.prefab'), ops: [op] }, fakeCtx(project));
        } catch (e) {
            threw = e.message;
        }
        assert.ok(
            threw && /op 内路径/.test(threw),
            `${rule.op}.${rule.field} 指向项目外时必须被拒绝，实际：${threw || '（没报错！）'}`
        );
        assert.ok(!fs.existsSync(victim), `${rule.op}.${rule.field} 越界时不得产生任何文件`);
    }
});

test('★ 离线层**自己**也要拦住越界的 op 路径（不能只靠 hub 那层兜着）', () => {
    // ⚠️ 这一条守的是**第二层** ——
    //    hub 层也有一道同样的检查，但离线模块是「独立可复用的单元」，
    //    不假设调用方一定检查过（它自己的注释就是这么写的）。
    //    只测 hub 层的话，把离线层那三个 assertOpPathAllowed 调用点删掉，
    //    所有用例照样全绿 —— 第 7 轮复审实测过这个缺口。
    const project = tmpdir();
    const outside = tmpdir();
    const prefab = path.join(project, 'a.prefab');
    writeJson(prefab, makePrefab());
    const victim = path.join(outside, 'victim.ts');

    // 直接调**离线层**（完全不经过 hub）
    const r = offline.editPrefab({
        filePath: prefab,
        allowedRoots: [project],
        ops: [{ op: 'ensure-meta', path: victim }],
    });
    assert.ok(!r.ok, '★ 离线层必须自己拦住越界的 op 路径');
    assert.match(r.error, /不在允许的目录范围/, r.error);
    assert.ok(!fs.existsSync(victim), '★ 越界时不得产生任何文件');
});

test('★ 守卫是**表驱动**的：表里加一条规则，护栏自动生效（不用改任何 op 代码）', () => {
    // ⚠️ 这一条守的是「新增 op 时忘了写守卫调用」这个病 ——
    //    之前每个 op 在自己的处理函数里手写一行 assertOpPathAllowed，
    //    忘了写 → 那道护栏静默失效（看着有、其实没有）。
    //    现在改成由表驱动：**新增 op 只要在 OP_PATH_FIELDS 里加一行**。
    const { OP_PATH_FIELDS } = require('../src/offline/ops');
    const project = tmpdir();
    const outside = tmpdir();
    const prefab = path.join(project, 'a.prefab');
    writeJson(prefab, makePrefab());
    const victim = path.join(outside, 'victim.txt');

    // 假装新增了一个 op 的路径字段（这里借 set-label-text 的 text 顶一下）
    OP_PATH_FIELDS.push({ op: 'set-label-text', field: 'text' });
    try {
        const r = offline.editPrefab({
            filePath: prefab,
            allowedRoots: [project],
            ops: [{ op: 'set-label-text', node: 'Child', text: victim }],
        });
        assert.ok(!r.ok, '★ 表里加一条规则后，护栏必须自动生效');
        assert.match(r.error, /不在允许的目录范围/, r.error);
        assert.ok(!fs.existsSync(victim), '★ 越界时不得产生任何文件');
    } finally {
        OP_PATH_FIELDS.pop(); // 还原，别影响别的用例
    }
});

test('★ anim 执行器也走同一张表（将来新增带文件路径的 anim op 时护栏自动生效）', () => {
    const { OP_PATH_FIELDS } = require('../src/offline/ops');
    const project = tmpdir();
    const outside = tmpdir();
    const anim = path.join(project, 'a.anim');
    // ⚠️ 夹具就地造 —— 不要 require 别的测试文件：
    //    那样会把那个文件的**全部用例**注册到本文件里（测试互相污染）。
    writeJson(anim, [
        { __type__: 'cc.AnimationClip', _name: 'idle', duration: 2, sample: 60, tracks: [{ __id__: 1 }] },
        { __type__: 'cc.animation.RealTrack', path: 'Root/Child', _channel: { __id__: 2 } },
        {
            __type__: 'cc.RealCurve',
            data: [
                { __type__: 'cc.RealKeyframeValue', value: 0, time: 0 },
                { __type__: 'cc.RealKeyframeValue', value: 100, time: 1 },
            ],
        },
    ]);
    const victim = path.join(outside, 'victim.txt');

    OP_PATH_FIELDS.push({ op: 'offset-curve', field: 'path' });
    try {
        const r = offline.editAnimation({
            filePath: anim,
            allowedRoots: [project],
            ops: [{ op: 'offset-curve', path: victim, offset: 5 }],
        });
        assert.ok(!r.ok, '★ anim 侧也必须按表拦住');
        assert.match(r.error, /不在允许的目录范围/, r.error);
    } finally {
        OP_PATH_FIELDS.pop();
    }
});
