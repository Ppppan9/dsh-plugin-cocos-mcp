'use strict';

/**
 * 场景进程脚本（scene script）
 * ---------------------------------------------------------------------------
 * 通过扩展清单的 `contributions.scene.script` 注册到**场景/渲染进程**执行，
 * 那里才有 `cc` 引擎运行时（director、节点、组件的真实实例）。
 *
 * 安全立场：这里**只导出固定的白名单方法，不提供任何形式的 eval / new Function**。
 * 现存实现里 shiliyu1991-lang 的 `execute_script` 直接在主进程和场景进程里
 * `new Function(code)`，等于把「任意代码执行」交给了模型。本项目不这么做：
 * 模型只能在下面这些受控能力里选。
 */

const METHODS = {};

/** 按名字在整棵场景树里找节点（引擎级查找，比遍历 dump 更准）。 */
METHODS.findNodesByName = function findNodesByName(name) {
    const cc = require('cc');
    const out = [];
    const walk = (node, path) => {
        const p = path ? `${path}/${node.name}` : node.name;
        if (node.name === name) out.push({ uuid: node.uuid, name: node.name, path: p });
        for (const child of node.children) walk(child, p);
    };
    const scene = cc.director.getScene();
    if (scene) walk(scene, '');
    return out;
};

/** 节点的引擎级信息（含世界坐标、活跃状态、组件真实类名）。 */
METHODS.getNodeInfo = function getNodeInfo(uuid) {
    const cc = require('cc');
    const node = cc.find(uuid);
    if (!node) return null;
    const wp = node.worldPosition;
    const ws = node.worldScale;
    return {
        uuid: node.uuid,
        name: node.name,
        path: getPath(node),
        active: node.activeInHierarchy,
        layer: node.layer,
        position: { x: wp.x, y: wp.y, z: wp.z },
        scale: { x: ws.x, y: ws.y, z: ws.z },
        components: node.components.map((c) => c.constructor.name),
    };
};

function getPath(node) {
    const parts = [];
    let cur = node;
    while (cur) {
        parts.unshift(cur.name);
        cur = cur.parent;
    }
    return parts.join('/');
}

/**
 * 会写到原型链上的**保留路径段**。
 *
 * ⚠️ 实测（用假 cc 驱动本文件的真实实现）：
 *    setNodeProperty(uuid, '__proto__.toString', 'PWNED')
 *    → **Object.prototype.toString 被覆盖成字符串 "PWNED"**
 *    → 整个编辑器进程的原型被破坏（模板字符串、String(obj) 全废）。
 *    原因：下面那句「属性必须存在」用的是 `key in obj`，
 *    而 `in` **会走原型链** —— 'toString' in Object.prototype === true ⇒ 守卫放行。
 *
 *    所以光靠「属性必须存在」挡不住 —— 必须**逐段拒绝**这些名字。
 *    （离线编辑器的 setPath 早就修过同一类洞，这里是引擎级的另一处。）
 */
const RESERVED_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * 用引擎运行时设置属性（自动处理 Vec3 / Color / Size / 枚举等类型）。
 * @param {string} uuid
 * @param {string} path 形如 'position' / '__comps__.0._string'
 * @param {any} value
 */
METHODS.setNodeProperty = function setNodeProperty(uuid, path, value) {
    const cc = require('cc');
    const node = cc.find(uuid);
    if (!node) throw new Error(`节点不存在：${uuid}`);

    // path 形如 __comps__.3._string → 定位组件
    const compMatch = /^__comps__\.(\d+)\.(.+)$/.exec(path);
    let target = node;
    let prop = path;

    if (compMatch) {
        const idx = Number(compMatch[1]);
        prop = compMatch[2];
        const comp = node.components[idx];
        if (!comp) throw new Error(`节点 ${uuid} 没有第 ${idx} 个组件`);
        target = comp;
    }

    const segments = prop.split('.');
    // ⚠️ 逐段拒绝保留名（否则能顺着原型链写到 Object.prototype 上）
    for (const seg of segments) {
        if (RESERVED_PATH_SEGMENTS.has(seg)) {
            throw new Error(
                `属性路径 "${path}" 含保留段 "${seg}"。` +
                '__proto__ / constructor / prototype 会写到原型链上（能污染整个编辑器进程），已拒绝。'
            );
        }
    }
    let obj = target;
    for (let i = 0; i < segments.length - 1; i++) {
        obj = obj[segments[i]];
        if (obj === undefined || obj === null) {
            throw new Error(`属性路径 "${path}" 在 "${segments.slice(0, i + 1).join('.')}" 处中断`);
        }
    }
    const key = segments[segments.length - 1];
    // ⚠️ 这里用 `in`（不是 hasOwnProperty）是**有意的** ——
    //    Cocos 的节点属性（position / active / angle …）大多是**原型上的访问器**，
    //    不是自有属性；换成 hasOwnProperty 会把正常用法全判成「属性不存在」。
    //    原型链的风险由上面的「逐段拒绝保留名」挡住。
    if (!(key in obj) && obj[key] === undefined) {
        throw new Error(`属性 "${key}" 不存在于 ${target.constructor.name}。可用键：${Object.keys(obj).slice(0, 40).join(', ')}`);
    }
    obj[key] = coerce(cc, obj[key], value);
    return { uuid, path, ok: true, value: obj[key] };
};

/** 值形状与目标类型不匹配时的转换。 */
function coerce(cc, current, value) {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'object') return value;
    if (Array.isArray(value)) return value;

    const ctor = current && current.constructor ? current.constructor.name : '';
    if (ctor === 'Vec3' || ctor === 'Vec2' || ctor === 'Vec4' || ctor === 'Quat') {
        const v = new current.constructor();
        for (const k of ['x', 'y', 'z', 'w']) {
            if (value[k] !== undefined) v[k] = Number(value[k]);
        }
        return v;
    }
    if (ctor === 'Color') {
        const v = new current.constructor();
        for (const k of ['r', 'g', 'b', 'a']) {
            if (value[k] !== undefined) v[k] = Number(value[k]);
        }
        return v;
    }
    if (ctor === 'Size') {
        const v = new current.constructor();
        if (value.width !== undefined) v.width = Number(value.width);
        if (value.height !== undefined) v.height = Number(value.height);
        return v;
    }
    return value;
}

/** 节点世界包围盒。 */
METHODS.getWorldBounds = function getWorldBounds(uuid) {
    const cc = require('cc');
    const node = cc.find(uuid);
    if (!node) return null;
    const ui = node.getComponent(cc.UITransform);
    if (ui) {
        const r = ui.getBoundingBoxToWorld();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
    }
    return null;
};

/** 创建节点（引擎级，支持在 UI 父节点下自动补 UITransform）。 */
METHODS.createNode = function createNode(parentUuid, name, options) {
    const cc = require('cc');
    const opts = options || {};
    const parent = cc.find(parentUuid);
    if (!parent) throw new Error(`父节点不存在：${parentUuid}`);
    const node = new cc.Node(name || 'NewNode');
    if (opts.position) {
        node.setPosition(Number(opts.position.x) || 0, Number(opts.position.y) || 0, Number(opts.position.z) || 0);
    }
    parent.addChild(node);
    if (opts.uiTransform !== false && parent.getComponent(cc.UITransform)) {
        node.addComponent(cc.UITransform);
    }
    return { uuid: node.uuid, name: node.name };
};

/** 场景概览：节点数、组件数、脏标记。 */
METHODS.getSceneSummary = function getSceneSummary() {
    const cc = require('cc');
    const scene = cc.director.getScene();
    if (!scene) return null;
    let nodes = 0;
    let components = 0;
    const walk = (n) => {
        nodes++;
        components += n.components.length;
        for (const c of n.children) walk(c);
    };
    walk(scene);
    return { name: scene.name, nodes, components };
};

/**
 * ⚠️ 必须是 `exports.methods` —— Cocos 3.8 的 `scene:execute-scene-script`
 *    按 `exports.methods[method]` 派发。直接 `module.exports = METHODS`
 *    的话方法根本找不到（官方内置 reflection-probe 与第三方扩展都是 exports.methods）。
 */
module.exports = { methods: METHODS };
