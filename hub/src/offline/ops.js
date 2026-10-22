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
const { isInsideAnyRoot } = require('../util/path-guard');
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
        description:
            '按选择器批量设置属性。\n' +
            'selector: byComponent（按组件类型匹配）/ byNamePrefix（按名字前缀）/ byNameRegex（按名字正则）。\n' +
            'target: **写入目标** —— "node" 写节点，或 "component:cc.Label" 写组件。\n' +
            'match: 匹配条件。byComponent 时填组件类型名（如 "cc.Label"），缺省时从 target 推导；' +
            'byNamePrefix / byNameRegex 时**必填**（留空会匹配全部节点，已拒绝）。\n' +
            '例：{"selector":"byComponent","target":"component:cc.Label","match":"cc.Label","property":"_string","value":"确定"}。\n' +
            '⚠️ property 用的是 **.prefab 序列化后的字段名**（带 _ 前缀，如 _string / _fontSize），不是编辑器里显示的名字。',
    },
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
    if (typeof ref === 'number') {
        // 数字索引也要校验 —— 不校验的话，下标越界会变成
        // "Cannot set properties of undefined" 这种没法定位的裸 TypeError。
        if (!ctx.nodes.has(ref)) {
            throw new Error(
                `节点下标 ${ref} 不存在（prefab 里有 ${ctx.nodes.size} 个节点，元素总数 ${ctx.data.length}）。`
            );
        }
        return ref;
    }
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
    //    孤儿节点（已软删）不参与匹配。
    let best = null;
    for (const idx of ctx.nodeOrder) {
        const info = ctx.nodes.get(idx);
        if (info && !ctx.orphanNodes.has(idx) && displayName(ctx, idx) === ref) {
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
    // ⚠️ 必须传 ctx —— 否则 normalizeCompType 拿不到 classIdIndex，
    // @ccclass("Foo") 这种脚本组件名就找不到（建得出来、却用不了）。
    const norm = normalizeCompType(componentType, ctx);
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
    assertSafePathSegments(segments, '路径');
    let cur = obj;
    for (const s of segments) {
        if (cur === null || cur === undefined) return undefined;
        cur = cur[s];
    }
    return cur;
}

/**
 * 按路径写值。
 *
 * ⚠️ 数组必须**当数组处理**：
 * 之前用 `isPlainObject(cur[s])` 判断，遇到数组会把它替换成 {} ——
 * 于是 `_items.0.v` 这种带下标的路径会**摧毁整个数组**，
 * 剩下的元素静默丢失，磁盘上还是「改成功了」。
 */
function setPath(obj, segments, value) {
    if (!segments.length) return false;
    // 兜底断言 —— setPath 是导出函数，外部直接调用时也要守住原型链。
    assertSafePathSegments(segments, '路径');
    let cur = obj;
    let i = 0;
    while (i < segments.length - 1) {
        const s = segments[i];
        const next = cur[s];
        // ⚠️ 往里走之前必须是**自有属性** ——
        //    继承来的对象（如 Object.prototype）被当成数据容器写进去，
        //    等于改到了全局共享对象上。保留段已在上面拦掉，这里防的是
        //    「原型上挂了一个普通对象的」这种更隐蔽的情况。
        if (next !== undefined && next !== null && !Object.prototype.hasOwnProperty.call(cur, s)) {
            throw new Error(
                `路径 "${segments.join('.')}" 的 "${s}" 是从原型链继承来的，不是数据自己的字段，` +
                '无法安全写入。已中止，未修改任何数据。'
            );
        }
        if (Array.isArray(next)) {
            // 数组：下一段是数字下标 —— 要落到**元素**上，不是数组本身
            const idx = segments[i + 1];
            if (typeof idx !== 'number' || idx < 0 || idx >= next.length) {
                throw new Error(
                    `路径 "${segments.join('.')}" 的下标 "${idx}" 超出数组范围（长度 ${next.length}）。` +
                    '不会修改该数组。'
                );
            }
            // ⚠️ 下标之后**还有**字段 → 落到元素上继续往下走。
            //    下标本身就是末段（如 "_items.0"）→ 直接替换那个元素。
            //    之前这里不区分，把末段下标也消费掉了，结果写成
            //    `arr[0]["0"] = v`（元素上多一个字符串键）——
            //    报成功，但数据是错的。
            if (i + 2 < segments.length) {
                cur = next[idx];
                i += 2;
                continue;
            }
            next[idx] = value;
            return true;
        }
        if (isPlainObject(next)) {
            cur = next;
            i += 1;
            continue;
        }
        if (next === undefined || next === null) {
            // 缺失的中间层：按下一段是数字就建数组，否则建对象
            const created = typeof segments[i + 1] === 'number' ? [] : {};
            cur[s] = created;
            cur = created;
            i += 1;
            continue;
        }
        // 已经是标量（字符串/数字/布尔）→ 不能往里写，抛错而不是覆盖
        throw new Error(
            `路径 "${segments.join('.')}" 在 "${segments.slice(0, i + 1).join('.')}" 处遇到非容器值` +
            `（${typeof next}），无法写入。已中止，未修改任何数据。`
        );
    }
    const last = segments[segments.length - 1];
    if (Array.isArray(cur)) {
        if (typeof last !== 'number' || last < 0 || last >= cur.length) {
            throw new Error(`路径末段 "${last}" 不是数组的有效下标（长度 ${cur.length}）。`);
        }
        cur[last] = value;
        return true;
    }
    if (!isPlainObject(cur)) {
        throw new Error(`路径 "${segments.join('.')}" 的父级不是对象，无法写入。`);
    }
    // ⚠️ 末段不能是「只存在于原型链上」的名字 ——
    //    toString / valueOf / hasOwnProperty 这些名字在 Object.prototype 上，
    //    单段路径不会走进上面的遍历循环，于是直接 `cur[last] = value`
    //    → 生成一个引擎根本不认的自有字段，**报成功但数据是垃圾**。
    //    规则很精确：**在对象上存在、但不是它自己的** → 拒绝；
    //    完全不存在 → 允许新建（那是合法的「加字段」语义）。
    if (last in cur && !Object.prototype.hasOwnProperty.call(cur, last)) {
        throw new Error(
            `路径 "${segments.join('.')}" 的末段 "${last}" 是从原型链继承来的（如 toString / constructor / valueOf），` +
            '不是数据自己的字段。写入会生成引擎不认的字段。已中止，未修改任何数据。'
        );
    }
    cur[last] = value;
    return true;
}

/**
 * 会写到原型链上的保留路径段。
 *
 * ⚠️ 之前**完全没有**这道闸 ——
 *    `property: "a.__proto__.x"` 会一路 setPath 走到 Object.prototype 上，
 *    **污染整个进程**（实测 `({}).x` 变成 "PWNED"，所有对象都中招）。
 *    `constructor` / `prototype` 同理：
 *      - `constructor` 会被下面的「属性存在」守卫用 `in` 放行 → 写出自有字段
 *        → 报 applied:1 但引擎根本不认（典型的「报告成功但零效果」）；
 *      - `prototype` 是类原型入口。
 *    prefab 里不可能有这三个字段名，直接拒掉最省事。
 */
const RESERVED_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * 拒绝会写到原型链上的路径段。
 *
 * 这是**唯一收口点**：所有用户给的 property 路径都经 splitPath 进来，
 * 放在这里比在每个 op 里各写一遍可靠得多。
 */
function assertSafePathSegments(segments, label) {
    for (const s of segments) {
        if (typeof s === 'string' && RESERVED_PATH_SEGMENTS.has(s)) {
            throw new Error(
                `${label || '路径'} "${segments.join('.')}" 含保留段 "${s}"。` +
                '__proto__ / constructor / prototype 会写到原型链上（能污染整个进程），已拒绝。'
            );
        }
    }
    return segments;
}

function splitPath(p) {
    const segs = Array.isArray(p) ? p.slice() : String(p).split('.').map((s) => (/^\d+$/.test(s) ? Number(s) : s));
    return assertSafePathSegments(segs, '属性路径');
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
        // ⚠️ **必须先判断是不是 stub，再决定写哪里** ——
        //    isStubNode 的判据是「`_name` 不是 string」（stub 节点的名字在 override 里），
        //    所以**一旦先写了 `_name`，判断就必然失效** → stub 分支永远走不到。
        //    之前就是先写后判，后果有三重：
        //      1. 引擎读的是 override，改 `_name` 等于**零效果**（工具报成功、编辑器不变）；
        //      2. stub 约定被破坏（stub 不该有 `_name`）；
        //      3. 连锁污染 —— 重新加载后该节点不再被当作 stub，
        //         后续 op 于是直接写进 stub 自己的组件 → 又是「报告成功但零效果」。
        const isStub = isStubNode(ctx, idx);
        if (isStub) {
            // stub：**只**写 override，绝不写 `_name`。
            const inst = instanceForNode(ctx, idx);
            if (!inst) {
                throw new Error(
                    `节点 "${displayName(ctx, idx)}" 是嵌套 prefab 的 stub，但找不到它所属的 PrefabInstance —— 无法写入名字覆盖。`
                );
            }
            upsertOverride(ctx, inst, {
                localID: inst.fileId ? [inst.fileId] : [],
                propertyPath: ['_name'],
                value: String(op.name),
            });
        } else {
            el._name = String(op.name);
        }
        rebuildPaths(ctx);
        return { node: displayName(ctx, idx), oldName: old, newName: String(op.name), stub: isStub };
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
        // ⚠️ 必须同步更新节点元素上的 _parent：
        // Cocos 反序列化时靠 _parent 建父子关系。只改内存索引的话，
        // 落盘后会出现「旧父节点不持有它 / 新父节点持有它 / _parent 却指向旧父节点」
        // 的三方矛盾 —— 引擎要么把节点挂回去，要么报 already has a parent。
        ctx.data[idx]._parent = { __id__: parentIdx };
        // 层级变了 → 路径索引要重建，否则同一批次后续步骤用旧路径会找不到节点
        rebuildPaths(ctx);
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
            _active: true,
            _id: '',
            _lpos: { x: Number(op.x || 0), y: Number(op.y || 0), z: Number(op.z || 0) },
            _lrot: { x: 0, y: 0, z: 0, w: 1 },
            _lscale: { x: 1, y: 1, z: 1 },
            _mobility: 0,
            _layer: 33554432,
            _euler: { x: 0, y: 0, z: 0 },
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
            // 孤儿节点不再出现在路径索引里 —— 否则同一批次后续步骤还能
            // 找到并修改一个编辑器根本看不到的节点（不可见的写入）。
            ctx.paths.delete(n.path);
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
                // ⚠️ 组件副本也必须进 map —— Cocos 的组件序列化里有
                // `node: {__id__: N}` 回指节点，组件不进 map 就不会被重映射，
                // 克隆出的组件会**归属到源节点**上。
                map.set(comp.index, compNew);
            }
        }
        // 修正引用（递归，含数组 —— 组件的 node 回指在数组里也可能出现）
        const remap = (el, seen = new Set()) => {
            if (!isPlainObject(el) && !Array.isArray(el)) return;
            if (seen.has(el)) return;
            seen.add(el);
            if (Array.isArray(el)) {
                for (const item of el) remap(item, seen);
                return;
            }
            for (const k of Object.keys(el)) {
                const v = el[k];
                if (isPlainObject(v) && typeof v.__id__ === 'number' && map.has(v.__id__)) {
                    el[k] = { __id__: map.get(v.__id__) };
                } else {
                    remap(v, seen);
                }
            }
        };
        for (const nIdx of map.values()) remap(ctx.data[nIdx]);
        // 重新挂到父节点
        const parentEl = ctx.data[parentIdx];
        parentEl._children = parentEl._children || [];
        parentEl._children.push({ __id__: rootNew });
        // ⚠️ 克隆节点的 _parent 必须指向新父节点，
        // 否则落盘后「父节点持有它 / _parent 却指向源父节点」，层级自相矛盾。
        ctx.data[rootNew]._parent = { __id__: parentIdx };
        // 新 fileId
        ctx.data[rootNew]._name = String(op.name);
        rebuildPaths(ctx);
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
            ensureTargetOverride(ctx, inst, localID);
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
        ensureTargetOverride(ctx, inst, localID);
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
        if (op.prefabPath) assertOpPathAllowed(ctx, path.resolve(op.prefabPath), 'add-nested-prefab.prefabPath');
        const prefabPath = op.prefabPath || resolvePrefabPath(ctx, op.prefabUuid);
        if (!prefabPath) throw new Error(`找不到 prefab "${op.prefabUuid}" 对应的文件路径（可显式传 prefabPath）`);
        const created = inlineNestedPrefab(ctx, {
            parentIndex: parentIdx,   // ← 修正：原来传的是未定义的 parentIndex，这个 op 必然抛错
            prefabPath,
            name: op.name,
            x: op.x,
            y: op.y,
        });
        return { added: created.name, nodeIndex: created.nodeIndex };
    },

    'replace-nested-prefab': (ctx, op) => {
        const idx = findNodeIndex(ctx, op.node);
        if (op.prefabPath) assertOpPathAllowed(ctx, path.resolve(op.prefabPath), 'replace-nested-prefab.prefabPath');
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
        assertOpPathAllowed(ctx, target, 'ensure-meta.path');
        const plan = ctx.planMetaWrite(target, { uuid: op.uuid });
        // planMetaWrite 一定返回对象（existed 时也会返回，内容不变时 skipped=true）
        if (plan.skipped) {
            return { meta: plan.path, uuid: plan.uuid, skipped: true, reason: '已有 .meta 且内容一致，未改动' };
        }
        ctx.metaPlans.push(plan);
        // ★ 返回真实的路径与 uuid —— 之前返回的 metaPath / uuid 两个字段根本不存在，
        //   调用方拿到的 result 是空对象。
        return { meta: plan.path, uuid: plan.uuid, created: !plan.existed, modified: plan.existed };
    },

    /**
     * 批量设置。
     *
     * ⚠️ 之前 `target` 同时被当作「匹配条件」和「写入目标」，
     * 两种语义互斥 —— 无论怎么写都改不到组件上，却报告 applied>0（假成功）。
     * 现在拆开：
     *   - `match`   —— 匹配条件（byComponent 时是组件类型名，如 "cc.Label"）
     *   - `target`  —— 写入目标："node" 或 "component:<类型>"
     *   - 为兼容旧写法，byComponent 的 match 缺省时从 target 推导。
     */
    'bulk-set': (ctx, op) => {
        const selector = op.selector;
        const writeTarget = String(op.target || 'node');
        const isComponentTarget = writeTarget.startsWith('component:');
        const targetCompType = isComponentTarget ? writeTarget.slice('component:'.length) : null;
        // byComponent 的 match 缺省时从 target 推导 —— target 形如 "component:cc.Label"，
        // 组件类型是 "cc.Label"，要**去前缀**才能匹配上。
        const derivedMatch = writeTarget.startsWith('component:') ? writeTarget.slice('component:'.length) : writeTarget;
        const matchCompType = op.match || (selector === 'byComponent' ? derivedMatch : null);

        const targets = [];
        for (const idx of ctx.nodeOrder) {
            const info = ctx.nodes.get(idx);
            if (!info || ctx.orphanNodes.has(idx)) continue;
            const name = info.name;
            let hit = false;
            if (selector === 'byComponent') {
                hit = nodeComponents(ctx, idx).some((c) => c.type === matchCompType || c.type.endsWith('.' + matchCompType));
            } else if (selector === 'byNamePrefix') {
                // ⚠️ match 为空会让 startsWith('') 恒真 → 把**所有**节点都改一遍。
                //   match 在 schema 里是可选的，漏填就从「什么都不做」变成「全量改写」。
                if (!op.match) {
                    throw new Error('byNamePrefix 必须提供 match（名字前缀）。留空会匹配全部节点，已拒绝。');
                }
                hit = name.startsWith(op.match);
            } else if (selector === 'byNameRegex') {
                if (!op.match) {
                    throw new Error('byNameRegex 必须提供 match（正则）。留空会匹配全部节点，已拒绝。');
                }
                let re;
                try {
                    re = new RegExp(op.match);
                } catch (e) {
                    throw new Error(`byNameRegex 的正则 "${op.match}" 不合法：${e.message}`);
                }
                hit = re.test(name);
            } else {
                throw new Error(`未知的 bulk-set selector "${selector}"，可用：byComponent / byNamePrefix / byNameRegex`);
            }
            if (hit) targets.push(idx);
        }

        let applied = 0;
        const skipped = [];
        const propSegs = splitPath(op.property);
        for (const idx of targets) {
            if (isComponentTarget) {
                const comps = nodeComponents(ctx, idx);
                const comp = comps.find((c) => c.type === targetCompType || c.type.endsWith('.' + targetCompType));
                if (!comp) {
                    skipped.push({ node: displayName(ctx, idx), reason: `没有组件 ${targetCompType}` });
                    continue;
                }
                // ⚠️ 写前校验属性存在 ——
                //    序列化字段名带 _ 前缀（_string / _fontSize），
                //    写成 "string" 会**新建**一个引擎不认的字段，
                //    报 applied:1 但真字段没变（典型的「报告成功但零效果」）。
                // ⚠️ 必须用 hasOwnProperty 而不是 `in` ——
                //    `in` 走原型链：'constructor' in el === true，
                //    于是 constructor/toString/__proto__ 都会被放行，
                //    写出自有字段却报 applied:1（引擎不认），甚至改掉原型。
                if (propSegs.length && !Object.prototype.hasOwnProperty.call(comp.element, propSegs[0])) {
                    skipped.push({
                        node: displayName(ctx, idx),
                        reason: `组件 ${targetCompType} 上没有属性 "${op.property}"（序列化字段名带 _ 前缀，如 _string）`,
                    });
                    continue;
                }
                setPath(comp.element, propSegs, op.value);
            } else {
                if (propSegs.length && !Object.prototype.hasOwnProperty.call(ctx.data[idx], propSegs[0])) {
                    skipped.push({
                        node: displayName(ctx, idx),
                        reason: `节点上没有属性 "${op.property}"`,
                    });
                    continue;
                }
                setPath(ctx.data[idx], propSegs, op.value);
            }
            applied++;
        }
        return {
            matched: targets.length,
            applied,
            skipped: skipped.length,
            skipDetails: skipped.slice(0, 10),
            target: writeTarget,
            match: matchCompType,
        };
    },
};

/**
 * op 级路径校验（纵深防御）。
 *
 * hub 层已经对 op 内的路径做过项目边界校验，但离线模块自己也要守一道 ——
 * 这个模块是独立的可复用单元，不能假设调用方一定检查过。
 * ctx.allowedRoots 由调用方注入（hub 传项目根 + 额外根）。
 */
function assertOpPathAllowed(ctx, target, label) {
    const roots = ctx && Array.isArray(ctx.allowedRoots) ? ctx.allowedRoots : null;
    if (roots === null) {
        // 调用方**没有配置**白名单（独立 CLI 用法）→ 不拦，由调用方自己负责
        return;
    }
    if (!roots.length) {
        // 调用方显式给了空白名单 = 「不允许任何目录」→ 拒绝一切
        // ⚠️ 不能退化成「不拦」——「没配限制就全放行」在护栏语义下等于没有护栏。
        throw new Error(
            `${label} "${target}" 无法校验：目录白名单为空，已拒绝。` +
            '（离线文件操作必须限定在已注册的 Cocos 项目目录内。）'
        );
    }
    const resolved = path.resolve(target);
    // ⚠️ 必须 realpath 感知 —— 只做词法比较时，
    //    项目内一个 `link -> /Outside` 软链就能越界写（实测可改写项目外文件）。
    if (isInsideAnyRoot(resolved, roots)) return;
    throw new Error(
        `${label} "${resolved}" 不在允许的目录范围内（允许：${roots.map((r) => path.resolve(r)).join('、')}）。已拒绝。`
    );
}

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
        for (const [k, v] of Object.entries(props)) {
            // ⚠️ props 的键是**用户可控**的，且这是离线模块里唯一
            //    一处不经 splitPath 的键写入 ——
            //    `props.__proto__` 会触发原型 setter（换掉新组件元素的原型，
            //    键被静默丢弃 → **报成功但零效果**）；
            //    `props.constructor` 会写出一个**引擎不认的自有字段**，
            //    持久化进用户的 prefab 文件。
            //    直接拒掉这三个名字（prefab 里不可能有这种字段）。
            assertSafePathSegments([k], `组件 ${type} 的 props 字段`);
            comp[k] = v;
        }
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
    assertSafePathSegments,
    suggest,
    assertOpPathAllowed,
};
