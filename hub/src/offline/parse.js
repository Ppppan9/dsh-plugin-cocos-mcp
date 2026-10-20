'use strict';

/**
 * parse.js —— prefab / anim 解析层。
 *
 * 关键概念
 *  - .prefab 是 JSON 数组，元素之间用 {"__id__": N} 互相引用，N = 数组下标。
 *  - 根节点：类型为 cc.Prefab 的元素，其 data.__id__ 指向真正的根节点。
 *  - stub 节点：嵌套 prefab 的实例节点，_name 是 undefined，
 *    真实名字在 PrefabInstance.propertyOverrides 里 propertyPath === ['_name'] 的 override 中。
 *    解析 / 查询 / 写入三处必须一致识别（都在本文件统一提供）。
 */

const { readTextFile, parseJsonText, detectFormat } = require('./write');

/* ------------------------------------------------------------------ 基础工具 */

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepClone(v) {
  if (v === undefined) return undefined;
  return JSON.parse(JSON.stringify(v));
}

/** 取 {"__id__": N} 里的 N；不是引用则返回 -1。 */
function refId(v) {
  if (isPlainObject(v) && typeof v.__id__ === 'number') return v.__id__;
  return -1;
}

/** 取 {"__uuid__": "..."} 里的 uuid。 */
function refUuid(v) {
  if (isPlainObject(v) && typeof v.__uuid__ === 'string') return v.__uuid__;
  return null;
}

/** 取元素类型名。 */
function typeOf(el) {
  if (!isPlainObject(el)) return null;
  return typeof el.__type__ === 'string' ? el.__type__ : null;
}

/** 判断数组下标片段（number 或纯数字字符串）。 */
function isIndexSegment(seg) {
  if (typeof seg === 'number') return Number.isInteger(seg) && seg >= 0;
  if (typeof seg === 'string') return /^\d+$/.test(seg);
  return false;
}

/**
 * propertyPath 归一化：数组下标必须是 number，不能是字符串。
 * 引擎对 ["_items","0"] 会静默忽略，所以这里强制转换。
 */
function normalizePropertyPath(propertyPath) {
  if (!Array.isArray(propertyPath)) return [];
  return propertyPath.map((seg) => (isIndexSegment(seg) ? Number(seg) : seg));
}

/* ------------------------------------------------------------- prefab 上下文 */

/** 判断是否为「节点」元素。 */
function isNodeElement(el) {
  if (!isPlainObject(el)) return false;
  const t = typeOf(el);
  if (t === 'cc.Node' || t === 'cc.PrivateNode') return true;
  if (t && t !== 'cc.Node') return false;
  return Array.isArray(el._children);
}

/**
 * 构建 prefab 上下文。
 * @param {Array} data .prefab 顶层数组
 * @param {string} filePath 用于错误信息
 */
function buildPrefabContext(data, filePath) {
  const ctx = {
    filePath,
    data,
    rootIndex: -1,
    prefabIndex: -1,
    nodes: new Map(), // idx -> nodeInfo
    nodeOrder: [], // DFS 顺序（父先于子）
    components: new Map(), // idx -> {index, element, nodeIndex}
    instances: new Map(), // idx -> instanceInfo (cc.PrefabInstance)
    prefabInfos: new Map(), // idx -> prefabInfo
    nodeInstance: new Map(), // node idx -> {instanceIndex, prefabInfoIndex, prefabInfo}
    paths: new Map(), // path -> node idx
    orphanNodes: new Set(),
    orphanComponents: new Set(),
  };

  if (!Array.isArray(data)) {
    throw new Error(`prefab 数据格式错误（${filePath}）：顶层必须是数组`);
  }

  // 1) 按类型索引
  const typeIndex = new Map();
  data.forEach((el, i) => {
    const t = typeOf(el);
    if (!t) return;
    if (!typeIndex.has(t)) typeIndex.set(t, []);
    typeIndex.get(t).push(i);
  });

  // 2) cc.Prefab（根节点指针）
  for (const i of typeIndex.get('cc.Prefab') || []) {
    const el = data[i];
    const root = refId(el.data);
    if (ctx.prefabIndex < 0 && root >= 0 && isNodeElement(data[root])) {
      ctx.prefabIndex = i;
      ctx.rootIndex = root;
    }
  }
  if (ctx.rootIndex < 0) {
    // 兜底：第一个节点元素
    for (let i = 0; i < data.length; i++) {
      if (isNodeElement(data[i])) {
        ctx.rootIndex = i;
        break;
      }
    }
  }
  if (ctx.rootIndex < 0) {
    throw new Error(`prefab 中找不到根节点（${filePath}）：既没有 cc.Prefab 也没有 cc.Node 元素`);
  }

  // 3) cc.PrefabInstance
  for (const i of typeIndex.get('cc.PrefabInstance') || []) {
    const el = data[i];
    const info = {
      index: i,
      element: el,
      fileId: typeof el.fileId === 'string' ? el.fileId : null,
      asset: null,
      overrideIndices: [],
      overrides: [],
      stubNodeIndex: -1,
      prefabInfoIndex: -1,
    };
    const po = el.propertyOverrides;
    if (Array.isArray(po)) {
      for (const r of po) {
        const ri = refId(r);
        if (ri >= 0) info.overrideIndices.push(ri);
      }
    }
    ctx.instances.set(i, info);
  }

  // 4) cc.PrefabInfo
  for (const i of typeIndex.get('cc.PrefabInfo') || []) {
    const el = data[i];
    const instIdx = refId(el.instance);
    const info = {
      index: i,
      element: el,
      fileId: typeof el.fileId === 'string' ? el.fileId : null,
      instanceIndex: instIdx >= 0 ? instIdx : -1,
      targetOverrideIndices: [],
    };
    const to = el.targetOverrides;
    if (Array.isArray(to)) {
      for (const r of to) {
        const ri = refId(r);
        if (ri >= 0) info.targetOverrideIndices.push(ri);
      }
    }
    ctx.prefabInfos.set(i, info);
  }

  // 5) 节点 → PrefabInfo → PrefabInstance
  data.forEach((el, i) => {
    if (!isNodeElement(el)) return;
    const pi = refId(el._prefab);
    if (pi < 0) return;
    const prefabInfo = ctx.prefabInfos.get(pi);
    const directInstance = ctx.instances.get(pi); // 少数写法：_prefab 直接指向 PrefabInstance
    const instanceIndex = prefabInfo ? prefabInfo.instanceIndex : directInstance ? pi : -1;
    ctx.nodeInstance.set(i, {
      instanceIndex,
      prefabInfoIndex: prefabInfo ? pi : -1,
      prefabInfo: prefabInfo || null,
    });
    if (instanceIndex >= 0) {
      const inst = ctx.instances.get(instanceIndex);
      if (inst) {
        if (inst.stubNodeIndex < 0) inst.stubNodeIndex = i;
        if (inst.prefabInfoIndex < 0 && prefabInfo) inst.prefabInfoIndex = pi;
      }
    }
  });

  // 6) 解析 instance 的 propertyOverrides
  for (const inst of ctx.instances.values()) {
    for (const oi of inst.overrideIndices) {
      const el = data[oi];
      if (!isPlainObject(el)) continue;
      const ti = refId(el.targetInfo);
      const target = ti >= 0 ? data[ti] : null;
      const localID = target && Array.isArray(target.localID) ? target.localID.slice() : [];
      inst.overrides.push({
        index: oi,
        element: el,
        propertyPath: normalizePropertyPath(el.propertyPath),
        value: el.value,
        localID,
        targetIndex: ti,
      });
    }
    inst.asset = resolveInstanceAsset(ctx, inst);
  }

  // 7) 遍历节点树
  traverse(ctx);
  return ctx;
}

/** 解析嵌套 prefab 实例的源资产 uuid（尽力而为，找不到返回 null）。 */
function resolveInstanceAsset(ctx, inst) {
  const el = inst.element;
  const candidates = [el.asset, el.sourceAsset, el.prefabAsset, el._asset];
  for (const c of candidates) {
    const u = refUuid(c);
    if (u) return u;
    const id = refId(c);
    if (id >= 0) {
      const u2 = refUuid(ctx.data[id]);
      if (u2) return u2;
    }
  }
  const pi = inst.prefabInfoIndex >= 0 ? ctx.prefabInfos.get(inst.prefabInfoIndex) : null;
  if (pi) {
    for (const c of [pi.element.asset, pi.element._asset]) {
      const u = refUuid(c);
      if (u) return u;
      const id = refId(c);
      if (id >= 0) {
        const u2 = refUuid(ctx.data[id]);
        if (u2) return u2;
      }
    }
  }
  return null;
}

/** 从根节点开始 DFS 建树（父先于子）。 */
function traverse(ctx) {
  const root = ctx.rootIndex;
  const visit = (idx, parentIndex, depth) => {
    const el = ctx.data[idx];
    if (!isPlainObject(el)) return;
    const info = {
      index: idx,
      element: el,
      parentIndex,
      depth,
      children: [],
      components: [],
      name: '',
      path: '',
    };
    ctx.nodes.set(idx, info);
    ctx.nodeOrder.push(idx);

    const comps = Array.isArray(el._components) ? el._components : [];
    for (const c of comps) {
      const ci = refId(c);
      if (ci >= 0) {
        const cinfo = { index: ci, element: ctx.data[ci], nodeIndex: idx };
        info.components.push(cinfo);
        ctx.components.set(ci, cinfo);
      }
    }
    const kids = Array.isArray(el._children) ? el._children : [];
    for (const c of kids) {
      const ci = refId(c);
      if (ci >= 0) {
        info.children.push(ci);
        visit(ci, idx, depth + 1);
      }
    }
  };
  visit(root, -1, 0);

  // 路径（父先于子，nodeOrder 天然满足）
  for (const idx of ctx.nodeOrder) {
    const info = ctx.nodes.get(idx);
    const name = displayName(ctx, idx);
    info.name = name;
    const parent = info.parentIndex >= 0 ? ctx.nodes.get(info.parentIndex) : null;
    info.path = parent ? `${parent.path}/${name}` : name;
    if (!ctx.paths.has(info.path)) ctx.paths.set(info.path, idx);
  }
}

/** 节点显示名：优先 _name，其次 stub 的真实名（来自 _name override）。 */
function displayName(ctx, idx) {
  const info = ctx.nodes.get(idx);
  const el = info ? info.element : ctx.data[idx];
  if (isPlainObject(el) && typeof el._name === 'string') return el._name;
  const real = stubRealName(ctx, idx);
  if (real) return real;
  return `未命名节点(${idx})`;
}

/** 是否 stub 节点：_name 不是字符串（即 undefined）。 */
function isStubNode(ctx, idx) {
  const info = ctx.nodes.get(idx);
  if (!info) return false;
  return typeof info.element._name !== 'string';
}

/** stub 节点的真实名字（来自 PrefabInstance 的 _name override）。 */
function stubRealName(ctx, idx) {
  const link = ctx.nodeInstance.get(idx);
  if (!link || link.instanceIndex < 0) return null;
  const inst = ctx.instances.get(link.instanceIndex);
  if (!inst) return null;
  const ov = inst.overrides.find((o) => o.propertyPath.length === 1 && o.propertyPath[0] === '_name');
  if (!ov) return null;
  return typeof ov.value === 'string' ? ov.value : String(ov.value);
}

/** 取 stub 节点对应的 PrefabInstance 信息。 */
function instanceForNode(ctx, idx) {
  const link = ctx.nodeInstance.get(idx);
  if (!link || link.instanceIndex < 0) return null;
  return ctx.instances.get(link.instanceIndex) || null;
}

/** 取节点本地位置（兼容 _lpos / _position / _localPosition）。 */
function getNodeLocalPos(el) {
  if (!isPlainObject(el)) return { x: 0, y: 0, z: 0 };
  const p = el._lpos || el._position || el._localPosition;
  if (!isPlainObject(p)) return { x: 0, y: 0, z: 0 };
  return {
    x: typeof p.x === 'number' ? p.x : 0,
    y: typeof p.y === 'number' ? p.y : 0,
    z: typeof p.z === 'number' ? p.z : 0,
  };
}

/** 写入节点本地位置。 */
function setNodeLocalPos(el, pos) {
  const key = el._lpos ? '_lpos' : el._position ? '_position' : el._localPosition ? '_localPosition' : '_lpos';
  const current = isPlainObject(el[key]) ? el[key] : { __type__: 'cc.Vec3', x: 0, y: 0, z: 0 };
  el[key] = {
    ...current,
    __type__: current.__type__ || 'cc.Vec3',
    x: pos.x,
    y: pos.y,
    z: pos.z,
  };
  return key;
}

/** 取节点缩放。 */
function getNodeLocalScale(el) {
  const s = isPlainObject(el) ? el._lscale || el._scale : null;
  if (!isPlainObject(s)) return { x: 1, y: 1, z: 1 };
  return {
    x: typeof s.x === 'number' ? s.x : 1,
    y: typeof s.y === 'number' ? s.y : 1,
    z: typeof s.z === 'number' ? s.z : 1,
  };
}

/** 载入 prefab 文件（只读上下文）。 */
function loadPrefab(filePath) {
  const text = readTextFile(filePath);
  const data = parseJsonText(text, filePath);
  const ctx = buildPrefabContext(data, filePath);
  ctx.text = text;
  ctx.format = detectFormat(text);
  return ctx;
}

/**
 * 载入 prefab 用于「编辑」：返回工作副本，原文件内容保持不变直到 commit。
 */
function loadPrefabForEdit(filePath) {
  const ctx = loadPrefab(filePath);
  ctx.work = deepClone(ctx.data);
  // 工作副本需要重建索引（__id__ 保持不变，但对象引用变了）
  const workCtx = buildPrefabContext(ctx.work, filePath);
  workCtx.text = ctx.text;
  workCtx.format = ctx.format;
  workCtx.pendingMeta = [];
  workCtx.diff = [];
  return workCtx;
}

/* -------------------------------------------------------------------- anim */

/**
 * 载入 .anim 文件。
 * 找 cc.AnimationClip 类型的元素作为头；track 字段单通道用 _channel，多通道用 _channels。
 */
function loadAnim(filePath) {
  const text = readTextFile(filePath);
  const data = parseJsonText(text, filePath);
  if (!Array.isArray(data)) {
    throw new Error(`anim 数据格式错误（${filePath}）：顶层必须是数组`);
  }
  let clipIndex = -1;
  for (let i = 0; i < data.length; i++) {
    if (typeOf(data[i]) === 'cc.AnimationClip') {
      clipIndex = i;
      break;
    }
  }
  if (clipIndex < 0) {
    throw new Error(`anim 中找不到 cc.AnimationClip（${filePath}）`);
  }
  const clip = data[clipIndex];
  const tracks = [];
  const rawTracks = Array.isArray(clip.tracks) ? clip.tracks : [];
  rawTracks.forEach((t, n) => {
    const ti = refId(t);
    if (ti < 0) return;
    const el = data[ti];
    if (!isPlainObject(el)) return;
    const channels = [];
    if (Array.isArray(el._channels)) {
      el._channels.forEach((c, ci) => {
        const ch = isPlainObject(c) ? c : null;
        channels.push({
          index: ci,
          channel: ch,
          path: ch ? channelPath(ch) : '',
          element: el,
        });
      });
    } else if (isPlainObject(el._channel)) {
      channels.push({ index: 0, channel: el._channel, path: channelPath(el._channel), element: el });
    } else if (typeof el.path === 'string' || typeof el._path === 'string') {
      // Cocos 真实 .anim 形态：track 元素本身就是 cc.CurveChannel
      // （带 path + curve），既没有 _channels 也没有 _channel。
      channels.push({ index: 0, channel: el, path: channelPath(el), element: el });
    }
    tracks.push({ index: ti, element: el, trackNo: n, channels });
  });

  return {
    filePath,
    text,
    format: detectFormat(text),
    data,
    clipIndex,
    clip,
    tracks,
  };
}

/** 取动画通道的路径（position / position.x / ...）。 */
function channelPath(channel) {
  if (!isPlainObject(channel)) return '';
  const p = channel.path || channel._path || channel.targetPath || channel._targetPath;
  if (typeof p === 'string') return p;
  if (isPlainObject(p) && typeof p.path === 'string') return p.path;
  return '';
}

/** 取通道的关键帧数组（兼容 data / keyframes / _curve.data 等写法）。 */
function getKeyframes(channel) {
  if (!isPlainObject(channel)) return null;
  const containers = [channel.curve, channel._curve, channel];
  for (const c of containers) {
    if (!isPlainObject(c)) continue;
    for (const key of ['data', 'keyframes', '_data', '_keyframes', 'points']) {
      if (Array.isArray(c[key])) return c[key];
    }
  }
  return null;
}

module.exports = {
  isPlainObject,
  deepClone,
  refId,
  refUuid,
  typeOf,
  isIndexSegment,
  normalizePropertyPath,
  isNodeElement,
  buildPrefabContext,
  loadPrefab,
  loadPrefabForEdit,
  displayName,
  isStubNode,
  stubRealName,
  instanceForNode,
  getNodeLocalPos,
  setNodeLocalPos,
  getNodeLocalScale,
  loadAnim,
  channelPath,
  getKeyframes,
};
