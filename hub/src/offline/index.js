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
const { OP_DEFS, HANDLERS, validateOps, buildClassIdIndex, findProjectRoot, findNodeIndex, nodeComponents, splitPath, getPath, assertOpPathAllowed } = require('./ops');
const { ANIM_HANDLERS, ANIM_OP_DEFS, executeAnimOps } = require('./anim');
const { compressUUID } = require('./id');

function ok(data) {
    return { ok: true, data };
}

/** 护栏用的最小 ctx（只需要 allowedRoots）。 */
function ctxForGuard(allowedRoots) {
    return { allowedRoots };
}
function err(message) {
    return { ok: false, error: String(message && message.message ? message.message : message) };
}

/**
 * 列出可用的 op。
 * @param {string} [domain] 'prefab' | 'anim' | 不传=全部
 *
 * 每个 op 带 domain 标记 —— cocos_prefab_ops / cocos_anim_ops 两个工具
 * 靠它分域，否则「prefab 工具却返回 anim op」这种描述与实现不符的问题
 * 会被掩盖过去。
 */
function listOps(domain) {
    const out = [];
    for (const [name, def] of Object.entries(OP_DEFS)) {
        out.push({
            name,
            domain: 'prefab',
            required: def.required,
            optional: def.optional,
            description: def.description,
            mutates: true,
        });
    }
    for (const [name, def] of Object.entries(ANIM_OP_DEFS)) {
        out.push({
            name,
            domain: 'anim',
            required: def.required,
            optional: def.optional,
            description: def.description,
            mutates: true,
        });
    }
    if (!domain) return out;
    const want = String(domain).toLowerCase();
    return out.filter((o) => o.domain === want);
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

        // ⚠️ filePath 本身也要过护栏 ——
        //    batchPrefab 的目标文件来自 ops JSON 文件，hub 只校验了那个 JSON 的位置，
        //    结果项目 A 里的 ops.json 可以改写项目 B 的文件。
        // ⚠️ 不能加 `.length` 判断 —— 那会把「显式空数组」当成「没配置」，
        //    导致同一个 [] 在 filePath 层放行、在 op 层拒绝，语义相反。
        //    null / [] / 非空 三种语义由 assertOpPathAllowed 自己区分。
        if (Array.isArray(args.allowedRoots)) {
            assertOpPathAllowed(ctxForGuard(args.allowedRoots), path.resolve(filePath), 'prefab 路径');
        }
        const originalText = readTextFile(filePath);
        const originalData = parseJsonText(originalText, filePath);
        const ctx = loadPrefabForEdit(filePath);
        ctx.projectRoot = findProjectRoot(filePath);
        ctx.classIdIndex = buildClassIdIndex(ctx.projectRoot);
        ctx.metaPlans = [];
        ctx.planMetaWrite = planMetaWrite;
        ctx.allowedRoots = Array.isArray(args.allowedRoots) ? args.allowedRoots.slice() : null;

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
        // .meta 的写入也是真实改动，必须出现在 diff 里 ——
        // 否则「改了但 diff 显示 0 处变化」，调用方会以为没改。
        const metaChanges = ctx.metaPlans.map((plan) => ({
            index: -1,
            type: plan.existed ? 'meta-modified' : 'meta-created',
            summary: `meta ${plan.existed ? '已更新' : '已创建'}: ${path.basename(plan.path)}`,
        }));
        const allChanges = diff.concat(metaChanges);

        // 3) dryRun → 只返回 diff
        if (args.dryRun) {
            return ok({
                filePath,
                dryRun: true,
                wouldChange: allChanges.length,
                diff: allChanges,
                steps: results,
                pendingMeta: ctx.metaPlans.map((p) => p.path),
            });
        }

        // 4) 提交：.meta 先行，主文件最后；中途失败自动回滚
        //
        // ⚠️ **没有任何实际改动时不要写盘** ——
        //    写盘不只是「多一次 I/O」：它会走一遍「写临时文件 → rename 覆盖」，
        //    期间原文件是**被替换过**的（进程此刻被杀就可能留下残file），
        //    而且 mtime 变了会让编辑器/构建系统以为资源变了。
        //    零效果的 op（例如把节点名改成它本来的名字）应该**什么都不做**。
        if (allChanges.length === 0) {
            return ok({
                filePath,
                changed: 0,
                diff: [],
                steps: results,
                written: [],
                noop: true,
            });
        }
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
            changed: allChanges.length,
            diff: allChanges,
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
                const r = editPrefab({ filePath: f.filePath, ops: f.ops, dryRun: args.dryRun, allowedRoots: args.allowedRoots });
                results.push({ filePath: f.filePath, ok: r.ok, error: r.error, changed: r.data && r.data.changed });
            }
            const failed = results.filter((r) => !r.ok);
            if (failed.length) return err(`${failed.length} 个文件失败：\n` + failed.map((f) => `  - ${f.filePath}: ${f.error}`).join('\n'));
            return ok({ mode: 'multi', files: results });
        }

        const target = parsed && parsed.filePath;
        if (!target) return err('ops 文件里没有 filePath 字段');
        return editPrefab({ filePath: target, ops, dryRun: args.dryRun, allowedRoots: args.allowedRoots });
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
    _internal: { computeDiff, validateOps, OP_DEFS, ANIM_OP_DEFS },
};
