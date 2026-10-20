'use strict';

/**
 * nested.js —— 嵌套 prefab override 协议。
 *
 * 三个关键对象
 *  - cc.TargetOverrideInfo：挂在宿主根节点的 PrefabInfo.targetOverrides[]
 *  - cc.TargetInfo：{ localID: string[] }
 *  - cc.CompPrefabInfo：子 prefab 内组件的 fileId
 *
 * localID 多层链规则：每跨一层 PrefabInstance 边界压一段 fileId；
 * 边界取 cc.PrefabInstance.fileId，到组件取 CompPrefabInfo.fileId，到节点取 PrefabInfo.fileId。
 *
 * 两个引擎坑（本文件统一处理）
 *  1. 数组索引必须是 number 不是 string（["_items","0"] 会被引擎静默忽略）。
 *  2. 单字段 override 必须排在数组字段 override 之前，否则被引擎静默跳过。
 *     插入逻辑：找到第一个「数组字段」override，插到它前面。
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  isPlainObject,
  deepClone,
  refId,
  typeOf,
  isIndexSegment,
  normalizePropertyPath,
  displayName,
} = require('./parse');
const { deterministicFileId, deterministicUuid } = require('./id');

/**
 * override 分类（决定排序与插入位置）：
 *  0 = 单字段（propertyPath.length === 1）—— 必须排在最前
 *  1 = 多段路径但不含数组下标
 *  2 = 数组字段（含数组下标）—— 必须排在最后
 */
function overrideCategory(propertyPath) {
  const path = normalizePropertyPath(propertyPath);
  if (path.length <= 1) return 0;
  if (path.slice(1).some((seg) => isIndexSegment(seg))) return 2;
  return 1;
}

/** 是否「数组字段」override。 */
function isArrayFieldOverride(override) {
  const path = override && Array.isArray(override.propertyPath) ? override.propertyPath : [];
  return overrideCategory(path) === 2;
}

/**
 * 找到新 override 应插入的位置：插到第一个「类别更大」的 override 之前。
 * 效果 = 插到第一个「数组字段」override 之前（单字段 override 优先）。
 */
function findInsertIndex(overrides, newPropertyPath) {
  const cat = overrideCategory(newPropertyPath);
  for (let i = 0; i < overrides.length; i++) {
    const o = overrides[i];
    const path = o && Array.isArray(o.propertyPath) ? o.propertyPath : [];
    if (overrideCategory(path) > cat) return i;
  }
  return overrides.length;
}

/** 稳定排序：按类别升序（单字段 → 多段 → 数组字段）。 */
function sortOverrides(overrides) {
  return overrides
    .map((o, i) => ({ o, i }))
    .sort((a, b) => {
      const ca = overrideCategory(a.o && a.o.propertyPath);
      const cb = overrideCategory(b.o && b.o.propertyPath);
      if (ca !== cb) return ca - cb;
      return a.i - b.i;
    })
    .map((x) => x.o);
}

/** 归一化 propertyPath：数组下标转 number。 */
function normalizeOverridePaths(ctx, instance) {
  const changed = [];
  for (const ov of instance.overrides) {
    const el = ov.element;
    if (!isPlainObject(el)) continue;
    const before = JSON.stringify(el.propertyPath);
    const after = normalizePropertyPath(el.propertyPath);
    if (before !== JSON.stringify(after)) {
      el.propertyPath = after;
      ov.propertyPath = after;
      changed.push({ index: ov.index, before, after });
    }
  }
  return changed;
}

/** 按引擎规则重排 instance 的 propertyOverrides。 */
function reorderOverrides(ctx, instance) {
  const arr = instance.element.propertyOverrides;
  if (!Array.isArray(arr)) return false;
  const before = arr.map((r) => refId(r));
  const sorted = sortOverrides(
    instance.overrides.map((ov) => ({ ...ov, __ref: arr[instance.overrideIndices.indexOf(ov.index)] }))
  );
  const after = sorted.map((o) => o.__ref);
  const changed = before.join(',') !== after.join(',');
  if (changed) {
    instance.element.propertyOverrides = after;
    instance.overrideIndices = sorted.map((o) => o.index);
    instance.overrides = sorted.map((o) => ({
      index: o.index,
      element: o.element,
      propertyPath: o.propertyPath,
      value: o.value,
      localID: o.localID,
      targetIndex: o.targetIndex,
    }));
  }
  return changed;
}

/** localID 链：instance 边界 fileId → 节点 PrefabInfo fileId → 组件 CompPrefabInfo fileId。 */
function buildLocalIdChain(parts) {
  const chain = [];
  for (const p of parts) {
    if (typeof p === 'string' && p) chain.push(p);
  }
  return chain;
}

/** 取组件的 CompPrefabInfo fileId。 */
function compPrefabInfoFileId(ctx, componentIndex) {
  const comp = ctx.components.get(componentIndex);
  if (!comp) return null;
  const el = comp.element;
  if (!isPlainObject(el)) return null;
  const pi = refId(el._prefab);
  if (pi < 0) return null;
  const info = ctx.data[pi];
  if (!isPlainObject(info)) return null;
  return typeof info.fileId === 'string' ? info.fileId : null;
}

/**
 * 计算「宿主文件内某个组件」在嵌套实例中的 localID 链。
 * 从根到目标节点逐层累积：每层 = PrefabInstance.fileId + 节点 PrefabInfo.fileId。
 */
function resolveLocalIdForComponent(ctx, nodeIndex, componentIndex) {
  const chain = [];
  const path = [];
  let cur = ctx.nodes.get(nodeIndex);
  while (cur) {
    path.unshift(cur.index);
    cur = cur.parentIndex >= 0 ? ctx.nodes.get(cur.parentIndex) : null;
  }
  for (const idx of path) {
    const link = ctx.nodeInstance.get(idx);
    if (!link || link.instanceIndex < 0) continue; // 宿主层节点不产生链段
    const inst = ctx.instances.get(link.instanceIndex);
    if (inst && inst.fileId) chain.push(inst.fileId); // 边界
    if (link.prefabInfo && link.prefabInfo.fileId) chain.push(link.prefabInfo.fileId); // 节点
  }
  const compFileId = compPrefabInfoFileId(ctx, componentIndex);
  if (compFileId) chain.push(compFileId);
  return chain;
}

/**
 * 新增 / 更新一条 propertyOverride。
 * @returns {{created:boolean, override:object, index:number}}
 */
function upsertOverride(ctx, instance, spec) {
  const propertyPath = normalizePropertyPath(spec.propertyPath);
  const localID = Array.isArray(spec.localID) ? spec.localID.slice() : [];
  const pathKey = JSON.stringify(propertyPath);
  const localKey = JSON.stringify(localID);

  for (const ov of instance.overrides) {
    if (JSON.stringify(ov.propertyPath) === pathKey && JSON.stringify(ov.localID) === localKey) {
      ov.element.propertyPath = propertyPath.slice();
      ov.element.value = deepClone(spec.value);
      ov.propertyPath = propertyPath;
      ov.value = spec.value;
      return { created: false, override: ov, index: ov.index };
    }
  }

  // 新建 cc.TargetInfo
  const targetInfo = { __type__: 'cc.TargetInfo', localID: localID.slice() };
  const targetIndex = ctx.data.length;
  ctx.data.push(targetInfo);

  // 新建 cc.PropertyOverrideInfo
  const propInfo = {
    __type__: 'cc.PropertyOverrideInfo',
    targetInfo: { __id__: targetIndex },
    propertyPath: propertyPath.slice(),
    value: deepClone(spec.value),
  };
  const propIndex = ctx.data.length;
  ctx.data.push(propInfo);

  // 按引擎规则插入到 propertyOverrides
  const arr = Array.isArray(instance.element.propertyOverrides)
    ? instance.element.propertyOverrides
    : (instance.element.propertyOverrides = []);
  const insertAt = findInsertIndex(instance.overrides, propertyPath);
  arr.splice(insertAt, 0, { __id__: propIndex });

  const override = {
    index: propIndex,
    element: propInfo,
    propertyPath,
    value: spec.value,
    localID,
    targetIndex,
  };
  instance.overrideIndices.push(propIndex);
  instance.overrides.splice(insertAt, 0, override);
  return { created: true, override, index: propIndex };
}

/**
 * 删除 override。
 * filter: { propertyPath?: string[], localID?: string[] }
 */
function removeOverrides(ctx, instance, filter) {
  const removed = [];
  const arr = Array.isArray(instance.element.propertyOverrides)
    ? instance.element.propertyOverrides
    : [];
  const keep = [];
  for (const ov of instance.overrides) {
    let hit = true;
    if (filter && Array.isArray(filter.propertyPath)) {
      hit = JSON.stringify(ov.propertyPath) === JSON.stringify(normalizePropertyPath(filter.propertyPath));
    }
    if (hit && filter && Array.isArray(filter.localID)) {
      hit = JSON.stringify(ov.localID) === JSON.stringify(filter.localID);
    }
    if (hit) removed.push(ov);
    else keep.push(ov);
  }
  if (!removed.length) return removed;
  instance.element.propertyOverrides = keep.map((ov) => ({ __id__: ov.index }));
  instance.overrideIndices = keep.map((ov) => ov.index);
  instance.overrides = keep;
  return removed;
}

/** 确保 instance 有对应的 cc.TargetOverrideInfo 挂在宿主 PrefabInfo.targetOverrides 上。 */
function ensureTargetOverride(ctx, instance) {
  const pi = instance.prefabInfoIndex >= 0 ? ctx.prefabInfos.get(instance.prefabInfoIndex) : null;
  if (!pi) return null;
  const arr = Array.isArray(pi.element.targetOverrides)
    ? pi.element.targetOverrides
    : (pi.element.targetOverrides = []);

  // 已存在指向该 instance 的 TargetOverrideInfo 就复用
  for (const r of arr) {
    const ri = refId(r);
    if (ri < 0) continue;
    const el = ctx.data[ri];
    if (!isPlainObject(el)) continue;
    if (typeOf(el) === 'cc.TargetOverrideInfo') {
      const ti = refId(el.targetInfo);
      if (ti >= 0) {
        const target = ctx.data[ti];
        if (isPlainObject(target) && target.instanceIndex === instance.index) return el;
        if (isPlainObject(target) && target.__id__ === undefined && Array.isArray(target.localID)) {
          return el;
        }
      }
    }
  }

  const localID = instance.fileId ? [instance.fileId] : [];
  const targetInfo = { __type__: 'cc.TargetInfo', localID: localID.slice() };
  const targetIndex = ctx.data.length;
  ctx.data.push(targetInfo);
  const toi = {
    __type__: 'cc.TargetOverrideInfo',
    targetInfo: { __id__: targetIndex },
    localID: localID.slice(),
  };
  const toiIndex = ctx.data.length;
  ctx.data.push(toi);
  arr.push({ __id__: toiIndex });
  pi.targetOverrideIndices.push(toiIndex);
  return toi;
}

/**
 * sync-nested-roots：把所有 stub 节点的 override 归一化（数组下标 number 化）并按引擎规则重排。
 */
function syncNestedRoots(ctx, nodeIndex) {
  const results = [];
  const targets = [];
  if (typeof nodeIndex === 'number' && nodeIndex >= 0) {
    const link = ctx.nodeInstance.get(nodeIndex);
    if (link && link.instanceIndex >= 0) {
      const inst = ctx.instances.get(link.instanceIndex);
      if (inst) targets.push(inst);
    } else {
      throw new Error(`节点 ${displayName(ctx, nodeIndex)} 不是嵌套 prefab 实例（无 PrefabInstance 关联）`);
    }
  } else {
    for (const inst of ctx.instances.values()) targets.push(inst);
  }

  for (const inst of targets) {
    const normalized = normalizeOverridePaths(ctx, inst);
    const reordered = reorderOverrides(ctx, inst);
    const toi = ensureTargetOverride(ctx, inst);
    results.push({
      instanceIndex: inst.index,
      fileId: inst.fileId,
      normalized,
      reordered,
      targetOverride: !!toi,
    });
  }
  return results;
}

/* ------------------------------------------------- 嵌套 prefab 引入 / 替换 */

/** 递归把对象里的 {"__id__": N} 重映射到新下标。 */
function remapRefs(el, remap) {
  if (Array.isArray(el)) {
    for (const item of el) remapRefs(item, remap);
    return el;
  }
  if (!isPlainObject(el)) return el;
  const id = refId(el);
  if (id >= 0 && remap.has(id)) {
    el.__id__ = remap.get(id);
    return el;
  }
  for (const key of Object.keys(el)) {
    if (key === '__id__') continue;
    remapRefs(el[key], remap);
  }
  return el;
}

/**
 * add-nested-prefab 的核心：把子 prefab 的内容内联进宿主 prefab，
 * 并建立 stub 节点 + cc.PrefabInstance + cc.PrefabInfo + _name override。
 */
function inlineNestedPrefab(ctx, options) {
  const { parentIndex, prefabPath, name, index } = options;
  if (!fs.existsSync(prefabPath)) {
    throw new Error(`嵌套 prefab 文件不存在：${prefabPath}`);
  }
  const childText = fs.readFileSync(prefabPath, 'utf8');
  const childData = JSON.parse(childText);
  if (!Array.isArray(childData)) {
    throw new Error(`嵌套 prefab 格式错误（${prefabPath}）：顶层必须是数组`);
  }
  let childRoot = -1;
  for (let i = 0; i < childData.length; i++) {
    if (typeOf(childData[i]) === 'cc.Prefab') {
      const r = refId(childData[i].data);
      if (r >= 0) childRoot = r;
      break;
    }
  }
  if (childRoot < 0) {
    for (let i = 0; i < childData.length; i++) {
      if (isPlainObject(childData[i]) && Array.isArray(childData[i]._children)) {
        childRoot = i;
        break;
      }
    }
  }
  if (childRoot < 0) {
    throw new Error(`嵌套 prefab 中找不到根节点（${prefabPath}）`);
  }

  // 内联
  const offset = ctx.data.length;
  const remap = new Map();
  for (let i = 0; i < childData.length; i++) remap.set(i, offset + i);
  for (let i = 0; i < childData.length; i++) {
    const clone = deepClone(childData[i]);
    remapRefs(clone, remap);
    ctx.data.push(clone);
  }
  const newRoot = remap.get(childRoot);

  // stub：删掉 _name（真正的名字放进 override）
  const rootEl = ctx.data[newRoot];
  delete rootEl._name;

  // cc.PrefabInfo（挂在新 stub 节点上）
  const prefabInfoFileId = deterministicFileId(`prefabinfo:${path.resolve(prefabPath)}:${newRoot}`);
  const prefabInfoEl = {
    __type__: 'cc.PrefabInfo',
    fileId: prefabInfoFileId,
    id: deterministicUuid(`prefabinfo-id:${path.resolve(prefabPath)}:${newRoot}`),
    instance: null,
    targetOverrides: [],
  };
  const prefabInfoIndex = ctx.data.length;
  ctx.data.push(prefabInfoEl);

  // cc.PrefabInstance
  const instanceFileId = deterministicFileId(`instance:${path.resolve(prefabPath)}:${newRoot}`);
  const instanceEl = {
    __type__: 'cc.PrefabInstance',
    fileId: instanceFileId,
    propertyOverrides: [],
    removedComponents: [],
    removedGameObjects: [],
    mountedChildren: [],
    mountedComponents: [],
  };
  const instanceIndex = ctx.data.length;
  ctx.data.push(instanceEl);
  prefabInfoEl.instance = { __id__: instanceIndex };

  // 挂到宿主节点
  rootEl._prefab = { __id__: prefabInfoIndex };
  const parentEl = ctx.data[parentIndex];
  if (!isPlainObject(parentEl) || !Array.isArray(parentEl._children)) {
    throw new Error(`父节点不是合法节点（index ${parentIndex}）`);
  }
  const at = typeof index === 'number' && index >= 0 ? Math.min(index, parentEl._children.length) : parentEl._children.length;
  parentEl._children.splice(at, 0, { __id__: newRoot });
  rootEl._parent = { __id__: parentIndex };

  // 重建上下文索引（新增了元素）
  reindex(ctx);

  const instance = ctx.instances.get(instanceIndex);
  const realName = name || displayName(ctx, newRoot);
  if (instance) {
    upsertOverride(ctx, instance, { localID: [instanceFileId], propertyPath: ['_name'], value: realName });
    ensureTargetOverride(ctx, instance);
  }

  return { nodeIndex: newRoot, instanceIndex, name: realName };
}

/**
 * replace-nested-prefab：把已有 stub 实例的内容替换成另一个 prefab 的内容。
 * 旧的内联内容标记为孤儿（保留元素维持 __id__ 稳定）。
 */
function replaceNestedPrefab(ctx, options) {
  const { nodeIndex, prefabPath } = options;
  const link = ctx.nodeInstance.get(nodeIndex);
  if (!link || link.instanceIndex < 0) {
    throw new Error(`节点 ${displayName(ctx, nodeIndex)} 不是嵌套 prefab 实例，无法替换`);
  }
  const instance = ctx.instances.get(link.instanceIndex);
  if (!instance) {
    throw new Error(`节点 ${displayName(ctx, nodeIndex)} 的 PrefabInstance 缺失，无法替换`);
  }
  const parentIndex = ctx.nodes.get(nodeIndex).parentIndex;
  if (parentIndex < 0) {
    throw new Error(`节点 ${displayName(ctx, nodeIndex)} 没有父节点，无法替换`);
  }
  const parentEl = ctx.data[parentIndex];
  const childPos = parentEl._children.findIndex((c) => refId(c) === nodeIndex);

  // 旧子树整体标孤儿
  const orphans = [];
  const markOrphan = (idx) => {
    const info = ctx.nodes.get(idx);
    if (!info) return;
    orphans.push(idx);
    ctx.orphanNodes.add(idx);
    for (const c of info.components) ctx.orphanComponents.add(c.index);
    for (const c of info.children) markOrphan(c);
  };
  markOrphan(nodeIndex);

  // 从父节点移除旧引用
  parentEl._children = parentEl._children.filter((c) => refId(c) !== nodeIndex);

  // 内联新内容
  const created = inlineNestedPrefab(ctx, {
    parentIndex,
    prefabPath,
    name: instance.overrides.find((o) => o.propertyPath[0] === '_name')
      ? instance.overrides.find((o) => o.propertyPath[0] === '_name').value
      : undefined,
    index: childPos >= 0 ? childPos : undefined,
  });
  return { created, orphans };
}

/** 数据变化后重建上下文索引（元素下标/引用变了）。 */
function reindex(ctx) {
  const rebuilt = require('./parse').buildPrefabContext(ctx.data, ctx.filePath);
  ctx.rootIndex = rebuilt.rootIndex;
  ctx.prefabIndex = rebuilt.prefabIndex;
  ctx.nodes = rebuilt.nodes;
  ctx.nodeOrder = rebuilt.nodeOrder;
  ctx.components = rebuilt.components;
  ctx.instances = rebuilt.instances;
  ctx.prefabInfos = rebuilt.prefabInfos;
  ctx.nodeInstance = rebuilt.nodeInstance;
  ctx.paths = rebuilt.paths;
  return ctx;
}

module.exports = {
  overrideCategory,
  isArrayFieldOverride,
  findInsertIndex,
  sortOverrides,
  normalizeOverridePaths,
  reorderOverrides,
  buildLocalIdChain,
  compPrefabInfoFileId,
  resolveLocalIdForComponent,
  upsertOverride,
  removeOverrides,
  ensureTargetOverride,
  syncNestedRoots,
  inlineNestedPrefab,
  replaceNestedPrefab,
  reindex,
};
