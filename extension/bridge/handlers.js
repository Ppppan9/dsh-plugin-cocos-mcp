'use strict';

const fs = require('fs');
const path = require('path');

const { verify } = require('./messages');

/**
 * 编辑器消息的默认超时（毫秒）。
 *
 * ⚠️ 必须有：实测一次 scene:open-scene 失败（资源还没导入完）之后，
 *    **整个 scene 频道会卡住** —— bridge/ping 正常，但 query-node-tree 永远不返回。
 *    没有超时的话调用方只能干等到客户端超时，且错误信息毫无信息量。
 */
const DEFAULT_MESSAGE_TIMEOUT_MS = 30000;

/**
 * 引擎侧 `scene:open-scene` 的单次超时（毫秒）。
 *
 * ⚠️ 一次给足，**不重试**（见调研报告 6.10 / 6.11）：
 *    实测引擎在资产库做 auto refresh 时打开场景要 26~54 秒；
 *    超时设短了会把「慢但最终成功」误判成失败，而失败后的重试
 *    是在引擎**半开着的状态**下继续折腾 —— 那才真的把 scene 频道搞死。
 *    实测最慢一次 53.8s，这里给到 90s 留足余量。
 */
const SCENE_OPEN_TIMEOUT_MS = 90000;

/**
 * 打开场景时顺带查一下资源名的超时（毫秒）。
 * 查不到不影响打开，所以给个小预算，不让它在关键路径上磨时间。
 */
const SCENE_OPEN_NAME_TIMEOUT_MS = 5000;

/**
 * Bridge 侧 `scene.open` 的**最坏耗时预算**（毫秒）。
 *
 * 逐项累加（每一步都可能用满自己的超时）：
 *   1. 打开前的探活          ≤ SCENE_HEALTH_TIMEOUT_MS
 *   2. 查资源名（可选）      ≤ SCENE_OPEN_NAME_TIMEOUT_MS
 *   3. open-scene 本身       ≤ SCENE_OPEN_TIMEOUT_MS
 *   4. 失败后的强制复探       ≤ SCENE_HEALTH_TIMEOUT_MS
 *
 * ⚠️ 这个数字是**导出的**，不是让测试去正则解析源码 ——
 *    正则解析有实测过的静默失效（`60_000` 数字分隔符、`60e3` 科学计数法、
 *    常量改名后被 `|| 兜底` 吞掉……），一旦失效断言会永远为真而不报错。
 */
function sceneOpenBudgetMs() {
    return (
        SCENE_HEALTH_TIMEOUT_MS +      // 打开前的探活
        SCENE_OPEN_NAME_TIMEOUT_MS +   // 查资源名（锦上添花，失败不影响流程）
        SCENE_OPEN_TIMEOUT_MS +         // open-scene 本身
        SCENE_HEALTH_TIMEOUT_MS        // 失败后的强制复探
    );
}

/**
 * 编辑器侧操作层
 * ---------------------------------------------------------------------------
 * 这里是「hub 说人话 → 编辑器认的协议」的唯一翻译层。
 *
 * 三个关键设计：
 * 1. **节点三态解析**：node 参数同时接受 uuid / 层级路径 / 节点名，
 *    agent 不必先去查 uuid 再回来调用（现存实现里这是失败率最高的一环）。
 * 2. **值类型推断**：set-property 需要 {value, type}，type 决定编辑器怎么反序列化。
 *    这里根据值形状 + 路径语义自动推断（cc.Vec3 / cc.Color / cc.Size / cc.Node / ...）。
 * 3. **消息白名单前置校验**：任何 Editor.Message 调用在发出前先过 verify()。
 */

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// Cocos 的短 uuid 是 22 字符 base64 风格（字符集 0-9a-zA-Z-_），**不是十六进制**。
// 之前按 hex 判会把 "62g8xkpqdJbZJCzFSSRkFV" 这类真实 uuid 当成节点名去树里找，必然找不到。
//
// ⚠️ 字符集**必须包含 `+` 和 `/`** —— 真实引擎会产出这两种字符
//    （真机实测："cbguKOUmRESoTWvkSFxlH+"、"d67EOER/ZLSLW84UxP+nMW"）。
//    漏掉它们的后果很隐蔽：这种 uuid 匹配不上 → 被当成节点名去场景树里找
//    → 节点刚建出来时树还没重建 → 间歇性报「找不到节点」。
const SHORT_UUID_RE = /^[A-Za-z0-9_+\/-]{22}$/;

function isUuidLike(s) {
    if (typeof s !== 'string') return false;
    return UUID_RE.test(s) || SHORT_UUID_RE.test(s);
}

// ─────────────────────────────────────────────────────────────
// 节点解析
// ─────────────────────────────────────────────────────────────

/** 把 INode 树压成轻量结构，保留 uuid / 名字 / 层级路径。 */
function slimNode(node, parentPath = '', out = []) {
    if (!node || typeof node !== 'object') return out;
    const name = readName(node);
    const path = parentPath ? `${parentPath}/${name}` : name;
    const entry = {
        uuid: readUuid(node),
        name,
        path,
        type: node.__type__ || 'cc.Node',
        active: readValue(node.active),
        depth: path.split('/').length - 1,
    };
    // 实测：scene:query-node-tree 的返回里**不含** __comps__（只有 scene:query-node 才有）。
    // 所以这里只在确实拿到组件时才输出 components 字段 —— 输出空数组会让模型
    // 误以为「这个节点没有组件」。组件清单请用 scene.node / component.list。
    if (Array.isArray(node.__comps__)) {
        entry.components = node.__comps__.map((c, i) => readCompType(c) || `unknown#${i}`);
    }
    out.push(entry);
    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) slimNode(child, path, out);
    return out;
}

function readValue(p) {
    if (p === null || p === undefined) return p;
    if (typeof p === 'object' && 'value' in p) return p.value;
    return p;
}

function readUuid(node) {
    const u = node && node.uuid;
    if (typeof u === 'string') return u;
    if (u && typeof u === 'object' && typeof u.value === 'string') return u.value;
    return null;
}

function readName(node) {
    if (!node || typeof node !== 'object') return '<unnamed>';
    const n = node.name;
    if (typeof n === 'string' && n) return n;
    if (n && typeof n === 'object' && typeof n.value === 'string' && n.value) return n.value;
    return node.__name__ || '<unnamed>';
}

function readCompType(comp) {
    if (!comp || typeof comp !== 'object') return null;
    if (typeof comp.__type__ === 'string') return comp.__type__;
    if (typeof comp.type === 'string') return comp.type;
    const v = comp.value;
    if (v && typeof v === 'object' && typeof v.__type__ === 'string') return v.__type__;
    return null;
}

/** 在扁平节点列表里按 uuid / 名字 / 路径匹配。 */
function matchNodes(flat, ref) {
    if (!ref) return [];
    // 1) uuid 精确匹配优先 —— 任何字符集的 uuid 都能命中
    const byUuid = flat.filter((n) => n.uuid === ref);
    if (byUuid.length) return byUuid;
    const lower = String(ref).toLowerCase();
    const exactPath = flat.filter((n) => n.path.toLowerCase() === lower);
    if (exactPath.length) return exactPath;
    const byPathSuffix = flat.filter((n) => n.path.toLowerCase().endsWith('/' + lower));
    if (byPathSuffix.length) return byPathSuffix;
    const byName = flat.filter((n) => n.name.toLowerCase() === lower);
    if (byName.length) return byName;
    const fuzzy = flat.filter((n) => n.name.toLowerCase().includes(lower));
    return fuzzy;
}

/**
 * 场景树缓存
 * ---------------------------------------------------------------------------
 * 节点解析（uuid / 路径 / 名字）都需要场景树。场景树查询一次要几十毫秒，
 * 而一个典型工作流里会连续解析好几个节点 —— 所以缓存 2 秒。
 * 任何写操作（建/删/移节点、改属性、场景生命周期）都会让缓存失效。
 */
const TREE_TTL_MS = 2000;
const treeCache = new Map(); // ctx 无关，全进程一份（编辑器主进程只有一个）

/**
 * 场景频道健康状态
 * ---------------------------------------------------------------------------
 * ⚠️ 这是本项目被咬得最狠的一个坑：
 *    Cocos 的 `scene:open-scene` 在某些情况下**既不 resolve 也不 reject**
 *    （引擎内部只打一行 "SceneFacadeManager.openScene timeout"）。
 *    之后**整个 scene 频道从此不再回应** —— query-node-tree / query-node
 *    全部永远不返回，但 bridge/ping 一切正常。
 *
 *    没有这道闸门时，调用方的体验是：
 *      scene.open  → 干等 135 秒 → 报「超时」
 *      scene.tree  → 干等 30 秒 → 报「超时」
 *      scene.save  → 干等 30 秒 → 报「超时」
 *    每一条都是「超时」，完全看不出真正的原因是「频道已经死了，要重启编辑器」。
 *
 * 这道闸门把「沉默地干等」变成「立刻失败 + 可行动的提示」。
 */
const SCENE_DEAD_HINT =
    'Cocos 的场景频道已经卡死（场景状态查询不再回应）。所有场景操作都会失败。' +
    '请**重启 Cocos Creator** —— 扩展面板的「重启 Bridge」只清掉我们这边的闸门状态，' +
    '清不掉引擎侧卡住的状态（点了也没用）。' +
    '重启之前可以继续用离线 prefab/animation 编辑器。';

/** @type {{dead: boolean, failures: number, lastProbeAt: number, lastProbeError: string|null, firstFailureAt: number}} */
const sceneHealth = {
    dead: false,
    failures: 0,
    lastProbeAt: 0,
    lastProbeError: null,
    firstFailureAt: 0,
};
/** 健康检查结果的缓存时间（毫秒）—— 太频繁会拖慢每一次场景调用。 */
let SCENE_HEALTH_TTL_MS = 8000;
/** 健康检查本身的超时 —— 必须远小于正常操作的超时，才能起到「快速失败」的作用。 */
let SCENE_HEALTH_TIMEOUT_MS = 8000;
/** 连续失败多少次才判定频道已死（避免编辑器忙的时候误判）。 */
let SCENE_HEALTH_MAX_FAILURES = 2;
/**
 * 「持续无响应多久」才判定为彻底卡死（而不是暂时无响应）。
 *
 * ⚠️ 实测：编辑器启动时资产库会做一次 auto refresh（场景进程被重载），
 *    这期间 `query-dirty` / `query-node-tree` 会**暂时**不响应，
 *    刷新结束后自己就恢复了（实测 30 秒后一切正常）。
 *    所以**不能因为两次失败就判死** —— 那会把一个暂态窗口
 *    变成「整个会话的场景工具全废」。
 *
 *    只有持续超过这个时长，才认定为引擎侧真的卡住、必须重启编辑器。
 */
let SCENE_HEALTH_DEAD_AFTER_MS = 180000;
/** 判定已死后，多久允许再探一次（给自愈留机会）。 */
const SCENE_DEAD_REPROBE_MS = 30000;

/**
 * ⚠️ 探活必须用**场景状态查询**类消息，不能用 `query-is-ready`。
 *
 * 实测（频道中毒后）：`query-is-ready` **3ms 就正常返回**，
 * 而 `query-node-tree` / `query-dirty` **永久挂起**。
 * 也就是说 `query-is-ready` 探不出真正的病灶 ——
 * 用它探活等于闸门一直显示「健康」，然后每次操作照旧干等 30 秒。
 *
 * `query-dirty` 正好卡在中间：它是场景状态查询（中毒时会挂），
 * 但不像 `query-node-tree` 那样要回传整棵树，代价小得多。
 */
const SCENE_HEALTH_PROBE = 'query-dirty';

/**
 * 发一条带超时的消息，并在结束后清掉定时器。
 * ⚠️ 没有超时的话，频道卡死时调用会**永久挂起**（既不 resolve 也不 reject）。
 */
async function sendWithTimeout(ctx, channel, message, args = [], timeoutMs = DEFAULT_MESSAGE_TIMEOUT_MS, hint = '') {
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const err = new Error(
                `编辑器消息 "${channel}:${message}" 超时（${timeoutMs}ms 未返回）。` + (hint || '')
            );
            err.code = 'EDITOR_MESSAGE_TIMEOUT';
            reject(err);
        }, timeoutMs);
    });
    try {
        return await Promise.race([ctx.msg(channel, message, ...args), timeout]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * 单次探活（single-flight）。
 *
 * ⚠️ 必须 single-flight，理由（实测会真的踩到）：
 *   hub 侧同一批写入的多条 JSON-RPC 是**并发**分发的（`server.js` 里没有 await），
 *   Bridge 侧每个 HTTP 请求也是独立 async 处理。
 *   如果每个并发调用各自发一次探活：
 *     - 会同时打出多条探活消息，浪费；
 *     - 探活失败会被**按并发数**累加到 failures —— 一次「编辑器忙」就可能
 *       攒够 2 次而被误判成「频道已死」，把用户的场景功能整个锁死。
 *   所以：并发调用**共享同一个探活 promise**，failures 按**探活轮次**累加。
 */
let healthProbeInFlight = null;

async function runHealthProbe(ctx) {
    try {
        await sendWithTimeout(ctx, 'scene', SCENE_HEALTH_PROBE, [], SCENE_HEALTH_TIMEOUT_MS);
        sceneHealth.dead = false;
        sceneHealth.failures = 0;
        sceneHealth.lastProbeError = null;
        sceneHealth.firstFailureAt = 0;
        return { ok: true };
    } catch (e) {
        sceneHealth.failures += 1;
        if (!sceneHealth.firstFailureAt) sceneHealth.firstFailureAt = Date.now();
        return { ok: false, error: e.message, failures: sceneHealth.failures };
    }
}

/**
 * 确认场景频道还活着；死了就立刻抛错，不让调用方干等。
 *
 * ⚠️ 三处必须小心，否则闸门本身会变成新的故障源：
 *   1. **不能一次失败就判死** —— 编辑器正忙（比如在构建、在导入大批资源）时，
 *      探活可能几秒不回。一次失败就永久判死，会把用户的场景工具
 *      全部锁死，而且再也回不来。所以要**两个独立的探活轮次**都失败才判死。
 *   2. **判死后要允许自愈** —— 频道未必真的死了（引擎侧可能只是暂时卡住）。
 *      每 30 秒给一次机会重新探活，探活成功就恢复。
 *   3. **失败结果必须被后来者继承** —— 缓存里存的是「失败」时，
 *      TTL 窗口内的后续调用必须**继承这个失败**，不能当成放行。
 *      （之前把 `checkedAt` 在探活**发出前**就写上，导致探活一失败，
 *        接下来 8 秒闸门完全敞开，`failures` 永远攒不到 2 → 闸门形同虚设。）
 */
async function assertSceneChannelAlive(ctx) {
    const now = Date.now();
    if (sceneHealth.dead) {
        // 判死了也定期给一次自愈机会
        if (now - sceneHealth.lastProbeAt < SCENE_DEAD_REPROBE_MS) {
            const err = new Error(
                `场景频道不可用：${SCENE_DEAD_HINT}` +
                `（闸门会在 ${Math.ceil((SCENE_DEAD_REPROBE_MS - (now - sceneHealth.lastProbeAt)) / 1000)} 秒后自动重试一次。）`
            );
            err.code = 'SCENE_CHANNEL_DEAD';
            throw err;
        }
        sceneHealth.lastProbeAt = now;
    } else if (sceneHealth.lastProbeAt && now - sceneHealth.lastProbeAt < SCENE_HEALTH_TTL_MS) {
        // TTL 窗口内：继承上一次探活的结果，不重复发探活
        if (sceneHealth.failures === 0) return;
        throw unhealthyError(sceneHealth.lastProbeError);
    }

    // single-flight：并发调用共享同一次探活
    if (!healthProbeInFlight) {
        healthProbeInFlight = runHealthProbe(ctx).finally(() => {
            healthProbeInFlight = null;
        });
    }
    const res = await healthProbeInFlight;
    sceneHealth.lastProbeAt = Date.now();
    if (res.ok) return;
    sceneHealth.lastProbeError = res.error;

    // ⚠️ 暂态 vs 持续：编辑器启动时的 auto refresh 会让场景状态查询**暂时**不响应，
    //    刷新结束自己就恢复。两次失败就判死 = 把一个几十秒的暂态窗口
    //    变成「整个会话的场景工具全废」。
    const lastingMs = sceneHealth.firstFailureAt ? Date.now() - sceneHealth.firstFailureAt : 0;
    if (sceneHealth.failures < SCENE_HEALTH_MAX_FAILURES || lastingMs < SCENE_HEALTH_DEAD_AFTER_MS) {
        // 还不敢判死，但也不能让调用方干等 —— 照常抛可重试的错误
        throw unhealthyError(res.error, lastingMs);
    }
    sceneHealth.dead = true;
    // 分清「编辑器完全没反应」和「编辑器活着、只是场景状态查询坏了」——
    // 后者更常见（实测中毒时 query-is-ready 仍然 3ms 正常返回），
    // 处置方式不一样，提示必须说准。
    const diag = await diagnoseEditorAlive(ctx);
    const err = new Error(
        `场景频道不可用：${SCENE_DEAD_HINT}` +
        `（健康检查失败：${res.error}；` +
        (diag.alive
            ? '补充诊断：**编辑器本身还活着**（scene:query-is-ready 正常），坏掉的是场景状态查询这一路。'
            : '补充诊断：编辑器**完全无响应**。') +
        '）'
    );
    err.code = 'SCENE_CHANNEL_DEAD';
    throw err;
}

/**
 * 探活失败后，再分一层：编辑器**完全没反应**，还是**活着但场景状态查询卡住**？
 *
 * ⚠️ 实测：场景频道中毒后，`scene:query-is-ready` **3ms 就正常返回**，
 *    而 `query-dirty` / `query-node-tree` 永久挂起 ——
 *    也就是**编辑器进程是活的**，只是场景状态查询这条路坏了。
 *    这两种情况的处置完全不同：
 *      - 编辑器完全无响应 → 可能是崩了/卡死了 → 重启 Cocos Creator；
 *      - 编辑器活着、只是场景查询坏了 → 也得重启（场景进程要重载），
 *        但至少用户知道「不是整个编辑器挂了」。
 */
async function diagnoseEditorAlive(ctx) {
    try {
        await sendWithTimeout(ctx, 'scene', 'query-is-ready', [], 3000, '（诊断用）');
        return { alive: true };
    } catch (_) {
        return { alive: false };
    }
}

/** 探活失败但编辑器其实还活着时的错误。 */
function unhealthyError(reason, lastingMs = 0) {
    const lasting = lastingMs ? `已持续 ${Math.round(lastingMs / 1000)} 秒` : '刚刚开始';
    const err = new Error(
        `场景频道**暂时无响应**（健康检查失败：${reason}；${lasting}）。` +
        '编辑器可能正忙（启动时的自动刷新 / 构建 / 批量导入都会这样），稍后重试即可。' +
        '如果持续好几分钟都没恢复，再重启 Cocos Creator。'
    );
    err.code = 'SCENE_CHANNEL_UNHEALTHY';
    return err;
}

async function getSceneTree(ctx) {
    const hit = treeCache.get('tree');
    const now = Date.now();
    if (hit && now - hit.ts < TREE_TTL_MS) {
        return hit.flat;
    }
    // ⚠️ 频道卡死时这条消息**永不返回** —— 必须有超时，还要先做健康检查。
    //    （之前的注释写着「也要超时」，但代码里根本没有超时 —— 频道一挂，
    //     这里就永久挂起，调用方连报错都拿不到。）
    await assertSceneChannelAlive(ctx);
    const tree = await sendWithTimeout(ctx, 'scene', 'query-node-tree', [], DEFAULT_MESSAGE_TIMEOUT_MS);
    const flat = slimNode(tree);
    treeCache.set('tree', { ts: now, flat });
    return flat;
}

function invalidateTree() {
    treeCache.delete('tree');
}

/**
 * 解析 node 参数 → uuid。
 * 支持：uuid 本身 / 层级路径（Canvas/Button）/ 节点名（Button）
 *
 * 判定顺序：先在（缓存的）场景树里按 uuid 精确匹配 → 再按路径/名字匹配 →
 * 都不中但形状像 uuid → 直接当 uuid 用（可能指向当前场景树之外的节点）。
 */
async function resolveNode(ctx, ref, opts = {}) {
    if (!ref) throw new Error('缺少 node 参数');

    // ⚠️ **先查树、查不到再回退到「当成 uuid」**（末尾那个分支）。
    //    之前这里有个「像 uuid 就直接透传」的前置快路径，动机是避开
    //    「节点刚建出来、场景树还没重建 → 按名字查不到」的竞态。
    //    但它有个致命副作用：**节点名没有任何字符集限制**，
    //    一个恰好 22 个 base64 字符的名字（"AAAAAAAAAAAAAAAAAAAAAA"）
    //    会被当成 uuid 直接丢给引擎 → 引擎返回 `<unnamed>` ——
    //    **静默的错误答案**，比报错更危险（真机实测复现）。
    //
    //    现在：先按 uuid/路径/**名字**查树（名字撞 uuid 也能正确命中），
    //    查不到才回退到「当成 uuid」—— 两种场景都覆盖到了。
    const flat = await getSceneTree(ctx);
    const hits = matchNodes(flat, ref);
    if (hits.length === 1) return hits[0].uuid;
    if (hits.length > 1 && !opts.pickFirst) {
        throw new Error(
            `节点 "${ref}" 匹配到 ${hits.length} 个：${hits.map((h) => h.path).join('、')}。` +
            '请用完整层级路径或 uuid 精确指定。'
        );
    }
    if (hits.length > 1) return hits[0].uuid;
    // 场景树里没有，但形状像 uuid —— 多半是当前场景之外的节点
    if (isUuidLike(ref)) {
        if (!opts.trustUuid) {
            // ⚠️ 但它也可能是一个**节点名**（节点名没有任何字符集限制）。
            //    典型场景：这个节点**刚建出来**，引擎的场景树还没重建 →
            //    按名字查树查不到 → 直接当成 uuid 丢给引擎 → 引擎返回 `<unnamed>`
            //    —— **静默的错误答案**，比报错更危险（真机实测复现：
            //    名字 "AAAAAAAAAAAAAAAAAAAAAA" 按名字查就查不到了）。
            //    → 等一下、**绕过缓存**重新查一次树（这时通常已重建），再决定。
            await new Promise((r) => setTimeout(r, 200));
            invalidateTree();
            const flat2 = await getSceneTree(ctx);
            const hits2 = matchNodes(flat2, ref);
            if (hits2.length === 1) return hits2[0].uuid;
            if (hits2.length > 1) {
                throw new Error(
                    `节点 "${ref}" 匹配到 ${hits2.length} 个：${hits2.map((h) => h.path).join('、')}。` +
                    '请用完整层级路径或 uuid 精确指定。'
                );
            }
        }
        return String(ref);
    }
    {
        const sample = flat.slice(0, 12).map((n) => n.path).join(', ');
        throw new Error(`找不到节点 "${ref}"。当前场景节点示例：${sample || '(空场景)'}`);
    }
}

// ─────────────────────────────────────────────────────────────
// 值类型推断
// ─────────────────────────────────────────────────────────────

/**
 * 推断 set-property 的 dump。
 * Cocos 的 set-property 需要 {value, type}，type 决定编辑器如何把 JSON 反序列化成引擎类型。
 */
function inferDump(value, pathHint = '') {
    if (value === null || value === undefined) return { value: null, type: 'null' };
    if (typeof value === 'number') return { value, type: 'number' };
    if (typeof value === 'boolean') return { value, type: 'boolean' };
    if (typeof value === 'string') {
        // 资源引用：db://assets/... 或 http(s) 资源
        if (value.startsWith('db://')) return { value, type: 'cc.Asset' };
        return { value, type: 'string' };
    }
    if (Array.isArray(value)) return { value, type: 'array' };

    if (typeof value === 'object') {
        // 节点引用
        if (typeof value.uuid === 'string' && Object.keys(value).length <= 2) {
            return { value: { uuid: value.uuid }, type: 'cc.Node' };
        }
        const keys = Object.keys(value).sort().join(',');
        if (keys === 'x,y') return { value: { x: num(value.x), y: num(value.y) }, type: 'cc.Vec2' };
        if (keys === 'x,y,z') return { value: { x: num(value.x), y: num(value.y), z: num(value.z) }, type: 'cc.Vec3' };
        if (keys === 'x,y,z,w') return { value: { x: num(value.x), y: num(value.y), z: num(value.z), w: num(value.w) }, type: 'cc.Vec4' };
        if (keys === 'r,g,b' || keys === 'r,g,b,a') {
            return {
                value: { r: num(value.r), g: num(value.g), b: num(value.b), a: value.a === undefined ? 255 : num(value.a) },
                type: 'cc.Color',
            };
        }
        if (keys === 'width,height') {
            return { value: { width: num(value.width), height: num(value.height) }, type: 'cc.Size' };
        }
        // 兜底：原样带 type=object
        return { value, type: 'object' };
    }
    return { value, type: 'unknown' };
}

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

/** 组件属性路径：__comps__.N.prop */
function componentPath(compIndex, prop) {
    return `__comps__.${compIndex}.${prop}`;
}

/** 从节点 dump 里找组件下标。 */
function findComponentIndex(nodeDump, compType) {
    const comps = Array.isArray(nodeDump && nodeDump.__comps__) ? nodeDump.__comps__ : [];
    for (let i = 0; i < comps.length; i++) {
        const t = readCompType(comps[i]);
        if (t === compType) return i;
    }
    // 宽松匹配：类名尾部
    for (let i = 0; i < comps.length; i++) {
        const t = readCompType(comps[i]);
        if (t && compType && (t.endsWith('.' + compType) || t === compType)) return i;
    }
    return -1;
}

// ─────────────────────────────────────────────────────────────
// 操作实现
// ─────────────────────────────────────────────────────────────

function createHandlers(ctx) {
    /**
     * 必填参数校验。
     * 不做这层的话，缺参数会一路传到编辑器，回来一句没头没脑的 "parameter error"，
     * 模型根本不知道是自己少传了东西。这里在编辑器之前就拦下并说清楚。
     */
    /**
     * 资源 url 必须是 db://assets/ 前缀 ——
     * 否则等于把「任意路径写文件」的能力透给模型。
     */
    function requireAssetUrl(url) {
        if (typeof url !== 'string' || !url.startsWith('db://assets/')) {
            throw new Error(
                `资源路径必须以 "db://assets/" 开头，收到 "${url}"。` +
                '（防止把项目外的路径透给编辑器。）'
            );
        }
        if (url.includes('..')) {
            throw new Error(`资源路径不允许包含 ".."：${url}`);
        }
    }

    /**
     * 用 `.meta` 文件解析资源 uuid。
     *
     * ⚠️ 为什么不用 `asset-db:query-asset-info` 拿 uuid：
     *    那条消息在资源**还没导入完**时返回空 —— 而那正是最需要它的时刻。
     *    （本项目自己的调研报告 6.9 和 handlers.js 里的实测注释都记着这件事。）
     *    .meta 文件是资产库给每个资源生成的登记表，**资源一创建就有**，
     *    里面直接写着 uuid。直接读它，既不依赖引擎状态，也不受导入进度影响。
     *
     * 路径安全：url 已经过 requireAssetUrl 限定在 `db://assets/` 内且不含 `..`，
     * 拼出来的绝对路径必然在 `<工程>/assets/` 之下。
     */
    function uuidFromMeta(url) {
        const projectRoot = ctx.projectPath || '';
        if (!projectRoot) return { error: '拿不到工程目录，无法解析资源' };
        const rel = String(url).replace(/^db:\/\/assets\/?/, '');
        if (!rel || rel.includes('..')) return { error: `资源路径不合法："${url}"` };
        const abs = path.join(projectRoot, 'assets', rel);
        const metaFile = abs + '.meta';
        let raw = null;
        try {
            raw = fs.readFileSync(metaFile, 'utf8');
        } catch (_) {
            return { error: `找不到资源 "${url}"（${rel}.meta 不存在）` };
        }
        let uuid = null;
        try {
            uuid = JSON.parse(raw).uuid || null;
        } catch (_) {
            return { error: `资源 "${url}" 的 .meta 解析失败` };
        }
        if (!uuid) return { error: `资源 "${url}" 的 .meta 里没有 uuid` };
        // ⚠️ .meta 是**用户可编辑的文件** —— 里面的 uuid 必须校验。
        //    不校验的话，一个塞了 "../../.." 的 uuid 会让库文件路径跳出
        //    <工程>/library/，变成「探测项目外文件是否存在」的信息泄露。
        if (!isUuidLike(uuid)) {
            return { error: `资源 "${url}" 的 .meta 里 uuid 不合法："${uuid}"` };
        }
        return { uuid };
    }

    /**
     * 资源是否**已经导入完成**。
     *
     * ⚠️ 这是本项目踩过最深的一个坑，答案很朴素：
     *    渲染进程打开场景时去取 `import://<uuid>.json`，
     *    那份数据的落盘位置就是 `<项目>/library/<uuid前2位>/<uuid>.json`。
     *    **这个文件存在 = 资源已被资产库收录 = 可以进入打开流程。**
     *
     * 为什么不用别的信号：
     *   - `asset-db:query-asset-info` 在资源刚创建时**立刻**就返回非空（实测 0.5s），
     *     `imported` 字段也是 true —— 但那只是 asset-db 记了账，渲染进程还没导入完。
     *   - `query-asset-info` 返回 null 也不代表资源不存在（可能只是没导入完）。
     *   - ⚠️ `.meta` 里的 `"imported": true` **也不行** —— 实测（2026-10-22）
     *     它和库产物文件**同时出现**（采样精度 50ms，两者都在 52ms 出现），
     *     也就是说它不比库文件更晚，没有提供额外的信息量。
     * 所以目前唯一可用的判据就是**直接看库文件在不在**。
     *
     * ⚠️ ⚠️ **它只是「必要条件」，不是「充分条件」** ——
     *    库文件存在 ≠ 渲染进程一定取得到 `import://<uuid>.json`。
     *    实测仍会**偶发**挂死（健康编辑器上 create→open 只要 18ms 就成功，
     *    但换个时机就会 90 秒超时并毒死整个 scene 频道）。
     *    剩下的触发器是引擎侧的（6.11 的「恢复上一个场景」失败、
     *    以及渲染进程偶发取不到 import:// 产物），客户端只能靠超时 + 健康闸门兜。
     *    ⇒ 别在这里写「有了它就能彻底避免挂死」—— 实测证明**不能**。
     */
    async function isImported(target) {
        // ⚠️ 用**前缀**区分 url 与 uuid，不要用「像不像 uuid」来判断 ——
        //    早期版本用 isUuidLike 判，结果格式不认识的 uuid 会被当成路径去查 .meta，
        //    报出驴唇不对马嘴的「找不到资源」。
        //    现在：带 db:// 前缀 = 资源路径；否则一律当 uuid。
        //
        // ⚠️ uuid 分支必须**严格校验格式** ——
        //    库文件路径是 path.join(root,'library',uuid.slice(0,2),uuid+'.json')，
        //    如果 uuid 里有 '..'，slice(0,2) 可能是 '..' → 路径会跳出 library 目录，
        //    变成「探测项目外文件是否存在」的信息泄露。
        if (!target || typeof target !== 'string') {
            return { imported: false, uuid: null, reason: '没有指定资源（url 或 uuid）' };
        }
        let uuid = null;
        if (target.startsWith('db://')) {
            // ⚠️ 直接读 .meta，不走 asset-db ——
            //    asset-db 在「还没导入完」时返回空，那正是最需要它的时候不可用。
            const m = uuidFromMeta(target);
            if (m.error) return { imported: false, uuid: null, reason: m.error };
            uuid = m.uuid;
        } else {
            if (!isUuidLike(target)) {
                return { imported: false, uuid: null, reason: `"${target}" 不是合法的资源 uuid` };
            }
            uuid = target;
        }
        if (!uuid) return { imported: false, uuid: null, reason: '资源还没有 uuid' };
        const projectRoot = ctx.projectPath || '';
        if (!projectRoot) return { imported: false, uuid, reason: '拿不到工程目录，无法检查库文件' };
        const libFile = path.join(projectRoot, 'library', String(uuid).slice(0, 2), `${uuid}.json`);
        let exists = false;
        try {
            exists = fs.existsSync(libFile);
        } catch (_) {
            exists = false;
        }
        return {
            imported: exists,
            uuid,
            libraryFile: libFile,
            reason: exists ? null : '库产物还没生成（引擎仍在导入）',
        };
    }

    /** 取节点的父节点 uuid（根节点返回场景根自身）。 */
    async function getParentUuid(ctx, uuid) {
        // ⚠️ 这条消息同样会挂死 —— 频道卡死时它既不 resolve 也不 reject。
        //    必须走带超时 + 健康检查的路径，不能直接 ctx.msg。
        await assertSceneChannelAlive(ctx);
        const tree = await sendWithTimeout(ctx, 'scene', 'query-node-tree', [], DEFAULT_MESSAGE_TIMEOUT_MS);
        const flat = slimNode(tree);
        const self = flat.find((n) => n.uuid === uuid);
        if (!self) return uuid;
        const idx = self.path.split('/').length - 1;
        if (idx <= 0) return flat[0] ? flat[0].uuid : uuid;
        const parentPath = self.path.split('/').slice(0, -1).join('/');
        const parent = flat.find((n) => n.path === parentPath);
        return parent ? parent.uuid : uuid;
    }

    function req(args, names, tool) {
        const missing = names.filter((n) => args[n] === undefined || args[n] === null || args[n] === '');
        if (missing.length) {
            throw new Error(`${tool} 缺少必填参数：${missing.join('、')}`);
        }
    }

    /**
     * 受控的消息透传：先过白名单，再发。
     *
     * ⚠️ 加超时兜底的原因（实测 3.8.8）：
     * Cocos 的 `scene:open-scene` 在**失败时不会 reject 消息** —— 渲染进程去取
     * `import://<uuid>.json` 失败后，编辑器内部只打了
     * 「SceneFacadeManager.openScene timeout」和
     * 「download failed: import://xx.json, status: 0」，
     * 消息通道那一侧既不 resolve 也不 reject，调用方只能干等到客户端超时。
     * 所以凡是「可能失败但不会回话」的编辑器消息，都在这一层兜住，
     * 并把「为什么会这样」一起告诉模型。
     */
    async function send(channel, message, args = [], opts = {}) {
        const v = verify(channel, message);
        if (!v.ok) {
            const err = new Error(v.reason + (v.suggestion ? ' ' + v.suggestion : ''));
            err.code = 'MESSAGE_NOT_AVAILABLE';
            throw err;
        }
        // ⚠️ 发消息**之前**先确认频道还活着。
        //   实测：一次 scene:open-scene 挂死之后，整个 scene 频道就不再回应，
        //   但 bridge/ping 照常成功 —— 从外面看「编辑器还连着」，实际上所有场景
        //   工具都会一直干等到超时。没有这道闸门，调用方拿到的全是
        //   「超时」这种没信息量的错误，完全看不出「频道已经死了，该重启编辑器」。
        if (channel === 'scene' && !opts.skipHealthCheck) {
            await assertSceneChannelAlive(ctx);
        }
        // ⚠️ **所有**编辑器消息都要有超时兜底。
        //   实测：一次 scene:open-scene 失败（资源还没导入完）之后，
        //   **整个 scene 频道就卡住了** —— bridge/ping 正常，但 query-node-tree
        //   永远不返回。没有超时的话，调用方只能干等到客户端超时（60s），
        //   而且错误信息毫无信息量。
        const timeoutMs = opts.timeoutMs || DEFAULT_MESSAGE_TIMEOUT_MS;
        return await sendWithTimeout(ctx, channel, message, args, timeoutMs, opts.timeoutHint);
    }

    const ops = {
        /**
         * 原始编辑器消息透传（白名单校验后）。
         * 用途：① 工具面没覆盖到的、但已验证存在的消息，模型仍可直接调；
         *       ② 排查问题时精确复现某条消息调用。
         * 不在白名单里的消息一律拒绝并给出正确名。
         */
        'message': async (args) => {
            req(args, ['channel', 'message'], 'message');
            const v = verify(args.channel, args.message);
            if (!v.ok) {
                const err = new Error(v.reason + (v.suggestion ? ' ' + v.suggestion : ''));
                err.code = 'MESSAGE_NOT_AVAILABLE';
                throw err;
            }
            const list = Array.isArray(args.args) ? args.args : args.args === undefined ? [] : [args.args];
            // 写类消息会改场景 → 缓存必须失效（透传绕过了高层封装，最容易漏）
            if (!v.readonly) invalidateTree();
            if (!v.readonly) {
                // 写类消息加超时兜底：Cocos 有些消息失败时既不 resolve 也不 reject
                return await send(args.channel, args.message, list, {
                    timeoutMs: 30000,
                    timeoutHint: '该编辑器消息可能不回话（Cocos 某些消息失败时不 resolve 也不 reject）。',
                });
            }
            return await send(args.channel, args.message, list);
        },

        /**
         * 在场景进程执行扩展脚本里的白名单方法。
         *
         * ⚠️ 官方 API `scene:execute-scene-script` 是「在渲染进程跑扩展脚本」的通道 ——
         *    不做方法白名单，模型就等于拿到任意代码执行。
         */
        'scene.script': async (args) => {
            req(args, ['method'], 'scene.script');
            const ALLOWED = ['getSceneSummary', 'findNodesByName', 'getNodeInfo', 'getWorldBounds', 'setNodeProperty', 'createNode'];
            if (!ALLOWED.includes(args.method)) {
                throw new Error(`场景脚本方法 "${args.method}" 不在白名单内。可用：${ALLOWED.join('、')}`);
            }
            const name = args.extension || 'cocos-mcp';
            invalidateTree();
            return await send(
                'scene',
                'execute-scene-script',
                [{ name, method: args.method, args: args.args || [] }],
                { timeoutMs: 20000, timeoutHint: '场景进程可能正忙，稍后再试。' }
            );
        },

        'editor.info': async () => ({
            editorVersion: ctx.editorVersion,
            projectPath: ctx.projectPath,
            projectUuid: ctx.projectUuid,
            appPath: ctx.appPath,
            platform: process.platform,
            pid: process.pid,
        }),

        'editor.logs': async (args) => {
            // ⚠️ 3.8.8 **没有** `console:query` 这个编辑器消息（实测：Message does not exist）。
            // 读编辑器控制台要用官方 API Editor.Logger.query()，它是同步的，返回
            // ILogInfo[]：{process:'browser'|'renderer', type:'log'|'info'|'warn'|'error',
            // message, stack, time}。
            const raw = ctx.logger();
            const list = Array.isArray(raw) ? raw : [];
            let filtered = list;
            if (args.level) {
                const levels = [].concat(args.level).map((x) => String(x).toLowerCase());
                filtered = filtered.filter((e) => levels.includes(String(e.type || '').toLowerCase()));
            }
            if (args.contains) {
                const kw = String(args.contains).toLowerCase();
                filtered = filtered.filter((e) => String(e.message || '').toLowerCase().includes(kw));
            }
            const limit = Math.min(Number(args.limit) || 100, 1000);
            return { total: filtered.length, entries: filtered.slice(-limit) };
        },

        'editor.console.clear': async () => {
            // 官方 API Editor.Logger.clear()（同步）。3.8.8 虽有 console:clear 消息，
            // 但官方 Logger.clear 更直接，且不依赖消息频道。
            ctx.clearLogs();
            return { cleared: true };
        },

        // ── 场景 ──
        'scene.tree': async (args) => {
            const tree = args.uuid
                ? await send('scene', 'query-node-tree', [args.uuid])
                : await send('scene', 'query-node-tree', []);
            const flat = slimNode(tree);
            const maxDepth = args.maxDepth === undefined ? Infinity : Number(args.maxDepth);
            return {
                root: readName(tree),
                count: flat.length,
                nodes: flat.filter((n) => n.depth <= maxDepth),
            };
        },

        'scene.node': async (args) => {
            const uuid = await resolveNode(ctx, args.node);
            const dump = await send('scene', 'query-node', [uuid]);
            const result = { uuid, name: readName(dump), components: listComponents(dump), dump: unwrapDump(dump) };
            if (args.raw) result.rawDump = dump;
            return result;
        },

        'scene.find': async (args) => {
            const tree = await send('scene', 'query-node-tree', []);
            const flat = slimNode(tree);
            const kw = String(args.name || '').toLowerCase();
            let hits = flat.filter((n) => n.name.toLowerCase().includes(kw));
            if (args.type) hits = hits.filter((n) => String(n.type || '').toLowerCase().includes(String(args.type).toLowerCase()));
            if (args.maxDepth !== undefined) hits = hits.filter((n) => n.depth <= Number(args.maxDepth));
            return { count: hits.length, nodes: hits };
        },

        'scene.open': async (args) => {
            req(args, ['uuid'], 'scene.open');
            invalidateTree();

            // ⚠️ **导入检查必须排在最前面**。
            //    实测：`asset-db:query-asset-info` 在资源**还没导入完**时返回 null ——
            //    而那正是「刚创建的场景、引擎还在导入」的真实表现。
            //    之前把「查不到资源」直接判成「找不到场景资源」，于是模型拿到的是
            //    「先用 asset.uuid 把路径转成 uuid」这种**驴唇不对马嘴**的提示
            //    （uuid 是对的、资源是存在的，唯一的真相是「还没导入完」）。
            const imp = await isImported(args.uuid);
            if (!imp.imported) {
                // 库产物不存在有两种可能：还没导入完 / 资源根本不存在。
                // 两种都要给出可行动的下一步。
                const notExist = /找不到资源|\.meta 不存在/.test(imp.reason || '');
                throw new Error(
                    notExist
                        ? `找不到场景资源 "${args.uuid}"。` +
                          '先用 asset.uuid 把 db://assets/xxx.scene 路径转成 uuid；' +
                          '如果这个场景是刚创建的，说明资产库还没登记它，等几秒再试。'
                        : `场景 "${args.uuid}" 还没导入完成（${imp.reason}），现在打开会导致场景操作全部卡死。` +
                          '请等几秒后重试，或先用 asset.reimport 触发导入。'
                );
            }

            // 资源名只是锦上添花，查不到不影响（别让它变成一个门禁）。
            let name = null;
            try {
                const info = await send('asset-db', 'query-asset-info', [args.uuid], { timeoutMs: SCENE_OPEN_NAME_TIMEOUT_MS });
                if (info && info.name) name = info.name;
            } catch (_) {
                /* 查不到就算了 */
            }

            // ⚠️ **一次给足，不要设短了再重试**（见调研报告 6.10）。
            //    实测引擎在资产库做 auto refresh 时打开场景要 26~54 秒。
            //    超时设 45s 会把「慢但最终成功」误判成失败；而失败之后的重试
            //    是在引擎**半开着的状态**下继续折腾 —— 那才真的把 scene 频道搞死。
            //    调研报告 6.11 还记着另一个触发器（引擎处理「上一个场景」失败），
            //    前置检查覆盖不到它，所以**更不能靠重试兜底**。
            const OPEN_TIMEOUT_MS = SCENE_OPEN_TIMEOUT_MS;
            try {
                await send(
                    'scene',
                    'open-scene',
                    [args.uuid],
                    {
                        timeoutMs: OPEN_TIMEOUT_MS,
                        timeoutHint:
                            '常见原因：场景资源还没导入完（渲染进程取 import://<uuid>.json 失败，' +
                            '编辑器内部会打 “SceneFacadeManager.openScene timeout”）。' +
                            '注意：引擎打开场景本身可能要几十秒，资产库自动刷新时更久。',
                    }
                );
                return { opened: args.uuid, name, attempts: 1 };
            } catch (e) {
                // 失败后分清「资源没准备好」和「频道已经死了」——
                // 这两种情况的处置方式完全不同，不能只给一句「稍后再试」。
                let channelState = 'alive';
                try {
                    // 强制做一次健康检查（跳过 TTL 缓存），确认频道还活着没有
                    sceneHealth.lastProbeAt = 0;
                    await assertSceneChannelAlive(ctx);
                } catch (_) {
                    channelState = 'dead';
                }
                if (channelState === 'dead') {
                    const err = new Error(
                        `打开场景 "${args.uuid}" 失败（${e.message}），` +
                        `并且场景频道随后不再回应 —— ${SCENE_DEAD_HINT}`
                    );
                    err.code = 'SCENE_CHANNEL_DEAD';
                    throw err;
                }
                throw new Error(
                    `打开场景 "${args.uuid}" 失败：${e.message}` +
                    '（引擎打开场景实测可能要 26~54 秒；如果确实更久，可能是场景频道已经半卡住了。' +
                    '用 scene.tree 或 asset.isImported 复核一下再重试。）'
                );
            }
        },

        'scene.save': async () => {
            invalidateTree();
            // 保存可能要等场景结算（刚打开的大场景会花十几秒）→ 给更长的超时
            const r = await send('scene', 'save-scene', [], { timeoutMs: 90000 });
            return { saved: true, result: r === undefined ? null : r };
        },

        'scene.close': async () => {
            invalidateTree();
            const r = await send('scene', 'close-scene', []);
            // ⚠️ 引擎**可能拒绝关闭**，而之前这里无条件报 closed:true —— 假成功。
            //    实测 3.8.8：general edit mode 下关不掉当前场景，引擎返回 false
            //    并打 "Trying to close current edit scene in general edit mode is not allowed"。
            //    模型据此以为场景已关、接着去删资源/切场景，就会踩到后续的怪问题。
            if (r === false) {
                throw new Error(
                    '引擎拒绝关闭当前场景（Cocos 3.8.8 在 general edit mode 下不允许关闭普通场景，' +
                    '编辑器日志会打 “Trying to close current edit scene in general edit mode is not allowed”）。' +
                    '场景仍然开着。切换场景直接用 scene.open 打开新的即可，不需要先关。'
                );
            }
            return { closed: true, result: r === undefined ? null : r };
        },

        'scene.reload': async () => {
            invalidateTree();
            await send('scene', 'soft-reload', [], { timeoutMs: 90000 });
            return { reloaded: true };
        },

        'scene.dirty': async () => await send('scene', 'query-dirty', []),
        'scene.ready': async () => await send('scene', 'query-is-ready', []),
        'scene.bounds': async () => {
            const b = await send('scene', 'query-scene-bounds', []);
            return b || null;
        },
        'scene.classes': async (args) => {
            // ⚠️ query-classes 的参数是 QueryClassesOptions {extends, excludeSelf}，
            // **不是** {name}。传 {} 会返回空数组（实测）。
            // 语义是「列出继承自某基类的所有类」，默认列全部组件类。
            //
            // ⚠️ **两种形态都要收**：
            //    嵌套 `options: {extends, excludeSelf}`（与 Cocos 消息同形），
            //    以及扁平 `extends / excludeSelf`（工具层与调用方的直觉）。
            //    之前只认嵌套的，而工具层传的是扁平的 → **extends 过滤器从来没生效过**，
            //    传什么都在列全部组件类（看起来能用，其实参数被静默丢了）。
            const nested = args.options && typeof args.options === 'object' ? args.options : {};
            const options = {
                extends: nested.extends !== undefined ? nested.extends : args.extends,
                excludeSelf:
                    nested.excludeSelf !== undefined ? nested.excludeSelf : args.excludeSelf,
            };
            if (!options.extends) options.extends = 'cc.Component';
            if (options.excludeSelf === undefined) options.excludeSelf = true;
            const list = await send('scene', 'query-classes', [options]);
            return { extends: options.extends, count: Array.isArray(list) ? list.length : 0, classes: list };
        },
        'scene.components': async () => send('scene', 'query-components', []),

        'scene.snapshot': async () => {
            await send('scene', 'snapshot', []);
            return { snapshot: 'started' };
        },
        'scene.snapshot.abort': async () => {
            await send('scene', 'snapshot-abort', []);
            return { snapshot: 'aborted' };
        },

        // ── 节点 ──
        'node.create': async (args) => {
            invalidateTree();
            const parent = await resolveNode(ctx, args.parent);
            const uuid = await send('scene', 'create-node', [
                {
                    parent,
                    name: args.name,
                    type: args.type,
                    position: args.position ? { x: num(args.position.x), y: num(args.position.y), z: num(args.position.z || 0) } : undefined,
                    canvasRequired: args.canvasRequired,
                },
            ]);
            // ⚠️ **引擎的 create-node 会忽略 position**（真机实测：
            //    建完回读 dump.position 仍是 {0,0,0}；而同样的 position
            //    走 node.transform / set-property 是**生效**的）。
            //    所以这里在建完之后补一次 set-property ——
            //    否则工具声明了 position、模型也传了、却静默不生效。
            let positionError = null;
            if (args.position) {
                const want = {
                    x: num(args.position.x),
                    y: num(args.position.y),
                    z: num(args.position.z || 0),
                };
                try {
                    await send('scene', 'set-property', [
                        { uuid, path: 'position', dump: inferDump(args.position) },
                    ]);
                } catch (e) {
                    positionError = `设置初始位置失败：${e.message}`;
                }
                if (!positionError) {
                    // ⚠️ set-property **返回时引擎可能还没真正应用**（真机实测：
                    //    紧接着回读有时还是 {0,0,0}，有时已经对了 —— 竞态）。
                    //    所以回读校验 + 短暂重试，让「position 生效」变成确定行为，
                    //    而不是看运气。
                    const deadline = Date.now() + 800;
                    let applied = false;
                    while (Date.now() < deadline) {
                        // ⚠️ 回读必须**自带短超时** ——
                        //    默认的 30s 会把 800ms 的预算拖穿（实测能拖到 30 秒）。
                        //    频道已经坏掉时，这一步要快速放弃，而不是把整个建节点拖住。
                        const remaining = Math.max(50, deadline - Date.now());
                        const dump = await send('scene', 'query-node', [uuid], {
                            timeoutMs: Math.min(300, remaining),
                        }).catch(() => null);
                        const p = dump && dump.position && dump.position.value ? dump.position.value : dump && dump.position;
                        if (p && num(p.x) === want.x && num(p.y) === want.y && num(p.z) === want.z) {
                            applied = true;
                            break;
                        }
                        await new Promise((r) => setTimeout(r, 50));
                    }
                    if (!applied) {
                        positionError =
                            '已请求设置初始位置，但回读校验未通过（引擎可能忽略了它）——' +
                            '可以之后用 node.transform 再设一次。';
                    }
                }
            }
            const created = [];
            const failed = [];
            for (const comp of args.components || []) {
                try {
                    await send('scene', 'create-component', [{ uuid, component: comp }]);
                    created.push(comp);
                } catch (e) {
                    // ⚠️ 组件挂载失败**不能**让整次建节点失败。
                    // 例如 cc.Canvas 会自动带 UITransform，再显式挂一次会报
                    // "already contains the same component" —— 节点其实建好了，
                    // 却因为这一个组件被整体判为失败，调用方会误以为节点没建成。
                    failed.push({ component: comp, reason: e.message });
                }
            }
            const out = { uuid, name: args.name, components: created, componentErrors: failed };
            if (positionError) out.positionError = positionError;
            return out;
        },

        'node.delete': async (args) => {
            invalidateTree();
            const uuid = await resolveNode(ctx, args.node);
            // 护栏：场景根节点不可删。
            // 实测 Cocos 的 scene:remove-node 对根节点会**返回成功**（但引擎层面不真删），
            // 这种「假成功」比报错更危险 —— 调用方会以为已经删掉了。直接在这里拦掉。
            const flat = await getSceneTree(ctx);
            const root = flat[0];
            if (root && root.uuid === uuid) {
                throw new Error(
                    `不能删除场景根节点 "${root.name}"。` +
                    '要清空场景内容，请删它的子节点，或新建一个空场景。'
                );
            }
            await send('scene', 'remove-node', [{ uuid }]);
            return { deleted: uuid, name: (flat.find((n) => n.uuid === uuid) || {}).name || null };
        },

        'node.duplicate': async (args) => {
            invalidateTree();
            const uuid = await resolveNode(ctx, args.node);
            const r = await send('scene', 'duplicate-node', [uuid]);
            return { duplicated: uuid, newUuids: r };
        },

        'node.move': async (args) => {
            invalidateTree();
            const uuid = await resolveNode(ctx, args.node);
            const parent = await resolveNode(ctx, args.parent);
            const r = await send('scene', 'set-parent', [{ parent, uuids: uuid }]);
            return { moved: uuid, parent, result: r };
        },

        'node.active': async (args) => {
            invalidateTree();
            const uuid = await resolveNode(ctx, args.node);
            const ok = await send('scene', 'set-property', [
                { uuid, path: 'active', dump: { value: !!args.active, type: 'boolean' } },
            ]);
            return { uuid, active: !!args.active, ok };
        },

        'node.transform': async (args) => {
            invalidateTree();
            const uuid = await resolveNode(ctx, args.node);
            const applied = [];
            if (args.position) {
                await send('scene', 'set-property', [
                    { uuid, path: 'position', dump: inferDump(args.position) },
                ]);
                applied.push('position');
            }
            if (args.scale) {
                await send('scene', 'set-property', [{ uuid, path: 'scale', dump: inferDump(args.scale) }]);
                applied.push('scale');
            }
            if (args.rotation !== undefined) {
                const rot = typeof args.rotation === 'number' ? { x: 0, y: 0, z: args.rotation } : args.rotation;
                await send('scene', 'set-property', [{ uuid, path: 'rotation', dump: inferDump(rot) }]);
                applied.push('rotation');
            }
            return { uuid, applied };
        },

        'node.clipboard': async (args) => {
            // paste 会新建节点 → 场景树缓存必须失效，
            // 否则紧接着用新节点名调用其它工具会命中 2 秒内的旧树，报「找不到节点」。
            invalidateTree();
            // ⚠️ paste 的 source 在**剪贴板里**，可能已经被 cut 删掉了 ——
            //    所以不能按场景节点去解析它，否则「剪切 → 粘贴」直接失败。
            if (args.action === 'paste') {
                const target = await resolveNode(ctx, args.target);
                const pasted = await send('scene', 'paste-node', [{ target, uuids: args.node }]);
                return { pasted };
            }
            const uuid = await resolveNode(ctx, args.node);
            if (args.action === 'copy') {
                return { copied: await send('scene', 'copy-node', [uuid]), clipboardKey: uuid };
            }
            if (args.action === 'cut') {
                // ⚠️ **Cocos 3.8.8 的 scene:cut-node 只准备剪贴板，不会把节点移出层级** ——
                //    实测 parent 传「父节点 uuid / 节点自己 uuid / 节点路径」三种形态，
                //    节点在场景树里都原封不动（官方描述是 "Cut node"，与行为不符）。
                //    所以「剪切」要自己实现成两步：copy-node（备剪贴板）+ remove-node（真删）。
                //    实测「复制 → 删除 → 粘贴」可行：粘贴会生成新 uuid 的节点。
                await send('scene', 'copy-node', [uuid]);
                await send('scene', 'remove-node', [{ uuid }]);
                return { cut: true, removed: uuid, clipboardKey: uuid };
            }
            throw new Error(`未知的剪贴板动作 "${args.action}"，可用：copy / cut / paste`);
        },

        // ── 组件 ──
        'component.add': async (args) => {
            invalidateTree();
            const uuid = await resolveNode(ctx, args.node);
            await send('scene', 'create-component', [{ uuid, component: args.component }]);
            return { uuid, component: args.component, added: true };
        },

        'component.remove': async (args) => {
            invalidateTree();
            req(args, ['node', 'component'], 'component.remove');
            const uuid = await resolveNode(ctx, args.node);
            // 先确认组件真的在 —— Cocos 的 remove-component 对不存在的组件不一定报错，
            // 返回「成功」但什么都没摘，静默失败最难查。
            const dump = await send('scene', 'query-node', [uuid]);
            const comps = Array.isArray(dump.__comps__) ? dump.__comps__ : [];
            const idx = comps.findIndex((c) => readCompType(c) === args.component);
            if (idx < 0) {
                throw new Error(
                    `节点 "${args.node}" 上没有组件 "${args.component}"，没有可摘的。` +
                    `现有组件：${comps.map((c) => readCompType(c)).join('、') || '(无)'}`
                );
            }
            // ⚠️ RemoveComponentOptions.uuid 是**组件的 uuid**，不是节点的 uuid！
            //    官方 d.ts 写得很清楚：
            //      export interface RemoveComponentOptions { uuid: string; // 组件的uuid
            //                                                  // 无用参数
            //                                                  // component: string; }
            //    之前传的是节点 uuid → Cocos 找不到该组件 → 只在日志里打一句
            //    "Remove Component failed: xxx does not exist"，而我们照样返回「已删除」= 假成功。
            // raw dump 里组件的 uuid 是 IProperty 包装 {value, type, ...}，要解包
            const compUuid = comps[idx] && comps[idx].value
                ? readValue(comps[idx].value.uuid)
                : null;
            if (!compUuid) {
                throw new Error(
                    `读不到组件 "${args.component}" 的 uuid，无法移除。` +
                    '（节点 dump 里该组件没有 value.uuid 字段。）'
                );
            }
            await send('scene', 'remove-component', [{ uuid: compUuid }]);

            // 操作后回读校验：真的摘掉了吗？
            const after = await send('scene', 'query-node', [uuid]).catch(() => null);
            if (!after) {
                // 节点本身已经不在了 —— 无法回读校验，如实说明而不是谎报成功
                throw new Error(
                    `移除组件 "${args.component}" 后读不回节点 "${uuid}"（节点可能已被删除），无法确认结果。`
                );
            }
            const still = (Array.isArray(after.__comps__) ? after.__comps__ : []).some(
                (c) => readCompType(c) === args.component
            );
            if (still) {
                throw new Error(
                    `移除组件 "${args.component}" 后回读发现它仍在节点上 —— 引擎没有真的摘掉。` +
                    '（这种情况要当作失败处理，不能报告成功。）'
                );
            }
            return { uuid, component: args.component, removed: true, componentUuid: compUuid };
        },

        'component.list': async (args) => {
            const uuid = await resolveNode(ctx, args.node);
            const dump = await send('scene', 'query-node', [uuid]);
            const comps = Array.isArray(dump.__comps__) ? dump.__comps__ : [];
            return {
                uuid,
                components: comps.map((c, i) => {
                    const type = readCompType(c) || 'unknown';
                    const props = c && c.value && typeof c.value === 'object' ? c.value : {};
                    const flat = {};
                    for (const [pk, pv] of Object.entries(props)) flat[pk] = unwrapProperty(pv);
                    return { index: i, type, enabled: flat._enabled, properties: flat };
                }),
            };
        },

        'component.set': async (args) => {
            invalidateTree();
            const uuid = await resolveNode(ctx, args.node);
            const dump = await send('scene', 'query-node', [uuid]);
            const comps = Array.isArray(dump.__comps__) ? dump.__comps__ : [];
            const compType = args.component;
            const idx = findComponentIndex(dump, compType);
            if (idx < 0) {
                throw new Error(
                    `节点 "${args.node}" 上没有组件 "${compType}"。现有组件：` +
                    (comps.map((c, i) => `#${i} ${readCompType(c) || 'unknown'}`).join('、') || '(无)')
                );
            }
            const prop = args.property;
            const path = componentPath(idx, prop);
            const res = await send('scene', 'set-property', [{ uuid, path, dump: inferDump(args.value, path) }]);
            return { uuid, component: compType, property: prop, path, ok: res !== false };
        },

        'component.call': async (args) => {
            req(args, ['node', 'method'], 'component.call');
            // 组件方法可能改场景（脚本里可以增删节点）→ 缓存失效
            invalidateTree();
            const uuid = await resolveNode(ctx, args.node);
            const r = await send('scene', 'execute-component-method', [
                { uuid, name: args.method, args: args.args || [] },
            ]);
            return { uuid, method: args.method, result: r === undefined ? null : r };
        },

        // ── 资源 ──
        'asset.query': async (args) => {
            const options = {};
            if (args.pattern) options.pattern = args.pattern;
            if (args.ccType) options.ccType = args.ccType;
            const list = await send('asset-db', 'query-assets', [options, args.dataKeys]);
            return { count: Array.isArray(list) ? list.length : 0, assets: list };
        },

        /**
         * 查资源是否已导入完成（本地库文件判定，最可靠）。
         * 刚创建的资源在导入完成前，打开它会**毒死整个 scene 频道** ——
         * 想知道能不能开，先查这个。
         */
        'asset.isImported': async (args) => {
            // url 与 uuid 二选一：url 必须限定在 db://assets/ 内（防止越权读盘），
            // uuid 走 isUuidLike 白名单，不含路径成分，天然安全。
            const hasUrl = typeof args.url === 'string' && args.url !== '';
            const hasUuid = typeof args.uuid === 'string' && args.uuid !== '';
            if (!hasUrl && !hasUuid) {
                throw new Error('asset.isImported 缺少必填参数：url 或 uuid');
            }
            if (hasUrl) {
                requireAssetUrl(args.url);
                return await isImported(args.url);
            }
            if (!isUuidLike(args.uuid)) {
                throw new Error(`asset.isImported 的 uuid 格式不合法："${args.uuid}"`);
            }
            return await isImported(args.uuid);
        },
        'asset.info': async (args) => {
            req(args, ['url'], 'asset.info');
            const info = await send('asset-db', 'query-asset-info', args.dataKeys ? [args.url, args.dataKeys] : [args.url]);
            if (!info) {
                // ⚠️ 实测：资源**刚创建、引擎还在导入**时，query-asset-info 也返回空 ——
                //    这时候报「资源不存在」是误导（它存在，只是还没导入完）。
                throw new Error(
                    `读不到资源信息：${args.url}。` +
                    '可能原因：① 资源不存在；② 资源刚创建、引擎还在导入（等几秒再试）。'
                );
            }
            return info;
        },

        'asset.create': async (args) => {
            req(args, ['url'], 'asset.create');
            requireAssetUrl(args.url);
            // asset-db:create-asset 的第三个参数是 AssetOperationOption，
            // overwrite 决定同名资源已存在时是覆盖还是报错。
            const options = args.overwrite ? { overwrite: true } : undefined;
            const r = await send(
                'asset-db',
                'create-asset',
                options
                    ? [args.url, args.content === undefined ? null : args.content, options]
                    : [args.url, args.content === undefined ? null : args.content]
            );
            return { created: args.url, info: r };
        },

        'asset.save': async (args) => {
            req(args, ['url', 'content'], 'asset.save');
            requireAssetUrl(args.url);
            const r = await send('asset-db', 'save-asset', [args.url, args.content]);
            return { saved: args.url, info: r };
        },

        'asset.delete': async (args) => {
            req(args, ['url'], 'asset.delete');
            requireAssetUrl(args.url);
            // ⚠️ **别删掉当前打开的场景** ——
            //    删掉之后编辑器里会留一个指向已删除资源的「上一个场景」，
            //    引擎在打开下一个场景时会先处理它、失败、然后 open-scene 永不返回
            //    → 整个 scene 频道中毒（query-node-tree 永久挂起）。
            //    这是本项目实测到的最隐蔽的一个坑，必须在这里挡住。
            //
            //    判据：场景的**根节点 uuid 就是场景资源的 uuid**（实测一致）。
            try {
                const info = await send('asset-db', 'query-asset-info', [args.url], { timeoutMs: 5000 });
                const uuid = info && info.uuid;
                if (uuid) {
                    const tree = await getSceneTree(ctx).catch(() => null);
                    const root = tree && tree[0];
                    if (root && root.uuid === uuid) {
                        throw new Error(
                            `不能删除当前打开的场景 "${args.url}"。` +
                            '删掉它会让编辑器留下一个指向已删除资源的引用，' +
                            '之后打开任何场景都有挂死的风险（引擎会打 “Open the previous scene failed”）。' +
                            '要删它，先 scene.open 打开另一个场景（它就不再是当前场景了），再回来删。' +
                            '注意：scene.close 在 3.8.8 的 general edit mode 下关不掉场景，所以别指望靠它来腾出。'
                        );
                    }
                }
            } catch (e) {
                // 守卫本身出错（比如场景树查不到）时**不要挡住删除** ——
                // 那是误伤。只在确凿无疑时拦截。
                if (e && /不能删除当前打开的场景/.test(e.message)) throw e;
            }
            const r = await send('asset-db', 'delete-asset', [args.url]);
            // delete-asset 找不到资源时返回 null 而不是报错 —— 明确告诉调用方「没删掉」
            if (r === null || r === undefined) {
                throw new Error(`资源不存在或删除失败：${args.url}。先用 asset.info 确认它存在。`);
            }
            return { deleted: args.url, info: r };
        },

        'asset.move': async (args) => {
            req(args, ['from', 'to'], 'asset.move');
            requireAssetUrl(args.from);
            requireAssetUrl(args.to);
            const r = await send('asset-db', 'move-asset', [args.from, args.to]);
            return { from: args.from, to: args.to, info: r };
        },

        'asset.copy': async (args) => {
            // ⚠️ 同族的 move / create / save / delete 都过 requireAssetUrl，只有 copy 没有 ——
            //    那等于把「复制任意路径」的能力透给了模型。
            //    （引擎侧到底接不接受非 db:// 的 URL，没法离线证实；
            //      但纵深防御不依赖引擎的实现细节 —— 自己的口子自己堵上。）
            req(args, ['from', 'to'], 'asset.copy');
            requireAssetUrl(args.from);
            requireAssetUrl(args.to);
            const r = await send('asset-db', 'copy-asset', [args.from, args.to]);
            return { from: args.from, to: args.to, info: r };
        },

        'asset.reimport': async (args) => {
            req(args, ['url'], 'asset.reimport');
            await send('asset-db', 'reimport-asset', [args.url]);
            return { reimported: args.url };
        },

        'asset.refresh': async (args) => {
            await send('asset-db', 'refresh-asset', [args.url]);
            return { refreshed: args.url };
        },

        'asset.uuid': async (args) => {
            req(args, ['url'], 'asset.uuid');
            return await send('asset-db', 'query-uuid', [args.url]);
        },
        'asset.url': async (args) => {
            req(args, ['uuid'], 'asset.url');
            return await send('asset-db', 'query-url', [args.uuid]);
        },
        'asset.path': async (args) => await send('asset-db', 'query-path', [args.url]),
        'asset.dependencies': async (args) => {
            req(args, ['url'], 'asset.dependencies');
            return await send('asset-db', 'query-asset-dependencies', args.type ? [args.url, args.type] : [args.url]);
        },
        'asset.users': async (args) => await send('asset-db', 'query-asset-users', [args.url, args.type]),

        // ── 预览 / 构建 ──
        'preview.url': async () => await send('preview', 'query-preview-url', []),

        'build.start': async (args) => {
            req(args, ['platform'], 'build.start');
            const options = args.options || {};
            // ⚠️ shouldWait 默认 true 会让这条消息在整个构建期间不返回 ——
            //    既占住一个 HTTP 连接（禁用扩展会挂死），也会撞上客户端超时。
            const shouldWait = args.shouldWait === true;
            await send('builder', 'add-task', [options, shouldWait], {
                timeoutMs: shouldWait ? 600000 : 30000,
                timeoutHint: shouldWait ? '' : '构建是异步的，用 build.status 轮询进度。',
            });
            return { started: true, platform: args.platform || null, shouldWait };
        },
        'build.status': async (args) => send('builder', 'query-tasks-info', [{ type: args.type || 'build' }]),
        'build.platforms': async () => send('builder', 'query-platform-config', ['web-desktop']),

        // ── 场景视图 ──
        'view.gizmo': async (args) => {
            if (args.tool !== undefined) {
                await send('scene', 'change-gizmo-tool', [args.tool]);
            }
            if (args.pivot !== undefined) {
                await send('scene', 'change-gizmo-pivot', [args.pivot]);
            }
            if (args.coordinate !== undefined) {
                await send('scene', 'change-gizmo-coordinate', [args.coordinate]);
            }
            return {
                tool: await send('scene', 'query-gizmo-tool-name', []),
                pivot: await send('scene', 'query-gizmo-pivot', []),
                coordinate: await send('scene', 'query-gizmo-coordinate', []),
            };
        },

        'view.is2d': async (args) => {
            if (args.value !== undefined) await send('scene', 'change-is2D', [!!args.value]);
            return await send('scene', 'query-is2D', []);
        },

        'view.grid': async (args) => {
            if (args.visible !== undefined) await send('scene', 'set-grid-visible', [!!args.visible]);
            return await send('scene', 'query-is-grid-visible', []);
        },

        'view.icon': async (args) => {
            if (args.is3D !== undefined) await send('scene', 'set-icon-gizmo-3d', [!!args.is3D]);
            if (args.size !== undefined) await send('scene', 'set-icon-gizmo-size', [Number(args.size)]);
            return {
                is3D: await send('scene', 'query-is-icon-gizmo-3d', []),
                size: await send('scene', 'query-icon-gizmo-size', []),
            };
        },

        'view.focus': async (args) => {
            const uuids = [];
            for (const ref of [].concat(args.nodes || [])) uuids.push(await resolveNode(ctx, ref));
            await send('scene', 'focus-camera', [uuids]);
            return { focused: uuids };
        },

        'view.align': async (args) => {
            if (args.mode === 'with-view') {
                await send('scene', 'align-with-view', []);
            } else {
                await send('scene', 'align-view-with-node', []);
            }
            return { aligned: args.mode || 'view-with-node' };
        },

        // ── 参考图 ──
        'reference.add': async (args) => {
            req(args, ['paths'], 'reference.add');
            const paths = [].concat(args.paths || []);
            // 提前检查文件是否存在：否则 Cocos 会在渲染进程抛 ENOENT，日志刷一片红
            const missing = paths.filter((p) => {
                try {
                    return !fs.existsSync(p);
                } catch (_) {
                    return false;
                }
            });
            if (missing.length) {
                throw new Error(`参考图文件不存在：${missing.join('、')}`);
            }
            await send('reference-image', 'add-image', [paths]);
            return { added: paths };
        },
        'reference.remove': async (args) => {
            const paths = [].concat(args.paths || []);
            await send('reference-image', 'remove-image', [paths]);
            return { removed: paths };
        },
        'reference.current': async () => send('reference-image', 'query-current', []),
        'reference.config': async () => send('reference-image', 'query-config', []),
        'reference.set': async (args) => {
            req(args, ['key'], 'reference.set');
            await send('reference-image', 'set-image-data', [args.key, args.value]);
            return { key: args.key, value: args.value };
        },

        // ── 偏好 / 项目 ──
        'preferences.get': async (args) => {
            req(args, ['name'], 'preferences.get');
            const v = await send('preferences', 'query-config', [args.name, args.key, args.protocol]);
            if (v === null || v === undefined) {
                throw new Error(
                    `没有读到偏好 "${args.name}${args.key ? '/' + args.key : ''}"。` +
                    '该分类可能不存在 —— 实测存在的分类有：preview / inspector / engine。'
                );
            }
            return v;
        },
        'preferences.set': async (args) => {
            req(args, ['name', 'key', 'value'], 'preferences.set');
            const ok = await send('preferences', 'set-config', [args.name, args.key, args.value, args.protocol]);
            // set-config 返回 false 表示没写进去 —— 这是「假成功」，必须报错而不是默默返回
            if (ok === false) {
                throw new Error(
                    `写偏好 "${args.name}/${args.key}" 失败（编辑器返回 false）。` +
                    '常见原因：分类名或键名不存在，或该偏好只读。'
                );
            }
            return { name: args.name, key: args.key, value: args.value, applied: true };
        },
        'project.config': async (args) => {
            const v = await send('project', 'query-config', [args.key]);
            if (v === null || v === undefined) {
                throw new Error(`没有读到项目配置 "${args.key}"。该键可能不存在。`);
            }
            return v;
        },
    };

    return ops;
}

function listComponents(dump) {
    const comps = Array.isArray(dump && dump.__comps__) ? dump.__comps__ : [];
    return comps.map((c, i) => ({
        index: i,
        type: readCompType(c) || 'unknown',
        enabled: readValue(c && c.enabled),
    }));
}

/**
 * 解包 IProperty
 * ---------------------------------------------------------------------------
 * 编辑器 dump 里每个属性都被包成 {value, type, default, displayName, tooltip, ...}，
 * 模型直接读会看到大量噪音（每个属性十几行）。
 * 这里把嵌套的属性表递归摊平成普通值：
 *   {string: {value:"开始", type:"String"}}            → {string:"开始"}
 *   {color:  {value:{r:{value:1},g:{value:1},b:{value:1}}, type:"cc.Color"}} → {color:{r:1,g:1,b:1}}
 */
function unwrapProperty(p) {
    if (p === null || p === undefined) return p;
    if (Array.isArray(p)) return p.map(unwrapProperty);
    if (typeof p !== 'object') return p;
    if ('value' in p && typeof p.type === 'string') {
        const v = p.value;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            const out = {};
            for (const [k, vv] of Object.entries(v)) out[k] = unwrapProperty(vv);
            return out;
        }
        return v === undefined ? null : v;
    }
    return p;
}

/** 整棵树解包（保留 uuid / __comps__ 结构，但属性值变plain）。 */
function unwrapDump(node) {
    if (node === null || node === undefined) return node;
    if (Array.isArray(node)) return node.map(unwrapDump);
    if (typeof node !== 'object') return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) {
        if (k === '__comps__' && Array.isArray(v)) {
            out.__comps__ = v.map((c) => {
                const t = readCompType(c);
                const props = c && c.value && typeof c.value === 'object' ? c.value : {};
                const flat = {};
                for (const [pk, pv] of Object.entries(props)) flat[pk] = unwrapProperty(pv);
                return { type: t, value: flat };
            });
            continue;
        }
        if (k === 'children' && Array.isArray(v)) {
            out.children = v.map(unwrapDump);
            continue;
        }
        out[k] = unwrapProperty(v);
    }
    return out;
}

module.exports = {
    createHandlers,
    /**
     * Bridge 侧 scene.open 的最坏耗时预算（毫秒）。
     * 导出给一致性测试直接求值 —— 不要让测试去正则解析源码。
     */
    sceneOpenBudgetMs,
    SCENE_OPEN_TIMEOUT_MS,
    SCENE_HEALTH_TIMEOUT_MS,
    SCENE_HEALTH_PROBE,
    /**
     * 重置场景频道健康状态。
     * 仅供测试与「重启 Bridge」使用 —— 生产里状态本来就该跟着编辑器进程走
     * （频道死了就是死了，重启编辑器会重新加载模块，状态自然清零）。
     */
    /**
     * 设置健康闸门的阈值。**仅供测试** ——
     * 「持续多久才算彻底卡死」默认 3 分钟，测试里改成 100ms 才能在秒级覆盖。
     */
    setSceneHealthThresholds(opts = {}) {
        if (opts.maxFailures !== undefined) SCENE_HEALTH_MAX_FAILURES = opts.maxFailures;
        if (opts.deadAfterMs !== undefined) SCENE_HEALTH_DEAD_AFTER_MS = opts.deadAfterMs;
        if (opts.ttlMs !== undefined) SCENE_HEALTH_TTL_MS = opts.ttlMs;
        if (opts.healthTimeoutMs !== undefined) SCENE_HEALTH_TIMEOUT_MS = opts.healthTimeoutMs;
    },
    getSceneHealthThresholds() {
        return {
            maxFailures: SCENE_HEALTH_MAX_FAILURES,
            deadAfterMs: SCENE_HEALTH_DEAD_AFTER_MS,
            ttlMs: SCENE_HEALTH_TTL_MS,
            healthTimeoutMs: SCENE_HEALTH_TIMEOUT_MS,
        };
    },
    resetSceneHealth() {
        sceneHealth.dead = false;
        sceneHealth.failures = 0;
        sceneHealth.lastProbeAt = 0;
        sceneHealth.lastProbeError = null;
        sceneHealth.firstFailureAt = 0;
        healthProbeInFlight = null;
    },
    /**
     * 场景频道健康快照（给扩展面板显示用）。
     *
     * ⚠️ 为什么值得单独暴露：场景频道中毒后，**所有场景工具都会失败**，
     *    而表现只是「超时」。用户在面板上看到「场景频道：已中毒」，
     *    才知道该点「重启 Bridge」/ 重启 Cocos，而不是以为 MCP 装错了。
     */
    sceneHealthSnapshot() {
        return {
            dead: sceneHealth.dead,
            failures: sceneHealth.failures,
            lastProbeAt: sceneHealth.lastProbeAt,
            probe: SCENE_HEALTH_PROBE,
            lastProbeError: sceneHealth.lastProbeError || null,
            lastProbeAtText: sceneHealth.lastProbeAt
                ? new Date(sceneHealth.lastProbeAt).toLocaleTimeString()
                : null,
        };
    },
    slimNode,
    resolveNode,
    inferDump,
    findComponentIndex,
    readName,
    readUuid,
    readCompType,
    listComponents,
    unwrapProperty,
    unwrapDump,
    isUuidLike,
    invalidateTree,
    getSceneTree,
};
