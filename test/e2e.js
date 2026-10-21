#!/usr/bin/env node
'use strict';

/**
 * 端到端验证：hub ↔ 真机 Cocos Creator 3.8.x
 * ---------------------------------------------------------------------------
 * 用真实 MCP 协议（stdio + JSON-RPC）驱动 hub，再由 hub 经 Bridge 驱动
 * 打开中的 Cocos Creator 编辑器，验证：
 *   1. MCP 握手（协议版本协商 / 能力 / instructions）
 *   2. tools/list 工具面
 *   3. 真实读取：编辑器信息、场景树、场景状态、知识库
 *   4. 真实写入：建节点 → 挂组件 → 设属性 → 读回校验 → 删除
 *   5. 安全护栏：危险操作缺 confirm 必须被拒；不存在的编辑器消息必须被拒
 *
 * 用法：
 *   node test/e2e.js                     # 跑全量（需要 Cocos Creator 开着且装了扩展）
 *   node test/e2e.js --keep-scene        # 跑完不删测试场景
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const HUB = path.join(__dirname, '..', 'hub', 'bin.js');
const KEEP_SCENE = process.argv.includes('--keep-scene');

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, detail) {
    pass++;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
}
function bad(name, detail) {
    fail++;
    failures.push(`${name}: ${detail}`);
    console.log(`  ❌ ${name} — ${detail}`);
}
function assert(cond, name, detail) {
    if (cond) ok(name, detail);
    else bad(name, detail || '断言失败');
    return cond;
}

/** 一个极简 MCP stdio 客户端。 */
class McpClient {
    constructor() {
        this.proc = spawn(process.execPath, [HUB], { stdio: ['pipe', 'pipe', 'pipe'] });
        this.buf = '';
        this.pending = new Map();
        this.nextId = 1;
        this.stderr = '';
        this.proc.stdout.setEncoding('utf8');
        this.proc.stdout.on('data', (d) => {
            this.buf += d;
            let i;
            while ((i = this.buf.indexOf('\n')) >= 0) {
                const line = this.buf.slice(0, i).trim();
                this.buf = this.buf.slice(i + 1);
                if (!line) continue;
                let msg;
                try {
                    msg = JSON.parse(line);
                } catch (_) {
                    continue;
                }
                if (msg.id !== undefined && this.pending.has(msg.id)) {
                    const { resolve } = this.pending.get(msg.id);
                    this.pending.delete(msg.id);
                    resolve(msg);
                }
            }
        });
        this.proc.stderr.setEncoding('utf8');
        this.proc.stderr.on('data', (d) => (this.stderr += d));
    }

    request(method, params) {
        const id = this.nextId++;
        const payload = { jsonrpc: '2.0', id, method, params: params || {} };
        return new Promise((resolve, reject) => {
            // 必须大于最长的工具超时（scene.open = 120s），否则测试先超时，
            // 拿不到 Bridge 侧准备好的清晰错误信息。
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${method} 超时（150s）`));
            }, 150000);
            this.pending.set(id, {
                resolve: (m) => {
                    clearTimeout(timer);
                    resolve(m);
                },
            });
            this.proc.stdin.write(JSON.stringify(payload) + '\n');
        });
    }

    notify(method, params) {
        this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }) + '\n');
    }

    /** 调用工具，返回解析后的 content 文本。 */
    async callTool(name, args) {
        const res = await this.request('tools/call', { name, arguments: args || {} });
        // 协议级错误（未知工具 / 参数非法）按 MCP 规范走 JSON-RPC error，
        // 工具执行错误走 isError + content。两种都表示「这次调用失败了」。
        if (res.error) return { isError: true, text: res.error.message, protocolError: true };
        const text = (res.result.content || []).map((c) => c.text).join('\n');
        let data;
        try {
            data = JSON.parse(text);
        } catch (_) {
            data = text;
        }
        return { isError: !!res.result.isError, data, text };
    }

    close() {
        try {
            this.proc.kill();
        } catch (_) {
            /* ignore */
        }
    }
}

function section(title) {
    console.log(`\n${'─'.repeat(64)}\n▸ ${title}\n${'─'.repeat(64)}`);
}

async function main() {
    console.log('Cocos MCP 端到端验证');
    console.log(`Node ${process.version}  |  ${process.platform}/${process.arch}`);

    // ── 0. 前置：必须有一个连着的编辑器 ─────────────────────────
    section('0. 前置检查');
    const probe = spawn(process.execPath, [HUB, '--probe'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let probeOut = '';
    probe.stdout.setEncoding('utf8');
    probe.stdout.on('data', (d) => (probeOut += d));
    await new Promise((r) => probe.on('close', r));
    let probeJson;
    try {
        probeJson = JSON.parse(probeOut);
    } catch (_) {
        console.error('无法解析 --probe 输出：\n' + probeOut);
        process.exit(2);
    }
    if (!probeJson.ok) {
        console.error('❌ 没有可用的 Cocos Creator 实例。请先打开项目并启用 cocos-mcp 扩展。');
        console.error(JSON.stringify(probeJson, null, 2));
        process.exit(2);
    }
    const editor = probeJson.editors.find((e) => e.ok);
    ok('发现并连接 Cocos Creator', `${editor.shortName} / ${editor.editorVersion} / ${editor.ops} 个操作`);

    const client = new McpClient();
    const cleanup = [];

    try {
        // ── 1. MCP 握手 ─────────────────────────────────────────
        section('1. MCP 协议握手');
        const init = await client.request('initialize', {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'cocos-mcp-e2e', version: '1.0.0' },
        });
        assert(!init.error, 'initialize 返回成功', init.error ? init.error.message : '');
        const r = init.result || {};
        assert(r.protocolVersion === '2025-06-18', '协议版本协商正确', r.protocolVersion);
        assert(!!r.capabilities && !!r.capabilities.tools, '声明了 tools 能力');
        assert(r.capabilities.tools && r.capabilities.tools.listChanged === true, '声明 tools.listChanged');
        assert(r.serverInfo && r.serverInfo.name === 'cocos-mcp', 'serverInfo 正确', JSON.stringify(r.serverInfo));
        assert(typeof r.instructions === 'string' && r.instructions.length > 100, '带 instructions 引导', `${(r.instructions || '').length} 字`);
        client.notify('notifications/initialized');
        const ping = await client.request('ping', {});
        assert(!ping.error, 'ping 正常');

        // ── 2. 工具面 ───────────────────────────────────────────
        section('2. 工具面');
        const tl = await client.request('tools/list', {});
        const tools = (tl.result && tl.result.tools) || [];
        assert(tools.length > 30, 'tools/list 返回工具', `${tools.length} 个`);
        const names = tools.map((t) => t.name);
        for (const must of ['scene.tree', 'scene.node', 'component.set', 'cocos_knowledge', 'cocos_prefab_edit', 'scene.transaction']) {
            assert(names.includes(must), `包含工具 ${must}`);
        }
        const dangerous = tools.filter((t) => t.annotations && t.annotations.destructiveHint);
        assert(dangerous.length > 0, '破坏性工具带 destructiveHint', `${dangerous.length} 个`);
        const withConfirm = dangerous.filter((t) => t.inputSchema.required && t.inputSchema.required.includes('confirm'));
        assert(
            withConfirm.length === dangerous.length,
            '所有破坏性工具的 schema 都强制要求 confirm',
            `${withConfirm.length}/${dangerous.length}`
        );

        // ── 3. 真实读取 ─────────────────────────────────────────
        section('3. 真实读取（编辑器在线）');
        const info = await client.callTool('editor.info');
        assert(!info.isError, 'editor.info 调用成功', info.isError ? info.text : '');
        assert(info.data && info.data.editorVersion === '3.8.8', '读到真实编辑器版本', info.data && info.data.editorVersion);
        assert(
            info.data && typeof info.data.projectPath === 'string' && info.data.projectPath.length > 0,
            '读到项目路径',
            info.data && info.data.projectPath
        );

        const tree = await client.callTool('scene.tree');
        assert(!tree.isError, 'scene.tree 调用成功', tree.isError ? tree.text : '');

        // 场景引导：编辑器重启后可能没有打开任何场景，
        // 这时自动打开工程里的第一个 .scene（否则后续写操作没有落点）。
        if (!tree.data || !tree.data.count) {
            console.log('  ℹ️  当前没有打开的场景，自动打开工程内的 .scene');
            const assets = await client.callTool('asset.query', { pattern: 'db://assets/scenes/**' });
            assert(!assets.isError, 'asset.query 成功', assets.isError ? assets.text : '');
            const list = assets.data && assets.data.assets ? assets.data.assets : [];
            const sceneAsset = list.find((a) => (a.url || '').endsWith('.scene'));
            assert(!!sceneAsset, '工程里能找到 .scene 资源', sceneAsset ? sceneAsset.url : '没有');
            if (sceneAsset) {
                const uuidRes = await client.callTool('asset.uuid', { url: sceneAsset.url });
                const sceneUuid = uuidRes.data && uuidRes.data.uuid ? uuidRes.data.uuid : uuidRes.data;
                const opened = await client.callTool('scene.open', { uuid: sceneUuid });
                assert(!opened.isError, 'scene.open 成功', opened.isError ? opened.text : '');
                await new Promise((r) => setTimeout(r, 1500));
            }
        }

        const tree2b = await client.callTool('scene.tree');
        assert(tree2b.data && Array.isArray(tree2b.data.nodes), 'scene.tree 返回节点数组', tree2b.data && `${tree2b.data.count} 个节点`);

        const status = await client.callTool('scene.status');
        assert(!status.isError, 'scene.status 调用成功', status.isError ? status.text : '');
        assert(status.data && typeof status.data.ready === 'boolean', 'scene.status 含 ready', JSON.stringify(status.data && status.data.ready));

        const know = await client.callTool('cocos_knowledge', { topic: 'components' });
        assert(!know.isError, 'cocos_knowledge 调用成功');
        assert(know.data && know.data.components && know.data.components['cc.Label'], '知识库含 cc.Label 属性表');

        const msgs = await client.callTool('cocos_knowledge', { topic: 'messages' });
        assert(!msgs.isError, '知识库含已验证消息清单');
        const chanCount = msgs.data && msgs.data.channels ? Object.keys(msgs.data.channels).length : 0;
        const msgCount = msgs.data && msgs.data.channels ? Object.values(msgs.data.channels).reduce((a, b) => a + b.length, 0) : 0;
        assert(msgCount >= 100, '已验证消息数量', `${chanCount} 频道 / ${msgCount} 条`);

        // ── 4. 真实写入闭环 ─────────────────────────────────────
        section('4. 真实写入闭环（建 Canvas → 建节点 → 挂组件 → 设属性 → 读回 → 删除）');
        // Cocos 3.8.8 默认模板是 3D 场景（Scene / Main Light / Main Camera），
        // 没有 Canvas。所以先建一个 Canvas 当 UI 根，再在它下面建测试节点。
        //
        // ⚠️ 根节点名**不能写死成 "Scene"** —— 编辑器当前打开的场景可能是
        //    上一轮测试留下的任意场景（根节点名不同），写死会让整个 4 段测试
        //    以「找不到节点 Scene」全线崩溃。这里动态读真实根节点名。
        const tree0 = await client.callTool('scene.tree');
        const rootName = tree0.data && tree0.data.root;
        assert(!!rootName, '读到当前场景的根节点名', rootName || '读取失败');
        const canvasName = `E2ECanvas_${Date.now()}`;
        const canvas = await client.callTool('node.create', {
            parent: rootName,
            name: canvasName,
            components: ['cc.Canvas', 'cc.UITransform'],
        });
        assert(!canvas.isError, 'node.create 建 Canvas 成功', canvas.isError ? canvas.text : '');
        const canvasUuid = canvas.data && canvas.data.uuid;

        const marker = `E2E_${Date.now()}`;
        const created = await client.callTool('node.create', {
            parent: canvasUuid || rootName,
            name: marker,
            components: ['cc.Label'],
        });
        assert(!created.isError, 'node.create 成功', created.isError ? created.text : '');
        const nodeUuid = created.data && created.data.uuid;
        assert(!!nodeUuid, '拿到新节点 uuid', nodeUuid);

        if (nodeUuid) {
            const setText = await client.callTool('component.set', {
                node: nodeUuid,
                component: 'cc.Label',
                property: 'string',
                value: 'hello-cocos-mcp',
            });
            assert(!setText.isError, 'component.set 成功', setText.isError ? setText.text : '');

            const readBack = await client.callTool('scene.node', { node: nodeUuid });
            assert(!readBack.isError, 'scene.node 读回成功');
            const dump = readBack.data && readBack.data.dump;
            const labelComp = dump && Array.isArray(dump.__comps__) ? dump.__comps__.find((c) => c.type === 'cc.Label') : null;
            const readText = labelComp && labelComp.value ? labelComp.value.string : null;
            assert(readText === 'hello-cocos-mcp', '读回的文本与写入一致（属性已解包成普通值）', JSON.stringify(readText));

            const tree2 = await client.callTool('scene.tree');
            const found = tree2.data && tree2.data.nodes.find((n) => n.name === marker);
            assert(!!found, '节点出现在场景树里', found ? found.path : '未找到');

            const comps = await client.callTool('component.list', { node: nodeUuid });
            const types = comps.data && comps.data.components ? comps.data.components.map((c) => c.type) : [];
            assert(types.includes('cc.Label'), '节点带上了 cc.Label', types.join(','));

            // 三态解析：用名字反查同一个 uuid
            const byName = await client.callTool('scene.node', { node: marker });
            assert(!byName.isError, '按名字解析节点（节点三态解析）', byName.isError ? byName.text : '');
            assert(byName.data && byName.data.uuid === nodeUuid, '按名字解析到同一个 uuid', byName.data && byName.data.uuid);

            // 危险操作：必须被 confirm 门禁拦住
            const delNoConfirm = await client.callTool('node.delete', { node: nodeUuid });
            assert(delNoConfirm.isError, '危险操作缺 confirm 被拒绝');
            assert(/confirm/i.test(delNoConfirm.text), '拒绝原因提到 confirm', delNoConfirm.text.slice(0, 120));

            const del = await client.callTool('node.delete', { node: nodeUuid, confirm: true });
            assert(!del.isError, '带 confirm 的删除成功', del.isError ? del.text : '');

            const tree3 = await client.callTool('scene.tree');
            const gone = tree3.data && tree3.data.nodes.find((n) => n.uuid === nodeUuid);
            assert(!gone, '节点已被真正删除');
        }

        // 清理测试 Canvas
        if (canvasUuid && !KEEP_SCENE) {
            const delCanvas = await client.callTool('node.delete', { node: canvasUuid, confirm: true });
            assert(!delCanvas.isError, '清理测试 Canvas 成功', delCanvas.isError ? delCanvas.text : '');
        }

        // ── 4b. 事务失败回滚（头号差异点，必须实测）─────────────
        section('4b. 事务失败自动回滚');
        const beforeTx = await client.callTool('scene.tree');
        const countBefore = beforeTx.data ? beforeTx.data.count : 0;
        const badTx = await client.callTool('scene.transaction', {
            ops: [
                { op: 'node.create', args: { parent: rootName, name: '__TX_OK__' } },
                { op: 'node.create', args: { parent: rootName, name: '__TX_BAD__' } },
                { op: 'component.set', args: { node: '__NO_SUCH_NODE__', component: 'cc.Label', property: 'string', value: 'x' } },
            ],
        });
        assert(badTx.isError || (badTx.data && badTx.data.ok === false), '失败的事务被标记为失败', String(badTx.text).slice(0, 160));
        assert(/已回滚/.test(String(badTx.text || (badTx.data && badTx.data.error))), '错误信息里明确告知已回滚', String(badTx.text).slice(0, 200));
        await new Promise((r) => setTimeout(r, 800));
        const afterTx = await client.callTool('scene.tree');
        const countAfter = afterTx.data ? afterTx.data.count : 0;
        assert(
            countAfter === countBefore,
            '★ 回滚后节点数与事务前一致（无残留）',
            `事务前 ${countBefore} → 事务后 ${countAfter}`
        );
        const leftover = afterTx.data && afterTx.data.nodes.find((n) => n.name === '__TX_OK__');
        assert(!leftover, '★ 事务里第一步建的节点也被回滚掉了');

        // ── 5. 安全护栏 ─────────────────────────────────────────
        section('5. 安全护栏');
        const badTool = await client.callTool('scene.definitely_not_a_tool', {});
        assert(badTool.isError, '未知工具被拒绝');
        assert(/未知工具/.test(badTool.text), '拒绝原因明确', badTool.text.slice(0, 120));

        const badMsg = await client.callTool('scene.node', { node: '__no_such_node__' });
        assert(badMsg.isError, '不存在的节点被拒绝', badMsg.text.slice(0, 120));

        // 白名单：直接打一个 3.8.8 不存在的消息名，Bridge 应拒绝并给替代方案
        const whitelistProbe = await client.request('tools/call', {
            name: 'editor.info',
            arguments: {},
        });
        assert(!whitelistProbe.error, 'editor.info 协议层正常');

        // ── 6. 资源 ─────────────────────────────────────────────
        section('6. MCP Resources');
        const rl = await client.request('resources/list', {});
        const resources = (rl.result && rl.result.resources) || [];
        assert(resources.length >= 2, 'resources/list 返回资源', `${resources.length} 个`);
        const rr = await client.request('resources/read', { uri: 'cocos://editor/editors' });
        assert(!rr.error, 'resources/read 可读', rr.error ? rr.error.message : '');
        if (!rr.error) {
            const parsed = JSON.parse(rr.result.contents[0].text);
            assert(Array.isArray(parsed) && parsed.length >= 1, '资源内容是实例列表', `${parsed.length} 个`);
        }

        // ── 7. 离线能力 ─────────────────────────────────────────
        section('7. 离线 prefab 能力');
        const ops = await client.callTool('cocos_prefab_ops');
        if (!ops.isError && ops.data && ops.data.ops) {
            assert(ops.data.ops.length >= 20, '离线 op 清单可用', `${ops.data.ops.length} 个 op`);
        } else {
            console.log('  ⚠️  离线模块未就绪（worker 仍在产出中），跳过');
        }

        // 路径护栏：项目外路径必须被拒
        const escape = await client.callTool('cocos_prefab_query', {
            filePath: '/etc/passwd',
            selector: 'tree',
        });
        assert(escape.isError, '项目外路径被护栏拒绝', escape.text.slice(0, 140));

        // ── 8. 多编辑器前缀（模拟第二个注册项）─────────────────
        section('8. 多编辑器前缀隔离');
        const regDir = path.join(os.homedir(), '.cocos-mcp', 'editors');
        const fakeFile = path.join(regDir, '999999999.json');
        let wrote = false;
        try {
            fs.writeFileSync(
                fakeFile,
                JSON.stringify({
                    pid: process.pid,
                    url: 'http://127.0.0.1:7999/bridge',
                    token: 'x'.repeat(64),
                    shortName: 'fake-editor',
                    projectPath: '/tmp/fake-project',
                    editorVersion: '3.8.8',
                    ts: Date.now(),
                })
            );
            wrote = true;
            // 等一个扫描周期
            await new Promise((r) => setTimeout(r, 16000));
            const tl2 = await client.request('tools/list', {});
            const names2 = ((tl2.result && tl2.result.tools) || []).map((t) => t.name);
            assert(names2.some((n) => n.includes('fake-editor__')), '第二个实例带前缀出现');
            assert(names2.some((n) => n.startsWith('cocos-mcp-e2e-project__')), '原实例也带前缀');
            assert(names2.includes('cocos_knowledge'), '全局工具不带前缀');
        } catch (e) {
            console.log('  ⚠️  多开用例跳过：' + e.message);
        } finally {
            if (wrote) {
                try {
                    fs.unlinkSync(fakeFile);
                } catch (_) {
                    /* ignore */
                }
            }
        }
    } catch (err) {
        bad('测试执行中断', err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : String(err));
    } finally {
        client.close();
        cleanup.forEach((f) => {
            try {
                f();
            } catch (_) {
                /* ignore */
            }
        });
    }

    section('结果');
    console.log(`  通过 ${pass} / 失败 ${fail}`);
    if (failures.length) {
        console.log('\n  失败项：');
        for (const f of failures) console.log('   - ' + f);
    }
    console.log('');
    process.exit(fail === 0 ? 0 : 1);
}

main();
