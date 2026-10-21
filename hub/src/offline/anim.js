'use strict';

/**
 * anim.js —— .anim 处理。
 *
 * 结构约定
 *  - 找 cc.AnimationClip 类型的元素作为头。
 *  - Track 字段：单通道用 _channel（单数），多通道用 _channels（复数）。
 *  - 通道路径：channel.path（position / position.x / ...）。
 *  - 关键帧：channel.curve.data（或 keyframes / _data / points）。
 *
 * op：offset-curve / set-keyframe-value / set-curve-channel
 */

const { isPlainObject, deepClone, typeOf, refId } = require('./parse');

/* ------------------------------------------------------------- op schema */

const ANIM_OP_DEFS = {
  'offset-curve': {
    description: '对指定动画通道的所有关键帧做偏移（可只作用于某个轴）',
    mutates: true,
    scope: 'anim',
    required: ['offset'],
    optional: ['path', 'axis'],
    fields: {
      path: { type: 'string', desc: '通道路径，如 position / position.x；缺省作用于全部通道' },
      offset: { type: 'any', desc: '偏移量：数字或 {x,y,z}' },
      axis: { type: 'string', desc: '只偏移某个轴：x / y / z' },
    },
  },
  'set-keyframe-value': {
    description: '设置指定动画通道某个时间点的关键帧值',
    mutates: true,
    scope: 'anim',
    required: ['value'],
    optional: ['path', 'time', 'index'],
    fields: {
      path: { type: 'string', desc: '通道路径；缺省作用于全部通道' },
      time: { type: 'number', desc: '关键帧时间（秒）' },
      index: { type: 'number', desc: '关键帧下标（与 time 二选一）' },
      value: { type: 'any', desc: '关键帧值：数字或 {x,y,z}' },
    },
  },
  'set-curve-channel': {
    description: '重命名动画通道的路径',
    mutates: true,
    scope: 'anim',
    required: ['path', 'newPath'],
    optional: [],
    fields: {
      path: { type: 'string', desc: '当前通道路径' },
      newPath: { type: 'string', desc: '新的通道路径' },
    },
  },
};

/* ---------------------------------------------------------------- 扫描 */

function channelPath(channel) {
  if (!isPlainObject(channel)) return '';
  const p = channel.path || channel._path || channel.targetPath || channel._targetPath;
  if (typeof p === 'string') return p;
  if (isPlainObject(p) && typeof p.path === 'string') return p.path;
  return '';
}

/**
 * 取通道的关键帧数组。
 *
 * ⚠️ 真实 Cocos 的 .anim 里，`cc.animation.RealTrack._channel` 是
 * **引用** `{"__id__": N}`（曲线元素在数组另一处），
 * `VectorTrack._channels` 同理。之前不解引用 → 找不到关键帧 →
 * offset-curve 静默跳过 → 「报告成功但零改动」。
 */
function getKeyframes(channel, data) {
  if (!isPlainObject(channel)) return null;
  // ⚠️ **先解引用，再在解引用后的元素上取容器**。
  //   之前容器列表是用**未解引用**的 channel 算的（channel.curve / channel._curve / channel），
  //   于是当 channel 本身是 {"__id__":N} 时，解引用后拿到的 CurveChannel 元素
  //   它的 curve 子容器**永远不会被检查** → 引用型通道解析不到关键帧。
  let el = channel;
  if (typeof channel.__id__ === 'number' && Array.isArray(data)) {
    el = data[channel.__id__];
    if (!isPlainObject(el)) return null;
  }
  const containers = [el.curve, el._curve, el];
  for (const c of containers) {
    if (!isPlainObject(c)) continue;
    for (const key of ['data', 'keyframes', '_data', '_keyframes', 'points']) {
      if (Array.isArray(c[key])) return c[key];
    }
    // cc.Curve 的另一种布局：data 是对象，内含 paths / times+values
    if (isPlainObject(c.data)) {
      if (Array.isArray(c.data.paths)) return c.data.paths;
      if (Array.isArray(c.data.times) && Array.isArray(c.data.values)) {
        return c.data.times.map((t, i) => ({ time: t, value: c.data.values[i] }));
      }
    }
  }
  return null;
}

/** 扫描 .anim 数据，返回 clip / tracks / channels。 */
function scanAnim(data, filePath) {
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
        if (!isPlainObject(c)) return;
        channels.push({ index: ci, channel: c, path: channelPath(c), trackIndex: ti });
      });
    } else if (isPlainObject(el._channel)) {
      channels.push({ index: 0, channel: el._channel, path: channelPath(el._channel), trackIndex: ti });
    } else if (typeof el.path === 'string' || typeof el._path === 'string') {
      // Cocos 真实 .anim 形态：track 元素本身就是 cc.CurveChannel
      channels.push({ index: 0, channel: el, path: channelPath(el), trackIndex: ti });
    }
    tracks.push({ index: ti, element: el, trackNo: n, channels });
  });
  return { clipIndex, clip, tracks };
}

/** 收集全部通道。 */
function allChannels(ctx) {
  const out = [];
  for (const track of ctx.tracks) {
    for (const ch of track.channels) out.push(ch);
  }
  return out;
}

/** 按路径筛选通道（path 缺省 → 全部；支持 'position' 匹配 'position.x'）。 */
function selectChannels(ctx, path) {
  const all = allChannels(ctx);
  if (path === undefined || path === null || path === '') return all;
  return all.filter((ch) => ch.path === path || ch.path.startsWith(`${path}.`));
}

function readKeyValue(kf) {
  if (!isPlainObject(kf)) return null;
  if (typeof kf.value === 'number' || isPlainObject(kf.value)) return kf.value;
  return null;
}

function writeKeyValue(kf, value) {
  if (!isPlainObject(kf)) return null;
  const before = deepClone(kf.value);
  kf.value = deepClone(value);
  return before;
}

function applyOffset(value, offset, axis) {
  if (typeof value === 'number') {
    const d = typeof offset === 'number' ? offset : (offset && typeof offset[axis || 'x'] === 'number' ? offset[axis || 'x'] : 0);
    return value + d;
  }
  if (!isPlainObject(value)) return value;
  const out = deepClone(value);
  const axes = axis ? [axis] : ['x', 'y', 'z'];
  for (const a of axes) {
    const d = typeof offset === 'number' ? offset : offset && typeof offset[a] === 'number' ? offset[a] : 0;
    if (typeof out[a] === 'number') out[a] = out[a] + d;
  }
  return out;
}

/* -------------------------------------------------------------- handlers */

function handleOffsetCurve(ctx, op) {
  const changes = [];
  const channels = selectChannels(ctx, op.path);
  if (!channels.length) {
    throw new Error(
      `anim 通道不存在${op.path ? `（path="${op.path}"）` : ''}：${ctx.filePath}`
    );
  }
  for (const ch of channels) {
    const kfs = getKeyframes(ch.channel, ctx.data);
    if (!kfs) {
      // 之前是 continue —— 静默跳过 → 报告成功但什么都没改。
      throw new Error(
        `anim 通道 "${ch.path}" 解析不到关键帧（${ctx.filePath}）。` +
        '可能是该通道用了当前实现不支持的曲线形态。'
      );
    }
    let touched = 0;
    kfs.forEach((kf, i) => {
      const cur = readKeyValue(kf);
      if (cur === null) return;
      const next = applyOffset(cur, op.offset, op.axis);
      const before = writeKeyValue(kf, next);
      changes.push({
        path: `${ch.path}[${i}].value`,
        before,
        after: next,
      });
      touched++;
    });
    if (!touched) {
      throw new Error(`anim 通道 "${ch.path}" 没有可偏移的关键帧：${ctx.filePath}`);
    }
  }
  return changes;
}

function handleSetKeyframeValue(ctx, op) {
  const changes = [];
  const channels = selectChannels(ctx, op.path);
  if (!channels.length) {
    throw new Error(
      `anim 通道不存在${op.path ? `（path="${op.path}"）` : ''}：${ctx.filePath}`
    );
  }
  for (const ch of channels) {
    const kfs = getKeyframes(ch.channel, ctx.data);
    if (!kfs) {
      throw new Error(
        `anim 通道 "${ch.path}" 解析不到关键帧（${ctx.filePath}）。` +
        '可能是该通道用了当前实现不支持的曲线形态。'
      );
    }
    if (!kfs.length) continue;
    let target = -1;
    if (typeof op.index === 'number') {
      target = op.index;
    } else if (typeof op.time === 'number') {
      target = kfs.findIndex((kf) => isPlainObject(kf) && Math.abs(kf.time - op.time) < 1e-6);
      if (target < 0) {
        throw new Error(
          `anim 通道 "${ch.path}" 在时间 ${op.time} 处没有关键帧（${ctx.filePath}）`
        );
      }
    } else {
      target = 0;
    }
    if (target < 0 || target >= kfs.length) {
      throw new Error(
        `anim 关键帧下标越界：通道 "${ch.path}" 仅有 ${kfs.length} 个关键帧，请求 ${target}（${ctx.filePath}）`
      );
    }
    const before = writeKeyValue(kfs[target], op.value);
    changes.push({ path: `${ch.path}[${target}].value`, before, after: op.value });
  }
  if (!changes.length) {
    throw new Error(`anim 没有匹配到关键帧：${ctx.filePath}`);
  }
  return changes;
}

function handleSetCurveChannel(ctx, op) {
  const changes = [];
  for (const ch of allChannels(ctx)) {
    if (ch.path !== op.path) continue;
    // path 在 track 元素上（ch.element），不在 channel 引用上
    const c = ch.element || ch.channel;
    const before = channelPath(c);
    if (typeof c.path === 'string') c.path = op.newPath;
    else if (typeof c._path === 'string') c._path = op.newPath;
    else c.path = op.newPath;
    changes.push({ path: `channel.${before}`, before, after: op.newPath });
  }
  if (!changes.length) {
    throw new Error(`anim 通道不存在（path="${op.path}"）：${ctx.filePath}`);
  }
  return changes;
}

const ANIM_HANDLERS = {
  'offset-curve': handleOffsetCurve,
  'set-keyframe-value': handleSetKeyframeValue,
  'set-curve-channel': handleSetCurveChannel,
};

/**
 * 执行 anim op 序列（作用于 ctx.data 工作副本）。
 * 任一 op 抛错 → 整个事务失败（调用方负责不落盘）。
 */
function executeAnimOps(ctx, ops) {
  const diff = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const name = op.op;
    const handler = ANIM_HANDLERS[name];
    if (!handler) {
      throw new Error(`anim 操作未实现："${name}"（op #${i + 1}）`);
    }
    const changes = handler(ctx, op) || [];
    diff.push({ op: name, opIndex: i, changes });
    // 通道路径可能变化，重扫
    const rescanned = scanAnim(ctx.data, ctx.filePath);
    ctx.clipIndex = rescanned.clipIndex;
    ctx.clip = rescanned.clip;
    ctx.tracks = rescanned.tracks;
  }
  return diff;
}

module.exports = {
  ANIM_OP_DEFS,
  ANIM_HANDLERS,
  scanAnim,
  allChannels,
  selectChannels,
  channelPath,
  getKeyframes,
  executeAnimOps,
};
