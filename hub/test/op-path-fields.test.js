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

const { OP_DEFS } = require('../src/offline/ops');
const offline = require('../src/offline/index');
const { GLOBAL_TOOLS, OP_PATH_FIELDS } = require('../src/tools/global-tools');

/** 字段名里带这些词，就当作「路径类字段」。 */
const PATHISH = /path|file|url|dir/i;

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

/** OP_DEFS 里所有路径类字段（op.field 形式）。 */
function pathishFields() {
    const out = [];
    for (const [opName, def] of Object.entries(OP_DEFS)) {
        for (const field of [...(def.required || []), ...(def.optional || [])]) {
            if (PATHISH.test(field)) out.push(`${opName}.${field}`);
        }
    }
    return out;
}

test('★ OP_PATH_FIELDS 必须覆盖 OP_DEFS 里所有路径类字段（漏了就复现「看着有、其实没有」）', () => {
    const pathish = pathishFields();
    const listed = new Set(OP_PATH_FIELDS.map((r) => `${r.op}.${r.field}`));
    for (const key of pathish) {
        assert.ok(
            listed.has(key),
            `OP_PATH_FIELDS 漏了 "${key}" —— 新增带路径字段的 op 时必须同时加进白名单，` +
            '否则那道护栏对新 op 完全不生效（且没有任何报错）。'
        );
    }
    // 反向：白名单里不能有 OP_DEFS 中不存在的项 ——
    // 拼错的 op 名/字段名会让白名单**空转**（看起来在守，实际什么都没守）。
    for (const key of listed) {
        assert.ok(
            pathish.includes(key),
            `OP_PATH_FIELDS 里的 "${key}" 在 OP_DEFS 里不存在 —— 白名单拼错了，那条规则永远不会命中。`
        );
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
