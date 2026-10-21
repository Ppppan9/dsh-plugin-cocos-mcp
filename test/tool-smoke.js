#!/usr/bin/env node
'use strict';

/**
 * 全工具冒烟测试 —— 逐个调用每一个 MCP 工具，报告真实可用性
 * ---------------------------------------------------------------------------
 * 为什么要单独做这个？
 * 现存开源实现最大的问题就是「工具注册成功，但一调用就报错」
 * （harady 有 10 个消息名在 3.8.8 不存在，README 还列了不存在的工具名）。
 * 声明 ≠ 能用。只有把每个工具真跑一遍，才知道工具面是真是假。
 *
 * 用法：node test/tool-smoke.js [--json] [--with-build]
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const HUB = path.join(__dirname, '..', 'hub', 'bin.js');
const AS_JSON = process.argv.includes('--json');
const WITH_BUILD = process.argv.includes('--with-build');

const results = [];
let client = null;
let sceneUrl = null;
let tempNodeUuid = null;
let tempCanvasUuid = null;
let tempAssetUrl = null;

class McpClient {
    constructor() {
        this.proc = spawn(process.execPath, [HUB], { stdio: ['pipe', 'pipe', 'pipe'] });
        this.buf = '';
        this.pending = new Map();
        this.nextId = 1;
        this.proc.stdout.setEncoding('utf8');
        this.proc.stdout.on('data', (d) => {
            this.buf += d;
            let i;
            while ((i = this.buf.indexOf('\n')) >= 0) {
                const line = this.buf.slice(0, i).trim();
                this.buf = this.buf.slice(i + 1);
                if (!line) continue;
                let m;
                try { m = JSON.parse(line); } catch (_) { continue; }
                if (m.id !== undefined && this.pending.has(m.id)) {
                    const { resolve } = this.pending.get(m.id);
                    this.pending.delete(m.id);
                    resolve(m);
                }
            }
        });
        this.proc.stderr.resume();
    }
    request(method, params) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 超时`)); }, 300000);
            this.pending.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); } });
            this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
        });
    }
    notify(method, params) {
        this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }) + '\n');
    }
    async call(name, args) {
        const res = await this.request('tools/call', { name, arguments: args || {} });
        if (res.error) return { isError: true, text: res.error.message };
        const text = (res.result.content || []).map((c) => c.text).join('\n');
        let data;
        try { data = JSON.parse(text); } catch (_) { data = text; }
        return { isError: !!res.result.isError, data, text };
    }
    close() { try { this.proc.kill(); } catch (_) {} }
}

function log(...a) { if (!AS_JSON) console.log(...a); }

/**
 * @param {object} opts
 *   expectError: true  → 期望被拒绝（护栏/校验类用例），拒绝才算通过
 */
async function check(name, args, opts = {}) {
    const t0 = Date.now();
    let r;
    try {
        r = await client.call(name, args);
    } catch (e) {
        results.push({ name, status: 'error', ms: Date.now() - t0, detail: e.message });
        log(`  ❌ ${name.padEnd(22)} ${e.message}`);
        return r;
    }
    const ms = Date.now() - t0;
    const rejected = !!r.isError;
    const pass = opts.expectError ? rejected : !rejected;
    const detail = rejected ? firstLine(r.text) : summarize(r.data);
    results.push({ name, status: pass ? 'ok' : 'fail', ms, detail, expectError: !!opts.expectError, rejected });
    const mark = pass ? (rejected ? '🚫' : '✅') : '❌';
    log(`  ${mark} ${name.padEnd(22)} ${String(ms).padStart(6)}ms  ${detail}`);
    return r;
}

function firstLine(t) {
    const s = String(t || '').split('\n').filter(Boolean);
    return s.length > 1 ? s[0] + ' | ' + s[1] : s[0] || '';
}
function summarize(d) {
    if (d === null || d === undefined) return 'null';
    if (typeof d !== 'object') return String(d).slice(0, 90);
    if (Array.isArray(d)) return `array(${d.length})`;
    const keys = Object.keys(d);
    // ⚠️ 只打印键名的话，失败时看不出「到底发生了什么」——
    //    比如「根节点不可删」的守卫失守，光看 {deleted,name} 完全无从判断删的是谁。
    const parts = keys.slice(0, 6).map((k) => {
        const v = d[k];
        const s = v && typeof v === 'object' ? (Array.isArray(v) ? `array(${v.length})` : '{…}') : String(v);
        return `${k}=${s.slice(0, 48)}`;
    });
    return '{' + parts.join(', ') + (keys.length > 6 ? ',…' : '') + '}';
}

async function main() {
    console.log('Cocos MCP 全工具冒烟测试\n' + '='.repeat(74));

    client = new McpClient();
    await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
    client.notify('notifications/initialized');

    // ── 0. 工具面自检（静态）──────────────────────────────
    console.log('\n▸ 0. 工具面静态自检');
    const declared = (await client.request('tools/list', {})).result.tools;
    const staticIssues = [];
    const seen = new Set();
    for (const t of declared) {
        if (seen.has(t.name)) staticIssues.push(`工具名重复：${t.name}`);
        seen.add(t.name);
        if (!t.description || t.description.length < 10) staticIssues.push(`${t.name} 描述过短`);
        if (!t.inputSchema || t.inputSchema.type !== 'object') staticIssues.push(`${t.name} 缺 inputSchema`);
        if (t.annotations && t.annotations.destructiveHint) {
            const req = (t.inputSchema && t.inputSchema.required) || [];
            if (!req.includes('confirm')) staticIssues.push(`${t.name} 是破坏性操作但 confirm 不在 required`);
        }
    }
    results.push({
        name: '(静态) 工具面自检',
        status: staticIssues.length ? 'fail' : 'ok',
        ms: 0,
        detail: staticIssues.length ? staticIssues.join('; ') : `${declared.length} 个工具，描述/schema/安全标记齐备`,
    });
    log(`  ${staticIssues.length ? '❌' : '✅'} 工具面自检 — ${staticIssues.length ? staticIssues.join('; ') : declared.length + ' 个工具全部合规'}`);

    // ── 1. 准备环境 ──
    console.log('\n▸ 1. 准备环境');

    // ⚠️ 先清掉**上一轮残留**的测试场景。
    //    上一轮如果中途失败，场景会留在 assets 里；下一轮 asset.query 随机挑中它，
    //    于是「当前打开的场景」和「测试用的场景」对不上 ——
    //    实测会连带把「根节点不可删」的守卫测歪（拿旧场景的根名去测新场景）。
    //    残留场景还是引擎「上一个场景」记账的来源，也可能触发
    //    "Open the previous scene failed: xxx can not be found"。
    const stale = await client.call('asset.query', { pattern: 'db://assets/scenes/__*.scene' });
    const staleList = (stale.data && stale.data.assets) || [];
    for (const a of staleList) {
        if (a.url) await client.call('asset.delete', { url: a.url, confirm: true });
    }
    if (staleList.length) {
        log(`  ℹ️  清理上一轮残留场景 ${staleList.length} 个`);
        await new Promise((r) => setTimeout(r, 800));
    }

    let tree = await client.call('scene.tree');
    const assets0 = await client.call('asset.query', { pattern: 'db://assets/scenes/**' });
    const sceneList = (assets0.data && assets0.data.assets) || [];
    const sceneAsset = sceneList.find((a) => (a.url || '').endsWith('.scene'));
    sceneUrl = sceneAsset ? sceneAsset.url : null;

    if (!tree.data || !tree.data.count) {
        if (sceneAsset) {
            const u = await client.call('asset.uuid', { url: sceneAsset.url });
            await client.call('scene.open', { uuid: u.data && u.data.uuid ? u.data.uuid : u.data });
            await new Promise((r) => setTimeout(r, 1800));
            tree = await client.call('scene.tree');
        }
    }
    log(`  ℹ️  场景：${sceneUrl || '(无)'}，节点数 ${tree.data && tree.data.count}`);

    // ⚠️ 根节点名必须**动态解析**。
    //    写死 'Scene' 的话，编辑器当前打开的如果是别的场景（比如上一轮测试留下的
    //    __ab_真实_xxx），后面所有 node.create 都会以「找不到节点 Scene」失败，
    //    整份冒烟报告全是噪音。
    const rootName = (tree.data && tree.data.root) || 'Scene';
    if (rootName === 'Scene' && !(tree.data && tree.data.root)) {
        log('  ⚠️  读不到场景根节点名，回退到 "Scene"（可能解析失败）');
    }

    // 临时对象（挂在场景根下，不依赖 Canvas 是否建成）
    const canvas = await client.call('node.create', { parent: rootName, name: '__SMOKE_CANVAS__', components: ['cc.Canvas', 'cc.UITransform'] });
    if (!canvas.isError && canvas.data && canvas.data.uuid) tempCanvasUuid = canvas.data.uuid;
    const n = await client.call('node.create', { parent: rootName, name: '__SMOKE_NODE__', components: ['cc.UITransform', 'cc.Label'] });
    if (!n.isError && n.data && n.data.uuid) tempNodeUuid = n.data.uuid;
    log(`  ℹ️  临时节点 ${tempNodeUuid || '(建失败)'} / 临时 Canvas ${tempCanvasUuid || '(建失败)'}`);

    // ── 2. 全局工具 ──
    console.log('\n▸ 2. 全局工具');
    await check('cocos_knowledge', { topic: 'components' });
    await check('cocos_knowledge', { topic: 'coordinates' });
    await check('cocos_knowledge', { topic: 'messages' });
    await check('cocos_knowledge', { topic: 'traps' });
    await check('cocos_prefab_ops', {});
    await check('cocos_anim_ops', {});
    // 路径护栏：越界必须被拒
    await check('cocos_prefab_query', { filePath: '/etc/passwd', selector: 'tree' }, { expectError: true });
    await check('cocos_prefab_edit', { filePath: '/tmp/x.prefab', ops: [{ op: 'set-active', node: 'a', active: false }] }, { expectError: true });
    await check('cocos_prefab_batch', { opsJsonPath: '/tmp/no-such-ops.json' }, { expectError: true });
    await check('cocos_anim_query', { filePath: '/tmp/no-such.anim', selector: 'tree' }, { expectError: true });
    await check('cocos_anim_batch', { filePath: '/tmp/no-such.anim', ops: [] }, { expectError: true });
    // 项目内的真实文件：读得到、改得动
    const realPrefab = await client.call('asset.query', { pattern: 'db://assets/**/*.prefab' });
    const plist = (realPrefab.data && realPrefab.data.assets) || [];
    if (plist.length) {
        await check('cocos_prefab_query', { filePath: plist[0].path || plist[0].url, selector: 'tree' });
    } else {
        log('  ℹ️  工程内没有 .prefab，跳过离线 prefab 正例');
    }

    // ── 3. 场景 / 节点 / 组件 ──
    console.log('\n▸ 3. 场景 / 节点 / 组件');
    await check('scene.tree', {});
    await check('scene.status', {});
    await check('scene.bounds', {});
    await check('scene.find', { name: 'Main' });
    await check('scene.classes', { extends: 'cc.Component' });
    await check('scene.components', {});
    await check('scene.node', { node: rootName });
    await check('scene.snapshot', {});
    await check('scene.snapshot.abort', {});
    await check('node.create', { parent: rootName, name: '__SMOKE_TMP__' });
    await check('node.active', { node: tempNodeUuid || rootName, active: false });
    await check('node.transform', { node: tempNodeUuid || rootName, position: { x: 1, y: 2 } });
    await check('node.duplicate', { node: tempNodeUuid || rootName });
    await check('node.move', { node: tempNodeUuid || rootName, parent: rootName });
    await check('node.clipboard', { action: 'copy', node: tempNodeUuid || rootName });
    await check('component.list', { node: tempNodeUuid || rootName });
    await check('component.set', { node: tempNodeUuid || rootName, component: 'cc.Label', property: 'string', value: 'smoke' });
    await check('component.add', { node: tempNodeUuid || rootName, component: 'cc.Button' });
    await check('component.remove', { node: tempNodeUuid || rootName, component: 'cc.Button', confirm: true });
    await check('component.call', { node: tempNodeUuid || rootName, method: 'hasFlag' });
    await check('scene.transaction', {
        ops: [
            { op: 'node.create', args: { parent: rootName, name: '__SMOKE_TX__' } },
            { op: 'node.create', args: { parent: rootName, name: '__SMOKE_TX2__' } },
        ],
    });

    // ── 4. 资源 ──
    console.log('\n▸ 4. 资源');
    await check('asset.query', { pattern: 'db://assets/**' });
    await check('asset.query', { pattern: 'db://assets/**/*.prefab' });
    if (sceneUrl) {
        await check('asset.info', { url: sceneUrl });
        await check('asset.uuid', { url: sceneUrl });
        const uuidRes = await client.call('asset.uuid', { url: sceneUrl });
        await check('asset.url', { uuid: uuidRes.data && uuidRes.data.uuid ? uuidRes.data.uuid : uuidRes.data });
        await check('asset.dependencies', { url: sceneUrl });
    await check('asset.path', { url: sceneUrl });
    await check('asset.users', { url: sceneUrl });
        // 导入完成判定：url 形式与 uuid 形式都要能查
        await check('asset.isImported', { url: sceneUrl });
        await check('asset.isImported', {
            uuid: uuidRes.data && uuidRes.data.uuid ? uuidRes.data.uuid : uuidRes.data,
        });
    } else {
        log('  ⚠️  工程里没有 .scene 资源，跳过 asset.info/uuid/url/dependencies');
        await check('asset.info', { url: 'db://assets/__no_such__.scene' }, { expectError: true });
    }

    const tmpAsset = 'db://assets/__smoke_tmp.json';
    const created = await check('asset.create', { url: tmpAsset, content: '{"smoke":true}' });
    if (!created.isError) {
        tempAssetUrl = tmpAsset;
        await check('asset.save', { url: tmpAsset, content: '{"smoke":2}' });
        await check('asset.reimport', { url: tmpAsset });
        await check('asset.refresh', { url: tmpAsset });
        await check('asset.copy', { from: tmpAsset, to: 'db://assets/__smoke_tmp_copy.json' });
        await check('asset.delete', { url: 'db://assets/__smoke_tmp_copy.json', confirm: true });
        await check('asset.move', { from: tmpAsset, to: 'db://assets/__smoke_tmp2.json' });
        await check('asset.delete', { url: 'db://assets/__smoke_tmp2.json', confirm: true });
    }

    // ── 5. 视图 / 预览 / 构建 / 参考图 ──
    console.log('\n▸ 5. 视图 / 预览 / 构建 / 参考图');
    await check('view.options', {});
    await check('view.focus', { nodes: [rootName] });
    await check('view.align', { mode: 'view-with-node' });
    await check('preview.url', {});
    await check('build.status', { type: 'build' });
    await check('build.platforms', {});
    await check('reference.current', {});
    await check('reference.config', {});
    const refPath = path.join(os.tmpdir(), '__smoke_ref.png');
    fs.writeFileSync(refPath, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex'));
    await check('reference.add', { paths: [refPath] });
    await check('reference.set', { key: 'opacity', value: 0.5 });
    await check('reference.remove', { paths: [refPath] });
    await check('reference.add', { paths: ['/tmp/definitely-not-there.png'] }, { expectError: true }); // 文件不存在要被拦
    if (WITH_BUILD) {
        await check('build.start', { platform: 'web-desktop', shouldWait: false });
    } else {
        log('  ℹ️  build.start 会真的发起构建，用 --with-build 才跑');
    }

    // ── 6. 编辑器 ──
    console.log('\n▸ 6. 编辑器');
    await check('editor.info', {});
    await check('scene.script', { method: 'getSceneSummary', args: [], confirm: true });
    await check('scene.script', { method: '不在白名单里的方法', args: [], confirm: true }, { expectError: true });
    await check('cocos_message', { channel: 'scene', message: 'query-is-ready', args: [], confirm: true });
    await check('cocos_message', { channel: 'scene', message: '不存在的消息', args: [], confirm: true }, { expectError: true });
    await check('editor.logs', { limit: 5 });
    await check('editor.logs', { level: ['error'], limit: 5 });
    await check('editor.console.clear', {});
    // 实测存在的偏好分类：preview / inspector / engine（general 不存在）
    await check('preferences.get', { name: 'preview' });
    await check('preferences.get', { name: '__不存在的分类__' }, { expectError: true });
    // 用不存在的分类 → 应该报错（set-config 对未知分类返回 false → 明确报错）
    await check('preferences.set', { name: '__不存在的分类__', key: 'k', value: 1 }, { expectError: true });
    // 真实存在分类的正常写入
    await check('preferences.set', { name: 'preview', key: '__smoke_probe__', value: 1 });
    await check('project.config', { key: 'engine' });
    await check('project.config', { key: '__不存在的键__' }, { expectError: true });

    // ── 7. 清理临时节点（必须在切换场景**之前**做）──
    //    临时节点建在第 1 段的场景里；第 8 段会打开另一个场景，
    //    到那时这些 uuid 已经不属于当前场景，删它们只会得到「静默成功但什么都没删」。
    console.log('\n▸ 7. 清理临时节点');
    if (tempNodeUuid) await client.call('node.delete', { node: tempNodeUuid, confirm: true });
    if (tempCanvasUuid) await client.call('node.delete', { node: tempCanvasUuid, confirm: true });

    // ── 8. 场景生命周期（会改当前场景，放最后）──
    console.log('\n▸ 8. 场景生命周期');
    // ⚠️ 场景名必须**每次唯一** ——
    //    用固定名字会覆盖上一轮残留的同名场景，而覆盖后的资源导入状态是陈旧的，
    //    紧接着 scene.open 就会挂起（实测 120s 超时）。
    const sceneName = '__smoke_scene_' + Date.now().toString(36);
    await check('scene.create', { name: sceneName, path: 'db://assets/scenes' });
    const createdScene = await client.call('asset.query', { pattern: `db://assets/scenes/${sceneName}.scene` });
    const cs = (createdScene.data && createdScene.data.assets) || [];
    if (cs.length) {
        const u = await client.call('asset.uuid', { url: cs[0].url });
        await check('scene.open', { uuid: u.data && u.data.uuid ? u.data.uuid : u.data });
        await new Promise((r) => setTimeout(r, 1800));
        await check('scene.save', {});
        await check('scene.reload', { confirm: true });
        await check('asset.delete', { url: cs[0].url, confirm: true });
    } else {
        log('  ⚠️  scene.create 后没查到资源');
    }

    // ── 9. 收尾 ──
    console.log('\n▸ 9. 收尾');
    // ⚠️ 根节点守卫要用**当前**场景的根节点名 ——
    //    第 1 段捕获的 rootName 属于旧场景，切换场景后它已经不是根了，
    //    拿它去测「根节点不可删」会误判（实测会真的删掉一个节点，守卫形同虚设）。
    const treeNow = await client.call('scene.tree');
    const rootNow = treeNow.data && treeNow.data.root;
    if (rootNow) {
        await check('node.delete', { node: rootNow, confirm: true }, { expectError: true }); // 根节点不可删
    } else {
        log('  ⚠️  读不到当前场景根节点，跳过根节点守卫检查');
    }
    // 清理本轮建出来的场景资源
    if (sceneName) {
        const sc2 = await client.call('asset.query', { pattern: `db://assets/scenes/${sceneName}.scene` });
        for (const a of (sc2.data && sc2.data.assets) || []) {
            await client.call('asset.delete', { url: a.url, confirm: true });
        }
    }
    await check('scene.close', { confirm: true });   // 关闭场景放最后

    // ── 汇总 ──
    const failed = results.filter((r) => r.status !== 'ok');
    const byTool = new Map();
    for (const r of results) {
        if (!byTool.has(r.name)) byTool.set(r.name, []);
        byTool.get(r.name).push(r);
    }

    console.log('\n' + '='.repeat(74));
    console.log(`总调用 ${results.length} 次，覆盖 ${byTool.size} 个工具`);
    console.log(`通过 ${results.length - failed.length} / 失败 ${failed.length}`);

    if (failed.length) {
        console.log('\n失败明细：');
        for (const f of failed) console.log(`  ❌ ${f.name}  ${f.detail}`);
    }

    const notCovered = declared.map((t) => t.name).filter((n) => !byTool.has(n));
    if (notCovered.length) {
        console.log(`\n未覆盖的工具（${notCovered.length}）：${notCovered.join(', ')}`);
    }

    // 慢工具提示
    const slow = results.filter((r) => r.ms > 2000).sort((a, b) => b.ms - a.ms);
    if (slow.length) {
        console.log('\n慢调用（>2s）：');
        for (const s of slow) console.log(`  ⏱ ${s.name.padEnd(22)} ${s.ms}ms`);
    }

    if (AS_JSON) process.stdout.write(JSON.stringify({ results, notCovered }, null, 2) + '\n');
    client.close();
    process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
    console.error('冒烟测试中断：', e);
    if (client) client.close();
    process.exit(2);
});
