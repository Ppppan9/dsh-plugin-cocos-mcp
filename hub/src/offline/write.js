'use strict';

/**
 * write.js —— 原子写 + 缩进风格保持 + .meta 生成。
 *
 * 修掉的参考实现缺陷：
 *  1) 原子写：先写 `xxx.tmp-<pid>-<rand>`，再 fs.renameSync 覆盖目标。
 *     原实现直接 writeFileSync 覆盖，写中断会留下截断文件。
 *  2) .meta 不在 op 执行期落盘；由调用方（ops.js）把待写 meta 收集到内存，
 *     等全部 op 成功后再统一 commit（见 commitPlans 的回滚逻辑）。
 *  3) 写回保留原缩进风格（探测最小缩进 + 末尾换行）。
 *  4) 不用 execSync('find ...')，全部用 fs.readdirSync(dir, {withFileTypes:true})。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { deterministicUuid } = require('./id');

/** 读取文本文件，不存在则抛出中文错误。 */
function readTextFile(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('文件路径为空或不是字符串');
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`文件不存在：${filePath}`);
  }
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    throw new Error(`无法读取文件（${filePath}）：${err.message}`);
  }
  if (!stat.isFile()) {
    throw new Error(`目标不是文件：${filePath}`);
  }
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`读取文件失败（${filePath}）：${err.message}`);
  }
}

/** 解析 JSON，错误信息带文件路径。 */
function parseJsonText(text, filePath) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`JSON 解析失败（${filePath}）：${err.message}`);
  }
}

/**
 * 探测原文件的缩进风格与末尾换行。
 * 返回 { indent: number|'\\t', trailingNewline: boolean }
 */
function detectFormat(text) {
  const lines = String(text).split(/\r?\n/);
  let minIndent = Infinity;
  let hasTab = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = /^([ \t]+)\S/.exec(line);
    if (!m) continue;
    const ws = m[1];
    if (ws.indexOf('\t') >= 0) {
      hasTab = true;
      continue;
    }
    if (ws.length < minIndent) minIndent = ws.length;
  }
  let indent = 2;
  if (hasTab) indent = '\t';
  else if (minIndent !== Infinity && minIndent > 0) indent = minIndent;
  return {
    indent,
    trailingNewline: /\r?\n$/.test(text),
  };
}

/** 按探测到的风格序列化 JSON。 */
function serializeJson(data, format) {
  const indent = format && format.indent === '\t' ? '\t' : (format && format.indent) || 2;
  let text = JSON.stringify(data, null, indent);
  if (format && format.trailingNewline && !text.endsWith('\n')) text += '\n';
  return text;
}

/**
 * 原子写：写临时文件 → rename 覆盖。
 * 失败时清理临时文件，绝不留下半个目标文件。
 */
function atomicWrite(filePath, content) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  );
  try {
    fs.writeFileSync(tmp, content, 'utf8');
  } catch (err) {
    throw new Error(`写入临时文件失败（${tmp}）：${err.message}`);
  }
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {
      /* ignore */
    }
    throw new Error(`原子写入失败（${filePath}）：${err.message}`);
  }
  return filePath;
}

/** .meta 文件路径。 */
function metaPathFor(filePath) {
  return `${filePath}.meta`;
}

/**
 * 按扩展名推导 Cocos 的 importer。
 * 之前一律写 'prefab' —— 给 .ts 脚本写 importer:"prefab" 会让 Cocos
 * 用 prefab 导入器去解析脚本，该脚本彻底无法编译。
 */
function importerForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.ts':
    case '.js':
      return 'typescript';
    case '.json':
      return 'json';
    case '.scene':
      return 'scene';
    case '.png':
    case '.jpg':
    case '.jpeg':
      return 'texture';
    case '.mp3':
    case '.wav':
      return 'audio-clip';
    case '.mp4':
      return 'video-clip';
    default:
      return 'prefab';
  }
}

/**
 * 生成 .meta 内容（Cocos 3.x importer 形态）。
 */
function buildMetaContent(filePath, options) {
  const opts = options || {};
  const uuid = opts.uuid || deterministicUuid(`meta:${path.resolve(filePath)}`);
  const importer = opts.importer || importerForPath(filePath);
  const meta = {
    ver: '1.1.0',
    importer,
    imported: true,
    uuid,
    files: [],
    subMetas: {},
    userData: {},
  };
  return `${JSON.stringify(meta, null, 2)}\n`;
}

/**
 * 准备一个 .meta 写入计划（不落盘）。
 * 返回 { path, content, existed, backupContent, uuid, skipped }
 *
 * ⚠️ **已有 .meta 时必须保留原 uuid 与原 importer**：
 * .meta 的 uuid 是资产主键，改了它，prefab / 场景里所有对该资产的引用
 * 全部断链（编辑器里变成粉红丢失引用）。所以：
 *   - 已有 .meta + 没显式给 uuid → 沿用旧 uuid
 *   - 已有 .meta + 没显式给 importer → 沿用旧 importer
 *   - 已有 .meta + 内容完全一致 → skipped（不写）
 */
function planMetaWrite(filePath, options) {
  const metaPath = metaPathFor(filePath);
  const existed = fs.existsSync(metaPath);
  const backupContent = existed ? fs.readFileSync(metaPath, 'utf8') : null;

  let prevUuid = null;
  let prevImporter = null;
  if (existed) {
    try {
      const prev = JSON.parse(backupContent);
      if (prev && typeof prev.uuid === 'string') prevUuid = prev.uuid;
      if (prev && typeof prev.importer === 'string') prevImporter = prev.importer;
    } catch (_) {
      /* 旧 .meta 解析失败 → 按新建处理 */
    }
  }

  const opts = options || {};
  const uuid = opts.uuid || prevUuid || deterministicUuid(`meta:${path.resolve(filePath)}`);
  const importer = opts.importer || prevImporter || importerForPath(filePath);

  // ⚠️ 已有 .meta 时**只补/改 uuid 与 importer，其余字段原样保留**。
  //   直接用 buildMetaContent 重建会把 files / subMetas / userData 全清空 ——
  //   subMetas 存着 SpriteFrame 等子元数据，清了纹理就失去所有子资源引用。
  if (existed) {
    let prev = null;
    try {
      prev = JSON.parse(backupContent);
    } catch (_) {
      prev = null;
    }
    if (prev && typeof prev === 'object' && !Array.isArray(prev)) {
      const merged = { ...prev, uuid, importer };
      const content = `${JSON.stringify(merged, null, 2)}\n`;
      if (backupContent === content) {
        return { path: metaPath, content, existed, backupContent, uuid, skipped: true };
      }
      return { path: metaPath, content, existed, backupContent, uuid, skipped: false };
    }
  }

  const content = buildMetaContent(filePath, { ...opts, uuid, importer });
  return { path: metaPath, content, existed, backupContent, uuid, skipped: false };
}

/**
 * 统一提交写计划（.meta 先行，主文件最后）。
 * 任一写入失败 → 回滚已写入的文件（含删除新建的 .meta），保证事务原子性。
 */
function commitPlans(plans) {
  const written = [];
  try {
    for (const plan of plans) {
      atomicWrite(plan.path, plan.content);
      written.push(plan);
    }
  } catch (err) {
    for (const plan of written) {
      try {
        if (plan.existed && plan.backupContent !== null) {
          atomicWrite(plan.path, plan.backupContent);
        } else if (fs.existsSync(plan.path)) {
          fs.unlinkSync(plan.path);
        }
      } catch (_) {
        /* 回滚尽力而为 */
      }
    }
    throw err;
  }
  return written.map((p) => p.path);
}

/**
 * 递归列出目录下的所有文件（纯 Node 实现，Windows 兼容）。
 * 返回相对 dir 的文件路径数组。
 */
function listFilesRecursive(dir, options) {
  const opts = options || {};
  const out = [];
  const walk = (current, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      if (opts.ignoreErrors) return;
      throw new Error(`读取目录失败（${current}）：${err.message}`);
    }
    for (const entry of entries) {
      if (opts.skipHidden !== false && entry.name.startsWith('.')) continue;
      const abs = path.join(current, entry.name);
      const relPath = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) walk(abs, relPath);
      else if (entry.isFile()) out.push(relPath);
    }
  };
  if (!fs.existsSync(dir)) {
    if (opts.ignoreErrors) return out;
    throw new Error(`目录不存在：${dir}`);
  }
  walk(dir, '');
  return out;
}

module.exports = {
  importerForPath,
  readTextFile,
  parseJsonText,
  detectFormat,
  serializeJson,
  atomicWrite,
  metaPathFor,
  buildMetaContent,
  planMetaWrite,
  commitPlans,
  listFilesRecursive,
};
