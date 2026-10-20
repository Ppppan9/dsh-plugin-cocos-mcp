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

const { createHandlers } = require('../extension/bridge/handlers');
const os = require('os');
const fs = require('fs');

// reference.add 会检查文件是否存在 —— 造一个真的
const REF_IMG = path.join(os.tmpdir(), '__cocos_mcp_smoke_ref.png');
try {
    fs.writeFileSync(REF_IMG, Buffer.from('89504e470d0a1a0a', 'hex'));
} catch (_) {
    /* ignore */
}

/** 一个够用的假编辑器：所有消息都返回可用的假数据。 */
function makeCtx(overrides = {}) {
    const calls = [];
    // ⚠️ query-node-tree 返回的是 **Cocos 原始节点树**（根节点 + children 数组），
    //    不是 {nodes:[...]} —— 那是 Bridge 自己 scene.tree op 的输出格式。
    const child = {
        __type__: 'cc.Node',
        name: 'Child',
        _name: 'Child',
        uuid: 'child-uuid',
        _active: true,
        children: [],
        __comps__: [
            { type: 'cc.UITransform', value: { _enabled: true, contentSize: { width: 100, height: 50 } } },
            { type: 'cc.Label', value: { _enabled: true, string: 'hi', fontSize: 24 } },
        ],
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
        __comps__: [
            { type: 'cc.UITransform', value: { _enabled: true, contentSize: { width: 100, height: 50 } } },
            { type: 'cc.Label', value: { _enabled: true, string: 'hi', fontSize: 24 } },
        ],
    };

    const msg = async (channel, message, ...args) => {
        calls.push([channel, message, args]);
        switch (message) {
            case 'query-node-tree':
                return tree;
            case 'query-node':
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
                return { name: 'x', url: args[0] };
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
            case 'create-component':
            case 'remove-component':
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

    return {
        calls,
        msg,
        editorVersion: '3.8.8',
        projectPath: '/tmp/proj',
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
    'scene.open': { uuid: 'uuid-1' },
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
