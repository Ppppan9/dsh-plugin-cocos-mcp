'use strict';

/**
 * 事务 undo 日志的单元测试
 * ---------------------------------------------------------------------------
 * 用一个假的 ctx 模拟编辑器，验证「失败后按逆序撤销」的正确性 ——
 * 这部分逻辑不依赖真机，可以确定性测试。
 *
 * 运行：node --test hub/test/*.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { runTransaction, findCompIndex, rollbackAll, isOutcomeUnknown, sceneRootUuid, findNodeByNameUnder } = require('../src/tools/transaction');

/** 模拟一个极简场景：节点表 + 组件表。 */
function makeScene() {
    const nodes = new Map(); // uuid -> {uuid, name, parent, active, position, scale, rotation, comps:[], children:[]}
    const comps = new Map(); // uuid -> {type, props}
    let seq = 0;

    function addNode(parent, name, opts = {}) {
        const uuid = 'n' + ++seq;
        const parentNode = parent ? nodes.get(parent) : null;
        const n = {
            uuid,
            name,
            parent: parent || null,
            // path / depth 必须随节点一起维护 ——
            // 事务模块的兜底查找按 path 前缀定位同名节点，路径不对就找不到。
            path: parentNode ? `${parentNode.path}/${name}` : name,
            depth: parentNode ? parentNode.depth + 1 : 0,
            active: opts.active !== false,
            position: opts.position || { x: 0, y: 0, z: 0 },
            scale: opts.scale || { x: 1, y: 1, z: 1 },
            rotation: opts.rotation || { x: 0, y: 0, z: 0, w: 1 },
            comps: [],
            children: [],
        };
        nodes.set(uuid, n);
        if (parent) nodes.get(parent).children.push(uuid);
        return n;
    }

    const ctx = {
        state: { nodes, comps },
        calls: [],
        /** 真实 bridge 支持 uuid / 名字两种写法，假 ctx 也要还原这个能力。 */
        find(ref) {
            return nodes.get(ref) || [...nodes.values()].find((x) => x.name === ref);
        },
        async call(op, args) {
            this.calls.push({ op, args });
            switch (op) {
                case 'scene.tree': {
                    // scene.tree 是 **Bridge op**，返回 {root, count, nodes}，
                    // 不是 Cocos 原始节点树 —— hub 侧的事务模块依赖这个形状。
                    const list = [];
                    for (const n of nodes.values()) {
                        list.push({
                            uuid: n.uuid,
                            name: n.name,
                            path: n.path,
                            depth: n.depth,
                            type: 'cc.Node',
                            active: n.active,
                            components: n.comps.map((c) => comps.get(c).type),
                            children: n.children.map((u) => ({ uuid: u })),
                        });
                    }
                    return { root: list[0] ? list[0].name : '', count: list.length, nodes: list };
                }
                case 'scene.node': {
                    const n = this.find(args.node);
                    if (!n) throw new Error(`找不到节点 "${args.node}"`);
                    return {
                        uuid: n.uuid,
                        name: n.name,
                        components: n.comps.map((c) => ({ index: n.comps.indexOf(c), type: comps.get(c).type })),
                        dump: {
                            name: n.name,
                            active: n.active,
                            position: n.position,
                            scale: n.scale,
                            rotation: n.rotation,
                            parent: n.parent ? { uuid: n.parent } : null,
                            children: n.children.map((uuid) => ({ uuid })),
                            __comps__: n.comps.map((c) => ({
                                type: comps.get(c).type,
                                value: { ...comps.get(c).props },
                            })),
                        },
                    };
                }
                case 'node.create': {
                    const n = addNode(args.parent, args.name);
                    return { uuid: n.uuid, name: n.name };
                }
                case 'node.delete': {
                    const n = this.find(args.node);
                    if (!n) throw new Error(`找不到节点 "${args.node}"`);
                    nodes.delete(n.uuid);
                    return { deleted: n.uuid };
                }
                case 'node.move': {
                    const n = this.find(args.node);
                    const p = this.find(args.parent);
                    if (!n || !p) throw new Error('节点或父节点不存在');
                    if (n.parent) {
                        const old = nodes.get(n.parent);
                        old.children = old.children.filter((u) => u !== n.uuid);
                    }
                    n.parent = p.uuid;
                    p.children.push(n.uuid);
                    return { moved: n.uuid };
                }
                case 'node.active': {
                    const n = this.find(args.node);
                    if (!n) throw new Error('节点不存在');
                    n.active = args.active;
                    return { uuid: n.uuid, active: n.active };
                }
                case 'node.transform': {
                    const n = this.find(args.node);
                    if (!n) throw new Error('节点不存在');
                    if (args.position) n.position = args.position;
                    if (args.scale) n.scale = args.scale;
                    if (args.rotation) n.rotation = args.rotation;
                    return { uuid: n.uuid };
                }
                case 'component.add': {
                    const n = this.find(args.node);
                    if (!n) throw new Error('节点不存在');
                    const id = 'c' + ++seq;
                    comps.set(id, { type: args.component, props: {} });
                    n.comps.push(id);
                    return { uuid: n.uuid, component: args.component, added: true };
                }
                case 'component.remove': {
                    const n = this.find(args.node);
                    if (!n) throw new Error('节点不存在');
                    const i = n.comps.findIndex((c) => comps.get(c).type === args.component);
                    if (i < 0) throw new Error(`没有组件 ${args.component}`);
                    n.comps.splice(i, 1);
                    return { removed: true };
                }
                case 'component.set': {
                    const n = this.find(args.node);
                    if (!n) throw new Error('节点不存在');
                    const i = n.comps.findIndex((c) => comps.get(c).type === args.component);
                    if (i < 0) throw new Error(`没有组件 ${args.component}`);
                    comps.get(n.comps[i]).props[args.property] = args.value;
                    return { ok: true };
                }
                default:
                    throw new Error(`未实现的 op: ${op}`);
            }
        },
    };
    return ctx;
}

test('失败的事务会撤销已完成的步骤', async () => {
    const ctx = makeScene();
    const root = await ctx.call('node.create', { parent: null, name: 'Root' });

    const r = await runTransaction(
        [
            { op: 'node.create', args: { parent: root.uuid, name: 'A' } },
            { op: 'node.create', args: { parent: root.uuid, name: 'B' } },
            { op: 'node.active', args: { node: '不存在的节点', active: false } },
        ],
        ctx,
        {
            execute: async (op) => {
                if (op.op === 'node.create') return ctx.call('node.create', op.args);
                if (op.op === 'node.active') return ctx.call('node.active', op.args);
                throw new Error('未知 op');
            },
        }
    );

    assert.strictEqual(r.ok, false, '事务应失败');
    assert.strictEqual(r.rolledBack, true, '应报告已回滚');
    const names = [...ctx.state.nodes.values()].map((n) => n.name);
    assert.deepStrictEqual(names, ['Root'], '只应剩下 Root，实际：' + names.join(','));
});

test('成功的事务不做任何撤销', async () => {
    const ctx = makeScene();
    const root = await ctx.call('node.create', { parent: null, name: 'Root' });

    const r = await runTransaction(
        [
            { op: 'node.create', args: { parent: root.uuid, name: 'A' } },
            { op: 'node.active', args: { node: 'A', active: false } },
        ],
        ctx,
        {
            execute: async (op) => {
                if (op.op === 'node.create') return ctx.call('node.create', op.args);
                if (op.op === 'node.active') return ctx.call('node.active', op.args);
                throw new Error('未知 op');
            },
        }
    );

    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.committed, 2);
    assert.strictEqual(ctx.state.nodes.size, 2, 'Root + A');
    assert.strictEqual([...ctx.state.nodes.values()].find((n) => n.name === 'A').active, false);
});

test('component.set 失败时旧值被恢复', async () => {
    const ctx = makeScene();
    const root = await ctx.call('node.create', { parent: null, name: 'Root' });
    const label = await ctx.call('node.create', { parent: root.uuid, name: 'L' });
    await ctx.call('component.add', { node: label.uuid, component: 'cc.Label' });
    await ctx.call('component.set', { node: label.uuid, component: 'cc.Label', property: 'string', value: 'ORIGINAL' });

    const r = await runTransaction(
        [
            { op: 'component.set', args: { node: label.uuid, component: 'cc.Label', property: 'string', value: 'CHANGED' } },
            { op: 'node.active', args: { node: '不存在的节点', active: false } },
        ],
        ctx,
        {
            execute: async (op) => {
                if (op.op === 'component.set') return ctx.call('component.set', op.args);
                if (op.op === 'node.active') return ctx.call('node.active', op.args);
                throw new Error('未知 op');
            },
        }
    );

    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.rolledBack, true);
    const comps = [...ctx.state.comps.values()];
    assert.strictEqual(comps.find((c) => c.type === 'cc.Label').props.string, 'ORIGINAL', '旧值必须被恢复');
});

test('不可逆的操作被直接拒绝并说明原因', async () => {
    const ctx = makeScene();
    const r = await runTransaction([{ op: 'component.call', args: { node: 'x', method: 'play' } }], ctx, {
        execute: async () => ({}),
    });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /component\.call/);
    assert.match(r.error, /无法撤销|不能放进事务/);
});

test('node.delete 带子节点时拒绝纳入事务', async () => {
    const ctx = makeScene();
    const root = await ctx.call('node.create', { parent: null, name: 'Root' });
    const parent = await ctx.call('node.create', { parent: root.uuid, name: 'P' });
    await ctx.call('node.create', { parent: parent.uuid, name: 'Child' });

    const r = await runTransaction([{ op: 'node.delete', args: { node: parent.uuid } }], ctx, {
        execute: async () => ({}),
    });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /子节点/);
});

test('node.delete 叶子节点失败后可被重建', async () => {
    const ctx = makeScene();
    const root = await ctx.call('node.create', { parent: null, name: 'Root' });
    const leaf = await ctx.call('node.create', { parent: root.uuid, name: 'Leaf' });
    await ctx.call('component.add', { node: leaf.uuid, component: 'cc.Label' });
    await ctx.call('component.set', { node: leaf.uuid, component: 'cc.Label', property: 'string', value: 'KEEP' });

    const r = await runTransaction(
        [
            { op: 'node.delete', args: { node: leaf.uuid } },
            { op: 'node.active', args: { node: '不存在的节点', active: false } },
        ],
        ctx,
        {
            execute: async (op) => {
                if (op.op === 'node.delete') {
                    ctx.state.nodes.delete(op.args.node);
                    return { deleted: op.args.node };
                }
                if (op.op === 'node.active') return ctx.call('node.active', op.args);
                throw new Error('未知 op');
            },
        }
    );

    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.rolledBack, true, '回滚错误：' + JSON.stringify(r.rollbackErrors));
    const names = [...ctx.state.nodes.values()].map((n) => n.name);
    assert.ok(names.includes('Leaf'), 'Leaf 应被重建，实际：' + names.join(','));
    const restored = [...ctx.state.nodes.values()].find((n) => n.name === 'Leaf');
    const label = [...ctx.state.comps.values()].find((c) => c.type === 'cc.Label');
    assert.strictEqual(label.props.string, 'KEEP', '标量属性应被恢复');
});

test('findCompIndex 支持完全匹配与后缀匹配', () => {
    const dump = { __comps__: [{ type: 'cc.UITransform' }, { type: 'cc.Label' }, { type: 'MyUI' }] };
    assert.strictEqual(findCompIndex(dump, 'cc.Label'), 1);
    assert.strictEqual(findCompIndex(dump, 'MyUI'), 2);
    // 后缀匹配是有意设计：'Label' 应命中 'cc.Label'
    assert.strictEqual(findCompIndex(dump, 'Label'), 1);
    assert.strictEqual(findCompIndex(dump, 'cc.Nope'), -1);
    assert.strictEqual(findCompIndex(dump, 'Nope'), -1);
});

test('rollbackAll 逆序撤销并汇总错误', async () => {
    const order = [];
    const journal = [
        { label: 'a', undo: async () => order.push('a') },
        { label: 'b', undo: async () => order.push('b') },
        { label: 'c', undo: async () => { throw new Error('炸了'); } },
    ];
    const r = await rollbackAll(journal, {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(order.length, 2);
    assert.strictEqual(order[0], 'b', '必须逆序：先撤销 b 再撤销 a');
    assert.strictEqual(r.errors.length, 1);
    assert.match(r.errors[0], /炸了/);
});

// ────────────────────────────── 本轮新增能力的行为测试 ──────────────────────────────

test('isOutcomeUnknown：超时/桥接不可达算「结果未知」，其它不算', () => {
    assert.strictEqual(isOutcomeUnknown({ code: 'TIMEOUT' }), true);
    assert.strictEqual(isOutcomeUnknown({ code: 'BRIDGE_UNREACHABLE' }), true);
    assert.strictEqual(isOutcomeUnknown({ code: 'BRIDGE_ERROR' }), false);
    assert.strictEqual(isOutcomeUnknown(new Error('普通失败')), false);
});

test('★ 结果未知时不能谎报「已回滚」', async () => {
    const ctx = makeScene();
    const root = await ctx.call('node.create', { parent: null, name: 'Root' });
    let n = 0;
    const r = await runTransaction(
        [
            { op: 'node.create', args: { parent: root.uuid, name: 'A' } },
            // 用一个**存在**的节点 —— 计划阶段要能成功，
            // 故障必须发生在**执行阶段**（编辑器可能已执行、只是响应没回来）
            { op: 'node.active', args: { node: root.uuid, active: false } },
        ],
        ctx,
        {
            execute: async (op) => {
                if (op.op === 'node.create') return ctx.call('node.create', op.args);
                // 模拟「编辑器可能已执行、但响应超时」
                const e = new Error('请求超时（30000ms）');
                e.code = 'TIMEOUT';
                throw e;
            },
        }
    );
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.outcomeUnknown, true, '应标记为结果未知');
    assert.strictEqual(r.rolledBack, false, '★ 结果未知时不得声称已回滚');
});

test('rollback:false 时不做回滚，并如实标记', async () => {
    const ctx = makeScene();
    const root = await ctx.call('node.create', { parent: null, name: 'Root' });
    const r = await runTransaction(
        [
            { op: 'node.create', args: { parent: root.uuid, name: 'A' } },
            { op: 'node.active', args: { node: '不存在的节点', active: false } },
        ],
        ctx,
        {
            rollback: false,
            execute: async (op) => {
                if (op.op === 'node.create') return ctx.call('node.create', op.args);
                throw new Error('失败');
            },
        }
    );
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.rolledBack, false);
    assert.strictEqual(r.rollbackSkipped, true, '应明确标记「按要求跳过回滚」');
    // 节点应当还在（没回滚）
    assert.ok([...ctx.state.nodes.values()].some((n) => n.name === 'A'), 'rollback:false 时节点应保留');
});

test('sceneRootUuid 能取到场景根', async () => {
    const ctx = makeScene();
    const root = await ctx.call('node.create', { parent: null, name: 'Root' });
    const child = await ctx.call('node.create', { parent: root.uuid, name: 'Child' });
    const r = await sceneRootUuid(ctx);
    assert.ok(r, '应能取到根节点 uuid');
});

test('★ findNodeByNameUnder：父节点解析不出来时必须放弃（不瞎删）', async () => {
    const ctx = makeScene();
    const root = await ctx.call('node.create', { parent: null, name: 'Root' });
    await ctx.call('node.create', { parent: root.uuid, name: 'Button' });
    const other = await ctx.call('node.create', { parent: root.uuid, name: 'Other' });
    await ctx.call('node.create', { parent: other.uuid, name: 'Button' });
    // 父节点不存在 → 必须返回 null（而不是匹配到某个同名节点）
    assert.strictEqual(await findNodeByNameUnder(ctx, '不存在的父节点', 'Button'), null);
    // 父节点存在但同名子节点有多个 → 也不确定 → null
    assert.strictEqual(await findNodeByNameUnder(ctx, root.uuid, 'Button'), null);
    // 唯一命中 → 返回它
    const only = await ctx.call('node.create', { parent: other.uuid, name: 'Unique' });
    assert.ok(await findNodeByNameUnder(ctx, other.uuid, 'Unique'));
});

test('node.delete 的 undo 会把 rotation 按角度恢复（四元数不能直接下发）', async () => {
    const ctx = makeScene();
    const root = await ctx.call('node.create', { parent: null, name: 'Root' });
    const leaf = await ctx.call('node.create', { parent: root.uuid, name: 'Leaf' });
    // 场景 dump 里 rotation 是四元数
    const origCall = ctx.call.bind(ctx);
    ctx.call = async (op, args) => {
        if (op === 'scene.node') {
            const r = await origCall(op, args);
            r.dump.rotation = { x: 0, y: 0, z: 0.7071, w: 0.7071 };
            return r;
        }
        return origCall(op, args);
    };
    const calls = [];
    ctx.call = (async (op, args) => {
        calls.push([op, args]);
        return origCall(op, args);
    });

    const r = await runTransaction(
        [
            { op: 'node.delete', args: { node: leaf.uuid } },
            { op: 'node.active', args: { node: '不存在的节点', active: false } },
        ],
        ctx,
        {
            execute: async (op) => {
                if (op.op === 'node.delete') {
                    ctx.state.nodes.delete(op.args.node);
                    return { deleted: op.args.node };
                }
                throw new Error('失败');
            },
        }
    );
    assert.strictEqual(r.ok, false);
    const transformCall = calls.find((c) => c[0] === 'node.transform' && c[1] && c[1].rotation !== undefined);
    assert.ok(transformCall, 'undo 应下发 rotation');
    assert.strictEqual(typeof transformCall[1].rotation, 'number', '★ rotation 必须是角度（数字），不能是四元数');
});
