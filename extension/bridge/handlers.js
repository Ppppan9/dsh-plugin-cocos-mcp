'use strict';

const fs = require('fs');

const { verify } = require('./messages');

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
 * 节点解析（uuid / 路径 / 名字）都需要场景树。场景树��询一次要几十毫秒，
 * 而一个典型工作流里会连续解析好几个节点 —— 所以缓存 2 秒。
 * 任何写操作（建/删/移节点、改属性、场景生命周期）都会让缓存失效。
 */
const TREE_TTL_MS = 2000;
const treeCache = new Map(); // ctx 无关，全进程一份（编辑器主进程只有一个）

async function getSceneTree(ctx) {
    const hit = treeCache.get('tree');
    const now = Date.now();
    if (hit && now - hit.ts < TREE_TTL_MS) {
        return hit.flat;
    }
    const tree = await ctx.msg('scene', 'query-node-tree');
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
        const timeoutMs = opts.timeoutMs;
        if (!timeoutMs) {
            return ctx.msg(channel, message, ...args);
        }
        let timer = null;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => {
                const err = new Error(
                    `编辑器消息 "${channel}:${message}" 超时（${timeoutMs}ms 未返回）。` + (opts.timeoutHint || '')
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
            return await ctx.msg(args.channel, args.message, ...list);
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
            await send(
                'scene',
                'open-scene',
                [args.uuid],
                {
                    timeoutMs: 60000,
                    timeoutHint:
                        '常见原因：场景资源刚创建、引擎还在导入（渲染进程取 import://<uuid>.json 失败，' +
                        '编辑器内部会打 “SceneFacadeManager.openScene timeout”）。等几秒后重试，' +
                        '或先用 asset.reimport 触发导入。',
                }
            );
            return { opened: args.uuid, name: info.name || null };
        },

        'scene.save': async () => {
            invalidateTree();
            const r = await send('scene', 'save-scene', []);
            return { saved: true, result: r === undefined ? null : r };
        },

        'scene.close': async () => {
            invalidateTree();
            const r = await send('scene', 'close-scene', []);
            return { closed: true, result: r === undefined ? null : r };
        },

        'scene.reload': async () => {
            invalidateTree();
            await send('scene', 'soft-reload', []);
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
            for (const comp of args.components || []) {
                await send('scene', 'create-component', [{ uuid, component: comp }]);
                created.push(comp);
            }
            return { uuid, name: args.name, components: created };
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
            const uuid = await resolveNode(ctx, args.node);
            if (args.action === 'copy') return { copied: await send('scene', 'copy-node', [uuid]) };
            if (args.action === 'cut') return { cut: await send('scene', 'cut-node', [{ parent: uuid, uuids: uuid }]) };
            const target = await resolveNode(ctx, args.target);
            return { pasted: await send('scene', 'paste-node', [{ target, uuids: uuid }]) };
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
            const has = comps.some((c) => readCompType(c) === args.component);
            if (!has) {
                throw new Error(
                    `节点 "${args.node}" 上没有组件 "${args.component}"，没有可摘的。` +
                    `现有组件：${comps.map((c) => readCompType(c)).join('、') || '(无)'}`
                );
            }
            await send('scene', 'remove-component', [{ uuid, component: args.component }]);
            return { uuid, component: args.component, removed: true };
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

        'asset.info': async (args) => {
            req(args, ['url'], 'asset.info');
            const info = await send('asset-db', 'query-asset-info', args.dataKeys ? [args.url, args.dataKeys] : [args.url]);
            if (!info) throw new Error(`资源不存在：${args.url}`);
            return info;
        },

        'asset.create': async (args) => {
            req(args, ['url'], 'asset.create');
            const r = await send('asset-db', 'create-asset', [args.url, args.content === undefined ? null : args.content]);
            return { created: args.url, info: r };
        },

        'asset.save': async (args) => {
            req(args, ['url', 'content'], 'asset.save');
            const r = await send('asset-db', 'save-asset', [args.url, args.content]);
            return { saved: args.url, info: r };
        },

        'asset.delete': async (args) => {
            req(args, ['url'], 'asset.delete');
            const r = await send('asset-db', 'delete-asset', [args.url]);
            // delete-asset 找不到资源时返回 null 而不是报错 —— 明确告诉调用方「没删掉」
            if (r === null || r === undefined) {
                throw new Error(`资源不存在或删除失败：${args.url}。先用 asset.info 确认它存在。`);
            }
            return { deleted: args.url, info: r };
        },

        'asset.move': async (args) => {
            req(args, ['from', 'to'], 'asset.move');
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
            await send('builder', 'add-task', [options, args.shouldWait !== false]);
            return { started: true, platform: args.platform || null };
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
        'preferences.get': async (args) => send('preferences', 'query-config', [args.name, args.key, args.protocol]),
        'preferences.set': async (args) =>
            await send('preferences', 'set-config', [args.name, args.key, args.value, args.protocol]),
        'project.config': async (args) => send('project', 'query-config', [args.key]),
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
