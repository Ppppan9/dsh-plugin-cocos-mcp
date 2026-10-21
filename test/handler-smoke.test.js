'use strict';

/**
 * Bridge op 级冒烟测试
 * ---------------------------------------------------------------------------
 * 为什么必须有这个：
 * 本轮修的 bug 里最严重的一个是 `node.create` 里把 `args.components` 写成了
 * `op.components` —— 而 `op` 在那个函数里**不存在**（形参叫 args）。
 * 结果是 ReferenceError，**所有 69 个测试全绿**，因为没有任何测试真的调用过这个 op。
 *
 * 这个文件解决的就是这个问题：把 `createHandlers()` 返回的**每一个 op**
 * 都用 mock ctx 调一遍，断言不抛 ReferenceError / TypeError。
 *
 * 运行：node --test test/handler-smoke.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { createHandlers, resetSceneHealth } = require('../extension/bridge/handlers');
const os = require('os');
const fs = require('fs');

// reference.add 会检查文件是否存在 —— 造一个真的
const REF_IMG = path.join(os.tmpdir(), '__cocos_mcp_smoke_ref.png');
try {
    fs.writeFileSync(REF_IMG, Buffer.from('89504e470d0a1a0a', 'hex'));
} catch (_) {
    /* ignore */
}

/**
 * 「已导入」的模拟工程。
 * ---------------------------------------------------------------------------
 * 真实引擎里，资源导入完成的标志是**本地库产物文件**落盘：
 *   <项目>/library/<uuid前2位>/<uuid>.json
 * 渲染进程打开场景时取的 import://<uuid>.json 就是它。
 *
 * mock 必须还原这件事，否则 scene.open 的「导入完成」前置拦截
 * 永远判定为「未导入」→ mock 与真机行为不一致，测出来的绿是假的。
 */
const MOCK_UUID = '11111111-2222-3333-4444-555555555555';
const MOCK_PROJECT = path.join(os.tmpdir(), '__cocos_mcp_smoke_project');
try {
    const libDir = path.join(MOCK_PROJECT, 'library', MOCK_UUID.slice(0, 2));
    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(path.join(libDir, `${MOCK_UUID}.json`), '{}');
    // ⚠️ .meta 文件也要造一个 ——
    //    Bridge 查「资源是否存在 / 拿到 uuid」走的是**直接读 .meta**，
    //    不走 asset-db（asset-db 在「还没导入完」时返回空，那正是最需要它的时候不可用）。
    //    mock 不造 .meta 的话，url 分支会永远失败，测不到真实路径。
    const assetsDir = path.join(MOCK_PROJECT, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(
        path.join(assetsDir, 'a.prefab.meta'),
        JSON.stringify({ ver: '1.1.0', importer: 'editor', uuid: MOCK_UUID, files: [], subMetas: {} })
    );
} catch (_) {
    /* ignore */
}

/** 一个够用的假编辑器：所有消息都返回可用的假数据。 */
function makeCtx(overrides = {}) {
    const calls = [];
    // ⚠️ query-node-tree 返回的是 **Cocos 原始节点树**（根节点 + children 数组），
    //    不是 {nodes:[...]} —— 那是 Bridge 自己 scene.tree op 的输出格式。
    //
    // 组件列表必须是**可变**的 —— mock 要能真实反映 remove-component 的效果，
    // 否则「操作后回读校验」永远会报「没删掉」。
    const nodeComps = [
        {
            type: 'cc.UITransform',
            // raw dump 里属性是 IProperty 包装 {value, type, ...} —— mock 必须还原这个形状
            value: {
                uuid: { value: 'comp-uitransform-uuid', type: 'String' },
                _enabled: { value: true, type: 'Boolean' },
                contentSize: { value: { width: 100, height: 50 }, type: 'cc.Size' },
            },
        },
        {
            type: 'cc.Label',
            value: {
                uuid: { value: 'comp-label-uuid', type: 'String' },
                _enabled: { value: true, type: 'Boolean' },
                string: { value: 'hi', type: 'String' },
                fontSize: { value: 24, type: 'Number' },
            },
        },
    ];
    const child = {
        __type__: 'cc.Node',
        name: 'Child',
        _name: 'Child',
        uuid: 'child-uuid',
        _active: true,
        children: [],
        __comps__: nodeComps,
    };
    const tree = {
        __type__: 'cc.Node',
        name: 'Scene',
        _name: 'Scene',
        uuid: 'root-uuid',
        _active: true,
        children: [child],
        __comps__: [{ type: 'cc.Canvas', value: { _enabled: true } }],
    };
    const nodeDump = {
        uuid: 'child-uuid',
        name: 'Child',
        active: true,
        position: { x: 1, y: 2, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        parent: { uuid: 'root-uuid' },
        children: [],
        __comps__: nodeComps,
    };

    const msg = async (channel, message, ...args) => {
        calls.push([channel, message, args]);
        switch (message) {
            case 'query-node-tree':
                return tree;
            case 'query-node':
                nodeDump.__comps__ = nodeComps;
                return nodeDump;
            case 'query-classes':
                return [{ name: 'cc.Label' }];
            case 'query-components':
                return [{ name: 'MyUI', cid: 'abc', path: 'Scene/Child', assetUuid: 'u' }];
            case 'query-scene-bounds':
                return { x: 0, y: 0, width: 960, height: 640 };
            case 'query-is-ready':
            case 'query-dirty':
                return true;
            case 'query-asset-info':
                // ⚠️ 真机的 query-asset-info **带 uuid** —— 没有 uuid 就没法定位库产物文件
                return { name: 'x', url: args[0], uuid: MOCK_UUID };
            case 'query-assets':
                return [{ url: 'db://assets/a.prefab', uuid: 'u1' }];
            case 'query-uuid':
                return 'uuid-1';
            case 'query-url':
                return 'db://assets/a.prefab';
            case 'query-path':
                return '/abs/path';
            case 'query-asset-dependencies':
            case 'query-asset-users':
                return [];
            case 'query-preview-url':
                return 'http://127.0.0.1:7456';
            case 'query-platform-config':
                return { name: 'web-desktop' };
            case 'query-tasks-info':
                return { queue: [], list: [] };
            case 'create-node':
                return 'new-node-uuid';
            case 'remove-component': {
                // 真的删掉（按组件 uuid 找）—— 验证「回读校验」的成功路径
                const i = nodeComps.findIndex((c) => c.value && c.value.uuid && c.value.uuid.value === args[0].uuid);
                if (i >= 0) nodeComps.splice(i, 1);
                return true;
            }
            case 'create-component':
            case 'remove-node':
            case 'save-scene':
            case 'open-scene':
            case 'soft-reload':
            case 'snapshot':
            case 'snapshot-abort':
            case 'set-property':
            case 'set-parent':
            case 'duplicate-node':
            case 'copy-node':
            case 'cut-node':
            case 'paste-node':
            case 'focus-camera':
            case 'change-gizmo-tool':
            case 'change-gizmo-pivot':
            case 'change-gizmo-coordinate':
            case 'change-is2D':
            case 'set-grid-visible':
            case 'set-icon-gizmo-3d':
            case 'set-icon-gizmo-size':
            case 'align-with-view':
            case 'align-view-with-node':
                return true;
            case 'execute-component-method':
                return { ok: true };
            case 'execute-scene-script':
                return { ok: true };
            case 'create-asset':
            case 'save-asset':
            case 'delete-asset':
            case 'move-asset':
            case 'copy-asset':
                return { uuid: 'u', url: args[0] };
            case 'query-config':
                return { some: 'config' };
            case 'set-config':
                return true;
            case 'add-task':
                return { id: 'task-1' };
            case 'query-ip-list':
                return ['192.168.1.1'];
            case 'query-port':
                return 7456;
            case 'add-image':
            case 'remove-image':
            case 'set-image-data':
                return true;
            case 'query-current':
                return { path: '', x: 0, y: 0 };
            case 'query-config-image':
                return { images: [] };
            default:
                return true;
        }
    };

    /**
     * 重置 mock 的可变状态（组件列表）。
     * op 之间会互相影响 —— component.remove 真的把组件删了之后，
     * 后面的 component.set 就找不到它了。每个 op 前都要重置。
     */
    const reset = () => {
        nodeComps.length = 0;
        nodeComps.push(
            {
                type: 'cc.UITransform',
                value: {
                    uuid: { value: 'comp-uitransform-uuid', type: 'String' },
                    _enabled: { value: true, type: 'Boolean' },
                    contentSize: { value: { width: 100, height: 50 }, type: 'cc.Size' },
                },
            },
            {
                type: 'cc.Label',
                value: {
                    uuid: { value: 'comp-label-uuid', type: 'String' },
                    _enabled: { value: true, type: 'Boolean' },
                    string: { value: 'hi', type: 'String' },
                    fontSize: { value: 24, type: 'Number' },
                },
            }
        );
    };

    return {
        calls,
        msg,
        reset,
        editorVersion: '3.8.8',
        projectPath: MOCK_PROJECT,
        projectUuid: 'proj-uuid',
        appPath: '/Applications/Cocos',
        logger: () => [{ type: 'log', message: 'x', stack: '', time: 0, process: 'renderer' }],
        clearLogs: () => {},
        ...overrides,
    };
}

/** 每个 op 的一组合法参数。 */
const OP_ARGS = {
    'editor.info': {},
    'editor.logs': { limit: 10 },
    'editor.console.clear': {},
    'scene.tree': {},
    'scene.node': { node: 'child-uuid' },
    'scene.find': { name: 'Child' },
    'scene.open': { uuid: '11111111-2222-3333-4444-555555555555' },
    'scene.create': { name: 'NewScene' },
    'scene.save': {},
    'scene.close': {},
    'scene.reload': {},
    'scene.status': {},
    'scene.dirty': {},
    'scene.ready': {},
    'scene.bounds': {},
    'scene.classes': {},
    'scene.components': {},
    'scene.snapshot': {},
    'scene.snapshot.abort': {},
    'scene.transaction': { ops: [] },
    'node.create': { parent: 'root-uuid', name: 'N' },
    'node.delete': { node: 'child-uuid' },
    'node.duplicate': { node: 'child-uuid' },
    'node.move': { node: 'child-uuid', parent: 'root-uuid' },
    'node.active': { node: 'child-uuid', active: false },
    'node.transform': { node: 'child-uuid', position: { x: 1, y: 2 } },
    'node.clipboard': { action: 'copy', node: 'child-uuid' },
    'component.add': { node: 'child-uuid', component: 'cc.Button' },
    'component.remove': { node: 'child-uuid', component: 'cc.Label' },
    'component.list': { node: 'child-uuid' },
    'component.set': { node: 'child-uuid', component: 'cc.Label', property: 'string', value: 'x' },
    'component.call': { node: 'child-uuid', method: 'play' },
    'asset.query': { pattern: 'db://assets/**' },
    'asset.info': { url: 'db://assets/a.prefab' },
    'asset.isImported': { url: 'db://assets/a.prefab' },
    'asset.create': { url: 'db://assets/b.prefab', content: '{}' },
    'asset.save': { url: 'db://assets/b.prefab', content: '{}' },
    'asset.delete': { url: 'db://assets/b.prefab' },
    'asset.move': { from: 'db://assets/a.prefab', to: 'db://assets/c.prefab' },
    'asset.copy': { from: 'db://assets/a.prefab', to: 'db://assets/d.prefab' },
    'asset.reimport': { url: 'db://assets/a.prefab' },
    'asset.refresh': { url: 'db://assets/a.prefab' },
    'asset.uuid': { url: 'db://assets/a.prefab' },
    'asset.url': { uuid: 'uuid-1' },
    'asset.path': { url: 'db://assets/a.prefab' },
    'asset.users': { url: 'db://assets/a.prefab' },
    'asset.dependencies': { url: 'db://assets/a.prefab' },
    'preview.url': {},
    'view.gizmo': {},
    'view.is2d': {},
    'view.grid': {},
    'view.icon': {},
    'view.focus': { nodes: ['child-uuid'] },
    'view.align': { mode: 'with-view' },
    'build.start': { platform: 'web-desktop' },
    'build.status': { type: 'build' },
    'build.platforms': {},
    'reference.add': { paths: [REF_IMG] },
    'reference.remove': { paths: [REF_IMG] },
    'reference.current': {},
    'reference.config': {},
    'reference.set': { key: 'opacity', value: 0.5 },
    'preferences.get': { name: 'preview' },
    'preferences.set': { name: 'preview', key: 'k', value: 1 },
    'project.config': { key: 'engine' },
    'message': { channel: 'scene', message: 'query-is-ready', args: [] },
    'scene.script': { method: 'getSceneSummary', args: [] },
};

test('每个 Bridge op 都能被调用，不抛 ReferenceError / TypeError', async () => {
    const ctx = makeCtx();
    const handlers = createHandlers(ctx);
    const ops = Object.keys(handlers).filter((k) => typeof handlers[k] === 'function');
    assert.ok(ops.length >= 50, `op 数量太少：${ops.length}`);

    const failures = [];
    for (const op of ops) {
        // 每个 op 之前重置 mock 状态 —— op 之间会互相影响
        ctx.reset();
        const args = OP_ARGS[op];
        if (args === undefined) {
            failures.push(`${op}: 没有为它准备测试参数（测试没跟上实现）`);
            continue;
        }
        try {
            await handlers[op](args);
        } catch (e) {
            // 业务性错误（参数不合法、找不到节点）是正常的 —— 只关心「代码级」异常
            const isCodeBug = e instanceof ReferenceError || e instanceof TypeError;
            failures.push(`${op}: ${isCodeBug ? '★代码缺陷★ ' : ''}${e.name}: ${e.message}`);
        }
    }
    assert.deepStrictEqual(failures, [], '以下 op 调用时出了问题：\n' + failures.join('\n'));
});

test('每个 op 都有对应的测试参数（防止新增 op 漏测）', () => {
    const ctx = makeCtx();
    const handlers = createHandlers(ctx);
    const ops = Object.keys(handlers).filter((k) => typeof handlers[k] === 'function');
    const missing = ops.filter((op) => OP_ARGS[op] === undefined);
    assert.deepStrictEqual(missing, [], '这些 op 没有测试参数：' + missing.join(', '));
});

test('会改场景的 op 都必须让场景树缓存失效', async () => {
    // 改一次场景树缓存的内容，再调一个「写类」op，
    // 看缓存是否被清掉（否则后续查询会拿到旧树）。
    const ctx = makeCtx();
    const handlers = createHandlers(ctx);
    await handlers['scene.tree']({});
    const callsAfterTree = ctx.calls.length;
    await handlers['node.active']({ node: 'child-uuid', active: false });
    // node.active 之后应能拿到新的树（缓存已失效 → 重新查一次树）
    ctx.calls.length = 0;
    await handlers['scene.tree']({});
    assert.ok(
        ctx.calls.some((c) => c[0] === 'scene' && c[1] === 'query-node-tree'),
        '写操作后场景树缓存必须失效（否则查到的是旧树）'
    );
    assert.ok(callsAfterTree >= 1);
});

// ──────────────────── 导入完成判定（本项目最深的坑） ────────────────────

test('asset.isImported：库产物存在才算导入完成', async () => {
    const ctx = makeCtx();
    const handlers = createHandlers(ctx);

    // 1) url 形式：mock 工程里已造好 MOCK_UUID 的库产物 → imported=true
    const ok = await handlers['asset.isImported']({ url: 'db://assets/a.prefab' });
    assert.strictEqual(ok.imported, true, '库产物存在时应判为已导入');
    assert.strictEqual(ok.uuid, MOCK_UUID);
    assert.ok(ok.libraryFile && ok.libraryFile.endsWith(`${MOCK_UUID}.json`), '应回报库产物路径');

    // 2) uuid 形式：同样应该判为已导入
    const ok2 = await handlers['asset.isImported']({ uuid: MOCK_UUID });
    assert.strictEqual(ok2.imported, true, 'uuid 形式也应判为已导入');

    // 3) 没有库产物 → 未导入，且必须给出**可行动**的原因
    const bad = await handlers['asset.isImported']({ uuid: '99999999-8888-7777-6666-555555555555' });
    assert.strictEqual(bad.imported, false, '没有库产物时不能判为已导入');
    assert.ok(bad.reason && bad.reason.length > 4, '未导入时必须说明原因');
});

test('asset.isImported：拒绝 url 越权与非法 uuid', async () => {
    const ctx = makeCtx();
    const handlers = createHandlers(ctx);

    await assert.rejects(
        () => handlers['asset.isImported']({ url: '/etc/passwd' }),
        /db:\/\/assets/,
        '非 db://assets/ 的 url 必须被拒（防止越权读盘）'
    );
    await assert.rejects(
        () => handlers['asset.isImported']({ url: 'db://assets/../../etc/passwd' }),
        /\.\./,
        '含 .. 的 url 必须被拒'
    );
    await assert.rejects(
        () => handlers['asset.isImported']({ uuid: 'not-a-uuid' }),
        /uuid/,
        '非法 uuid 必须被拒'
    );
    await assert.rejects(
        () => handlers['asset.isImported']({}),
        /url 或 uuid/,
        'url 和 uuid 都缺必须报错'
    );
    // ⚠️ 目录穿越：库文件路径是
    //    path.join(root, 'library', uuid.slice(0,2), uuid + '.json')，
    //    如果 uuid 形如 '../..'，slice(0,2) 就是 '..' → 路径会跳出 library 目录，
    //    变成「探测项目外文件是否存在」的信息泄露。必须靠 uuid 格式校验挡住。
    for (const evil of ['../../etc/passwd', '..', '../secret', 'a/b', '..%2Fetc']) {
        await assert.rejects(
            () => handlers['asset.isImported']({ uuid: evil }),
            /uuid 格式不合法/,
            `含路径成分的 uuid "${evil}" 必须被拒`
        );
    }
});

test('scene.open：未导入完成时**在打开前**就拒绝，不去碰 open-scene', async () => {
    // 这是最关键的一条：真机上「打开一个没导入完的场景」会毒死整个 scene 频道
    // （query-node-tree 永远不返回，所有场景工具全挂）。
    // 所以拦截必须发生在 send('scene','open-scene') **之前**。
    const ctx = makeCtx();
    const handlers = createHandlers(ctx);

    await assert.rejects(
        () => handlers['scene.open']({ uuid: '99999999-8888-7777-6666-555555555555' }),
        /还没导入完成/,
        '未导入的场景必须被拒绝'
    );

    const opened = ctx.calls.filter((c) => c[0] === 'scene' && c[1] === 'open-scene');
    assert.strictEqual(opened.length, 0, '未导入时绝不能发出 open-scene 消息（会毒死 scene 频道）');
});

test('scene.open：已导入完成时正常打开', async () => {
    const ctx = makeCtx();
    const handlers = createHandlers(ctx);

    const res = await handlers['scene.open']({ uuid: MOCK_UUID });
    assert.ok(res.opened, '应返回 opened');
    const opened = ctx.calls.filter((c) => c[0] === 'scene' && c[1] === 'open-scene');
    assert.strictEqual(opened.length, 1, '已导入时应发出一次 open-scene');
});

test('asset.delete：拒绝删掉当前打开的场景（会毒化编辑器）', async () => {
    // ⚠️ 删掉当前打开的场景后，编辑器会留下一个指向已删除资源的引用，
    //    引擎打开下一个场景时先处理它、失败、然后 open-scene 永不返回
    //    → 整个 scene 频道中毒。这条守卫是实测踩出来的。
    resetSceneHealth();
    const ctx = makeCtx();
    const handlers = createHandlers(ctx);

    // mock 的场景树根节点 uuid 是 'root-uuid'；
    // 让 query-asset-info 对应地返回它，模拟「要删的就是当前场景」
    const orig = ctx.msg;
    ctx.msg = async (channel, message, ...args) => {
        if (channel === 'asset-db' && message === 'query-asset-info') {
            return { name: 'x', url: args[0], uuid: 'root-uuid' };
        }
        return orig(channel, message, ...args);
    };

    await assert.rejects(
        () => handlers['asset.delete']({ url: 'db://assets/scenes/current.scene' }),
        /不能删除当前打开的场景/,
        '删除当前打开的场景必须被拦住'
    );
    const delCalls = ctx.calls.filter((c) => c[0] === 'asset-db' && c[1] === 'delete-asset');
    assert.strictEqual(delCalls.length, 0, '被拦住时绝不能真的发出 delete-asset');

    resetSceneHealth();
});

test('asset.delete：不是当前场景的资源照常能删', async () => {
    resetSceneHealth();
    const ctx = makeCtx();
    const handlers = createHandlers(ctx);
    const r = await handlers['asset.delete']({ url: 'db://assets/other.scene' });
    assert.ok(r && r.deleted, '普通资源应当能删');
    const delCalls = ctx.calls.filter((c) => c[0] === 'asset-db' && c[1] === 'delete-asset');
    assert.strictEqual(delCalls.length, 1, '应该真的发出一次 delete-asset');
    resetSceneHealth();
});

test('scene.close：引擎拒绝关闭时必须报错，不能报「已关闭」', async () => {
    // ⚠️ 实测 3.8.8 在 general edit mode 下关不掉普通场景：
    //    引擎返回 false 并打 "Trying to close current edit scene in general edit mode is not allowed"。
    //    之前这里无条件返回 closed:true —— 假成功。模型据此以为场景已关，
    //    接着去删资源/切场景，就会踩到后续一堆怪问题。
    resetSceneHealth();
    const ctx = makeCtx({
        msg: async (channel, message, ...args) => {
            if (channel === 'scene' && message === 'close-scene') return false;
            return true;
        },
    });
    const handlers = createHandlers(ctx);
    await assert.rejects(
        () => handlers['scene.close']({}),
        /引擎拒绝关闭/,
        '引擎拒绝关闭时必须明确报错，不能报 closed:true'
    );
    resetSceneHealth();
});

test('scene.close：引擎正常关闭时返回 closed:true', async () => {
    resetSceneHealth();
    const ctx = makeCtx();
    const handlers = createHandlers(ctx);
    const r = await handlers['scene.close']({});
    assert.ok(r && r.closed === true, '正常关闭时返回 closed:true');
    resetSceneHealth();
});

test('场景频道健康快照：给扩展面板用', async () => {
    // 面板要能一眼看出「场景频道已中毒」——
    // 因为中毒后所有场景工具都失败，而表现只是「超时」，
    // 用户在面板上看一眼就该知道该重启，而不是以为 MCP 装错了。
    const { sceneHealthSnapshot } = require('../extension/bridge/handlers');
    resetSceneHealth();
    const snap = sceneHealthSnapshot();
    assert.ok(snap && typeof snap === 'object', '能拿到健康快照');
    assert.strictEqual(snap.dead, false, '初始状态不是中毒');
    assert.ok(snap.probe && typeof snap.probe === 'string', '快照里要带上探活用的消息名');

    // 判死后快照要能反映出来
    const ctx = makeCtx({
        msg: async (channel, message, ...args) => {
            if (channel === 'scene' && message === snap.probe) await new Promise(() => {});
            return true;
        },
    });
    const handlers = createHandlers(ctx);
    await assert.rejects(() => handlers['scene.tree']({}), /场景频道/);
    await new Promise((r) => setTimeout(r, 8200));
    await assert.rejects(() => handlers['scene.tree']({}), /场景频道不可用/);
    const snap2 = sceneHealthSnapshot();
    assert.strictEqual(snap2.dead, true, '判死后快照要显示中毒');
    resetSceneHealth();
});

// ──────────────────── 场景频道健康闸门 ────────────────────

test('场景频道卡死时，场景操作**快速失败**而不是干等到超时', async () => {
    // ⚠️ 实测：一次 scene:open-scene 挂死之后，整个 scene 频道就不再回应，
    //    但 bridge/ping 照常正常。没有这道闸门，调用方拿到的是一堆
    //    「超时」这种没信息量的错误，看不出真正原因。
    resetSceneHealth();
    let probeCount = 0;
    const ctx = makeCtx({
        msg: async (channel, message, ...args) => {
            if (channel === 'scene' && message === 'query-dirty') {
                probeCount += 1;
                // 模拟「频道已死」：永不返回
                await new Promise(() => {});
            }
            return true;
        },
    });
    const handlers = createHandlers(ctx);

    const t0 = Date.now();
    await assert.rejects(
        () => handlers['scene.tree']({}),
        /场景频道|重启/,
        '频道死了必须给出可行动的提示，而不是干等'
    );
    const spent = Date.now() - t0;
    // 探活超时是 8s —— 绝不能拖到 30s+ 的操作超时
    assert.ok(spent < 20000, `失败应该很快返回，实际等了 ${spent}ms`);

    // 第一次失败只是「响应异常」，还不能判死（编辑器正忙时会这样）
    await assert.rejects(
        () => handlers['scene.tree']({}),
        /场景频道响应异常/,
        '第一次探活失败应报「响应异常」而不是直接判死'
    );
    assert.strictEqual(probeCount, 1, 'TTL 窗口内的后续调用必须继承上次探活结果，不能再发探活');

    // 跨过 TTL 之后再失败一次 → 判死
    await new Promise((r) => setTimeout(r, 8200));
    await assert.rejects(
        () => handlers['scene.tree']({}),
        /场景频道不可用/,
        '两个独立探活轮次都失败后才判死'
    );

    // 判死后：立刻失败，不再等探活超时
    const t1 = Date.now();
    await assert.rejects(
        () => handlers['scene.tree']({}),
        /场景频道不可用/,
        '判死后应立刻失败'
    );
    assert.ok(Date.now() - t1 < 3000, '判死后不应再等探活超时');

    resetSceneHealth();
});

test('并发调用共享同一次探活（不能各自发探活、也不能把一次忙碌算成多次失败）', async () => {
    // ⚠️ hub 侧同一批写入的多条 JSON-RPC 是**并发**分发的（server.js 里没有 await）。
    //    如果每个并发调用各自探活：
    //      - 一次「编辑器忙」会被按并发数累加到 failures → 误判成「频道已死」，
    //        把用户的场景功能整个锁死；
    //      - 而且探活消息会打出一堆。
    resetSceneHealth();
    let probeCount = 0;
    const ctx = makeCtx({
        msg: async (channel, message, ...args) => {
            if (channel === 'scene' && message === 'query-dirty') {
                probeCount += 1;
                await new Promise((r) => setTimeout(r, 50));
                return true;
            }
            return true;
        },
    });
    const handlers = createHandlers(ctx);

    const results = await Promise.allSettled([
        handlers['scene.tree']({}),
        handlers['scene.tree']({}),
        handlers['scene.tree']({}),
        handlers['scene.tree']({}),
    ]);
    assert.strictEqual(probeCount, 1, `4 个并发调用只应发 1 次探活，实际发了 ${probeCount} 次`);
    assert.ok(
        results.every((r) => r.status === 'fulfilled'),
        '并发调用都应该成功（频道是健康的）'
    );

    resetSceneHealth();
});

test('健康检查偶发失败不判死（编辑器忙的时候不能误锁）', async () => {
    // ⚠️ 一次失败就永久判死 = 把闸门本身变成新的故障源。
    //    编辑器正忙（构建 / 批量导入）时探活可能几秒不回。
    //    正确语义：第一次失败 → 报「响应异常，可重试」，**不判死**；
    //    TTL 窗口内的后续调用继承这个失败（不重复探活）；
    //    跨过 TTL 后再探一次 → 成功就恢复正常。
    resetSceneHealth();
    let failNext = true;
    const ctx = makeCtx({
        msg: async (channel, message, ...args) => {
            if (channel === 'scene' && message === 'query-dirty' && failNext) {
                failNext = false;
                throw new Error('模拟编辑器繁忙');
            }
            return true;
        },
    });
    const handlers = createHandlers(ctx);

    // 第一次：报「响应异常」而不是「不可用」—— 关键是没有被误判成频道已死
    await assert.rejects(
        () => handlers['scene.tree']({}),
        /场景频道响应异常/,
        '第一次失败应报「响应异常（可重试）」，不能直接判死'
    );
    // TTL 窗口内：继承失败，不重复探活，也不升级成「不可用」
    await assert.rejects(
        () => handlers['scene.tree']({}),
        /场景频道响应异常/,
        'TTL 窗口内应继承上次的失败结果，不升级成判死'
    );

    // 跨过 TTL → 重新探活 → 成功 → 恢复正常
    await new Promise((r) => setTimeout(r, 8200));
    const res = await handlers['scene.tree']({});
    assert.ok(res && Array.isArray(res.nodes), '探活恢复后应正常工作，不该把频道锁死');
    resetSceneHealth();
});

test('场景频道健康状态是可恢复的（健康检查通过就不拦）', async () => {
    resetSceneHealth();
    const ctx = makeCtx();
    const handlers = createHandlers(ctx);
    const res = await handlers['scene.tree']({});
    assert.ok(res && Array.isArray(res.nodes), '频道健康时应正常返回');
    resetSceneHealth();
});
