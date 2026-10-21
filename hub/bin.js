#!/usr/bin/env node
'use strict';

/**
 * cocos-mcp hub —— stdio MCP Server 入口
 * ---------------------------------------------------------------------------
 * 这是用户唯一需要配置的东西：
 *
 *   {
 *     "mcpServers": {
 *       "cocos-mcp": { "command": "node", "args": ["/path/to/cocos-mcp/hub/bin.js"] }
 *     }
 *   }
 *
 * 不需要 npm install、不需要起 HTTP 服务、不需要配 token。
 * hub 启动后扫描 ~/.cocos-mcp/editors/ 发现所有打开的 Cocos Creator 实例。
 */

const path = require('path');
const { McpServer, PROTOCOL_VERSION } = require('./src/mcp/server');
const { EditorRegistry } = require('./src/registry');
const { EditorClient } = require('./src/editor-client');
const { ToolRegistry } = require('./src/tools');
const { GLOBAL_TOOLS } = require('./src/tools/global-tools');

const SERVER_INFO = { name: 'cocos-mcp', version: require('../package.json').version || '1.0.0' };

const INSTRUCTIONS = `Cocos Creator 3.8.x 的 MCP 服务。

【怎么用】
1. 先用 scene.tree 看清当前场景结构，不要凭空猜节点名或 uuid。
2. 节点定位三种写法都支持：uuid、层级路径（Canvas/Panel/Button）、节点名。
3. 改属性用 component.set（会自动推断值类型）；改 prefab **资源文件**用 cocos_prefab_edit（离线直接改文件，不需要编辑器在线）。
4. 多步有依赖的改动用 scene.transaction —— 中途失败会自动回滚，不留半改状态。
5. 改完用 scene.save 保存；离线改完文件用 asset.reimport 通知编辑器。
6. 拿不准 Cocos 的 API/坐标系/布局规则时，先查 cocos_knowledge，别试错。

【重要边界】
- 本服务只调用经 Cocos Creator 3.8.8 真机验证存在的编辑器消息，调用不存在的消息会被直接拒绝并给出正确替代。
- 破坏性操作（删节点/删资源/摘组件）必须在同一次调用里显式传 confirm=true。
- **不提供「通用 eval」**：没有 \`new Function(code)\` 这类通用执行入口。
  但要知道：\`cocos_message\` + \`confirm=true\` 可以触达白名单里的
  \`scene:execute-scene-script\` / \`scene:execute-component-method\`，
  它们能调用扩展脚本与组件方法 —— 这是**受控但真实存在**的执行面，用之前请确认清楚。`;

function makeClientFactory(registry) {
    const cache = new Map();
    const factory = (entry) => {
        const key = `${entry.pid}:${entry.url}`;
        let c = cache.get(key);
        if (!c) {
            c = new EditorClient(entry);
            cache.set(key, c);
        }
        // 扩展「重启 Bridge」会换 url 与 token（pid 不变）→ 必须同步，
        // 否则之后每次调用都拿着旧 token 打新端口。
        c.sync(entry);
        return c;
    };
    // 淘汰已经消失的实例对应的 client（否则长跑进程会缓慢增长）
    factory.evictStale = () => {
        const live = new Set(registry.list().map((e) => `${e.pid}:${e.url}`));
        for (const key of [...cache.keys()]) {
            if (!live.has(key)) cache.delete(key);
        }
    };
    return factory;
}

async function main() {
    const args = process.argv.slice(2);

    const registry = new EditorRegistry().start();
    const getClient = makeClientFactory(registry);

    const tools = new ToolRegistry({
        getClient,
        listEditors: () => registry.list(),
    });

    // ── 调试模式：直接打印工具清单 / 探测连接，不进入 MCP 循环 ──
    if (args.includes('--print-tools')) {
        const list = tools.list();
        process.stdout.write(JSON.stringify(list, null, 2) + '\n');
        process.exit(0);
    }
    if (args.includes('--probe')) {
        const editors = registry.list();
        const out = { editors: [], ok: false };
        for (const e of editors) {
            const client = getClient(e);
            const rec = { shortName: e.shortName, projectPath: e.projectPath, editorVersion: e.editorVersion, url: e.url };
            // ⚠️ stale 要**在 ping 之前**就记上 ——
            //    「编辑器正忙」的表现恰恰是 ping 失败，
            //    如果只在 ping 成功之后才检查 stale，真·正忙的时候反而不会报 stale。
            if (e.stale) {
                rec.stale = true;
                rec.staleNote = '心跳超时（编辑器可能正忙）';
            }
            try {
                rec.ping = await client.ping();
                rec.ops = (await client.describe()).ops.length;
                rec.ok = true;
            } catch (err) {
                rec.error = err.message;
                if (rec.stale) {
                    rec.staleNote = '心跳超时且无响应（编辑器正忙或场景频道已中毒）';
                }
            }
            out.editors.push(rec);
        }
        out.ok = out.editors.some((e) => e.ok);
        process.stdout.write(JSON.stringify(out, null, 2) + '\n');
        process.exit(out.ok ? 0 : 1);
    }

    const server = new McpServer({
        serverInfo: SERVER_INFO,
        providers: {
            instructions: () => INSTRUCTIONS,
            tools: async () => tools.list(),
            callTool: async (name, toolArgs) => {
                const data = await tools.call(name, toolArgs);
                return {
                    content: [{ type: 'text', text: formatResult(data) }],
                    isError: false,
                };
            },
            resources: async () => listResources(registry),
            readResource: async (uri) => readResource(registry, getClient, uri),
            prompts: async () => listPrompts(),
            getPrompt: async (name, promptArgs) => getPrompt(name, promptArgs),
        },
    });

    // 编辑器实例数量变化 → 工具清单变化 → 通知客户端
    // 比较**短名集合**而不是数量 —— 同名项目去重改名时数量不变，但工具名前缀变了，
    // 客户端手里的工具名会全是旧的。
    let lastShortNames = registry.list().map((e) => e.shortName).sort().join('|');
    registry.onChange((editors) => {
        const now = editors.map((e) => e.shortName).sort().join('|');
        if (now !== lastShortNames) {
            lastShortNames = now;
            server.notifyToolListChanged();
            server.notifyResourceListChanged();
        }
    });

    // 定期淘汰失效的 client（扩展重启 Bridge 后旧 entry 不会消失）
    const evictTimer = setInterval(() => getClient.evictStale && getClient.evictStale(), 30000);
    if (evictTimer.unref) evictTimer.unref();

    server.start();

    const shutdown = () => {
        registry.stop();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // stderr 用于日志（MCP 规定 stdout 只能有协议消息）
    const editors = registry.list();
    if (editors.length === 0) {
        process.stderr.write(
            '[cocos-mcp] 已启动，但暂未发现运行中的 Cocos Creator。\n' +
            '[cocos-mcp] 请打开项目并启用扩展；或用 `node hub/bin.js --probe` 排查。\n'
        );
    } else {
        process.stderr.write(
            `[cocos-mcp] 已连接 ${editors.length} 个 Cocos Creator 实例：${editors.map((e) => e.shortName).join('、')}\n`
        );
    }
}

function formatResult(data) {
    if (typeof data === 'string') return data;
    try {
        return JSON.stringify(data, null, 2);
    } catch (_) {
        return String(data);
    }
}

// ─────────────────────────── Resources ───────────────────────────

function listResources(registry) {
    const editors = registry.list();
    const out = [
        { uri: 'cocos://editor/editors', name: '已连接的 Cocos 实例', description: '当前 hub 发现的所有 Cocos Creator 编辑器实例及其项目路径', mimeType: 'application/json' },
        { uri: 'cocos://knowledge/all', name: 'Cocos 知识库', description: '组件属性表 / 坐标系 / 布局配方 / 踩坑清单', mimeType: 'application/json' },
    ];
    for (const e of editors) {
        // 用 `cocos://editor/<短名>/...` 而不是 `<短名>__`：
        // 短名来自目录名，可能含下划线，`__` 分隔会产生歧义（解析不出正确的短名）。
        const seg = encodeURIComponent(e.shortName);
        out.push(
            { uri: `cocos://editor/${seg}/project/info`, name: `${e.shortName} 项目信息`, description: '项目路径、uuid、编辑器版本', mimeType: 'application/json' },
            { uri: `cocos://editor/${seg}/scene/tree`, name: `${e.shortName} 场景节点树`, description: '当前场景的完整节点树', mimeType: 'application/json' }
        );
    }
    return out;
}

async function readResource(registry, getClient, uri) {
    const json = (obj) => [{ uri, mimeType: 'application/json', text: JSON.stringify(obj, null, 2) }];

    if (uri === 'cocos://editor/editors') {
        return json(registry.list().map((e) => ({ shortName: e.shortName, projectPath: e.projectPath, editorVersion: e.editorVersion, pid: e.pid })));
    }
    if (uri === 'cocos://knowledge/all') {
        return json(require('./src/knowledge/cocos-knowledge.json'));
    }
    // 固定前缀 + 明确分隔，短名含下划线也不会歧义
    const m = /^cocos:\/\/editor\/([^/]+)\/(.+)$/.exec(uri);
    if (m) {
        const shortName = decodeURIComponent(m[1]);
        const rest = m[2];
        const entry = registry.list().find((e) => e.shortName === shortName);
        if (!entry) throw new Error(`没有名为 "${shortName}" 的编辑器实例`);
        const client = getClient(entry);
        if (rest === 'project/info') {
            return json(await client.invoke('editor.info', {}));
        }
        if (rest === 'scene/tree') {
            return json(await client.invoke('scene.tree', {}));
        }
        throw new Error(`未知的 resource 子路径: ${rest}`);
    }
    throw new Error(`未知的 resource uri: ${uri}`);
}

// ─────────────────────────── Prompts ───────────────────────────

function listPrompts() {
    return [
        {
            name: '搭建 UI 界面',
            description: '按设计稿在 Cocos 里搭一个 UI 界面的标准流程（含查知识库、查场景、搭节点、配组件、保存、自检）。',
            arguments: [],
        },
        {
            name: '批量改 prefab',
            description: '不启动编辑器、离线批量修改 prefab 的标准流程。',
            arguments: [],
        },
    ];
}

function getPrompt(name) {
    const prompts = {
        '搭建 UI 界面': `按以下流程在 Cocos Creator 里搭 UI 界面：

1. 调用 cocos_knowledge(topic="components") 确认要用到的组件属性名。
2. 调用 scene.tree 看清当前场景结构，确认 Canvas 是否存在、UI 挂在哪个节点下。
3. 调用 scene.transaction，把「建容器 → 建子节点 → 挂组件 → 设属性」编排成一步操作，
   这样中途失败不会留下半成品。
4. 调用 scene.save 保存。
5. 调用 editor.logs(level=["error"]) 自检有没有报错。

注意：锚点默认是中心 {0.5,0.5}；Label 的 color 分量是 0-255；UI 节点必须有 UITransform。`,
        '批量改 prefab': `离线批量修改 prefab（不需要编辑器运行）：

1. 调用 cocos_prefab_ops 拿到全部可用 op 与参数。
2. 先用 cocos_prefab_query(selector="tree") 看清目标 prefab 的节点结构与真实名字。
3. 先 dryRun=true 跑一遍 cocos_prefab_edit，确认 diff 符合预期。
4. 去掉 dryRun 正式执行（全部 op 成功才落盘，任一失败磁盘零写入）。
5. 调用 asset.reimport 通知编辑器重新导入。

注意：嵌套 prefab 里的节点名不在 _name 里，工具会自动识别；离线改完不 reimport，
编辑器下次保存会用旧数据覆盖你的修改。`,
    };
    if (!prompts[name]) throw new Error(`未知 prompt: ${name}`);
    return {
        description: name,
        messages: [{ role: 'user', content: { type: 'text', text: prompts[name] } }],
    };
}

main().catch((err) => {
    process.stderr.write(`[cocos-mcp] 启动失败: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
});
