'use strict';

/**
 * 离线批量编辑（cocos_prefab_batch）的单元测试
 * ---------------------------------------------------------------------------
 * 覆盖两件之前是「坏的」的事：
 *
 *   1. {files:[...]} 多文件形态**根本进不去** ——
 *      「必须有 ops」的守卫排在 files 分支前面，多文件形态在到达它之前就被拦掉。
 *
 *   2. 多文件模式**跨文件非原子** ——
 *      之前每个文件各自「执行 + 写盘」，第 3 个文件失败时前 2 个已经写进磁盘了。
 *      调用方看到「批量失败」通常以为什么都没发生 → 工程停在半改状态，没人知道。
 *
 * 另外覆盖 hub 层那道 op 路径护栏 ——
 * 它之前读的是 res.data.ops，而返回里根本没有这个字段 → 从来没生效过。
 *
 * 运行：node --test hub/test/*.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const offline = require('../src/offline/index');
const { GLOBAL_TOOLS } = require('../src/tools/global-tools');

const ROOT_UUID = '12345678-1234-5678-1234-567812345678';

function makePrefab() {
    return [
        { __type__: 'cc.Prefab', data: { __id__: 1 }, optimizationPolicy: 0 },
        {
            __type__: 'cc.Node',
            _name: 'Root',
            _children: [{ __id__: 2 }],
            _components: [{ __id__: 3 }],
            _prefab: { __id__: 5 },
            _active: true,
            _lpos: { x: 0, y: 0, z: 0 },
        },
        {
            __type__: 'cc.Node',
            _name: 'Child',
            _children: [],
            _components: [{ __id__: 4 }],
            _prefab: { __id__: 5 },
            _active: true,
            _lpos: { x: 10, y: 20, z: 0 },
        },
        { __type__: 'cc.Label', _string: 'hello', _fontSize: 24, _enabled: true, node: { __id__: 1 } },
        { __type__: 'cc.Label', _string: 'child text', _enabled: true, node: { __id__: 2 } },
        {
            __type__: 'cc.PrefabInfo',
            root: { __id__: 1 },
            asset: { __uuid__: ROOT_UUID, __expectedType__: 'cc.Prefab' },
            fileId: 'ZmFrZS1maWxlLUlkLTEwMDAwMDAw',
        },
    ];
}

function tmpdir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-mcp-batch-'));
}

function writeJson(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/** 取 Child 上那个 Label 的文本。 */
function childLabelText(file) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const label = data.find((e) => e.__type__ === 'cc.Label' && e.node && e.node.__id__ === 2);
    return label ? label._string : null;
}

function makeOpsFile(dir, payload) {
    const p = path.join(dir, 'ops.json');
    writeJson(p, payload);
    return p;
}

/** 造一个「已注册项目」的假 ctx。 */
function fakeCtx(projectDir) {
    return {
        listEditors: () => [{ projectPath: projectDir }],
        extraRoots: [],
    };
}

function batchTool() {
    const t = GLOBAL_TOOLS.find((x) => x.name === 'cocos_prefab_batch');
    assert.ok(t, 'cocos_prefab_batch 必须存在');
    return t;
}

// ────────────────────────────── 多文件形态 ──────────────────────────────

test('★ {files:[...]} 多文件形态能跑通（之前根本进不去）', () => {
    const dir = tmpdir();
    const a = path.join(dir, 'a.prefab');
    const b = path.join(dir, 'b.prefab');
    writeJson(a, makePrefab());
    writeJson(b, makePrefab());
    const opsJson = makeOpsFile(dir, {
        files: [
            { filePath: a, ops: [{ op: 'set-label-text', node: 'Child', text: 'FILE-A' }] },
            { filePath: b, ops: [{ op: 'set-label-text', node: 'Child', text: 'FILE-B' }] },
        ],
    });
    const r = offline.batchPrefab({ opsJsonPath: opsJson, allowedRoots: [dir] });
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.data.mode, 'multi');
    assert.strictEqual(r.data.files.length, 2);
    assert.strictEqual(childLabelText(a), 'FILE-A', '★ 第 1 个文件必须真的改了');
    assert.strictEqual(childLabelText(b), 'FILE-B', '★ 第 2 个文件必须真的改了');
});

test('★ 多文件模式下第 N 个文件失败 → 磁盘零写入（跨文件原子）', () => {
    const dir = tmpdir();
    const a = path.join(dir, 'a.prefab');
    const b = path.join(dir, 'b.prefab');
    const c = path.join(dir, 'c.prefab');
    writeJson(a, makePrefab());
    writeJson(b, makePrefab());
    writeJson(c, makePrefab());
    const beforeA = fs.readFileSync(a, 'utf8');
    const beforeB = fs.readFileSync(b, 'utf8');
    const beforeC = fs.readFileSync(c, 'utf8');

    const opsJson = makeOpsFile(dir, {
        files: [
            { filePath: a, ops: [{ op: 'set-label-text', node: 'Child', text: 'OK-A' }] },
            { filePath: b, ops: [{ op: 'set-label-text', node: 'NoSuchNode', text: 'BOOM' }] },
            { filePath: c, ops: [{ op: 'set-label-text', node: 'Child', text: 'OK-C' }] },
        ],
    });
    const r = offline.batchPrefab({ opsJsonPath: opsJson, allowedRoots: [dir] });
    assert.ok(!r.ok, '第 2 个文件失败，整批必须失败');
    assert.match(r.error, /未发生任何写入/, `错误信息要说清没有写入：${r.error}`);
    // ★ 关键断言：前一个文件也不能被写
    assert.strictEqual(fs.readFileSync(a, 'utf8'), beforeA, '★ 第 1 个文件不得被写入（跨文件非原子）');
    assert.strictEqual(fs.readFileSync(b, 'utf8'), beforeB);
    assert.strictEqual(fs.readFileSync(c, 'utf8'), beforeC);
});

test('多文件模式 dryRun 不写盘', () => {
    const dir = tmpdir();
    const a = path.join(dir, 'a.prefab');
    writeJson(a, makePrefab());
    const before = fs.readFileSync(a, 'utf8');
    const opsJson = makeOpsFile(dir, {
        files: [{ filePath: a, ops: [{ op: 'set-label-text', node: 'Child', text: 'DRY' }] }],
    });
    const r = offline.batchPrefab({ opsJsonPath: opsJson, dryRun: true, allowedRoots: [dir] });
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.data.dryRun, true);
    assert.ok(r.data.files[0].wouldChange > 0, '应报告会改几处');
    assert.strictEqual(fs.readFileSync(a, 'utf8'), before, 'dryRun 不得写盘');
});

test('多文件模式里每项都缺 filePath / ops 要报错（不能静默跳过）', () => {
    const dir = tmpdir();
    const a = path.join(dir, 'a.prefab');
    writeJson(a, makePrefab());
    const before = fs.readFileSync(a, 'utf8');

    const noPath = makeOpsFile(dir, { files: [{ ops: [{ op: 'set-label-text', node: 'Child', text: 'X' }] }] });
    const r1 = offline.batchPrefab({ opsJsonPath: noPath, allowedRoots: [dir] });
    assert.ok(!r1.ok);
    assert.match(r1.error, /filePath/, r1.error);

    const noOps = makeOpsFile(dir, { files: [{ filePath: a }] });
    const r2 = offline.batchPrefab({ opsJsonPath: noOps, allowedRoots: [dir] });
    assert.ok(!r2.ok);
    assert.match(r2.error, /ops/, r2.error);

    assert.strictEqual(fs.readFileSync(a, 'utf8'), before, '失败时磁盘不得有任何写入');
});

// ────────────────────────────── hub 层的 op 路径护栏 ──────────────────────────────

test('★ hub 层 op 路径护栏：多文件模式下 op 里的路径指向项目外 → 写盘前就拒绝', async () => {
    const project = tmpdir();
    const outside = tmpdir();
    const a = path.join(project, 'a.prefab');
    writeJson(a, makePrefab());
    const before = fs.readFileSync(a, 'utf8');
    const victim = path.join(outside, 'victim.txt');

    const opsJson = makeOpsFile(project, {
        files: [
            { filePath: a, ops: [{ op: 'set-label-text', node: 'Child', text: 'X' }] },
            { filePath: a, ops: [{ op: 'ensure-meta', path: victim }] },
        ],
    });
    const tool = batchTool();
    await assert.rejects(
        () => tool.handler({ opsJsonPath: opsJson }, fakeCtx(project)),
        // ★ 断言 **hub 层** 的报错格式（离线层的长相不一样：
        //   离线层是 "ensure-meta.path ... 不在允许的目录范围内"，
        //   hub 层是 "op 内路径（ensure-meta.path）... 不在任何一个已注册的 ..."）。
        //   不写死这一层，这道护栏就算被删掉测试也照样绿 —— 那就又成了死代码。
        /op 内路径（ensure-meta\.path）/,
        '★ 项目外的 op 路径必须被拒绝'
    );
    assert.strictEqual(fs.readFileSync(a, 'utf8'), before, '★ 被拒绝时不得有任何写入');
    assert.ok(!fs.existsSync(victim), '★ 项目外不得产生文件');
});

test('★ hub 层 op 路径护栏：单文件模式同样生效（之前是死代码）', async () => {
    const project = tmpdir();
    const outside = tmpdir();
    const a = path.join(project, 'a.prefab');
    writeJson(a, makePrefab());
    const before = fs.readFileSync(a, 'utf8');
    const victim = path.join(outside, 'victim.txt');

    const opsJson = makeOpsFile(project, {
        filePath: a,
        ops: [{ op: 'ensure-meta', path: victim }],
    });
    const tool = batchTool();
    await assert.rejects(
        () => tool.handler({ opsJsonPath: opsJson }, fakeCtx(project)),
        /op 内路径（ensure-meta\.path）/,
        '★ 项目外的 op 路径必须被拒绝'
    );
    assert.strictEqual(fs.readFileSync(a, 'utf8'), before, '★ 被拒绝时不得有任何写入');
    assert.ok(!fs.existsSync(victim), '★ 项目外不得产生文件');
});

test('★ hub 层 op 路径护栏：项目内的 op 路径正常放行', async () => {
    const project = tmpdir();
    const a = path.join(project, 'a.prefab');
    writeJson(a, makePrefab());
    const tex = path.join(project, 'tex.png');
    fs.writeFileSync(tex, 'x');

    const opsJson = makeOpsFile(project, {
        filePath: a,
        ops: [{ op: 'ensure-meta', path: tex }],
    });
    const tool = batchTool();
    const res = await tool.handler({ opsJsonPath: opsJson }, fakeCtx(project));
    assert.ok(res, '项目内的路径必须放行');
    assert.ok(fs.existsSync(`${tex}.meta`), '应生成 .meta');
});
