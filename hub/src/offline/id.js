'use strict';

/**
 * id.js —— fileId / classId / uuid 相关工具。
 *
 * 约束：
 *  - 零第三方依赖（只用 node:crypto）。
 *  - compressUUID / decompressUUID 必须严格互逆（round-trip 会被真机 Cocos 的
 *    scene:query-components 返回的 cid 字段交叉验证）。
 *  - deterministicFileId 对相同 seed 必须永远返回相同结果。
 */

const crypto = require('node:crypto');

/** Cocos classId（压缩 uuid）使用的 base64 变体表，共 64 个字符。 */
const B64 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * 把 36 位标准 uuid 压缩成 23 字符 classId。
 * 非 36 位字符串原样返回。
 */
function compressUUID(uuid) {
  if (typeof uuid !== 'string' || uuid.length !== 36) return uuid;
  const hex = uuid.replace(/-/g, '');
  let ret = hex.slice(0, 5);
  for (let i = 5; i < 32; i += 3) {
    const v = parseInt(hex.slice(i, i + 3), 16);
    ret += B64[v >> 6] + B64[v & 0x3f];
  }
  return ret; // 长度固定 23
}

/**
 * 把 23 字符 classId 解压回 36 位标准 uuid。
 * 非 23 位字符串（或含非法字符）原样返回。
 */
function decompressUUID(str) {
  if (typeof str !== 'string' || str.length !== 23) return str;
  for (let i = 0; i < str.length; i++) {
    if (B64.indexOf(str[i]) < 0) return str; // 非法字符，不做转换
  }
  let hex = str.slice(0, 5);
  for (let i = 5; i < 23; i += 2) {
    const v = (B64.indexOf(str[i]) << 6) | B64.indexOf(str[i + 1]);
    hex += v.toString(16).padStart(3, '0');
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** 判断字符串是否为合法的 23 字符 classId。 */
function isCompressedUUID(str) {
  if (typeof str !== 'string' || str.length !== 23) return false;
  for (let i = 0; i < str.length; i++) {
    if (B64.indexOf(str[i]) < 0) return false;
  }
  return true;
}

/** 判断字符串是否为 36 位标准 uuid。 */
function isUUID(str) {
  return typeof str === 'string' && UUID_RE.test(str);
}

/**
 * 确定性 fileId：sha256(seed) 取前 16 字节再 base64。
 * 相同 seed 永远得到相同结果（跨进程、跨机器一致）。
 */
function deterministicFileId(seed) {
  const input = typeof seed === 'string' ? seed : JSON.stringify(seed);
  return crypto.createHash('sha256').update(input).digest().subarray(0, 16).toString('base64');
}

/**
 * 由 seed 推导一个确定性的 36 位 uuid（用于 .meta 里的 uuid 字段）。
 * 与 deterministicFileId 不同长度：这里需要 16 字节十六进制 → 32 位 hex。
 */
function deterministicUuid(seed) {
  const input = typeof seed === 'string' ? seed : JSON.stringify(seed);
  const hex = crypto.createHash('sha256').update(input).digest('hex').slice(0, 32).split('');
  hex[12] = '4'; // version 4
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16); // variant
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/** 把任意 id（标准 uuid 或 23 字符 classId）统一成标准 uuid。 */
function toStandardUUID(id) {
  if (isUUID(id)) return id.toLowerCase();
  if (isCompressedUUID(id)) return decompressUUID(id);
  return id;
}

module.exports = {
  B64,
  compressUUID,
  decompressUUID,
  isCompressedUUID,
  isUUID,
  deterministicFileId,
  deterministicUuid,
  toStandardUUID,
};
