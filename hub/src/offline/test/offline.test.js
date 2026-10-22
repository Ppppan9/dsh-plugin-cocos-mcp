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
const { setPath, splitPath, getPath } = require('../ops');
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

/**
 * **真实 Cocos Creator 3.8 的 .anim 结构**（照 Cocos 自带的 taxi/light.anim 还原）。
 *
 * ⚠️ 为什么单独造这个夹具：
 *    仓库里原有的 makeRealAnim 是**简化过的虚构格式**
 *    （clip.tracks / track 直接带 path / _channel 直接指向曲线），
 *    旧解析器恰好能吃 → 于是**真实格式**从来没人测过，
 *    结果真实 .anim 上「queryAnimation 找到 0 个通道、批量编辑第 2 个 op 必失败」。
 *
 * 真实结构的关键点（每一条都是踩过的坑）：
 *   1. clip 用的是 **`_tracks`**（不是 tracks）
 *   2. track 的属性路径藏在 **`_binding.path` → cc.animation.TrackPath → `_paths`**
 *      （`_paths` 最后一项才是属性名，前面是层级路径）
 *   3. track 的 **`_channel` / `_channels` 是引用**，指向 cc.animation.Channel 元素
 *   4. Channel 的 **`_curve` 又是引用**，指向 cc.RealCurve / cc.QuatCurve
 *   5. 曲线用 **`_times` + `_values` 两个平行数组**（不是 data 数组）
 */
function makeCocos38Anim() {
  return [
    {
      __type__: 'cc.AnimationClip',
      _name: '',
      sample: 60,
      speed: 1,
      wrapMode: 1,
      _duration: 2,
      _tracks: [{ __id__: 1 }, { __id__: 6 }],
      _events: [],
    },
    // ── QuatTrack：单数引用 _channel → Channel → _curve → QuatCurve
    {
      __type__: 'cc.animation.QuatTrack',
      _binding: { __type__: 'cc.animation.TrackBinding', path: { __id__: 2 } },
      _channel: { __id__: 4 },
    },
    { __type__: 'cc.animation.TrackPath', _paths: [{ __id__: 3 }, 'rotation'] },
    { __type__: 'cc.animation.HierarchyPath', path: '/' },
    { __type__: 'cc.animation.Channel', _curve: { __id__: 5 } },
    {
      __type__: 'cc.QuatCurve',
      _times: [0, 1],
      _values: [
        { __type__: 'cc.QuatKeyframeValue', value: { __type__: 'cc.Quat', x: 0, y: 0, z: 0, w: 1 } },
        { __type__: 'cc.QuatKeyframeValue', value: { __type__: 'cc.Quat', x: 0, y: 0, z: 0, w: 1 } },
      ],
    },
    // ── VectorTrack：复数引用 _channels → 多个 Channel
    {
      __type__: 'cc.animation.VectorTrack',
      _binding: { __type__: 'cc.animation.TrackBinding', path: { __id__: 7 } },
      _channels: [{ __id__: 9 }, { __id__: 11 }],
      _nComponents: 2,
    },
    { __type__: 'cc.animation.TrackPath', _paths: [{ __id__: 8 }, 'scale'] },
    { __type__: 'cc.animation.HierarchyPath', path: '/' },
    { __type__: 'cc.animation.Channel', _curve: { __id__: 10 } },
    { __type__: 'cc.RealCurve', _times: [0, 1], _values: [{ __type__: 'cc.RealKeyframeValue', value: 1 }, { __type__: 'cc.RealKeyframeValue', value: 2 }] },
    { __type__: 'cc.animation.Channel', _curve: { __id__: 12 } },
    { __type__: 'cc.RealCurve', _times: [0, 1], _values: [{ __type__: 'cc.RealKeyframeValue', value: 3 }, { __type__: 'cc.RealKeyframeValue', value: 4 }] },
  ];
}

function makeAnim() {
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

test('editPrefab 会清理**陈旧**的临时残file，但不动可能正被使用的', () => {
    // ⚠️ 进程在「写完临时文件、还没 rename」之间被杀，会在用户的 assets 目录里
    //    留下 .xxx.tmp-<pid>-<rand> 残file（隐藏文件，Cocos 一般忽略，但污染工程目录）。
    //    → 写盘前应清理**陈旧**的；但刚建的不能动（可能正被另一个进程用着）。
    const dir = tmpdir();
    const f = path.join(dir, 'a.prefab');
    writeJson(f, makePrefab());

    // 一个「很老」的残file
    const oldTmp = path.join(dir, '.a.prefab.tmp-999999-deadbeef');
    fs.writeFileSync(oldTmp, 'x');
    const past = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(oldTmp, past, past);
    // 一个「刚建」的残file
    const freshTmp = path.join(dir, '.a.prefab.tmp-999999-cafe');
    fs.writeFileSync(freshTmp, 'x');

    const r = offline.editPrefab({ filePath: f, ops: [{ op: 'set-label-text', node: 'Child', text: 'zzz' }] });
    assert.ok(r.ok, r.error);
    assert.ok(!fs.existsSync(oldTmp), '陈旧的临时残file 应被清理');
    assert.ok(fs.existsSync(freshTmp), '刚建的临时文件不能动（可能正被别的进程使用）');
    fs.unlinkSync(freshTmp);
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

// ────────────────────────────── 原型链安全 ──────────────────────────────

test('★ 保留路径段必须被拒绝 —— 否则能污染整个进程的原型链', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.prefab');
    writeJson(f, makePrefab());
    const before = fs.readFileSync(f, 'utf8');

    // 这些段名一旦放行，setPath 会一路走到 Object.prototype 上
    for (const prop of ['__proto__', 'constructor', 'prototype', '_lpos.__proto__.polluted']) {
        const r = offline.editPrefab({
            filePath: f,
            ops: [{ op: 'set-component-field', node: 'Child', component: 'cc.Label', property: prop, value: 'X' }],
        });
        assert.ok(!r.ok, `property="${prop}" 必须被拒绝`);
        assert.match(r.error, /保留段/, `错误信息要说清是保留段：${r.error}`);
    }

    // ★ 这才是这条测试真正要守的东西 —— 进程级的原型污染
    assert.strictEqual({}.polluted, undefined, '★ Object.prototype 被污染了');
    assert.strictEqual(Object.prototype.polluted, undefined);
    assert.strictEqual(fs.readFileSync(f, 'utf8'), before, '★ 磁盘不得有任何写入');
});

test('★ 末段只在原型链上的字段名（toString 等）不得写入', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.prefab');
    writeJson(f, makePrefab());
    const before = fs.readFileSync(f, 'utf8');
    const r = offline.editPrefab({
        filePath: f,
        ops: [{ op: 'set-component-field', node: 'Child', component: 'cc.Label', property: 'toString', value: 'X' }],
    });
    assert.ok(!r.ok, 'toString 只在原型链上，必须被拒绝');
    assert.match(r.error, /原型链/, r.error);
    assert.strictEqual(fs.readFileSync(f, 'utf8'), before, '★ 磁盘不得有任何写入');
});

test('★ bulk-set 的「属性存在」检查不能用 in（原型链上的名字会被放行）', () => {
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
            property: 'toString',
            value: 'X',
        }],
    });
    assert.ok(r.ok, r.error);
    const res = r.data.steps[0].result;
    assert.strictEqual(res.applied, 0, '★ toString 不是组件自己的字段，必须跳过而不是应用');
    assert.strictEqual(res.skipped, 2);
    assert.match(res.skipDetails[0].reason, /没有属性/);
    // 组件上不得多出 toString 自有字段（引擎不认，但会真的写进磁盘）
    const after = JSON.parse(fs.readFileSync(f, 'utf8'));
    const label = after.find((e) => e.__type__ === 'cc.Label' && e.node && e.node.__id__ === 2);
    assert.ok(label);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(label, 'toString'), false, '★ 不得生成引擎不认的字段');
});

test('★ 数组末段是下标时要替换元素，不能写成元素上的字符串键', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.prefab');
    const data = makePrefab();
    data[4]._items = [{ v: 1 }, { v: 2 }];
    writeJson(f, data);
    const r = offline.editPrefab({
        filePath: f,
        ops: [{ op: 'set-component-field', node: 'Child', component: 'cc.Label', property: '_items.0', value: { v: 9 } }],
    });
    assert.ok(r.ok, r.error);
    const after = JSON.parse(fs.readFileSync(f, 'utf8'));
    const label = after.find((e) => e.__type__ === 'cc.Label' && Array.isArray(e._items));
    assert.deepStrictEqual(label._items, [{ v: 9 }, { v: 2 }], '★ 应替换第 0 个元素，而不是给它加一个 "0" 键');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(label._items[0], '0'), false);
});

test('setPath / splitPath / getPath 是导出的，直接调用也要守住原型链', () => {
    assert.throws(() => splitPath('__proto__'), /保留段/);
    assert.throws(() => splitPath('a.constructor.b'), /保留段/);
    // ⚠️ getPath 也要有自己的用例 ——
    //    变异验证发现：拆掉 getPath 的守卫**没有任何用例变红**
    //    （因为其它层都在兜，看起来是「纵深防御」，
    //      但那一层实际上从来没被独立验证过 —— 万一以后有人删掉别的层，它就是裸的）。
    assert.throws(() => getPath({ a: {} }, ['__proto__']), /保留段/);
    assert.throws(() => getPath({ a: {} }, ['a', 'constructor']), /保留段/);
    const o = { a: {} };
    assert.throws(() => setPath(o, ['a', '__proto__', 'x'], 1), /保留段/);
    assert.strictEqual({}.x, undefined, '★ 不得污染全局原型');
    assert.strictEqual(Object.getPrototypeOf(o), Object.prototype, '★ 不得换掉对象的原型');
    // 正常路径不受影响
    const o2 = { _lpos: { x: 0 } };
    assert.strictEqual(setPath(o2, ['_lpos', 'x'], 5), true);
    assert.strictEqual(o2._lpos.x, 5);
    assert.strictEqual(getPath(o2, ['_lpos', 'x']), 5);
});

test('setPath 不得穿过继承来的对象（模块是可复用的，要纵深防御）', () => {
    // 原型上挂了一个**普通对象** —— 不是函数，所以 isPlainObject 会放行，
    // 不加自有属性检查就会一路写进去，改到原型上的共享对象。
    const proto = { nested: { v: 1 } };
    const o = Object.create(proto);
    assert.throws(() => setPath(o, ['nested', 'v'], 999), /原型链/);
    assert.strictEqual(proto.nested.v, 1, '★ 不得改到原型上的共享对象');
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

test('★ editAnimation 也必须过目录白名单（纵深防御：独立复用时不能改项目外的文件）', () => {
    const allowed = tmpdir();
    const outside = tmpdir();
    const f = path.join(outside, 'a.anim');
    writeJson(f, makeRealAnim());
    const before = fs.readFileSync(f, 'utf8');
    const r = offline.editAnimation({
        filePath: f,
        allowedRoots: [allowed], // 白名单只指向另一个目录
        ops: [{ op: 'offset-curve', path: 'Root/Child', offset: 5 }],
    });
    assert.strictEqual(r.ok, false, '★ 不在白名单内必须被拒绝');
    assert.match(r.error, /不在允许的目录范围/, r.error);
    assert.strictEqual(fs.readFileSync(f, 'utf8'), before, '★ 磁盘必须字节不变');
});

test('★ editAnimation 显式空白名单 = 拒绝一切（不能退化成「没配就全放行」）', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.anim');
    writeJson(f, makeRealAnim());
    const before = fs.readFileSync(f, 'utf8');
    const r = offline.editAnimation({
        filePath: f,
        allowedRoots: [],
        ops: [{ op: 'offset-curve', path: 'Root/Child', offset: 5 }],
    });
    assert.strictEqual(r.ok, false, '★ 空白名单必须拒绝一切');
    assert.match(r.error, /白名单为空/, r.error);
    assert.strictEqual(fs.readFileSync(f, 'utf8'), before, '★ 磁盘必须字节不变');
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

test('★ 离线读路径（queryPrefab / queryAnimation）也必须过目录白名单', () => {
    const allowed = tmpdir();
    const outside = tmpdir();
    const p = path.join(outside, 'a.prefab');
    const a = path.join(outside, 'a.anim');
    writeJson(p, makePrefab());
    writeJson(a, makeAnim());

    // 读路径同样要守 —— 这个模块是独立可复用的，不能假设调用方检查过
    const r1 = offline.queryPrefab({ filePath: p, selector: 'tree', allowedRoots: [allowed] });
    assert.strictEqual(r1.ok, false, '★ queryPrefab 必须拒绝白名单外的路径');
    assert.match(r1.error, /不在允许的目录范围/, r1.error);

    const r2 = offline.queryAnimation({ filePath: a, selector: 'tree', allowedRoots: [allowed] });
    assert.strictEqual(r2.ok, false, '★ queryAnimation 必须拒绝白名单外的路径');
    assert.match(r2.error, /不在允许的目录范围/, r2.error);

    // 白名单内正常放行
    const inside = path.join(allowed, 'b.prefab');
    writeJson(inside, makePrefab());
    const r3 = offline.queryPrefab({ filePath: inside, selector: 'tree', allowedRoots: [allowed] });
    assert.ok(r3.ok, r3.error);
});

test('★ add-component 的 props 键不许是保留段（这是唯一不经 splitPath 的键写入）', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.prefab');
    writeJson(f, makePrefab());
    const before = fs.readFileSync(f, 'utf8');

    // ⚠️ 用 JSON.parse 造出**自有**的 __proto__ 键 ——
    //    JS 字面量 {__proto__: …} 造出来的是原型设置，不是自有键，
    //    用字面量测会得出假阴性（看起来没被污染，其实根本没走到那条路径）。
    for (const key of ['__proto__', 'constructor', 'prototype']) {
        const props = JSON.parse(`{"${key}": {"POLLUTE": "yes"}}`);
        const r = offline.editPrefab({
            filePath: f,
            ops: [{ op: 'add-component', node: 'Child', component: 'cc.Sprite', props }],
        });
        assert.ok(!r.ok, `props.${key} 必须被拒绝`);
        assert.match(r.error, /保留段/, r.error);
    }
    assert.strictEqual({}.POLLUTE, undefined, '★ 不得污染全局原型');
    assert.strictEqual(fs.readFileSync(f, 'utf8'), before, '★ 磁盘不得有任何写入');
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

// ───────────── 真实 Cocos 3.8 .anim 形态（之前从没被测过） ─────────────

test('queryAnimation 能解析真实 Cocos 3.8 的 .anim（_tracks / _binding.path / 引用链）', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'real.anim');
    writeJson(f, makeCocos38Anim());
    const r = offline.queryAnimation({ filePath: f, selector: 'tree' });
    assert.ok(r.ok, r.error);
    const paths = (r.data.channels || []).map((c) => c.path);
    assert.ok(paths.includes('rotation'), `应找到 rotation 通道，实际：${paths.join(',')}`);
    assert.ok(paths.includes('scale'), `应找到 scale 通道，实际：${paths.join(',')}`);
});

test('真实 .anim 的批量编辑：2 个 op 都要成功，且值真的落进文件', () => {
    // ⚠️ 之前真实 .anim 上「第 1 个 op 成功、第 2 个 op 必失败」
    //    （两套解析器不一致，每执行完一个 op 就用坏的那套重扫）。
    const dir = tmpdir();
    const f = path.join(dir, 'real.anim');
    writeJson(f, makeCocos38Anim());
    const before = fs.readFileSync(f, 'utf8');

    const r = offline.editAnimation({
        filePath: f,
        ops: [
            { op: 'set-keyframe-value', path: 'rotation', time: 0, value: 0.5 },
            { op: 'set-keyframe-value', path: 'scale', time: 0, value: 0.25 },
        ],
    });
    assert.ok(r.ok, r.error);
    assert.ok(r.data.changed > 0, `应有实际改动，changed=${r.data.changed}`);

    const after = fs.readFileSync(f, 'utf8');
    assert.notStrictEqual(after, before, '文件必须真的被改了');
    const d = JSON.parse(after);
    const real = d.find((e) => e.__type__ === 'cc.RealCurve');
    assert.ok(real, '应还能找到 cc.RealCurve');
    assert.strictEqual(real._values[0].value, 0.25, '关键帧的值必须真的写进文件（不是只改了副本）');
});

test('★ offset-curve 的 axis 传错必须报错（不能静默变成零效果）', () => {
    const dir = tmpdir();
    const f = path.join(dir, 'a.anim');
    writeJson(f, makeRealAnim());
    const before = fs.readFileSync(f, 'utf8');
    // "xx" / "foo" / 大写 "X" 都应该被拒 ——
    // 放过去的话一个轴都命不中，工具报 changed:0 但调用方可能当成「改过了」。
    for (const axis of ['xx', 'foo', 'X', '__proto__']) {
        const r = offline.editAnimation({
            filePath: f,
            ops: [{ op: 'offset-curve', path: 'Root/Child', offset: 5, axis }],
        });
        assert.strictEqual(r.ok, false, `axis="${axis}" 必须被拒绝`);
        assert.match(r.error, /不是合法的轴名/, r.error);
    }
    // 合法轴仍然正常工作
    const ok = offline.editAnimation({
        filePath: f,
        ops: [{ op: 'offset-curve', path: 'Root/Child', offset: 5, axis: 'x' }],
    });
    assert.ok(ok.ok, ok.error);
    assert.ok(ok.data.changed > 0, '★ 合法轴必须真的改到东西');
});
