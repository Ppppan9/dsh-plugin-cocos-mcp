#!/usr/bin/env node
'use strict';

/**
 * 从代码重新生成 README 的工具清单表
 * ---------------------------------------------------------------------------
 * 为什么需要这个：工具面一改，README 里的表就会漂移。
 * 现存开源项目就栽在这上面 —— README 列了 10 个不存在的工具名，
 * 24 个真实工具一个字没提。
 *
 * 用法：node scripts/gen-readme-tools.js [--check]
 *   --check  只校验不写文件（CI / 提交前用）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { EDITOR_TOOLS, GLOBAL_TOOLS } = require('../hub/src/tools');

const START = '<!-- TOOLS:START -->';
const END = '<!-- TOOLS:END -->';

/** 按域分组，域内按名称排。 */
function groupTools(tools) {
    const groups = new Map();
    for (const t of tools) {
        const domain = t.name.split('.')[0];
        if (!groups.has(domain)) groups.set(domain, []);
        groups.get(domain).push(t);
    }
    const order = [...groups.keys()].sort((a, b) => {
        // 全局工具（cocos_*）排最前
        const ga = a.startsWith('cocos_') ? 0 : 1;
        const gb = b.startsWith('cocos_') ? 0 : 1;
        if (ga !== gb) return ga - gb;
        return a.localeCompare(b);
    });
    return order.map((k) => [k, groups.get(k).sort((a, b) => a.name.localeCompare(b.name))]);
}

function render(tools) {
    const lines = [];
    lines.push(`## 工具清单（${tools.length} 个）`);
    lines.push('');
    lines.push('### 全局工具（与编辑器实例无关，始终无前缀）');
    lines.push('');
    lines.push('| 工具 | 说明 |');
    lines.push('|---|---|');
    for (const t of tools.filter((x) => x.name.startsWith('cocos_'))) {
        const desc = t.description.split('\n')[0].replace(/\|/g, '\\|');
        lines.push(`| \`${t.name}\` | ${desc} |`);
    }
    lines.push('');
    lines.push('### 编辑器工具（单实例时无前缀，多实例时 `<短名>__` 前缀）');
    lines.push('');
    lines.push('| 域 | 工具 |');
    lines.push('|---|---|');
    for (const [domain, list] of groupTools(tools.filter((x) => !x.name.startsWith('cocos_')))) {
        const names = list.map((t) => `\`${t.name}\``).join(' ');
        lines.push(`| ${domain} | ${names} |`);
    }
    lines.push('');
    lines.push('> 危险操作（`node.delete` / `component.remove` / `asset.delete` / `cocos_message`）');
    lines.push('> 必须在同一次调用里显式传 `confirm: true`，`confirm` 已写进工具 schema 的必填项，模型无法绕过。');
    lines.push('');
    return lines.join('\n');
}

function main() {
    const tools = [...EDITOR_TOOLS, ...GLOBAL_TOOLS];
    const block = render(tools);
    const readmePath = path.join(ROOT, 'README.md');
    const readme = fs.readFileSync(readmePath, 'utf8');
    const startIdx = readme.indexOf(START);
    const endIdx = readme.indexOf(END);
    if (startIdx < 0 || endIdx < 0) {
        console.error(`❌ README 里找不到 ${START} / ${END} 标记`);
        process.exit(2);
    }
    const next = readme.slice(0, startIdx) + START + '\n\n' + block + '\n' + END + readme.slice(endIdx + END.length);

    if (process.argv.includes('--check')) {
        if (next !== readme) {
            console.error('❌ README 的工具清单与代码不一致。请运行：node scripts/gen-readme-tools.js');
            process.exit(1);
        }
        console.log('✅ README 工具清单与代码一致');
        return;
    }
    fs.writeFileSync(readmePath, next, 'utf8');
    console.log(`✓ README 工具清单已重新生成（${tools.length} 个工具）`);
}

main();
