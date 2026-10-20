'use strict';

/**
 * 离线 prefab / animation 编辑器 —— 对外接口
 * ---------------------------------------------------------------------------
 * 事务语义（关键）：
 *   所有 op 先在内存副本上执行；**任一 op 抛错 → 磁盘保持字节不变**。
 *   连 ensure-meta 产生的 .meta 也只写「计划」，等全部 op 成功才一起提交；
 *   提交阶段若中途失败，会回滚已写入的文件（含删除新建的 .meta）。
 *
 * 原子写：先写同目录临时文件，再 rename 覆盖 —— 写中断不会留截断文件。
 */

const fs = require('node:fs');
const path = require('node:path');

const {
    loadPrefab,
    loadPrefabForEdit,
    loadAnim,
    isPlainObject,
    typeOf,
    displayName,
    isStubNode,
    stubRealName,
    instanceForNode,
} = require('./parse');
const { readTextFile, parseJsonText, detectFormat, serializeJson, atomicWrite, planMetaWrite, commitPlans } = require('./write');
const { OP_DEFS, ANIM_OPS, HANDLERS, validateOps, buildClassIdIndex, findProjectRoot, findNodeIndex, nodeComponents, splitPath, getPath } = require('./ops');
const { ANIM_HANDLERS, ANIM_OP_DEFS, executeAnimOps } = require('./anim');
const { compressUUID } = require('./id');

function ok(data) {
    return { ok: true, data };
}
function err(message) {
    return { ok: false, error: String(message && message.message ? message.message : message) };
}

/** 列出全部 op。 */
function listOps() {
    const out = [];
    for (const [name, def] of Object.entries(OP_DEFS)) {
        out.push({
            name,
            required: def.required,
            optional: def.optional,
            description: def.description,
            mutates: true,
        });
    }
    for (const [name, def] of Object.entries(ANIM_OPS)) {
        out.push({
            name,
            required: def.required,
            optional: def.optional,
            description: def.description,
            mutates: true,
        });
    }
    return out;
}

// ─────────────────────────────────────────────────────────────
// 查询
// ─────────────────────────────────────────────────────────────

function nodeView(ctx, idx, depth) {
    const info = ctx.nodes.get(idx);
    const stub = isStubNode(ctx, idx);
    const inst = instanceForNode(ctx, idx);
    return {
        uuid: `__id__${idx}`,
        index: idx,
        name: displayName(ctx, idx),
        path: info.path,
        depth: info.depth,
        active: ctx.data[idx]._active,
        isStub: stub,
        stubAsset: stub && inst ? inst.asset : null,
        type: ctx.data[idx].__type__ || 'cc.Node',
        components: nodeComponents(ctx, idx).map((c) => c.type),
        children: (info.children || []).map((c) => c.index),
    };
}

function queryPrefab(args) {
    try {
        const { filePath, selector } = args || {};
        if (!filePath) return err('缺少 filePath');
        if (!fs.existsSync(filePath)) return err(`文件不存在：${filePath}`);
        const ctx = loadPrefab(filePath);

        switch (selector) {
            case 'tree': {
                const maxDepth = args.maxDepth === undefined ? Infinity : Number(args.maxDepth);
                const nodes = ctx.nodeOrder
                    .filter((i) => ctx.nodes.get(i).depth <= maxDepth)
                    .map((i) => nodeView(ctx, i));
                return ok({
                    filePath,
                    root: displayName(ctx, ctx.rootIndex),
                    count: nodes.length,
                    nodes,
                });
            }
            case 'node': {
                const idx = findNodeIndex(ctx, args.target);
                const view = nodeView(ctx, idx);
                const inst = instanceForNode(ctx, idx);
                return ok({
                    filePath,
                    node: view,
                    properties: ctx.data[idx],
                    overrides: inst
                        ? inst.overrides.map((o) => ({
                              propertyPath: o.propertyPath,
                              value: o.value,
                              localID: o.localID,
                          }))
                        : [],
                });
            }
            case 'find': {
                const kw = String(args.target || '').toLowerCase();
                const nodes = ctx.nodeOrder
                    .map((i) => nodeView(ctx, i))
                    .filter((n) => n.name.toLowerCase().includes(kw));
                return ok({ filePath, count: nodes.length, nodes });
            }
            case 'field': {
                const idx = findNodeIndex(ctx, args.target);
                const segs = splitPath(args.property || '');
                const value = getPath(ctx.data[idx], segs);
                return ok({ filePath, node: displayName(ctx, idx), property: args.property, value });
            }
            case 'overrides': {
                const idx = findNodeIndex(ctx, args.target);
                const inst = instanceForNode(ctx, idx);
                if (!inst) return ok({ filePath, node: displayName(ctx, idx), isStub: false, overrides: [] });
                return ok({
                    filePath,
                    node: displayName(ctx, idx),
                    isStub: true,
                    asset: inst.asset,
                    overrides: inst.overrides.map((o) => ({
                        propertyPath: o.propertyPath,
                        value: o.value,
                        localID: o.localID,
                    })),
                });
            }
            default:
                return err(`未知 selector "${selector}"，可用：tree / node / find / field / overrides`);
        }
    } catch (e) {
        return err(e);
    }
}

function queryAnimation(args) {
    try {
        const { filePath, selector } = args || {};
        if (!filePath) return err('缺少 filePath');
        if (!fs.existsSync(filePath)) return err(`文件不存在：${filePath}`);
        const ctx = loadAnim(filePath);

        const allChannels = [];
        for (const track of ctx.tracks) {
            for (const ch of track.channels) allChannels.push(ch);
        }
        if (selector === 'tree') {
            const channels = allChannels.map((c) => ({ path: c.path, type: c.channel.__type__ || 'cc.Curve' }));
            return ok({ filePath, count: channels.length, channels });
        }
        if (selector === 'node' || selector === 'find') {
            const kw = String(args.target || '').toLowerCase();
            const channels = allChannels.filter((c) => String(c.path).toLowerCase().includes(kw));
            return ok({
                filePath,
                count: channels.length,
                channels: channels.map((c) => ({
                    path: c.path,
                    type: c.channel.__type__ || 'cc.Curve',
                    keys: (c.channel.keys || []).length,
                })),
            });
        }
        if (selector === 'field') {
            const kw = String(args.target || '').toLowerCase();
            const channels = allChannels.filter((c) => String(c.path).toLowerCase().includes(kw));
            return ok({
                filePath,
                channels: channels.map((c) => ({ path: c.path, channel: c.channel })),
            });
        }
        return err(`未知 selector "${selector}"，可用：tree / node / find / field`);
    } catch (e) {
        return err(e);
    }
}

// ─────────────────────────────────────────────────────────────
// 编辑
// ─────────────────────────────────────────────────────────────

/** 字段级 diff（只报告变化的元素索引与关键差异）。 */
function computeDiff(originalData, newData) {
    const changes = [];
    const max = Math.max(originalData.length, newData.length);
    for (let i = 0; i < max; i++) {
        const a = originalData[i];
        const b = newData[i];
        if (JSON.stringify(a) === JSON.stringify(b)) continue;
        if (a === undefined) {
            changes.push({ index: i, type: 'added', summary: describeElement(b) });
        } else if (b === undefined) {
            changes.push({ index: i, type: 'removed', summary: describeElement(a) });
        } else {
            changes.push({ index: i, type: 'modified', summary: describeElement(b) });
        }
    }
    return changes;
}

function describeElement(el) {
    if (!isPlainObject(el)) return String(el);
    const t = el.__type__ || 'unknown';
    const n = el._name || el.name || '';
    return n ? `${t} "${n}"` : t;
}

function editPrefab(args) {
    try {
        const { filePath, ops } = args || {};
        if (!filePath) return err('缺少 filePath');
        if (!fs.existsSync(filePath)) return err(`文件不存在：${filePath}`);
        if (!Array.isArray(ops) || !ops.length) return err('ops 必须是非空数组');

        // 1) 校验（一次性报齐所有错误）
        const errors = validateOps(ops, OP_DEFS);
        if (errors.length) {
            return err(
                `op 校验未通过（${errors.length} 处）：\n` +
                errors.map((e) => `  - ${e.message}`).join('\n')
            );
        }

        const originalText = readTextFile(filePath);
        const originalData = parseJsonText(originalText, filePath);
        const ctx = loadPrefabForEdit(filePath);
        ctx.projectRoot = findProjectRoot(filePath);
        ctx.classIdIndex = buildClassIdIndex(ctx.projectRoot);
        ctx.metaPlans = [];
        ctx.planMetaWrite = planMetaWrite;

        // 2) 逐 op 在内存执行
        const results = [];
        for (let i = 0; i < ops.length; i++) {
            const op = ops[i];
            const handler = HANDLERS[op.op];
            if (!handler) return err(`第 ${i + 1} 个 op "${op.op}" 没有执行器`);
            try {
                const r = handler(ctx, op);
                results.push({ step: i + 1, op: op.op, result: r });
            } catch (e) {
                // 失败 → 磁盘零写入（连 .meta 计划都不提交）
                return err(
                    `第 ${i + 1} 步 op "${op.op}" 执行失败：${e.message}\n` +
                    `（磁盘未发生任何写入，前 ${i} 步的结果已全部丢弃）`
                );
            }
        }

        const newText = serializeJson(ctx.data, ctx.format);
        const diff = computeDiff(originalData, ctx.data);

        // 3) dryRun → 只返回 diff
        if (args.dryRun) {
            return ok({
                filePath,
                dryRun: true,
                wouldChange: diff.length,
                diff,
                steps: results,
                pendingMeta: ctx.metaPlans.map((p) => p.path),
            });
        }

        // 4) 提交：.meta 先行，主文件最后；中途失败自动回滚
        const plans = ctx.metaPlans.slice();
        plans.push({
            path: filePath,
            content: newText,
            existed: true,
            backupContent: originalText,
        });
        const written = commitPlans(plans);
        return ok({
            filePath,
            changed: diff.length,
            diff,
            steps: results,
            written,
        });
    } catch (e) {
        return err(e);
    }
}

function batchPrefab(args) {
    try {
        const { opsJsonPath } = args || {};
        if (!opsJsonPath) return err('缺少 opsJsonPath');
        if (!fs.existsSync(opsJsonPath)) return err(`ops 文件不存在：${opsJsonPath}`);
        let parsed;
        try {
            parsed = JSON.parse(readTextFile(opsJsonPath));
        } catch (e) {
            return err(`ops 文件不是合法 JSON：${e.message}`);
        }
        const ops = Array.isArray(parsed) ? parsed : parsed && parsed.ops;
        if (!Array.isArray(ops)) return err('ops 文件内容必须是数组，或含 ops 数组字段');

        // 支持 [{filePath, ops:[...]}] 的多文件形态
        if (!Array.isArray(parsed) && Array.isArray(parsed.files)) {
            const results = [];
            for (const f of parsed.files) {
                const r = editPrefab({ filePath: f.filePath, ops: f.ops, dryRun: args.dryRun });
                results.push({ filePath: f.filePath, ok: r.ok, error: r.error, changed: r.data && r.data.changed });
            }
            const failed = results.filter((r) => !r.ok);
            if (failed.length) return err(`${failed.length} 个文件失败：\n` + failed.map((f) => `  - ${f.filePath}: ${f.error}`).join('\n'));
            return ok({ mode: 'multi', files: results });
        }

        const target = parsed && parsed.filePath;
        if (!target) return err('ops 文件里没有 filePath 字段');
        return editPrefab({ filePath: target, ops, dryRun: args.dryRun });
    } catch (e) {
        return err(e);
    }
}

function editAnimation(args) {
    try {
        const { filePath, ops } = args || {};
        if (!filePath) return err('缺少 filePath');
        if (!fs.existsSync(filePath)) return err(`文件不存在：${filePath}`);
        if (!Array.isArray(ops) || !ops.length) return err('ops 必须是非空数组');

        const errors = validateOps(ops, ANIM_OP_DEFS);
        if (errors.length) {
            return err(`op 校验未通过（${errors.length} 处）：\n` + errors.map((e) => `  - ${e.message}`).join('\n'));
        }

        const originalText = readTextFile(filePath);
        const ctx = loadAnim(filePath);
        const originalData = JSON.parse(originalText);

        try {
            executeAnimOps(ctx, ops);
        } catch (e) {
            return err(`anim op 执行失败：${e.message}\n（磁盘未发生任何写入）`);
        }

        const newText = serializeJson(ctx.data, ctx.format);
        const diff = computeDiff(originalData, ctx.data);
        if (args.dryRun) {
            return ok({ filePath, dryRun: true, wouldChange: diff.length, diff });
        }
        commitPlans([{ path: filePath, content: newText, existed: true, backupContent: originalText }]);
        return ok({ filePath, changed: diff.length, diff });
    } catch (e) {
        return err(e);
    }
}

module.exports = {
    listOps,
    queryPrefab,
    editPrefab,
    batchPrefab,
    queryAnimation,
    editAnimation,
    // 便于测试与复用
    _internal: { computeDiff, validateOps, OP_DEFS, ANIM_OPS },
};
