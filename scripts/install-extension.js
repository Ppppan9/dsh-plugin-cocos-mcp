#!/usr/bin/env node
'use strict';

/**
 * 一键安装：把扩展装进 Cocos Creator 工程
 * ---------------------------------------------------------------------------
 *   node scripts/install-extension.js <项目路径> [--force]
 *
 * 装到 <项目>/extensions/cocos-mcp/。已存在且非 --force 时跳过（不覆盖用户改动）。
 * 装完会提示如何接入 MCP 客户端。
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'extension');

function fail(msg) {
    console.error(`❌ ${msg}`);
    process.exit(1);
}

function main() {
    const args = process.argv.slice(2);
    const force = args.includes('--force');
    const projectArg = args.find((a) => !a.startsWith('--'));

    if (!projectArg) {
        console.log('用法: node scripts/install-extension.js <Cocos 项目路径> [--force]');
        console.log('');
        console.log('示例:');
        console.log('  node scripts/install-extension.js ~/Documents/MyGame');
        process.exit(projectArg ? 0 : 1);
    }

    const project = path.resolve(projectArg.replace(/^~/, process.env.HOME));
    if (!fs.existsSync(project)) fail(`项目路径不存在: ${project}`);
    if (!fs.existsSync(path.join(project, 'package.json'))) {
        fail(`${project} 不像一个 Cocos Creator 项目（缺少 package.json）`);
    }
    let creatorVersion = '未知';
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
        creatorVersion = (pkg.creator && pkg.creator.version) || '未知';
    } catch (_) {
        /* ignore */
    }

    const destDir = path.join(project, 'extensions', 'cocos-mcp');
    // 目标永远是 extensions/cocos-mcp。
    // 之前的逻辑是「destDir 下有 package.json 就装 destDir，否则装 destDir/cocos-mcp」，
    // 结果**全新安装**会装成 extensions/cocos-mcp/cocos-mcp 的嵌套布局 ——
    // Cocos 不会把嵌套目录当成扩展根，扩展根本加载不了。
    const target = destDir;

    if (fs.existsSync(target) && !force) {
        console.log(`⚠️  已存在扩展：${target}`);
        console.log('   加 --force 可覆盖安装。');
    } else {
        if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.cpSync(SRC, target, { recursive: true });
        console.log(`✅ 扩展已安装到 ${target}`);
    }

    // 把 hub 的真实路径写进扩展 —— 面板的「复制 MCP 配置」要用它。
    // 扩展装在 <项目>/extensions/cocos-mcp/，hub 在仓库根，两者不同目录。
    const hubPath = path.join(__dirname, '..', 'hub', 'bin.js');
    try {
        fs.writeFileSync(path.join(target, 'hub-path.txt'), hubPath + '\n', 'utf8');
        console.log(`  hub 路径已写入：${hubPath}`);
    } catch (e) {
        console.log(`  ⚠️  写 hub-path.txt 失败（面板的「复制配置」会提示找不到 hub）：${e.message}`);
    }

    // 初始化 .dev 信号目录（扩展的 restart-package 通道用）
    try {
        fs.mkdirSync(path.join(project, '.dev'), { recursive: true });
    } catch (_) {
        /* ignore */
    }

    console.log('');
    console.log(`项目 Cocos Creator 版本：${creatorVersion}`);
    console.log('');
    console.log('接下来：');
    console.log('  1. 打开（或重开）Cocos Creator，确认扩展面板显示「Bridge 已启动」');
    console.log('  2. 把下面这段加进你的 MCP 客户端配置：');
    console.log('');
    const hub = path.join(__dirname, '..', 'hub', 'bin.js');
    console.log('     {');
    console.log('       "mcpServers": {');
    console.log('         "cocos-mcp": {');
    console.log(`           "command": "node",`);
    console.log(`           "args": ["${hub}"]`);
    console.log('         }');
    console.log('       }');
    console.log('     }');
    console.log('');
    console.log('  3. 自检： node ' + hub + ' --probe');
}

main();
