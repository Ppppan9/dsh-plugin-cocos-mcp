'use strict';

/**
 * 离线 prefab / animation 编辑器测试
 * 运行：node --test hub/src/offline/test/
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const offline = require('../index');
const { compressUUID, decompressUUID, isCompressedUUID, deterministicFileId, deterministicUuid } = require('../id');

// ────────────────────────────── fixture ──────────────────────────────

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
        // Child 的 Label 带 node 回指 —— Cocos 的组件序列化就是这个形态，
        // 克隆时必须重映射到克隆节点（否则组件会归属到源节点）
        { __type__: 'cc.Label', _string: 'child text', _enabled: true, node: { __id__: 2 } },
        {
            __type__: 'cc.PrefabInfo',
            root: { __id__: 1 },
            asset: { __uuid__: ROOT_UUID, __expectedType__: 'cc.Prefab' },
            fileId: 'ZmFrZS1maWxlLUlkLTEwMDAwMDAw',
        },
    ];
}

function makeStubPrefab() {
    // 结构（对齐 Cocos 真实格式）：
    //   0 cc.Prefab            → 根 = 1
    //   1 cc.Node "Host"       → _prefab = 3 (自己的 PrefabInfo)
    //   2 cc.Node (stub)       → _prefab = 6 (stub 自己的 PrefabInfo)
    //   3 cc.PrefabInfo (root) → 无 instance
    //   4 cc.PrefabInstance    → propertyOverrides = [5]
    //   5 cc.PropertyOverrideInfo (_name = RealNestedName)
    //   6 cc.PrefabInfo (stub) → instance = 4
    //   7 cc.TargetInfo
    return [
        { __type__: 'cc.Prefab', data: { __id__: 1 }, optimizationPolicy: 0 },
        {
            __type__: 'cc.Node',
            _name: 'Host',
            _children: [{ __id__: 2 }],
            _components: [],
            _prefab: { __id__: 3 },
            _active: true,
            _lpos: { x: 0, y: 0, z: 0 },
        },
        {
            // stub 节点：_name 不存在，真实名字在 PrefabInstance 的 _name override 里
            __type__: 'cc.Node',
            _children: [],
            _components: [],
            _prefab: { __id__: 6 },
            _active: true,
            _lpos: { x: 0, y: 0, z: 0 },
        },
        {
            __type__: 'cc.PrefabInfo',
            root: { __id__: 1 },
            fileId: 'aG9zdC1maWxlLUlkLUExMDEyMzQ1Njc4',
            targetOverrides: [],
        },
        {
            __type__: 'cc.PrefabInstance',
            fileId: 'c3R1Yi1maWxlLUlkLUExMDEyMzQ1Njc4',
            asset: { __uuid__: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', __expectedType__: 'cc.Prefab' },
            propertyOverrides: [{ __id__: 5 }],
        },
        {
            __type__: 'cc.PropertyOverrideInfo',
            targetInfo: { __id__: 7 },
            propertyPath: ['_name'],
            value: 'RealNestedName',
        },
        {
            __type__: 'cc.PrefabInfo',
            instance: { __id__: 4 },
            fileId: 'c3R1Yi1maWxlLUlkLUExMDEyMzQ1Njc4',
            targetOverrides: [],
        },
        { __type__: 'cc.TargetInfo', localID: ['c3R1Yi1maWxlLUlkLUExMDEyMzQ1Njc4'] },
    ];
}

/**
 * 真实 Cocos 3.8 的 .anim 形态：
 *   - cc.animation.RealTrack 的 _channel 是**引用** {"__id__": N}
 *   - 曲线元素是 cc.RealCurve，data 是**内联数组**的关键帧
 *   - path 在 track 元素上
 */
function makeRealAnim() {
    return [
        { __type__: 'cc.AnimationClip', _name: 'idle', duration: 2, sample: 60, tracks: [{ __id__: 1 }] },
        { __type__: 'cc.animation.RealTrack', path: 'Root/Child', _channel: { __id__: 2 } },
        {
            __type__: 'cc.RealCurve',
            data: [
                { __type__: 'cc.RealKeyframeValue', value: 0, time: 0 },
                { __type__: 'cc.RealKeyframeValue', value: 100, time: 1 },
            ],
        },
    ];
}

function makeAnim() {
    // Cocos 真实 .anim 形态：clip.tracks 指向 cc.CurveChannel 元素，
    // channel 元素自带 path 与 curve。
    return [
        {
            __type__: 'cc.AnimationClip',
            _name: 'idle',
            duration: 2,
            sample: 60,
            tracks: [{ __id__: 1 }],
        },
        {
            __type__: 'cc.CurveChannel',
            path: 'Root/Child',
            curve: { __id__: 2 },
        },
        {
            __type__: 'cc.Curve',
            data: {
                paths: [
                    { keyframeIndex: 0, key: { time: 0, value: 0 } },
                    { keyframeIndex: 1, key: { time: 1, value: 100 } },
                ],
            },
        },
    ];
}

function tmpdir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-mcp-offline-'));
}

function writeJson(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// ────────────────────────────── classId / fileId ──────────────────────────────

test('compressUUID 产生 23 字符且可解压还原', () => {
    const c = compressUUID(ROOT_UUID);
    assert.strictEqual(c.length, 23, `期望 23 字符，实际 ${c.length}`);
    assert.ok(isCompressedUUID(c));
    assert.strictEqual(decompressUUID(c), ROOT_UUID, 'round-trip 必须完全一致');
});

test('compressUUID 对非 36 位输入原样返回', () => {
    assert.strictEqual(compressUUID('cc.Label'), 'cc.Label');
    assert.strictEqual(compressUUID(''), '');
});

test('deterministicFileId 相同 seed 结果一致且长度正确', () => {
    const a = deterministicFileId('seed-1');
    const b = deterministicFileId('seed-1');
    const c = deterministicFileId('seed-2');
    assert.strictEqual(a, b, '同样 seed 必须得到同样 fileId');
    assert.notStrictEqual(a, c, '不同 seed 必须得到不同 fileId');
    assert.strictEqual(Buffer.from(a, 'base64').length, 16, 'fileId 应为 16 字节');
});

test('deterministicUuid 稳定', () => {
    assert.strictEqual(deterministicUuid('x'), deterministicUuid('x'));
    assert.match(deterministicUuid('x'), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

// ────────────────────────────── 查询 ──────────────────────────────

test('queryPrefab tree 列出节点树', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.prefab');
    writeJson(f, makePrefab());
    const r = offline.queryPrefab({ filePath: f, selector: 'tree' });
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.data.count, 2);
    assert.strictEqual(r.data.root, 'Root');
    const child = r.data.nodes.find((n) => n.name === 'Child');
    assert.strictEqual(child.path, 'Root/Child');
    assert.deepStrictEqual(child.components, ['cc.Label']);
});

test('queryPrefab node 返回属性与组件', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.prefab');
    writeJson(f, makePrefab());
    const r = offline.queryPrefab({ filePath: f, selector: 'node', target: 'Child' });
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.data.node.name, 'Child');
    assert.strictEqual(r.data.properties._lpos.y, 20);
    assert.deepStrictEqual(r.data.overrides, []);
});

test('queryPrefab 识别 stub 节点并给出真实名字', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'stub.prefab');
    writeJson(f, makeStubPrefab());
    const r = offline.queryPrefab({ filePath: f, selector: 'tree' });
    assert.ok(r.ok, r.error);
    const stub = r.data.nodes.find((n) => n.isStub);
    assert.ok(stub, '应识别出 stub 节点');
    assert.strictEqual(stub.name, 'RealNestedName', 'stub 的真实名应来自 override');
});

test('queryPrefab overrides 返回嵌套 prefab 的 override 列表', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'stub.prefab');
    writeJson(f, makeStubPrefab());
    const r = offline.queryPrefab({ filePath: f, selector: 'overrides', target: 'RealNestedName' });
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.data.isStub, true);
    assert.strictEqual(r.data.overrides.length, 1);
    assert.deepStrictEqual(r.data.overrides[0].propertyPath, ['_name']);
});

test('queryPrefab 未知 selector 给出可用值提示', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.prefab');
    writeJson(f, makePrefab());
    const r = offline.queryPrefab({ filePath: f, selector: 'nope' });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /tree \/ node \/ find \/ field \/ overrides/);
});

test('queryPrefab 文件不存在时返回错误而非抛异常', () => {
    const r = offline.queryPrefab({ filePath: '/no/such/file.prefab', selector: 'tree' });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /不存在/);
});

// ────────────────────────────── 编辑 ──────────────────────────────

test('editPrefab 修改文本并落盘', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.prefab');
    writeJson(f, makePrefab());
    const r = offline.editPrefab({ filePath: f, ops: [{ op: 'set-label-text', node: 'Child', text: 'new text' }] });
    assert.ok(r.ok, r.error);
    assert.ok(r.data.changed > 0);
    const after = JSON.parse(fs.readFileSync(f, 'utf8'));
    const label = after.find((e) => e.__type__ === 'cc.Label' && e._string === 'new text');
    assert.ok(label, '磁盘文件应包含新文本');
});

test('editPrefab 零效果 op **完全不写盘**（不重写文件、不动 mtime）', () => {
    // ⚠️ 写盘不只是「多一次 I/O」：它走「写临时文件 → rename 覆盖」，
    //    期间原文件是**被替换过**的（进程此刻被杀就可能留下残file），
    //    而且 mtime 变了会让编辑器/构建系统以为资源变了。
    //    零效果的 op（比如把名字改成它本来的名字）应该什么都不做。
    const dir = tmpdir();
    const f = path.join(dir, 'a.prefab');
    writeJson(f, makePrefab());
    const before = fs.readFileSync(f, 'utf8');
    // ⚠️ 先把 mtime 拨到过去（这样「写盘前后」的差异一眼能看出来），再取基准值
    const past = new Date(Date.now() - 5000);
    fs.utimesSync(f, past, past);
    const mtime0 = fs.statSync(f).mtimeMs;

    // 'child text' 就是夹具里的原值 → 零效果
    const r = offline.editPrefab({ filePath: f, ops: [{ op: 'set-label-text', node: 'Child', text: 'child text' }] });
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.data.changed, 0, '零效果 op 的 changed 应为 0');
    assert.deepStrictEqual(r.data.written, [], '零效果 op 不该写任何文件');
    assert.strictEqual(fs.readFileSync(f, 'utf8'), before, '内容必须不变');
    assert.strictEqual(fs.statSync(f).mtimeMs, mtime0, 'mtime 不该变（= 真的没写盘）');
    assert.strictEqual(r.data.noop, true, '应标记为 noop');
});

test('editPrefab dryRun 不写盘', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.prefab');
    writeJson(f, makePrefab());
    const before = fs.readFileSync(f, 'utf8');
    const r = offline.editPrefab({ filePath: f, ops: [{ op: 'set-label-text', node: 'Child', text: 'x' }], dryRun: true });
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.data.dryRun, true);
    assert.ok(r.data.wouldChange > 0);
    assert.strictEqual(fs.readFileSync(f, 'utf8'), before, 'dryRun 后磁盘必须字节不变');
});

test('★ 事务原子性：任一 op 失败 → 磁盘字节完全不变', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.prefab');
    writeJson(f, makePrefab());
    const before = fs.readFileSync(f, 'utf8');
    const r = offline.editPrefab({
        filePath: f,
        ops: [
            { op: 'set-label-text', node: 'Child', text: 'should not persist' },
            { op: 'set-component-field', node: 'Child', component: 'cc.Label', property: '_fontSize', value: 99 },
            { op: 'set-component-field', node: 'NoSuchNode', component: 'cc.Label', property: '_fontSize', value: 1 },
        ],
    });
    assert.strictEqual(r.ok, false, '应失败');
    assert.strictEqual(fs.readFileSync(f, 'utf8'), before, '★ 失败后磁盘必须字节不变');
});

test('★ 事务原子性：失败时 ensure-meta 也不留残留', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.prefab');
    const scriptPath = path.join(dir, 'MyScript.ts');
    fs.writeFileSync(scriptPath, 'export class MyScript {}', 'utf8');
    writeJson(f, makePrefab());
    const metaPath = `${scriptPath}.meta`;
    assert.ok(!fs.existsSync(metaPath), '前置条件：.meta 不应存在');

    const r = offline.editPrefab({
        filePath: f,
        ops: [
            { op: 'ensure-meta', path: scriptPath },
            { op: 'set-component-field', node: 'NoSuchNode', component: 'cc.Label', property: 'x', value: 1 },
        ],
    });
    assert.strictEqual(r.ok, false);
    assert.ok(!fs.existsSync(metaPath), '★ 失败后 .meta 不应残留');
});

test('op 校验一次性报齐所有错误', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.prefab');
    writeJson(f, makePrefab());
    const r = offline.editPrefab({
        filePath: f,
        ops: [
            { op: 'set-position', node: 'Child' },
            { op: 'not-a-real-op', x: 1 },
            { op: 'set-active', node: 'Child', active: true, bogusField: 2 },
        ],
    });
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('缺少必填参数'), '应报告缺必填');
    assert.ok(r.error.includes('不存在'), '应报告未知 op');
    assert.ok(r.error.includes('未知参数'), '应报告多余参数');
    assert.ok(r.error.split('\n').length >= 4, '应一次性报齐多条');
});

test('未知 op 给出拼写建议', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.prefab');
    writeJson(f, makePrefab());
    const r = offline.editPrefab({ filePath: f, ops: [{ op: 'set-positon', node: 'Child', x: 1, y: 2 }] });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /set-position/, '应给出最接近的候选');
});

test('set-position / adjust-position 正确写入 _lpos', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.prefab');
    writeJson(f, makePrefab());
    const r = offline.editPrefab({
        filePath: f,
        ops: [
            { op: 'set-position', node: 'Child', x: 100, y: 200, z: 5 },
            { op: 'adjust-position', node: 'Child', dx: -10, dy: -20 },
        ],
    });
    assert.ok(r.ok, r.error);
    const after = JSON.parse(fs.readFileSync(f, 'utf8'));
    const child = after.find((e) => e.__type__ === 'cc.Node' && e._name === 'Child');
    assert.strictEqual(child._lpos.x, 90);
    assert.strictEqual(child._lpos.y, 180);
    assert.strictEqual(child._lpos.z, 5);
});

test('add-node / remove-node（软删）工作正常', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.prefab');
    writeJson(f, makePrefab());
    const r = offline.editPrefab({
        filePath: f,
        ops: [
            { op: 'add-node', parent: 'Root', name: 'Added' },
            { op: 'remove-node', node: 'Child' },
        ],
    });
    assert.ok(r.ok, r.error);
    const after = JSON.parse(fs.readFileSync(f, 'utf8'));
    const added = after.find((e) => e.__type__ === 'cc.Node' && e._name === 'Added');
    assert.ok(added, '新节点应存在');
    const root = after.find((e) => e.__type__ === 'cc.Node' && e._name === 'Root');
    assert.ok(!root._children.some((c) => c.__id__ === 2), 'Child 应已从根节点解绑');
    // 软删：元素仍在数组里，保持 __id__ 稳定
    assert.ok(after.some((e) => e.__type__ === 'cc.Node' && e._name === 'Child'), '软删应保留元素');
});

test('add-component 后组件出现在节点上', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.prefab');
    writeJson(f, makePrefab());
    const r = offline.editPrefab({
        filePath: f,
        ops: [{ op: 'add-component', node: 'Child', component: 'cc.Button' }],
    });
    assert.ok(r.ok, r.error);
    const after = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.ok(after.some((e) => e.__type__ === 'cc.Button'), '应新增 cc.Button 组件');
});

test('批量 op 全部成功才落盘（正例）', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.prefab');
    writeJson(f, makePrefab());
    const r = offline.editPrefab({
        filePath: f,
        ops: [
            { op: 'set-active', node: 'Child', active: false },
            { op: 'rename-node', node: 'Child', name: 'Renamed' },
            { op: 'set-label-text', node: 'Renamed', text: 'ok' },
        ],
    });
    assert.ok(r.ok, r.error);
    const after = JSON.parse(fs.readFileSync(f, 'utf8'));
    const renamed = after.find((e) => e.__type__ === 'cc.Node' && e._name === 'Renamed');
    assert.ok(renamed);
    assert.strictEqual(renamed._active, false);
});

test('batchPrefab 从 JSON 文件读 ops', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.prefab');
    const opsFile = path.join(dir, 'ops.json');
    writeJson(f, makePrefab());
    writeJson(opsFile, { filePath: f, ops: [{ op: 'set-label-text', node: 'Child', text: 'batched' }] });
    const r = offline.batchPrefab({ opsJsonPath: opsFile });
    assert.ok(r.ok, r.error);
    const after = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.ok(after.some((e) => e._string === 'batched'));
});

test('★ ensure-meta 不得抹掉已有 .meta 的 subMetas / files / userData', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.prefab');
    const texPath = path.join(dir, 'hero.png');
    fs.writeFileSync(texPath, 'x', 'utf8');
    writeJson(f, makePrefab());
    // 真实 Cocos 3.8 的 .meta 形态：ver 1.0.0 + 非空 files/subMetas/userData
    const existing = {
        ver: '1.0.0',
        importer: 'texture',
        imported: true,
        uuid: 'REAL-TEX-UUID-AAAA-BBBB',
        files: ['/hero.png'],
        subMetas: { '6c48a': { importer: 'sprite-frame' } },
        userData: { keepMe: 'important' },
    };
    fs.writeFileSync(`${texPath}.meta`, JSON.stringify(existing, null, 2) + '\n', 'utf8');

    const r = offline.editPrefab({ filePath: f, ops: [{ op: 'ensure-meta', path: texPath }] });
    assert.ok(r.ok, r.error);
    const meta = JSON.parse(fs.readFileSync(`${texPath}.meta`, 'utf8'));
    assert.strictEqual(meta.uuid, 'REAL-TEX-UUID-AAAA-BBBB', 'uuid 不得变');
    assert.deepStrictEqual(meta.files, ['/hero.png'], '★ files 不得被抹掉');
    assert.deepStrictEqual(meta.subMetas, { '6c48a': { importer: 'sprite-frame' } }, '★ subMetas 不得被抹掉（SpriteFrame 引用靠它）');
    assert.deepStrictEqual(meta.userData, { keepMe: 'important' }, '★ userData 不得被抹掉');
});

test('ensure-meta 生成合法 .meta 且 uuid 稳定', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.prefab');
    const scriptPath = path.join(dir, 'MyScript.ts');
    fs.writeFileSync(scriptPath, 'export class MyScript {}', 'utf8');
    writeJson(f, makePrefab());
    const r = offline.editPrefab({ filePath: f, ops: [{ op: 'ensure-meta', path: scriptPath }] });
    assert.ok(r.ok, r.error);
    const meta = JSON.parse(fs.readFileSync(`${scriptPath}.meta`, 'utf8'));
    assert.ok(meta.uuid, '.meta 必须有 uuid');
    // .ts 必须用 typescript 导入器 —— 写成 prefab 会让 Cocos 用 prefab
    // 导入器解析脚本，该脚本彻底无法编译。
    assert.strictEqual(meta.importer, 'typescript');
});

test('★ ensure-meta 不得改写已有 .meta 的 uuid（资产主键）', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.prefab');
    const scriptPath = path.join(dir, 'MyScript.ts');
    fs.writeFileSync(scriptPath, 'export class MyScript {}', 'utf8');
    writeJson(f, makePrefab());
    // 预置一个已有 uuid 的 .meta
    const existing = {
        ver: '1.1.0',
        importer: 'typescript',
        imported: true,
        uuid: 'REAL-UUID-1111-2222-3333-444455556666',
        files: [],
        subMetas: {},
        userData: {},
    };
    fs.writeFileSync(`${scriptPath}.meta`, JSON.stringify(existing, null, 2) + '\n', 'utf8');

    const r = offline.editPrefab({ filePath: f, ops: [{ op: 'ensure-meta', path: scriptPath }] });
    assert.ok(r.ok, r.error);
    const meta = JSON.parse(fs.readFileSync(`${scriptPath}.meta`, 'utf8'));
    assert.strictEqual(meta.uuid, 'REAL-UUID-1111-2222-3333-444455556666', '★ uuid 不得被改写');
    assert.strictEqual(meta.importer, 'typescript', 'importer 也不得被改写');
});

test('★ set-component-field 带数组下标不得摧毁数组', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.prefab');
    const data = makePrefab();
    // 给 Child 的 Label 加一个数组字段
    data[4]._items = [{ v: 1 }, { v: 2 }];
    writeJson(f, data);
    const r = offline.editPrefab({
        filePath: f,
        ops: [{ op: 'set-component-field', node: 'Child', component: 'cc.Label', property: '_items.0.v', value: 99 }],
    });
    assert.ok(r.ok, r.error);
    const after = JSON.parse(fs.readFileSync(f, 'utf8'));
    const label = after.find((e) => e.__type__ === 'cc.Label' && Array.isArray(e._items));
    assert.ok(label, '数组字段应仍在');
    assert.ok(Array.isArray(label._items), '★ _items 必须还是数组，不能被替换成对象');
    assert.strictEqual(label._items.length, 2, '★ 第二个元素不能丢');
    assert.strictEqual(label._items[0].v, 99);
    assert.strictEqual(label._items[1].v, 2);
});

test('★ bulk-set 的写入目标与匹配条件分离', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.prefab');
    writeJson(f, makePrefab());
    const r = offline.editPrefab({
        filePath: f,
        ops: [{
            op: 'bulk-set',
            selector: 'byComponent',
            target: 'component:cc.Label',
            match: 'cc.Label',
            property: '_string',
            value: 'BULK',
        }],
    });
    assert.ok(r.ok, r.error);
    assert.ok(r.data.steps[0].result.applied >= 1, '应至少应用 1 处');
    const after = JSON.parse(fs.readFileSync(f, 'utf8'));
    const label = after.find((e) => e.__type__ === 'cc.Label' && e._string === 'BULK');
    assert.ok(label, '★ 值必须写在组件上，而不是节点上');
    const node = after.find((e) => e.__type__ === 'cc.Node' && e._name === 'Root');
    assert.strictEqual(node._string, undefined, '★ 节点上不应出现 _string');
});

test('★ reparent 必须同步 _parent 并让同批次后续步骤能用新路径', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.prefab');
    const data = makePrefab();
    // Root 下再加一个 Other
    data.push({ __type__: 'cc.Node', _name: 'Other', _children: [], _components: [], _prefab: { __id__: 5 }, _active: true, _lpos: { x: 0, y: 0, z: 0 } });
    data[1]._children.push({ __id__: 6 });
    writeJson(f, data);
    const r = offline.editPrefab({
        filePath: f,
        ops: [
            { op: 'reparent', node: 'Child', parent: 'Other' },
            { op: 'set-active', node: 'Other/Child', active: false },
        ],
    });
    assert.ok(r.ok, r.error);
    const after = JSON.parse(fs.readFileSync(f, 'utf8'));
    const child = after.find((e) => e.__type__ === 'cc.Node' && e._name === 'Child');
    assert.strictEqual(child._active, false, '第 2 步应该能找到新路径下的节点');
    const other = after.find((e) => e.__type__ === 'cc.Node' && e._name === 'Other');
    assert.ok(other._children.some((c) => c.__id__ === 2), 'Other 应持有 Child');
    assert.strictEqual(child._parent.__id__, after.indexOf(other), '★ _parent 必须指向新父节点');
});

test('★ clone-node 的组件回指必须重映射到克隆节点', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.prefab');
    writeJson(f, makePrefab());
    const r = offline.editPrefab({
        filePath: f,
        ops: [{ op: 'clone-node', node: 'Child', name: 'ChildClone' }],
    });
    assert.ok(r.ok, r.error);
    const after = JSON.parse(fs.readFileSync(f, 'utf8'));
    const clone = after.find((e) => e.__type__ === 'cc.Node' && e._name === 'ChildClone');
    assert.ok(clone, '克隆节点应存在');
    const cloneCompIdx = clone._components[0].__id__;
    const cloneComp = after[cloneCompIdx];
    assert.ok(cloneComp, '克隆的组件应存在');
    assert.strictEqual(cloneComp.node.__id__, after.indexOf(clone), '★ 组件的 node 回指必须指向克隆节点，而不是源节点');
});

// ────────────────────────────── anim ──────────────────────────────

test('★ 真实 Cocos .anim 形态下 offset-curve 真的改到关键帧', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.anim');
    writeJson(f, makeRealAnim());
    const r = offline.editAnimation({
        filePath: f,
        ops: [{ op: 'offset-curve', path: 'Root/Child', offset: 5 }],
    });
    assert.ok(r.ok, r.error);
    assert.ok(r.data.changed > 0, '★ 必须报告有改动（之前是「成功但零改动」）');
    const after = JSON.parse(fs.readFileSync(f, 'utf8'));
    const curve = after.find((e) => e.__type__ === 'cc.RealCurve');
    assert.ok(curve, '曲线元素应还在');
    assert.strictEqual(curve.data[0].value, 5, '★ 第一个关键帧应被偏移');
    assert.strictEqual(curve.data[1].value, 105, '★ 第二个关键帧应被偏移');
});

test('★ 真实 Cocos .anim 形态下通道路径要能被筛出来', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.anim');
    writeJson(f, makeRealAnim());
    const r = offline.queryAnimation({ filePath: f, selector: 'tree' });
    assert.ok(r.ok, r.error);
    assert.ok(r.data.count >= 1, '应至少找到一个通道');
    assert.ok(
        r.data.channels.some((c) => c.path === 'Root/Child'),
        '★ 通道路径必须来自 track 元素，实际：' + JSON.stringify(r.data.channels)
    );
});

test('★ 找不到关键帧必须报错，不能「报告成功但零改动」', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.anim');
    // 通道存在但曲线形态不支持
    writeJson(f, [
        { __type__: 'cc.AnimationClip', _name: 'x', duration: 1, tracks: [{ __id__: 1 }] },
        { __type__: 'cc.animation.RealTrack', path: 'P', _channel: { __id__: 2 } },
        { __type__: 'cc.UnknownCurve', foo: 1 },
    ]);
    const before = fs.readFileSync(f, 'utf8');
    const r = offline.editAnimation({ filePath: f, ops: [{ op: 'offset-curve', path: 'P', offset: 5 }] });
    assert.strictEqual(r.ok, false, '应该报错而不是报告成功');
    assert.strictEqual(fs.readFileSync(f, 'utf8'), before, '失败时磁盘必须不变');
});

test('queryAnimation tree 列出通道', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.anim');
    writeJson(f, makeAnim());
    const r = offline.queryAnimation({ filePath: f, selector: 'tree' });
    assert.ok(r.ok, r.error);
    assert.ok(r.data.count >= 1, '应至少找到一个通道');
});

test('editAnimation 失败时不写盘', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.anim');
    writeJson(f, makeAnim());
    const before = fs.readFileSync(f, 'utf8');
    const r = offline.editAnimation({
        filePath: f,
        ops: [{ op: 'offset-curve', node: 'NoSuch', property: 'x', offset: 5 }],
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(fs.readFileSync(f, 'utf8'), before, '★ 失败后磁盘必须字节不变');
});

// ────────────────────────────── 原子写 ──────────────────────────────

test('原子写不产生残留临时文件', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.prefab');
    writeJson(f, makePrefab());
    offline.editPrefab({ filePath: f, ops: [{ op: 'set-active', node: 'Child', active: false }] });
    const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.tmp-'));
    assert.strictEqual(leftovers.length, 0, `不应有临时文件残留：${leftovers.join(', ')}`);
});

test('写回保留原缩进风格', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.prefab');
    fs.writeFileSync(f, JSON.stringify(makePrefab(), null, 4) + '\n', 'utf8');
    const r = offline.editPrefab({ filePath: f, ops: [{ op: 'set-active', node: 'Child', active: false }] });
    assert.ok(r.ok, r.error);
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(text.includes('\n    '), '应保留 4 空格缩进');
});

// ────────────────────────────── 本轮补齐的覆盖缺口 ──────────────────────────────

test('★ bulk-set：match 缺省必须报错（不能退化成全量改写）', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.prefab');
    writeJson(f, makePrefab());
    const before = fs.readFileSync(f, 'utf8');
    const r = offline.editPrefab({
        filePath: f,
        ops: [{ op: 'bulk-set', selector: 'byNamePrefix', target: 'node', property: '_active', value: false }],
    });
    assert.strictEqual(r.ok, false, '缺 match 时应报错');
    assert.match(r.error, /match/, '错误信息要说明是 match 的问题');
    assert.strictEqual(fs.readFileSync(f, 'utf8'), before, '失败时磁盘必须不变');
});

test('★ bulk-set：属性不存在时计入 skipped，不能报告成功', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.prefab');
    writeJson(f, makePrefab());
    const r = offline.editPrefab({
        filePath: f,
        ops: [{
            op: 'bulk-set',
            selector: 'byComponent',
            target: 'component:cc.Label',
            match: 'cc.Label',
            property: 'string',       // ← 序列化字段名是 _string，写 string 会凭空建字段
            value: 'X',
        }],
    });
    assert.ok(r.ok, r.error);
    const step = r.data.steps[0].result;
    assert.strictEqual(step.applied, 0, '★ 不该报告 applied');
    assert.ok(step.skipped > 0, '应计入 skipped');
    const after = JSON.parse(fs.readFileSync(f, 'utf8'));
    const label = after.find((e) => e.__type__ === 'cc.Label');
    assert.strictEqual(label.string, undefined, '★ 不该凭空造出 string 字段');
    assert.strictEqual(label._string, 'hello', '原字段不受影响');
});

test('★ bulk-set：属性名写对时能改到组件上', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.prefab');
    writeJson(f, makePrefab());
    const r = offline.editPrefab({
        filePath: f,
        ops: [{
            op: 'bulk-set',
            selector: 'byComponent',
            target: 'component:cc.Label',
            match: 'cc.Label',
            property: '_string',
            value: 'BULK',
        }],
    });
    assert.ok(r.ok, r.error);
    const after = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.ok(after.some((e) => e.__type__ === 'cc.Label' && e._string === 'BULK'), '组件字段应被改到');
});

test('★ assertOpPathAllowed：未配置 / 显式空 / 软链 三种语义', () => {
    const { assertOpPathAllowed } = require('../ops');
    const dir = tmpdir();
    const outside = tmpdir();
    const inside = path.join(dir, 'ok.txt');
    fs.writeFileSync(inside, 'x');

    // 1) 未配置（null）→ 放行（独立 CLI 用法）
    assert.doesNotThrow(() => assertOpPathAllowed({}, inside, 't'));

    // 2) 显式空数组 → 拒绝一切
    assert.throws(() => assertOpPathAllowed({ allowedRoots: [] }, inside, 't'), /白名单为空/);

    // 3) 非空 → 按 realpath 判断
    assert.doesNotThrow(() => assertOpPathAllowed({ allowedRoots: [dir] }, inside, 't'));
    assert.throws(() => assertOpPathAllowed({ allowedRoots: [dir] }, path.join(outside, 'x.txt'), 't'), /不在允许的目录范围/);

    // 4) 符号链接逃逸 → 必须被拒
    const link = path.join(dir, 'link');
    try {
        fs.symlinkSync(outside, link, 'dir');
    } catch (_) {
        return;   // 环境不支持软链就跳过这条
    }
    assert.throws(
        () => assertOpPathAllowed({ allowedRoots: [dir] }, path.join(link, 'victim.txt'), 't'),
        /不在允许的目录范围/,
        '★ 软链指向项目外时必须被拒绝'
    );
});

test('★ planMetaWrite：保留已有 .meta 的全部字段', () => {
    const { planMetaWrite } = require('../write');
    const dir = tmpdir();
    const target = path.join(dir, 'hero.png');
    fs.writeFileSync(target, 'x');
    fs.writeFileSync(`${target}.meta`, JSON.stringify({
        ver: '1.0.0',
        importer: 'texture',
        imported: true,
        uuid: 'KEEP-UUID',
        files: ['/hero.png'],
        subMetas: { abc: { importer: 'sprite-frame' } },
        userData: { keep: 'me' },
    }, null, 2) + '\n');

    const plan = planMetaWrite(target, {});
    assert.strictEqual(plan.uuid, 'KEEP-UUID', 'uuid 必须保留');
    const merged = JSON.parse(plan.content);
    assert.strictEqual(merged.importer, 'texture', 'importer 必须保留');
    assert.deepStrictEqual(merged.files, ['/hero.png'], 'files 必须保留');
    assert.deepStrictEqual(merged.subMetas, { abc: { importer: 'sprite-frame' } }, '★ subMetas 必须保留（SpriteFrame 引用靠它）');
    assert.deepStrictEqual(merged.userData, { keep: 'me' }, 'userData 必须保留');
    assert.strictEqual(merged.ver, '1.0.0', 'ver 必须保留');
});

test('★ planMetaWrite：显式指定不同 uuid 时必须拒绝（改 uuid 会断掉所有引用）', () => {
    const { planMetaWrite } = require('../write');
    const dir = tmpdir();
    const target = path.join(dir, 'hero.png');
    fs.writeFileSync(target, 'x');
    fs.writeFileSync(`${target}.meta`, JSON.stringify({ ver: '1.0.0', importer: 'texture', uuid: 'OLD-UUID' }, null, 2) + '\n');
    assert.throws(() => planMetaWrite(target, { uuid: 'NEW-UUID' }), /拒绝改写|uuid/);
});

test('importerForPath 按扩展名推导，不是一律 prefab', () => {
    const { importerForPath } = require('../write');
    assert.strictEqual(importerForPath('/a/x.ts'), 'typescript');
    assert.strictEqual(importerForPath('/a/x.anim'), 'animation-clip');
    assert.strictEqual(importerForPath('/a/x.prefab'), 'prefab');
    assert.strictEqual(importerForPath('/a/x.json'), 'json');
    assert.notStrictEqual(importerForPath('/a/x.unknown'), 'prefab', '★ 未知扩展名不能默认 prefab');
});

test('★ ensureTargetOverride：localID 链不同时不复用（不能把 override 挂到错目标）', () => {
    const { ensureTargetOverride } = require('../nested');
    // 构造一个最小 ctx：data 是数组，prefabInfos / instances 是 Map
    const data = [];
    const ctx = {
        data,
        prefabInfos: new Map(),
        instances: new Map(),
    };
    // 宿主的 PrefabInfo（第 0 个）与它挂着的 TargetOverrideInfo（第 1 个）
    const prefabInfoIndex = 0;
    const toiIndex = 1;
    data.push({ __type__: 'cc.PrefabInfo', targetOverrides: [{ __id__: toiIndex }] });
    data.push({ __type__: 'cc.TargetOverrideInfo', targetInfo: { __id__: 2 }, localID: ['OLD-CHAIN'] });
    data.push({ __type__: 'cc.TargetInfo', localID: ['OLD-CHAIN'] });
    ctx.prefabInfos.set(prefabInfoIndex, {
        index: prefabInfoIndex,
        element: data[prefabInfoIndex],
        fileId: 'INST',
        instanceIndex: 5,
        targetOverrideIndices: [toiIndex],
    });
    // ⚠️ instance.prefabInfoIndex 必须指向宿主的 PrefabInfo ——
    //    ensureTargetOverride 靠它找到「挂在谁身上」，缺了就直接返回 null。
    const instance = {
        index: 5,
        fileId: 'INST',
        prefabInfoIndex: prefabInfoIndex,
        element: { propertyOverrides: [] },
        overrides: [],
    };
    ctx.instances.set(5, instance);

    // 链不同 → 必须新建一条，而不是复用那条 OLD-CHAIN
    ensureTargetOverride(ctx, instance, ['INST', 'COMP']);
    const tois = data[prefabInfoIndex].targetOverrides;
    assert.strictEqual(tois.length, 2, '★ 链不同应新建一条 TargetOverrideInfo');
    const last = data[tois[1].__id__];
    assert.deepStrictEqual(last.localID, ['INST', 'COMP'], '新链必须与本次 override 的链一致');

    // 链相同 → 复用，不新增
    const before = data[prefabInfoIndex].targetOverrides.length;
    ensureTargetOverride(ctx, instance, ['INST', 'COMP']);
    assert.strictEqual(data[prefabInfoIndex].targetOverrides.length, before, '链相同应复用而不是新建');
});
