'use strict';

/**
 * 精确提取 bridge 里每个 op 的源码。
 *
 * ⚠️ 不要用「正则找 `'name': async (args) => {` 再配对大括号」——
 *    op 体里有字符串/模板字面量里的花括号，配对会错位，
 *    结果会把**相邻 op** 的参数算进来（真实踩过：scene.node 报出了
 *    maxDepth/name/type —— 那是 scene.find 的参数，结论完全错）。
 *
 * 所有 op 都在同一个对象字面量里、缩进一致（8 空格），
 * 所以「一个顶层键到下一个顶层键」就是准确的边界。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HANDLERS = path.join(ROOT, 'extension', 'bridge', 'handlers.js');

function extractOpBodies(src) {
    const ops = new Map();
    // 顶层 op 的键：行首 8 空格 + 引号 + 名字 + 引号 + 冒号
    const re = /^ {8}'([a-z][a-zA-Z0-9_.]*)':/gm;
    const marks = [];
    let m;
    while ((m = re.exec(src)) !== null) marks.push({ name: m[1], start: m.index });
    for (let i = 0; i < marks.length; i++) {
        const end = i + 1 < marks.length ? marks[i + 1].start : src.length;
        ops.set(marks[i].name, src.slice(marks[i].start, end));
    }
    return ops;
}

/**
 * 检测「解构式读取参数」。
 * ⚠️ `const { url, pattern } = args` 这种写法正则抓不到 ——
 *    检查器会**静默地**漏掉这些参数，断言照样通过 → 检查器失效却没人知道。
 *    所以：检测到解构就**报出来**（宁可吵，也不能静默失效）。
 */
function hasDestructuring(body) {
    return /(?:const|let|var)\s*\{[^}]*\}\s*=\s*args\b/.test(body) || /=\s*args\s*;/.test(body);
}

/** 某个 op 真正读到的参数名。 */
function argsUsed(body) {
    const used = new Set();
    // 只取**该 op 自己的** args.X（排除 op.args / foo.args 这类嵌套的）
    const re = /(?<![\w.$])args\.([A-Za-z_][A-Za-z0-9_]*)/g;
    let m;
    while ((m = re.exec(body)) !== null) used.add(m[1]);
    return [...used].sort();
}

module.exports = { extractOpBodies, argsUsed, hasDestructuring, HANDLERS, ROOT };

if (require.main === module) {
    const src = fs.readFileSync(HANDLERS, 'utf8');
    const ops = extractOpBodies(src);
    const { EDITOR_TOOLS, GLOBAL_TOOLS } = require(path.join(ROOT, 'hub', 'src', 'tools'));
    console.log(`解析到 ${ops.size} 个 bridge op\n`);
    let bad = 0;
    for (const t of [...EDITOR_TOOLS, ...GLOBAL_TOOLS]) {
        if (!t.op) continue;
        const body = ops.get(t.op);
        if (!body) {
            // ⚠️ 「找不到」必须**算失败** —— 静默跳过的话，
            //    一旦 op 改名/删除，这个检查器就悄悄查不到它了，
            //    还会打印「✅ 全部一致」，等于检查器自己失效了。
            bad++;
            console.log(`  ✘ ${t.name} → op "${t.op}" 在 handlers.js 里找不到（可能改名了）`);
            continue;
        }
        if (hasDestructuring(body)) {
            bad++;
            console.log(
                `  ! ${t.name} (op ${t.op}) → 用了解构式读取参数，自动检查**抓不到**，需要人工确认`
            );
            continue;
        }
        const declared = new Set(Object.keys((t.inputSchema || {}).properties || {}));
        const missing = argsUsed(body).filter((k) => !declared.has(k));
        if (missing.length) {
            bad++;
            console.log(`  ✘ ${t.name} (op ${t.op}) → bridge 读了但 schema 没声明：${missing.join(', ')}`);
        }
    }
    console.log(bad ? `\n共 ${bad} 个工具有缺口` : '\n✅ 全部一致');
    process.exit(bad ? 1 : 0);
}
