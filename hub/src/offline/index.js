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
        // ⚠️ **读**也要过护栏 ——
        //    之前只有 editPrefab / editAnimation 有，queryPrefab / queryAnimation 没有。
        //    这个模块的定位是「独立的可复用单元」，不能假设调用方一定检查过
        //    （assertOpPathAllowed 的注释就是这么写的）。
        //    顶层调用方（hub）本来也守着，这里是同一套 roots 的第二道闸。
        if (Array.isArray(args.allowedRoots)) {
            assertOpPathAllowed(ctxForGuard(args.allowedRoots), path.resolve(filePath), 'prefab 路径');
        }
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
        // ⚠️ 读路径也要过护栏 —— 同 queryPrefab，这个模块不能假设调用方检查过
        if (Array.isArray(args.allowedRoots)) {
            assertOpPathAllowed(ctxForGuard(args.allowedRoots), path.resolve(filePath), 'anim 路径');
        }
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

/**
 * 准备阶段：校验 + 在内存里执行 op + 序列化 + 算 diff，**完全不写盘**。
 *
 * 拆出来是为了让批量编辑能做真正的**两阶段提交** ——
 * 之前每个文件各自「执行 + 写盘」，第 3 个文件失败时，
 * 前 2 个文件**已经写进磁盘**了（跨文件非原子）。
 *
 * @returns {{ok:true,data:object}|{ok:false,error:string}}
 */
function preparePrefab(args) {
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

    return ok({
        filePath,
        originalText,
        newText,
        allChanges,
        steps: results,
        metaPlans: ctx.metaPlans.slice(),
    });
}

/** 提交阶段：.meta 先行，主文件最后；中途失败由 commitPlans 自动回滚本组。 */
function commitPrepared(plan) {
    const plans = plan.metaPlans.slice();
    plans.push({
        path: plan.filePath,
        content: plan.newText,
        existed: true,
        backupContent: plan.originalText,
    });
    return commitPlans(plans);
}

/**
 * 回滚已提交的文件 —— 用 prepare 阶段记下的 backupContent，
 * 与 commitPlans 内部回滚是同一份数据。
 * @returns {number} 实际恢复的写入处数
 */
function rollbackPrepared(preparedList) {
    let n = 0;
    for (const p of preparedList) {
        if (!p.plan.allChanges.length) continue; // 没改过的文件不必碰
        const plans = p.plan.metaPlans.map((m) => ({
            path: m.path,
            existed: m.existed,
            backupContent: m.backupContent,
        }));
        plans.push({ path: p.plan.filePath, existed: true, backupContent: p.plan.originalText });
        for (const plan of plans) {
            try {
                if (plan.existed && plan.backupContent !== null) {
                    atomicWrite(plan.path, plan.backupContent);
                    n++;
                } else if (fs.existsSync(plan.path)) {
                    fs.unlinkSync(plan.path);
                    n++;
                }
            } catch (_) {
                /* 回滚尽力而为 */
            }
        }
    }
    return n;
}

function editPrefab(args) {
    try {
        const prepared = preparePrefab(args);
        if (!prepared.ok) return prepared;
        const p = prepared.data;

        // 3) dryRun → 只返回 diff
        if (args.dryRun) {
            return ok({
                filePath: p.filePath,
                dryRun: true,
                wouldChange: p.allChanges.length,
                diff: p.allChanges,
                steps: p.steps,
                pendingMeta: p.metaPlans.map((m) => m.path),
            });
        }

        // 4) 提交：.meta 先行，主文件最后；中途失败自动回滚
        //
        // ⚠️ **没有任何实际改动时不要写盘** ——
        //    写盘不只是「多一次 I/O」：它会走一遍「写临时文件 → rename 覆盖」，
        //    期间原文件是**被替换过**的（进程此刻被杀就可能留下残file），
        //    而且 mtime 变了会让编辑器/构建系统以为资源变了。
        //    零效果的 op（例如把节点名改成它本来的名字）应该**什么都不做**。
        if (p.allChanges.length === 0) {
            return ok({
                filePath: p.filePath,
                changed: 0,
                diff: [],
                steps: p.steps,
                written: [],
                noop: true,
            });
        }
        const written = commitPrepared(p);
        return ok({
            filePath: p.filePath,
            changed: p.allChanges.length,
            diff: p.allChanges,
            steps: p.steps,
            written,
        });
    } catch (e) {
        return err(e);
    }
}

/**
 * 只解析 ops 文件，**不执行**。
 *
 * 单独暴露出来，是为了让上层能在**写盘前**检查 op 里的路径 ——
 * 之前 hub 层那个检查读的是 `res.data.ops`，
 * 而 editPrefab / batchPrefab 的返回里**根本没有 ops 字段**
 * → 那道护栏从来没生效过（看着有、其实没有）。
 *
 * batchPrefab 自己也走这个函数，避免两处解析逻辑漂移。
 */
function peekBatchOps(opsJsonPath) {
    if (!opsJsonPath) return err('缺少 opsJsonPath');
    if (!fs.existsSync(opsJsonPath)) return err(`ops 文件不存在：${opsJsonPath}`);
    let parsed;
    try {
        parsed = JSON.parse(readTextFile(opsJsonPath));
    } catch (e) {
        return err(`ops 文件不是合法 JSON：${e.message}`);
    }

    // ⚠️ 顺序：**先**判多文件形态 ——
    //    之前「必须有 ops」的守卫排在 files 分支**前面**，
    //    于是 {files:[...]}（没有 ops 字段）在到达 files 分支前就被拦掉，
    //    多文件形态**根本进不去**。
    if (!Array.isArray(parsed) && Array.isArray(parsed.files)) {
        return ok({ mode: 'multi', files: parsed.files });
    }
    const ops = Array.isArray(parsed) ? parsed : parsed && parsed.ops;
    if (!Array.isArray(ops)) return err('ops 文件内容必须是数组，或含 ops 数组字段');
    const target = parsed && parsed.filePath;
    if (!target) return err('ops 文件里没有 filePath 字段');
    return ok({ mode: 'single', filePath: target, ops });
}

/**
 * 多文件批量：**两阶段提交**。
 *
 * ⚠️ 之前每个文件各自「执行 + 写盘」—— 第 3 个文件失败时，
 *    前 2 个文件已经写进磁盘了（跨文件非原子）。
 *    调用方看到「批量失败」，通常会以为什么都没发生 →
 *    工程就停在半改的状态，而且没人知道。
 *
 * 现在：
 *   阶段 1  所有文件只 prepare（零写入）→ 任何 op 失败都在**没写任何东西**时暴露
 *   阶段 2  才提交；提交中途失败（磁盘错误之类）→ 回滚已写的文件
 */
function batchMultiFile(files, args) {
    if (!files.length) return err('files 是空数组，没有可执行的文件');
    for (const f of files) {
        if (!f || typeof f !== 'object') return err('files 里每一项都必须是对象');
        if (!f.filePath) return err('files 里每一项都必须有 filePath');
        if (!Array.isArray(f.ops) || !f.ops.length) {
            return err(`files 里 "${f.filePath}" 必须有非空 ops 数组`);
        }
    }

    // ── 阶段 1：全部 prepare，磁盘零写入 ──
    const prepared = [];
    for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const r = preparePrefab({ filePath: f.filePath, ops: f.ops, allowedRoots: args.allowedRoots });
        if (!r.ok) {
            return err(
                `第 ${i + 1}/${files.length} 个文件准备失败（磁盘未发生任何写入）：${f.filePath}\n${r.error}`
            );
        }
        prepared.push({ file: f, plan: r.data });
    }

    if (args.dryRun) {
        // ⚠️ dryRun 的每项字段也要和**单文件 dryRun** 一致 ——
        //    单文件 dryRun 返回 {filePath, dryRun, wouldChange, diff, steps, pendingMeta}，
        //    这里少了 steps / pendingMeta（消费方读它们会静默拿到 undefined）。
        //    同一个工具的两种形态、两个分支，响应契约都不能分叉。
        return ok({
            mode: 'multi',
            dryRun: true,
            files: prepared.map((p) => ({
                filePath: p.file.filePath,
                dryRun: true,
                wouldChange: p.plan.allChanges.length,
                diff: p.plan.allChanges,
                steps: p.plan.steps,
                pendingMeta: p.plan.metaPlans.map((m) => m.path),
            })),
        });
    }

    // ── 阶段 2：提交 ──
    const results = [];
    for (let i = 0; i < prepared.length; i++) {
        const p = prepared[i];
        // ⚠️ 每项的字段要和**单文件**模式一致 ——
        //    之前多文件少了 diff / steps，消费方读它们会静默拿到 undefined。
        //    两种模式是同一个工具的两种形态，响应契约不该分叉。
        const base = {
            filePath: p.file.filePath,
            ok: true,
            changed: p.plan.allChanges.length,
            diff: p.plan.allChanges,
            steps: p.plan.steps,
            written: [],
        };
        if (!p.plan.allChanges.length) {
            // 零效果的 op 不写盘（和单文件模式一致）
            results.push({ ...base, noop: true });
            continue;
        }
        try {
            const written = commitPrepared(p.plan);
            results.push({ ...base, written });
        } catch (e) {
            const rolled = rollbackPrepared(prepared.slice(0, i));
            return err(
                `第 ${i + 1}/${prepared.length} 个文件写入失败：${p.file.filePath}\n${e.message}\n` +
                (rolled
                    ? `已回滚 ${rolled} 处写入，磁盘已恢复到本批次开始前的状态。`
                    : '没有文件被写入，磁盘未发生变化。')
            );
        }
    }
    return ok({ mode: 'multi', files: results });
}

function batchPrefab(args) {
    try {
        const peeked = peekBatchOps(args && args.opsJsonPath);
        if (!peeked.ok) return peeked;
        const plan = peeked.data;
        if (plan.mode === 'multi') return batchMultiFile(plan.files, args);
        return editPrefab({
            filePath: plan.filePath,
            ops: plan.ops,
            dryRun: args.dryRun,
            allowedRoots: args.allowedRoots,
        });
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

        // ⚠️ **.anim 也要过路径护栏** —— 之前只有 editPrefab 有，
        //    editAnimation 完全没有（纵深防御缺口：独立复用这个模块时，
        //    就能改到项目外的文件）。语义与 editPrefab 一致：
        //    null = 不限制（独立 CLI 用），[] = 拒绝一切，非空 = 限定在这些根下。
        if (Array.isArray(args.allowedRoots)) {
            assertOpPathAllowed(ctxForGuard(args.allowedRoots), path.resolve(filePath), 'anim 路径');
        }

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
    peekBatchOps,
    queryAnimation,
    editAnimation,
    // 便于测试与复用
    _internal: { computeDiff, validateOps, OP_DEFS, ANIM_OP_DEFS, preparePrefab, commitPrepared },
};
