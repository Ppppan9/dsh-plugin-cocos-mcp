'use strict';

/**
 * prefab op 集合 —— schema 校验 + 执行器
 * ---------------------------------------------------------------------------
 * 事务模型：**延迟写盘**。
 * 所有 op 先在内存的 elements 数组上执行；任何一个 op 抛错都不会调用写盘，
 * 所以磁盘保持字节不变（不需要回滚日志）。
 * 连 ensure-meta 产生的 .meta 内容也收集到内存，等全部 op 成功才一起落盘。
 */

const fs = require('node:fs');
const path = require('node:path');

const {
    isPlainObject,
    deepClone,
    refId,
    typeOf,
    normalizePropertyPath,
    displayName,
    isStubNode,
    stubRealName,
    instanceForNode,
    getNodeLocalPos,
    setNodeLocalPos,
} = require('./parse');
const { deterministicFileId, deterministicUuid, compressUUID, isCompressedUUID } = require('./id');
const {
    upsertOverride,
    removeOverrides,
    ensureTargetOverride,
    syncNestedRoots,
    inlineNestedPrefab,
    replaceNestedPrefab,
    resolveLocalIdForComponent,
    buildLocalIdChain,
    normalizeOverridePaths,
    reorderOverrides,
} = require('./nested');

// ─────────────────────────────────────────────────────────────
// op 定义（schema）
// ─────────────────────────────────────────────────────────────

const OP_DEFS = {
    // ── 节点 ──
    'set-position': {
        required: ['node', 'x', 'y'],
        optional: ['z'],
        description: '设置节点本地坐标。写 _lpos。',
    },
    'adjust-position': {
        required: ['node'],
        optional: ['dx', 'dy', 'dz'],
        description: '在当前本地坐标上做相对偏移。',
    },
    'rename-node': { required: ['node', 'name'], optional: [], description: '重命名节点（写 _name）。' },
    'set-active': { required: ['node', 'active'], optional: [], description: '设置节点激活状态（_active）。' },
    'reparent': { required: ['node', 'parent'], optional: ['index'], description: '把节点挂到另一个父节点下。' },
    'reorder-children': { required: ['node', 'order'], optional: [], description: '重排子节点顺序，order 必须包含全部子节点。' },
    'add-node': {
        required: ['parent', 'name'],
        optional: ['type', 'x', 'y', 'z', 'components'],
        description: '新建子节点；components 可指定自动挂载的组件类型。',
    },
    'remove-node': { required: ['node'], optional: [], description: '删除节点（软删：元素保留为孤儿以维持 __id__ 稳定）。' },
    'clone-node': { required: ['node', 'name'], optional: ['parent'], description: '深拷贝子树并重挂到 parent。' },
    'set-node-color': { required: ['node'], optional: ['r', 'g', 'b', 'a'], description: '设置节点上所有 UI 渲染组件的颜色。' },

    // ── 组件 ──
    'add-component': { required: ['node', 'component'], optional: ['props'], description: '挂组件（component 用 cc.Label / 脚本 @ccclass 名）。' },
    'remove-component': { required: ['node', 'component'], optional: [], description: '摘组件（软删）。' },
    'set-component-field': {
        required: ['node', 'component', 'property', 'value'],
        optional: [],
        description: '设置组件的任意字段；property 支持点号路径（如 _color.r）。',
    },
    'set-component-enabled': { required: ['node', 'component', 'enabled'], optional: [], description: '启用/禁用组件（_enabled）。' },
    'set-component-ref': {
        required: ['node', 'component', 'property', 'refNode'],
        optional: ['refType', 'refSubNode'],
        description: '把组件上的 @property 字段指向另一个节点。',
    },
    'set-nested-component-field': {
        required: ['node', 'component', 'property', 'value'],
        optional: ['subNode'],
        description: '设置**嵌套 prefab 内部**节点的组件字段（走 TargetOverrideInfo 协议）。',
    },

    // ── 快捷 ──
    'set-label': {
        required: ['node'],
        optional: ['text', 'fontSize', 'lineHeight', 'overflow', 'horizontalAlign', 'verticalAlign', 'bold', 'italic', 'underline', 'enableWrapText'],
        description: '批量设置 cc.Label 的常用属性。',
    },
    'set-label-text': { required: ['node', 'text'], optional: ['labelNode'], description: '只改 cc.Label 的文本。' },
    'set-button': { required: ['node'], optional: ['interactable', 'transition', 'zoomScale', 'duration'], description: '设置 cc.Button 常用属性。' },
    'set-layout': {
        required: ['node'],
        optional: ['type', 'resizeMode', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'spacingX', 'spacingY', 'startAxis', 'constraint', 'constraintNum'],
        description: '设置 cc.Layout 常用属性。',
    },
    'set-editbox': { required: ['node'], optional: ['inputMode', 'maxLength', 'placeholder', 'string', 'inputFlag', 'fontSize'], description: '设置 cc.EditBox 常用属性。' },
    'set-richtext': { required: ['node'], optional: ['text', 'maxWidth', 'fontSize', 'lineHeight'], description: '设置 cc.RichText 常用属性。' },
    'set-sprite': { required: ['node'], optional: ['sizeMode', 'type', 'grayscale', 'trim'], description: '设置 cc.Sprite 模式类属性。' },
    'set-sprite-frame': { required: ['node', 'uuid'], optional: ['spriteNode'], description: '替换 cc.Sprite 的 spriteFrame（uuid 为 SpriteFrame 资源 uuid）。' },
    'set-anchor': { required: ['node'], optional: ['x', 'y', 'compensatePosition'], description: '设置 cc.UITransform 的锚点。' },
    'set-size': { required: ['node'], optional: ['width', 'height'], description: '设置 cc.UITransform 的尺寸。' },

    // ── 嵌套 prefab ──
    'add-nested-prefab': { required: ['parent', 'prefabUuid'], optional: ['name', 'x', 'y', 'prefabPath'], description: '把另一个 prefab 作为嵌套实例插入。' },
    'replace-nested-prefab': { required: ['node', 'prefabUuid'], optional: ['clearOverrides', 'prefabPath'], description: '替换已有嵌套 prefab 实例的内容。' },
    'reset-overrides': { required: ['node'], optional: ['property', 'componentType', 'subNode', 'all'], description: '清除嵌套 prefab 节点上的 override。' },
    'sync-nested-roots': { required: [], optional: ['node'], description: '重建 nestedPrefabInstanceRoots 并按引擎规则重排 override。' },

    // ── 其它 ──
    'ensure-meta': { required: ['path'], optional: ['uuid'], description: '为 .ts/.json 等资源生成/修正 .meta（纳入事务，失败不留残留）。' },
    'bulk-set': {
        required: ['selector', 'target', 'property', 'value'],
        optional: ['match'],
        description: '按选择器批量设置属性。selector: byComponent / byNamePrefix / byNameRegex；target: node | component:<类型>',
    },
};

const ANIM_OPS = {
    'offset-curve': { required: ['node', 'property', 'offset'], optional: ['axis', 'time'], description: '整体平移一条曲线。' },
    'set-keyframe-value': { required: ['node', 'property', 'time', 'value'], optional: [], description: '修改某个关键帧的值。' },
    'set-curve-channel': { required: ['node', 'property', 'channel'], optional: [], description: '设置轨道使用的通道。' },
};

// ─────────────────────────────────────────────────────────────
// schema 校验
// ─────────────────────────────────────────────────────────────

function levenshtein(a, b) {
    const m = a.length;
    const n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
        }
    }
    return dp[m][n];
}

function suggest(name, candidates) {
    let best = null;
    let bestD = Infinity;
    for (const c of candidates) {
        const d = levenshtein(name.toLowerCase(), c.toLowerCase());
        if (d < bestD) {
            bestD = d;
            best = c;
        }
    }
    return bestD <= Math.max(2, Math.floor(name.length / 3)) ? best : null;
}

/**
 * 校验一串 op。任何错误一次性报齐。
 * @returns {Array<{index:number, message:string}>}
 */
function validateOps(ops, defs = OP_DEFS) {
    const errors = [];
    if (!Array.isArray(ops)) {
        return [{ index: -1, message: 'ops 必须是数组' }];
    }
    ops.forEach((op, i) => {
        if (!isPlainObject(op)) {
            errors.push({ index: i, message: `第 ${i + 1} 个 op 不是对象` });
            return;
        }
        const name = op.op;
        if (typeof name !== 'string') {
            errors.push({ index: i, message: `第 ${i + 1} 个 op 缺少 op 字段` });
            return;
        }
        const def = defs[name];
        if (!def) {
            const s = suggest(name, Object.keys(defs));
            errors.push({
                index: i,
                message: `第 ${i + 1} 个 op 名称 "${name}" 不存在${s ? `，你是不是想用 "${s}"？` : ''}`,
            });
            return;
        }
        const keys = Object.keys(op).filter((k) => k !== 'op');
        for (const req of def.required) {
            if (!(req in op) || op[req] === undefined || op[req] === null) {
                errors.push({ index: i, message: `第 ${i + 1} 个 op "${name}" 缺少必填参数 "${req}"` });
            }
        }
        const allowed = new Set([...def.required, ...def.optional, 'op']);
        for (const k of keys) {
            if (!allowed.has(k)) {
                const s = suggest(k, [...def.required, ...def.optional]);
                errors.push({
                    index: i,
                    message: `第 ${i + 1} 个 op "${name}" 含未知参数 "${k}"${s ? `，你是不是想用 "${s}"？` : ''}`,
                });
            }
        }
    });
    return errors;
}

// ─────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────

/** 重建路径索引（重命名 / 移动层级后调用）。nodeOrder 是 DFS 父先于子，天然满足依赖顺序。 */
function rebuildPaths(ctx) {
    ctx.paths.clear();
    for (const idx of ctx.nodeOrder) {
        const info = ctx.nodes.get(idx);
        if (!info) continue;
        const name = displayName(ctx, idx);
        info.name = name;
        const parent = info.parentIndex >= 0 ? ctx.nodes.get(info.parentIndex) : null;
        info.path = parent ? `${parent.path}/${name}` : name;
        if (!ctx.paths.has(info.path)) ctx.paths.set(info.path, idx);
    }
}

function findNodeIndex(ctx, ref) {
    if (typeof ref === 'number') return ref;
    if (typeof ref !== 'string' || !ref) throw new Error('node 参数必须是节点路径/名称或索引');
    // 1) 完整路径
    if (ctx.paths.has(ref)) return ctx.paths.get(ref);
    // 2) 路径后缀匹配
    const suffix = '/' + ref;
    let hit = -1;
    for (const [p, idx] of ctx.paths) {
        if (p.endsWith(suffix)) {
            if (hit >= 0) throw new Error(`节点 "${ref}" 匹配到多个：${p} 等，请用完整层级路径`);
            hit = idx;
        }
    }
    if (hit >= 0) return hit;
    // 3) 名字匹配（取最浅的一个）。用**实时** displayName —— 重命名后
    //    ctx.paths / info.name 是旧值，只有读元素本身才是当前名字。
    let best = null;
    for (const idx of ctx.nodeOrder) {
        const info = ctx.nodes.get(idx);
        if (info && displayName(ctx, idx) === ref) {
            if (!best || info.depth < ctx.nodes.get(best).depth) best = idx;
        }
    }
    if (best !== null) return best;
    throw new Error(`找不到节点 "${ref}"。可用路径示例：${[...ctx.paths.keys()].slice(0, 15).join('、')}`);
}

function nodeComponents(ctx, nodeIndex) {
    const info = ctx.nodes.get(nodeIndex);
    if (!info) return [];
    return info.components.map((c) => ({ ...c, type: typeOf(c.element) || 'unknown' }));
}

function findComponent(ctx, nodeIndex, componentType) {
    const comps = nodeComponents(ctx, nodeIndex);
    const norm = normalizeCompType(componentType);
    let hit = comps.find((c) => c.type === componentType || c.type === norm);
    if (!hit) hit = comps.find((c) => c.type && (c.type.endsWith('.' + componentType) || c.type.endsWith('.' + norm)));
    if (!hit) {
        throw new Error(
            `节点 "${displayName(ctx, nodeIndex)}" 上没有组件 "${componentType}"。现有组件：` +
            (comps.map((c) => c.type).join('、') || '(无)')
        );
    }
    return hit;
}

/** componentType 三态归一：cc.* 透传 / 23 位压缩透传 / uuid 压缩 / @ccclass 名查表。 */
function normalizeCompType(componentType, ctx) {
    if (typeof componentType !== 'string') return componentType;
    if (componentType.startsWith('cc.') || componentType.startsWith('sp.')) return componentType;
    if (isCompressedUUID(componentType)) return componentType;
    if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(componentType)) {
        return compressUUID(componentType);
    }
    const index = ctx && ctx.classIdIndex ? ctx.classIdIndex : null;
    if (index) {
        const found = index.get(componentType);
        if (found) return found;
        throw new Error(
            `找不到 @ccclass("${componentType}") 对应的脚本。请确认脚本在 assets/ 或 extensions/ 下且已生成 .meta。` +
            `已知脚本：${[...index.keys()].slice(0, 20).join('、') || '(无)'}`
        );
    }
    return componentType;
}

/** 扫描项目建立 @ccclass 名 → 压缩 classId 索引。 */
function buildClassIdIndex(projectRoot) {
    const index = new Map();
    if (!projectRoot) return index;
    const roots = [path.join(projectRoot, 'assets')];
    const extDir = path.join(projectRoot, 'extensions');
    try {
        if (fs.existsSync(extDir)) {
            for (const e of fs.readdirSync(extDir)) roots.push(path.join(extDir, e));
        }
    } catch (_) {
        /* ignore */
    }
    for (const root of roots) {
        if (!fs.existsSync(root)) continue;
        walkTs(root, index);
    }
    return index;
}

function walkTs(dir, index) {
    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
        return;
    }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name === 'node_modules' || e.name === '.git') continue;
            walkTs(full, index);
        } else if (e.isFile() && e.name.endsWith('.ts')) {
            let src = '';
            try {
                src = fs.readFileSync(full, 'utf8');
            } catch (_) {
                continue;
            }
            const re = /@ccclass\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
            let m;
            while ((m = re.exec(src))) {
                const name = m[1];
                const metaPath = `${full}.meta`;
                try {
                    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                    if (meta && meta.uuid) {
                        index.set(name, compressUUID(meta.uuid));
                        index.set(meta.uuid, compressUUID(meta.uuid));
                    }
                } catch (_) {
                    /* 没有 .meta 或解析失败 */
                }
            }
        }
    }
}

function findProjectRoot(filePath) {
    let dir = path.dirname(path.resolve(filePath));
    for (let i = 0; i < 12; i++) {
        if (fs.existsSync(path.join(dir, 'assets'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

/** 按点号路径读写对象字段。 */
function getPath(obj, segments) {
    let cur = obj;
    for (const s of segments) {
        if (cur === null || cur === undefined) return undefined;
        cur = cur[s];
    }
    return cur;
}

function setPath(obj, segments, value) {
    if (!segments.length) return false;
    let cur = obj;
    for (let i = 0; i < segments.length - 1; i++) {
        const s = segments[i];
        if (!isPlainObject(cur[s])) cur[s] = {};
        cur = cur[s];
    }
    cur[segments[segments.length - 1]] = value;
    return true;
}

function splitPath(p) {
    if (Array.isArray(p)) return p.slice();
    return String(p)
        .split('.')
        .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
}

// ─────────────────────────────────────────────────────────────
// op 执行器
// ─────────────────────────────────────────────────────────────

const HANDLERS = {
    'set-position': (ctx, op) => {
        const idx = findNodeIndex(ctx, op.node);
        const el = ctx.data[idx];
        const z = op.z === undefined ? (getNodeLocalPos(el).z || 0) : Number(op.z);
        setNodeLocalPos(el, { x: Number(op.x), y: Number(op.y), z: Number(z) });
        return { node: displayName(ctx, idx), position: { x: Number(op.x), y: Number(op.y), z: Number(z) } };
    },

    'adjust-position': (ctx, op) => {
        const idx = findNodeIndex(ctx, op.node);
        const el = ctx.data[idx];
        const p = getNodeLocalPos(el);
        const next = {
            x: (p.x || 0) + Number(op.dx || 0),
            y: (p.y || 0) + Number(op.dy || 0),
            z: (p.z || 0) + Number(op.dz || 0),
        };
        setNodeLocalPos(el, next);
        return { node: displayName(ctx, idx), position: next };
    },

    'rename-node': (ctx, op) => {
        const idx = findNodeIndex(ctx, op.node);
        const el = ctx.data[idx];
        const old = el._name;
        el._name = String(op.name);
        if (isStubNode(ctx, idx)) {
            // stub 的真实名字在 override 里
            const inst = instanceForNode(ctx, idx);
            if (inst) {
                upsertOverride(ctx, inst, {
                    localID: inst.fileId ? [inst.fileId] : [],
                    propertyPath: ['_name'],
                    value: String(op.name),
                });
            }
        }
        rebuildPaths(ctx);
        return { node: displayName(ctx, idx), oldName: old, newName: String(op.name) };
    },

    'set-active': (ctx, op) => {
        const idx = findNodeIndex(ctx, op.node);
        ctx.data[idx]._active = !!op.active;
        return { node: displayName(ctx, idx), active: !!op.active };
    },

    'reparent': (ctx, op) => {
        const idx = findNodeIndex(ctx, op.node);
        const parentIdx = findNodeIndex(ctx, op.parent);
        if (idx === parentIdx) throw new Error('不能把节点挂到它自己下面');
        // 循环检测
        let cur = parentIdx;
        while (cur >= 0) {
            if (cur === idx) throw new Error('不能把节点挂到它的后代下面（会形成环）');
            cur = ctx.nodes.get(cur).parentIndex;
        }
        const oldParent = ctx.nodes.get(idx).parentIndex;
        if (oldParent >= 0) {
            const op_ = ctx.data[oldParent];
            op_._children = (op_._children || []).filter((c) => refId(c) !== idx);
        }
        const pe = ctx.data[parentIdx];
        pe._children = pe._children || [];
        if (op.index === undefined || op.index === null) pe._children.push({ __id__: idx });
        else pe._children.splice(Number(op.index), 0, { __id__: idx });
        ctx.nodes.get(idx).parentIndex = parentIdx;
        return { node: displayName(ctx, idx), parent: displayName(ctx, parentIdx) };
    },

    'reorder-children': (ctx, op) => {
        const idx = findNodeIndex(ctx, op.node);
        const el = ctx.data[idx];
        const order = [].concat(op.order);
        const current = (el._children || []).map((c) => refId(c));
        if (order.length !== current.length) {
            throw new Error(`order 长度（${order.length}）与子节点数（${current.length}）不一致`);
        }
        const set = new Set(order.map(Number));
        for (const c of current) {
            if (!set.has(c)) throw new Error(`order 里缺少子节点 __id__ ${c}`);
        }
        el._children = order.map((c) => ({ __id__: Number(c) }));
        return { node: displayName(ctx, idx), order };
    },

    'add-node': (ctx, op) => {
        const parentIdx = findNodeIndex(ctx, op.parent);
        const name = String(op.name);
        const nodeIndex = ctx.data.length;
        const node = {
            __type__: 'cc.Node',
            _name: name,
            _objFlags: 0,
            _parent: { __id__: parentIdx },
            _children: [],
            _components: [],
            _prefab: null,
            _lpos: { x: Number(op.x || 0), y: Number(op.y || 0), z: Number(op.z || 0) },
            _lrot: { x: 0, y: 0, z: 0, w: 1 },
            _lscale: { x: 1, y: 1, z: 1 },
            _mobility: 0,
            _layer: 33554432,
        };
        ctx.data.push(node);
        const parent = ctx.data[parentIdx];
        parent._children = parent._children || [];
        parent._children.push({ __id__: nodeIndex });

        const added = [];
        for (const comp of op.components || []) {
            added.push(addComponentInternal(ctx, nodeIndex, comp));
        }
        return { node: name, index: nodeIndex, components: added };
    },

    'remove-node': (ctx, op) => {
        const idx = findNodeIndex(ctx, op.node);
        if (idx === ctx.rootIndex) throw new Error('不能删除根节点');
        const info = ctx.nodes.get(idx);
        const parentIdx = info.parentIndex;
        if (parentIdx >= 0) {
            const pe = ctx.data[parentIdx];
            pe._children = (pe._children || []).filter((c) => refId(c) !== idx);
        }
        // 软删：整棵子树标孤儿，元素保留以维持 __id__ 稳定
        const orphans = [];
        const mark = (i) => {
            const n = ctx.nodes.get(i);
            if (!n) return;
            orphans.push(i);
            ctx.orphanNodes.add(i);
            for (const c of n.components) ctx.orphanComponents.add(c.index);
            for (const c of n.children) mark(c);
        };
        mark(idx);
        return { removed: displayName(ctx, idx), orphanCount: orphans.length };
    },

    'clone-node': (ctx, op) => {
        const idx = findNodeIndex(ctx, op.node);
        const parentIdx = op.parent ? findNodeIndex(ctx, op.parent) : ctx.nodes.get(idx).parentIndex;
        if (parentIdx < 0) throw new Error('克隆失败：源节点没有父节点，且未指定 parent');
        const map = new Map();
        const cloneSubtree = (src) => {
            const copy = deepClone(ctx.data[src]);
            const newIdx = ctx.data.length;
            ctx.data.push(copy);
            map.set(src, newIdx);
            return newIdx;
        };
        const rootNew = cloneSubtree(idx);
        const queue = [idx];
        while (queue.length) {
            const cur = queue.shift();
            const curNew = map.get(cur);
            const curEl = ctx.data[curNew];
            curEl._children = [];
            curEl._components = [];
            const srcInfo = ctx.nodes.get(cur);
            for (const child of srcInfo.children) {
                const childNew = cloneSubtree(child);
                curEl._children.push({ __id__: childNew });
                queue.push(child);
            }
            for (const comp of srcInfo.components) {
                const compCopy = deepClone(ctx.data[comp.index]);
                const compNew = ctx.data.length;
                ctx.data.push(compCopy);
                curEl._components.push({ __id__: compNew });
            }
        }
        // 修正引用
        const remap = (el) => {
            if (!isPlainObject(el)) return;
            for (const k of Object.keys(el)) {
                const v = el[k];
                if (isPlainObject(v) && typeof v.__id__ === 'number' && map.has(v.__id__)) {
                    el[k] = { __id__: map.get(v.__id__) };
                }
            }
        };
        for (const nIdx of map.values()) remap(ctx.data[nIdx]);
        // 重新挂到父节点
        const parentEl = ctx.data[parentIdx];
        parentEl._children = parentEl._children || [];
        parentEl._children.push({ __id__: rootNew });
        // 新 fileId
        ctx.data[rootNew]._name = String(op.name);
        return { cloned: displayName(ctx, idx), newIndex: rootNew, name: String(op.name) };
    },

    'set-node-color': (ctx, op) => {
        const idx = findNodeIndex(ctx, op.node);
        const color = { r: Number(op.r || 255), g: Number(op.g || 255), b: Number(op.b || 255), a: Number(op.a === undefined ? 255 : op.a) };
        let n = 0;
        for (const comp of nodeComponents(ctx, idx)) {
            if (isPlainObject(comp.element._color)) {
                comp.element._color = { ...color };
                n++;
            }
        }
        if (!n) throw new Error(`节点 "${displayName(ctx, idx)}" 上没有带 _color 的渲染组件（cc.Sprite / cc.Label 等）`);
        return { node: displayName(ctx, idx), color, appliedTo: n };
    },

    'add-component': (ctx, op) => {
        const idx = findNodeIndex(ctx, op.node);
        return addComponentInternal(ctx, idx, op.component, op.props);
    },

    'remove-component': (ctx, op) => {
        const idx = findNodeIndex(ctx, op.node);
        const comp = findComponent(ctx, idx, op.component);
        const nodeEl = ctx.data[idx];
        nodeEl._components = (nodeEl._components || []).filter((c) => refId(c) !== comp.index);
        ctx.orphanComponents.add(comp.index);
        return { node: displayName(ctx, idx), removed: comp.type };
    },

    'set-component-field': (ctx, op) => {
        const idx = findNodeIndex(ctx, op.node);
        const comp = findComponent(ctx, idx, op.component);
        if (isStubNode(ctx, idx)) {
            throw new Error(
                `节点 "${displayName(ctx, idx)}" 是嵌套 prefab 的 stub，组件字段要写入 override。` +
                '请改用 set-nested-component-field。'
            );
        }
        const segs = splitPath(op.property);
        const old = getPath(comp.element, segs);
        setPath(comp.element, segs, op.value);
        return { node: displayName(ctx, idx), component: comp.type, property: op.property, old, value: op.value };
    },

    'set-component-enabled': (ctx, op) => {
        const idx = findNodeIndex(ctx, op.node);
        const comp = findComponent(ctx, idx, op.component);
        comp.element._enabled = !!op.enabled;
        return { node: displayName(ctx, idx), component: comp.type, enabled: !!op.enabled };
    },

    'set-component-ref': (ctx, op) => {
        const idx = findNodeIndex(ctx, op.node);
        const comp = findComponent(ctx, idx, op.component);
        const refIdx = findNodeIndex(ctx, op.refNode);
        const refType = op.refType ? normalizeCompType(op.refType, ctx) : 'cc.Node';
        if (isStubNode(ctx, idx)) {
            const inst = instanceForNode(ctx, idx);
            if (!inst) throw new Error('stub 节点没有对应的 PrefabInstance，无法写 override');
            const localID = resolveLocalIdForComponent(ctx, idx, comp.index);
            upsertOverride(ctx, inst, { localID, propertyPath: splitPath(op.property), value: { __id__: refIdx } });
            ensureTargetOverride(ctx, inst);
            return { node: displayName(ctx, idx), component: comp.type, property: op.property, ref: displayName(ctx, refIdx), viaOverride: true };
        }
        const segs = splitPath(op.property);
        setPath(comp.element, segs, { __id__: refIdx });
        return { node: displayName(ctx, idx), component: comp.type, property: op.property, ref: displayName(ctx, refIdx) };
    },

    'set-nested-component-field': (ctx, op) => {
        const idx = findNodeIndex(ctx, op.node);
        const inst = instanceForNode(ctx, idx);
        if (!inst) throw new Error(`节点 "${displayName(ctx, idx)}" 不是嵌套 prefab 实例，无法写内部组件`);
        const comps = nodeComponents(ctx, idx);
        let comp = null;
        for (const c of comps) {
            if (c.type === op.component || c.type.endsWith('.' + op.component)) {
                comp = c;
                break;
            }
        }
        if (!comp) {
            throw new Error(
                `节点 "${displayName(ctx, idx)}" 上没有组件 "${op.component}"。现有组件：${comps.map((c) => c.type).join('、') || '(无)'}`
            );
        }
        const localID = resolveLocalIdForComponent(ctx, idx, comp.index);
        upsertOverride(ctx, inst, { localID, propertyPath: splitPath(op.property), value: op.value });
        ensureTargetOverride(ctx, inst);
        return {
            node: displayName(ctx, idx),
            component: comp.type,
            property: op.property,
            value: op.value,
            localID,
        };
    },

    'set-label': (ctx, op) => setComponentShortcut(ctx, op, 'cc.Label', {
        _string: 'text', _fontSize: 'fontSize', _lineHeight: 'lineHeight', _overflow: 'overflow',
        _horizontalAlign: 'horizontalAlign', _verticalAlign: 'verticalAlign', _isBold: 'bold',
        _isItalic: 'italic', _isUnderline: 'underline', _enableWrapText: 'enableWrapText',
    }),
    'set-label-text': (ctx, op) => setComponentShortcut(ctx, op, 'cc.Label', { _string: 'text' }),
    'set-button': (ctx, op) => setComponentShortcut(ctx, op, 'cc.Button', {
        _interactable: 'interactable', _transition: 'transition', _zoomScale: 'zoomScale', _duration: 'duration',
    }),
    'set-layout': (ctx, op) => setComponentShortcut(ctx, op, 'cc.Layout', {
        _layoutType: 'type', _resizeMode: 'resizeMode', _paddingLeft: 'paddingLeft', _paddingRight: 'paddingRight',
        _paddingTop: 'paddingTop', _paddingBottom: 'paddingBottom', _spacingX: 'spacingX', _spacingY: 'spacingY',
        _startAxis: 'startAxis', _constraint: 'constraint', _constraintNum: 'constraintNum',
    }),
    'set-editbox': (ctx, op) => setComponentShortcut(ctx, op, 'cc.EditBox', {
        _inputMode: 'inputMode', _maxLength: 'maxLength', _placeholder: 'placeholder',
        _string: 'string', _inputFlag: 'inputFlag', _fontSize: 'fontSize',
    }),
    'set-richtext': (ctx, op) => setComponentShortcut(ctx, op, 'cc.RichText', {
        _string: 'text', _maxWidth: 'maxWidth', _fontSize: 'fontSize', _lineHeight: 'lineHeight',
    }),
    'set-sprite': (ctx, op) => setComponentShortcut(ctx, op, 'cc.Sprite', {
        _sizeMode: 'sizeMode', _type: 'type', _grayscale: 'grayscale', _trim: 'trim',
    }),
    'set-sprite-frame': (ctx, op) => {
        const target = op.spriteNode ? findNodeIndex(ctx, op.spriteNode) : findNodeIndex(ctx, op.node);
        const comp = findComponent(ctx, target, 'cc.Sprite');
        comp.element._spriteFrame = { __id__: -1, __uuid__: String(op.uuid) };
        return { node: displayName(ctx, target), component: 'cc.Sprite', spriteFrame: String(op.uuid) };
    },
    'set-anchor': (ctx, op) => {
        const idx = findNodeIndex(ctx, op.node);
        const comp = findComponent(ctx, idx, 'cc.UITransform');
        const x = op.x === undefined ? 0.5 : Number(op.x);
        const y = op.y === undefined ? 0.5 : Number(op.y);
        comp.element._anchorPoint = { x, y };
        return { node: displayName(ctx, idx), anchorPoint: { x, y } };
    },
    'set-size': (ctx, op) => {
        const idx = findNodeIndex(ctx, op.node);
        const comp = findComponent(ctx, idx, 'cc.UITransform');
        const w = op.width === undefined ? comp.element._contentSize.width : Number(op.width);
        const h = op.height === undefined ? comp.element._contentSize.height : Number(op.height);
        comp.element._contentSize = { width: w, height: h };
        return { node: displayName(ctx, idx), contentSize: { width: w, height: h } };
    },

    'add-nested-prefab': (ctx, op) => {
        const parentIdx = findNodeIndex(ctx, op.parent);
        const prefabPath = op.prefabPath || resolvePrefabPath(ctx, op.prefabUuid);
        if (!prefabPath) throw new Error(`找不到 prefab "${op.prefabUuid}" 对应的文件路径（可显式传 prefabPath）`);
        const created = inlineNestedPrefab(ctx, {
            parentIndex,
            prefabPath,
            name: op.name,
            x: op.x,
            y: op.y,
        });
        return { added: created.name, nodeIndex: created.nodeIndex };
    },

    'replace-nested-prefab': (ctx, op) => {
        const idx = findNodeIndex(ctx, op.node);
        const prefabPath = op.prefabPath || resolvePrefabPath(ctx, op.prefabUuid);
        if (!prefabPath) throw new Error(`找不到 prefab "${op.prefabUuid}" 对应的文件路径（可显式传 prefabPath）`);
        const r = replaceNestedPrefab(ctx, { nodeIndex: idx, prefabPath });
        if (op.clearOverrides) {
            const inst = instanceForNode(ctx, idx);
            if (inst) removeOverrides(ctx, inst, {});
        }
        return { replaced: displayName(ctx, idx), orphans: r.orphans.length };
    },

    'reset-overrides': (ctx, op) => {
        const idx = findNodeIndex(ctx, op.node);
        const inst = instanceForNode(ctx, idx);
        if (!inst) throw new Error(`节点 "${displayName(ctx, idx)}" 不是嵌套 prefab 实例，没有 override 可清`);
        const filter = {};
        if (op.property) filter.propertyPath = splitPath(op.property);
        const removed = removeOverrides(ctx, inst, filter);
        return { node: displayName(ctx, idx), removed: removed.length };
    },

    'sync-nested-roots': (ctx, op) => {
        const idx = op.node ? findNodeIndex(ctx, op.node) : -1;
        const r = syncNestedRoots(ctx, idx);
        return { synced: r.length || 0 };
    },

    'ensure-meta': (ctx, op) => {
        const target = path.resolve(op.path);
        const plan = ctx.planMetaWrite(target, { uuid: op.uuid });
        if (!plan) return { skipped: target, reason: '已存在 .meta' };
        ctx.metaPlans.push(plan);
        return { meta: plan.metaPath, uuid: plan.uuid };
    },

    'bulk-set': (ctx, op) => {
        const selector = op.selector;
        const targets = [];
        for (const idx of ctx.nodeOrder) {
            const info = ctx.nodes.get(idx);
            if (!info || ctx.orphanNodes.has(idx)) continue;
            const name = info.name;
            let hit = false;
            if (selector === 'byComponent') {
                hit = nodeComponents(ctx, idx).some((c) => c.type === op.target || c.type.endsWith('.' + op.target));
            } else if (selector === 'byNamePrefix') {
                hit = name.startsWith(op.match || op.target);
            } else if (selector === 'byNameRegex') {
                hit = new RegExp(op.match || op.target).test(name);
            }
            if (hit) targets.push(idx);
        }
        let applied = 0;
        for (const idx of targets) {
            const target = op.target;
            if (target.startsWith('component:')) {
                const compType = target.slice('component:'.length);
                const comps = nodeComponents(ctx, idx);
                const comp = comps.find((c) => c.type === compType || c.type.endsWith('.' + compType));
                if (!comp) continue;
                setPath(comp.element, splitPath(op.property), op.value);
            } else {
                setPath(ctx.data[idx], splitPath(op.property), op.value);
            }
            applied++;
        }
        return { matched: targets.length, applied };
    },
};

function setComponentShortcut(ctx, op, compType, fieldMap) {
    const idx = findNodeIndex(ctx, op.node);
    const comp = findComponent(ctx, idx, compType);
    const applied = {};
    for (const [field, opKey] of Object.entries(fieldMap)) {
        if (op[opKey] === undefined) continue;
        comp.element[field] = op[opKey];
        applied[field] = op[opKey];
    }
    if (!Object.keys(applied).length) {
        throw new Error(`没有指定任何要修改的字段。可用字段：${Object.values(fieldMap).join('、')}`);
    }
    return { node: displayName(ctx, idx), component: compType, applied };
}

function addComponentInternal(ctx, nodeIndex, componentType, props) {
    const type = normalizeCompType(componentType, ctx);
    const idx = ctx.data.length;
    const comp = { __type__: type };
    if (props && isPlainObject(props)) {
        for (const [k, v] of Object.entries(props)) comp[k] = v;
    }
    ctx.data.push(comp);
    const nodeEl = ctx.data[nodeIndex];
    nodeEl._components = nodeEl._components || [];
    nodeEl._components.push({ __id__: idx });
    return { index: idx, type };
}

function resolvePrefabPath(ctx, prefabUuid) {
    const root = ctx.projectRoot;
    if (!root || !prefabUuid) return null;
    const idx = ctx.assetIndex ? ctx.assetIndex.get(prefabUuid) : null;
    return idx || null;
}

module.exports = {
    OP_DEFS,
    ANIM_OPS,
    HANDLERS,
    validateOps,
    normalizeCompType,
    buildClassIdIndex,
    findProjectRoot,
    findNodeIndex,
    rebuildPaths,
    nodeComponents,
    findComponent,
    getPath,
    setPath,
    splitPath,
    suggest,
};
