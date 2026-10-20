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
        { __type__: 'cc.Label', _string: 'hello', _fontSize: 24, _enabled: true },
        { __type__: 'cc.Label', _string: 'child text', _enabled: true },
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
    assert.strictEqual(meta.importer, 'prefab');
});

// ────────────────────────────── anim ──────────────────────────────

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
