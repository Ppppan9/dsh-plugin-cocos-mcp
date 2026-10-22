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

const { isPlainObject, deepClone, typeOf, refId, loadAnimFromData, getKeyframes: parseGetKeyframes } = require('./parse');

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
/**
 * 取通道的关键帧数组。
 *
 * ⚠️ **直接用 parse.js 的实现** —— 之前 anim.js 和 parse.js 各有一份，
 *    行为不一致（anim.js 那份不解引用 `_curve` 引用、也不认
 *    真实 Cocos 的 `_times`/`_values` 布局），于是同一个通道
 *    在 query 和 edit 里解析结果不同 → 「通道存在但解析不到关键帧」。
 *    两套实现必须合并成一套。
 */
function getKeyframes(channel, data) {
  return parseGetKeyframes(channel, data);
}

/** 扫描 .anim 数据，返回 clip / tracks / channels。 */
/**
 * 扫描 anim 的轨道与通道。
 *
 * ⚠️ 这里**不再自己实现一套解析** —— 之前 anim.js 和 parse.js 各有一套，
 *    行为不一致（anim.js 不解引用 `_channel`/`_channels`、不处理
 *    `clip._tracks` 和 `_binding.path`），而 executeAnimOps 每执行完一个 op
 *    就用这里的 scanAnim **重扫** → 于是**第 2 个 op 起状态就被污染**，
 *    真实 Cocos .anim 的批量编辑全军覆没（还报成误导性的「通道不存在」）。
 *    现在统一走 parse.js 的实现（唯一真相）。
 */
function scanAnim(data, filePath) {
  const parsed = loadAnimFromData(data, filePath);
  return {
    clipIndex: parsed.clipIndex,
    clip: parsed.clip,
    tracks: parsed.tracks.map((t) => ({
      index: t.index,
      element: t.element,
      trackNo: t.trackNo,
      channels: t.channels.map((c) => ({
        index: c.index,
        channel: c.channel,
        ref: c.ref,
        path: c.path,
        trackIndex: t.index,
      })),
    })),
  };
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

/** 合法的轴。 */
const VALID_AXES = ['x', 'y', 'z'];

function handleOffsetCurve(ctx, op) {
  // ⚠️ axis 写错（"X" / "xx" / "foo"）时，applyOffset 一个轴都不会命中，
  //    结果是「什么都没改」——工具报 changed:0、磁盘不写，
  //    看起来是安全的，但调用方（尤其是模型）很可能把「changed:0」当成
  //    「已经改过了别的通道」。**假成功比报错更危险** → 直接拒绝。
  //
  // ⚠️⚠️ 判断必须先卡住**类型** ——
  //    只写 `VALID_AXES.includes(String(op.axis))` 的话，
  //    `axis: ["x"]` 或 `axis: {toString: () => 'x'}` 会被 String() 强制转换成
  //    "x" 而**通过校验**，但 applyOffset 用的是**原始值**
  //    （`axes = [axis]` → 拿 `out[["x"]]` 去比）→ 一个轴都命不中 →
  //    又变成「报成功但零效果」。实测过，不是理论风险。
  if (op.axis !== undefined && op.axis !== null) {
    if (typeof op.axis !== 'string') {
      throw new Error(
        `offset-curve 的 axis 必须是字符串（x / y / z），收到 ${typeof op.axis}。` +
        '（数组 / 对象会被强制转换成字符串骗过校验，但实际一个轴都命不中 → 什么都不改。）'
      );
    }
    if (!VALID_AXES.includes(op.axis)) {
      throw new Error(
        `offset-curve 的 axis "${op.axis}" 不是合法的轴名，只能是 ${VALID_AXES.join(' / ')}。` +
        '（传错轴名会一个轴都命不中 → 什么都不改。与其静默无效，不如直接报错。）'
      );
    }
  }
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
