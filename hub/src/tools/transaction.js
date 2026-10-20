'use strict';

/**
 * 场景事务 —— 自带 undo 日志的真回滚
 * ---------------------------------------------------------------------------
 * ## 为什么自己实现
 *
 * 实测 Cocos Creator 3.8.8：**公开编辑器消息里没有可用的回滚原语**。
 *
 *   scene:snapshot → scene:snapshot-abort
 *     建 2 个节点后调 snapshot-abort，节点数不变（3 → 4 → 4，没回滚）
 *   scene:begin-recording → scene:cancel-recording
 *     建 2 个节点后调 cancel-recording，节点数不变（4 → 6 → 6，没回滚）
 *     改一个 Label 的 string 后调 cancel-recording，值也不回滚
 *
 * 官方 i18n 描述表里写着 "Begin node recording for undo" / "Cancel node recording for undo"，
 * 但 3.8.8 的行为跟描述对不上。所以不能依赖它。
 *
 * ## 怎么做
 *
 * 「先记账、失败时按账反向撤销」：
 *   执行每个 op 之前先捕获它的**逆操作**，全部记进 undo 日志；
 *   任一步失败 → 按日志**逆序**逐条撤销。
 *
 * ## 可逆性分级
 *
 * 完全可逆（已实现 + 有测试）：
 *   node.create / node.duplicate / node.move / node.active / node.transform
 *   component.add / component.set / component.remove（标量属性可完整恢复）
 *
 * 部分可逆：
 *   node.delete —— 只支持**叶子节点**（没有子节点）；有子节点时直接拒绝，
 *     因为子树的重建无法保证完全一致。恢复时只还原标量属性。
 *
 * 不可逆（事务里直接拒绝，并说明原因）：
 *   component.call —— 可能触发任意副作用（发请求、播动画、跳场景）
 *   scene.save     —— 会把中间态写盘，撤销也救不回来
 *   asset.*        —— 改的是资源文件不是场景状态，不参与场景事务
 */

const SCALAR = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/** 从解包后的节点 dump 里按组件类型找下标。 */
function findCompIndex(dump, compType) {
    const comps = (dump && dump.__comps__) || [];
    for (let i = 0; i < comps.length; i++) {
        if (comps[i].type === compType) return i;
    }
    for (let i = 0; i < comps.length; i++) {
        const t = comps[i].type || '';
        if (t.endsWith('.' + compType)) return i;
    }
    return -1;
}

/** 节点 dump → 可恢复的精简状态。 */
async function captureNode(ctx, nodeRef) {
    const r = await ctx.call('scene.node', { node: nodeRef });
    const dump = r.dump || {};
    const comps = (dump.__comps__ || []).map((c) => {
        const props = {};
        for (const [k, v] of Object.entries(c.value || {})) {
            if (SCALAR(v)) props[k] = v;
        }
        return { type: c.type, props };
    });
    return {
        uuid: r.uuid,
        name: r.name,
        dump,   // 供 findCompIndex 查旧值
        parentUuid: dump.parent && dump.parent.uuid ? dump.parent.uuid : null,
        position: dump.position || null,
        scale: dump.scale || null,
        rotation: dump.rotation || null,
        active: dump.active !== false,
        childCount: Array.isArray(dump.children) ? dump.children.length : 0,
        components: comps,
    };
}

/**
 * 为一个 op 生成「撤销动作」。
 * @returns {{undo: Function, note?: string}}
 */
async function planUndo(op, ctx) {
    const name = op.op;
    const args = op.args || {};

    switch (name) {
        case 'node.create': {
            let createdUuid = null;
            return {
                undo: async () => {
                    if (createdUuid) await ctx.call('node.delete', { node: createdUuid, confirm: true });
                },
                capture: (r) => {
                    createdUuid = r && r.uuid;
                },
            };
        }
        case 'node.duplicate': {
            let newUuids = [];
            return {
                undo: async () => {
                    for (const u of newUuids) await ctx.call('node.delete', { node: u, confirm: true });
                },
                capture: (r) => {
                    newUuids = (r && r.newUuids) || [];
                },
            };
        }
        case 'node.move': {
            const before = await captureNode(ctx, args.node);
            return {
                undo: async () => {
                    if (before.parentUuid) {
                        await ctx.call('node.move', { node: args.node, parent: before.parentUuid });
                    }
                },
            };
        }
        case 'node.active': {
            const before = await captureNode(ctx, args.node);
            return {
                undo: async () => {
                    await ctx.call('node.active', { node: args.node, active: before.active });
                },
            };
        }
        case 'node.transform': {
            const before = await captureNode(ctx, args.node);
            return {
                undo: async () => {
                    const undoArgs = { node: args.node };
                    if (before.position) undoArgs.position = before.position;
                    if (before.scale) undoArgs.scale = before.scale;
                    if (before.rotation) undoArgs.rotation = before.rotation;
                    if (Object.keys(undoArgs).length > 1) {
                        await ctx.call('node.transform', undoArgs);
                    }
                },
            };
        }
        case 'component.add': {
            return {
                undo: async () => {
                    await ctx.call('component.remove', { node: args.node, component: args.component, confirm: true });
                },
            };
        }
        case 'component.set': {
            const before = await captureNode(ctx, args.node);
            const idx = findCompIndex(before.dump, args.component);
            const oldValue =
                idx >= 0 && before.dump.__comps__[idx].value
                    ? before.dump.__comps__[idx].value[args.property]
                    : undefined;
            if (oldValue === undefined) {
                // 读不到旧值 → 无法安全撤销
                throw new Error(
                    `component.set 无法回滚：读不到 "${args.component}.${args.property}" 的旧值` +
                    `（节点 "${args.node}"）。请先确认属性名正确。`
                );
            }
            return {
                undo: async () => {
                    await ctx.call('component.set', {
                        node: args.node,
                        component: args.component,
                        property: args.property,
                        value: oldValue,
                    });
                },
            };
        }
        case 'component.remove': {
            const before = await captureNode(ctx, args.node);
            const idx = findCompIndex(before.dump, args.component);
            if (idx < 0) {
                throw new Error(
                    `component.remove 无法回滚：节点 "${args.node}" 上没有 "${args.component}"。` +
                    `现有组件：${(before.dump.__comps__ || []).map((c) => c.type).join('、') || '(无)'}`
                );
            }
            const props = {};
            for (const [k, v] of Object.entries(before.dump.__comps__[idx].value || {})) {
                if (SCALAR(v)) props[k] = v;
            }
            return {
                undo: async () => {
                    await ctx.call('component.add', { node: args.node, component: args.component });
                    for (const [k, v] of Object.entries(props)) {
                        try {
                            await ctx.call('component.set', {
                                node: args.node,
                                component: args.component,
                                property: k,
                                value: v,
                            });
                        } catch (_) {
                            /* 某些属性不可写，忽略 */
                        }
                    }
                },
                note: 'component.remove 只能恢复标量属性',
            };
        }
        case 'node.delete': {
            const before = await captureNode(ctx, args.node);
            if (before.childCount > 0) {
                throw new Error(
                    `node.delete 无法回滚：节点 "${before.name}" 有 ${before.childCount} 个子节点，` +
                    '子树重建无法保证完全一致。请在事务外删除带子节点的节点。'
                );
            }
            return {
                undo: async () => {
                    const created = await ctx.call('node.create', {
                        parent: before.parentUuid || args.parent,
                        name: before.name,
                    });
                    const newUuid = created.uuid;
                    try {
                        if (before.position) await ctx.call('node.transform', { node: newUuid, position: before.position });
                        if (before.scale) await ctx.call('node.transform', { node: newUuid, scale: before.scale });
                        if (before.active === false) await ctx.call('node.active', { node: newUuid, active: false });
                        for (const c of before.components) {
                            if (c.type === 'cc.UITransform' || c.type === 'cc.Node') continue;
                            try {
                                await ctx.call('component.add', { node: newUuid, component: c.type });
                            } catch (_) {
                                continue;
                            }
                            for (const [k, v] of Object.entries(c.props || {})) {
                                try {
                                    await ctx.call('component.set', {
                                        node: newUuid,
                                        component: c.type,
                                        property: k,
                                        value: v,
                                    });
                                } catch (_) {
                                    /* 忽略不可写属性 */
                                }
                            }
                        }
                    } catch (_) {
                        /* 尽力而为 */
                    }
                },
                note: 'node.delete 只能恢复叶子节点与标量属性',
            };
        }
        case 'component.call':
            throw new Error(
                'component.call 不能放进事务：它可能触发任意副作用（发请求、播动画、跳场景），无法撤销。' +
                '请在事务外单独调用。'
            );
        case 'scene.save':
            throw new Error(
                'scene.save 不能放进事务：保存会把中间态写盘，之后撤销也救不回来。' +
                '请在事务成功后单独保存。'
            );
        case 'scene.transaction':
            throw new Error('不能嵌套事务。');
        default:
            throw new Error(
                `操作 "${name}" 没有定义撤销方式，不能放进事务。` +
                '可放进事务的操作：node.create / node.duplicate / node.delete / node.move / node.active / ' +
                'node.transform / component.add / component.remove / component.set'
            );
    }
}

/**
 * 执行一个事务。
 * @param {object[]} ops
 * @param {object} ctx  {call(op, args)}
 * @param {object} opts {execute: (op) => Promise<any>}
 */
async function runTransaction(ops, ctx, opts = {}) {
    const execute = opts.execute;
    const journal = []; // {label, undo, note}
    const steps = [];

    for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        const label = `第 ${i + 1} 步 op "${op.op}"`;

        // 1) 先捕获逆操作（这一步只读，不改状态）
        let plan;
        try {
            plan = await planUndo(op, ctx);
        } catch (e) {
            const rollback = await rollbackAll(journal, ctx);
            return {
                ok: false,
                error: `${label} 无法纳入事务：${e.message}`,
                rolledBack: rollback.ok,
                rollbackErrors: rollback.errors,
                completed: steps.length,
            };
        }

        // 2) 执行
        let result;
        try {
            result = await execute(op);
            if (plan.capture) plan.capture(result);
        } catch (e) {
            // 3) 执行失败 → 逆序撤销
            const rollback = await rollbackAll(journal, ctx);
            return {
                ok: false,
                error: `${label} 执行失败：${e.message}`,
                rolledBack: rollback.ok,
                rollbackErrors: rollback.errors,
                completed: steps.length,
            };
        }

        journal.push({ label, undo: plan.undo, note: plan.note });
        steps.push({ step: i + 1, op: op.op, result: result === undefined ? null : result });
    }

    return { ok: true, committed: steps.length, steps };
}

/** 逆序撤销。 */
async function rollbackAll(journal, ctx) {
    const errors = [];
    for (let i = journal.length - 1; i >= 0; i--) {
        const entry = journal[i];
        try {
            await entry.undo();
        } catch (e) {
            errors.push(`${entry.label} 的撤销失败：${e.message}`);
        }
    }
    return { ok: errors.length === 0, errors };
}

module.exports = { runTransaction, planUndo, captureNode, findCompIndex, rollbackAll };
