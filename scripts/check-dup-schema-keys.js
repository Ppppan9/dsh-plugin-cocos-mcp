'use strict';

/**
 * 检测工具 schema 里的**重复 key**。
 *
 * ⚠️ 为什么必须从**源码文本**查：
 *    JS 对象字面量里同一个 key 写两次，**后写的覆盖先写的**，
 *    运行时对象里重复信息已经丢了 —— 从对象上根本看不出来。
 *    真实踩过：node.create 的 properties 里 type/position/components 各写了两次，
 *    新加的那些描述全被丢弃，模型看到的仍是旧的（而且是错的那条）。
 *
 *    而且这类问题**不会被任何基于「key 集合」的比对发现** ——
 *    重复 key 的集合是一样的。
 *
 * 用法：node scripts/check-dup-schema-keys.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = ['hub/src/tools/editor-tools.js', 'hub/src/tools/global-tools.js'];

/**
 * 从源码里找出每个 `properties: {` 块里的顶层 key。
 * 只看**直接**的一层（嵌套的 properties 块各自独立）。
 */
function findDuplicateKeys(src) {
    const dupes = [];
    const lines = src.split('\n');
    let inProps = false;
    let depth = 0;
    let seen = new Map();
    let startLine = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!inProps) {
            if (/properties:\s*\{\s*$/.test(line)) {
                inProps = true;
                depth = 1; // properties 对象内部的深度
                startLine = i + 1;
                seen = new Map();
            }
            continue;
        }
        // ⚠️ 深度必须用**这一行开始前**的值。
        //    `position: {` 这种「跨行展开」的行会把深度从 1 推到 2 ——
        //    如果先更新深度再匹配 key，这一行自己就不算「第一层 key」→
        //    **跨行形态的重复 key 全部漏检**（而这恰恰是写 schema 时最常见的形态）。
        const depthBefore = depth;
        const m = line.match(/^ {16}([A-Za-z_][A-Za-z0-9_]*):/);
        if (m && depthBefore === 1) {
            const key = m[1];
            if (seen.has(key)) {
                dupes.push({
                    key,
                    first: seen.get(key),
                    second: i + 1,
                    startLine,
                });
            } else {
                seen.set(key, i + 1);
            }
        }
        depth += countBraces(line);
        if (depth <= 0) {
            inProps = false;
        }
    }
    return dupes;
}

function countBraces(line) {
    // 粗略计数：忽略字符串里的花括号（本项目 schema 描述里没有花括号）
    let n = 0;
    for (const ch of line) {
        if (ch === '{') n++;
        else if (ch === '}') n--;
    }
    return n;
}

module.exports = { findDuplicateKeys, ROOT, FILES };

if (require.main === module) {
    let bad = 0;
    for (const f of FILES) {
        const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
        const dupes = findDuplicateKeys(src);
        for (const d of dupes) {
            bad++;
            console.log(
                `  ✘ ${f}:${d.second}  properties 里 "${d.key}" 重复` +
                `（第 ${d.first} 行已经写过）—— 后写的会覆盖先写的，先写的描述/约束全部丢失`
            );
        }
    }
    console.log(bad ? `\n共 ${bad} 处重复 key` : '✅ 没有重复 key');
    process.exit(bad ? 1 : 0);
}
