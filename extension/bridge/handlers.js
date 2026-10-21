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
const SHORT_UUID_RE = /^[A-Za-z0-9_-]{22}$/;

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
    'Cocos 的场景频道已经卡死（引擎侧 open-scene 挂死后，整个 scene 频道不再回应）。' +
    '所有场景操作都会失败。请重启 Cocos Creator（或在扩展面板点「重启 Bridge」），' +
    '期间可以改用离线 prefab/animation 编辑器。';

/** @type {{dead: boolean, checkedAt: number, failures: number, lastProbeAt: number}} */
const sceneHealth = { dead: false, checkedAt: 0, failures: 0, lastProbeAt: 0 };
/** 健康检查结果的缓存时间（毫秒）—— 太频繁会拖慢每一次场景调用。 */
const SCENE_HEALTH_TTL_MS = 8000;
/** 健康检查本身的超时 —— 必须远小于正常操作的超时，才能起到「快速失败」的作用。 */
const SCENE_HEALTH_TIMEOUT_MS = 8000;
/** 连续失败多少次才判定频道已死（避免编辑器忙的时候误判）。 */
const SCENE_HEALTH_MAX_FAILURES = 2;
/** 判定已死后，多久允许再探一次（给自愈留机会）。 */
const SCENE_DEAD_REPROBE_MS = 30000;

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
 * 确认场景频道还活着；死了就立刻抛错，不让调用方干等。
 *
 * ⚠️ 两处必须小心，否则闸门本身会变成新的故障源：
 *   1. **不能一次失败就判死** —— 编辑器正忙（比如在构建、在导入大批资源）时，
 *      query-is-ready 可能几秒不回。一次失败就永久判死，会把用户的场景工具
 *      全部锁死，而且再也回不来。所以要连续失败 2 次才判死。
 *   2. **判死后要允许自愈** —— 频道未必真的死了（引擎侧可能只是暂时卡住）。
 *      每 30 秒给一次机会重新探活，探活成功就恢复。
 */
async function assertSceneChannelAlive(ctx) {
    const now = Date.now();
    if (sceneHealth.dead) {
        // 判死了也定期给一次自愈机会
        if (now - sceneHealth.lastProbeAt < SCENE_DEAD_REPROBE_MS) {
            const err = new Error(`场景频道不可用：${SCENE_DEAD_HINT}`);
            err.code = 'SCENE_CHANNEL_DEAD';
            throw err;
        }
        sceneHealth.lastProbeAt = now;
    } else if (now - sceneHealth.checkedAt < SCENE_HEALTH_TTL_MS) {
        return;
    }
    sceneHealth.checkedAt = now;

    try {
        await sendWithTimeout(ctx, 'scene', 'query-is-ready', [], SCENE_HEALTH_TIMEOUT_MS);
        // 探活成功 → 频道是好的（可能之前只是暂时卡住）
        sceneHealth.dead = false;
        sceneHealth.failures = 0;
    } catch (e) {
        sceneHealth.failures += 1;
        if (sceneHealth.failures < SCENE_HEALTH_MAX_FAILURES) {
            // 第一次失败：还不敢判死，但也不能让调用方干等 —— 照常抛超时错误
            const err = new Error(
                `场景频道响应异常（健康检查失败：${e.message}）。` +
                '编辑器可能正忙，稍后重试；如果持续失败，重启 Cocos Creator。'
            );
            err.code = 'SCENE_CHANNEL_UNHEALTHY';
            throw err;
        }
        sceneHealth.dead = true;
        sceneHealth.lastProbeAt = now;
        const err = new Error(`场景频道不可用：${SCENE_DEAD_HINT}（健康检查失败：${e.message}）`);
        err.code = 'SCENE_CHANNEL_DEAD';
        throw err;
    }
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
    if (isUuidLike(ref)) return String(ref);
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
     * 资源是否**已经导入完成**。
     *
     * ⚠️ 这是本项目踩过最深的一个坑，答案很朴素：
     *    渲染进程打开场景时去取 `import://<uuid>.json`，
     *    那份数据的落盘位置就是 `<项目>/library/<uuid前2位>/<uuid>.json`。
     *    **文件存在 = 导入完成 = 场景可打开。**
     *
     * 为什么不用别的信号：
     *   - `asset-db:query-asset-info` 在资源刚创建时**立刻**就返回非空（实测 0.5s），
     *     `imported` 字段也是 true —— 但那只是 asset-db 记了账，渲染进程还没导入完。
     *   - `query-asset-info` 返回 null 也不代表资源不存在（可能只是没导入完）。
     * 所以唯一可靠的就是**直接看库文件在不在**。
     *
     * 有了它就能**彻底避免**「打开一个还没导入的场景 → 失败 → 整个 scene 频道卡死」。
     */
    async function isImported(target) {
        // target 可以是 uuid 也可以是 db:// 资源 URL ——
        // scene.open 传的是 uuid，asset.isImported / scene.create 传的是 URL。
        // ⚠️ 这里必须两种都支持：早期版本只认 URL，scene.open 传 uuid 进来
        //    查不到信息 → 一律判为「未导入」→ 打开场景 100% 失败。
        if (!target || typeof target !== 'string') {
            return { imported: false, uuid: null, reason: '没有指定资源（url 或 uuid）' };
        }
        let uuid = null;
        if (isUuidLike(target)) {
            uuid = target;
        } else {
            try {
                const info = await send('asset-db', 'query-asset-info', [target]);
                if (info && info.uuid) uuid = info.uuid;
            } catch (_) {
                return { imported: false, uuid: null, reason: '查不到资源信息（可能还没进库）' };
            }
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
            // 先确认资源在库里且已导入，否则 open-scene 会静默挂死
            let info = null;
            try {
                info = await send('asset-db', 'query-asset-info', [args.uuid]);
            } catch (_) {
                /* 查不到就继续，让 open-scene 自己去报错 */
            }
            if (!info) {
                throw new Error(`找不到场景资源 "${args.uuid}"。先用 asset.uuid 把 db://assets/xxx.scene 路径转成 uuid。`);
            }
            // ⚠️ **打开前必须先确认已导入**。
            //    实测：打开一个还没导入完的场景 → 渲染进程取 import://<uuid>.json 失败 →
            //    编辑器内部打 "SceneFacadeManager.openScene timeout" →
            //    **整个 scene 频道从此卡死**（query-node-tree 永远不返回），
            //    后面所有碰场景的工具全部挂住。
            //    这里提前拦下来，给出可行动的错误，而不是把编辑器搞挂。
            const imp = await isImported(args.uuid);
            if (!imp.imported) {
                throw new Error(
                    `场景 "${args.uuid}" 还没导入完成（${imp.reason}），现在打开会导致场景操作全部卡死。` +
                    '请等几秒后重试，或先用 asset.reimport 触发导入。'
                );
            }

            // 已导入但仍然失败 → 重试（引擎侧偶发失败）
            let lastErr = null;
            // ⚠️ 总预算必须小于 hub 侧 scene.open 的 timeoutMs（180s），
            //    否则客户端会先超时，Bridge 还在重试 —— 白白挂住。
            //
            // ⚠️ 超时预算必须**算清楚**，否则客户端会先超时，而 Bridge 还在重试 ——
            //    白白挂住，而且错误信息会变成客户端的「请求超时」而不是真正的原因。
            //
            //    最坏路径逐项累加：
            //      健康检查(≤8s) + open-scene(≤60s) + 间隔(2s)
            //      + 健康检查(TTL 命中，0s) + open-scene(≤60s)
            //      + 失败后的强制健康检查(≤8s)
            //      = 138s
            //    hub 侧 scene.open 工具的 timeoutMs 是 180000（180s）→ 留 42s 余量。
            //
            // ⚠️ 为什么是 60s 而不是更短：实测引擎在资产库做 auto refresh 时
            //    打开场景要 26~54 秒。超时设 45s 会把「慢但最终成功」误判成失败，
            //    而失败之后的重试是在引擎**半开着的状态**下继续折腾，
            //    才真的把 scene 频道搞死。宁可一次给足，不要设短了再重试。
            const OPEN_ATTEMPTS = 2;
            const OPEN_TIMEOUT_MS = 60000;
            for (let attempt = 1; attempt <= OPEN_ATTEMPTS; attempt++) {
                try {
                    await send(
                        'scene',
                        'open-scene',
                        [args.uuid],
                        {
                            timeoutMs: OPEN_TIMEOUT_MS,
                            timeoutHint:
                                '常见原因：场景资源刚创建、引擎还在导入（渲染进程取 import://<uuid>.json 失败，' +
                                '编辑器内部会打 “SceneFacadeManager.openScene timeout”）。',
                        }
                    );
                    return { opened: args.uuid, name: info.name || null, attempts: attempt };
                } catch (e) {
                    lastErr = e;
                    if (attempt < OPEN_ATTEMPTS) {
                        // ⚠️ 这个模块里没有 log —— 上一版写成了 log(...) 直接 ReferenceError，
                        //    把「打开失败重试」变成了「打开必崩」。
                        console.log(`[cocos-mcp] 打开场景第 ${attempt} 次失败，等 2s 后重试：${e.message}`);
                        await new Promise((r) => setTimeout(r, 2000));
                    }
                }
            }
            // 最后失败：分清「资源没准备好」和「频道已经死了」——
            // 这两种情况的处置方式完全不同，不能只给一句「稍后再试」。
            let channelState = 'alive';
            try {
                // 强制做一次健康检查（跳过 TTL 缓存），确认频道还活着没有
                sceneHealth.checkedAt = 0;
                await assertSceneChannelAlive(ctx);
            } catch (_) {
                channelState = 'dead';
            }
            if (channelState === 'dead') {
                const err = new Error(
                    `打开场景 "${args.uuid}" 失败（${lastErr && lastErr.message}），` +
                    `并且场景频道随后不再回应 —— ${SCENE_DEAD_HINT}`
                );
                err.code = 'SCENE_CHANNEL_DEAD';
                throw err;
            }
            throw new Error(
                `打开场景 "${args.uuid}" 连续 ${OPEN_ATTEMPTS} 次失败：${lastErr && lastErr.message}` +
                '（场景资源可能还没导入完 —— 先用 asset.reimport 触发导入，稍后再试。' +
                '场景频道目前仍然正常，所以可以重试。）'
            );
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
            const options = args.options && typeof args.options === 'object' ? args.options : {};
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
            return { uuid, name: args.name, components: created, componentErrors: failed };
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
     * 重置场景频道健康状态。
     * 仅供测试使用 —— 生产里状态本来就该跟着编辑器进程走
     * （频道死了就是死了，重启编辑器/重启 Bridge 会重新加载模块，状态自然清零）。
     */
    resetSceneHealth() {
        sceneHealth.dead = false;
        sceneHealth.checkedAt = 0;
        sceneHealth.failures = 0;
        sceneHealth.lastProbeAt = 0;
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
