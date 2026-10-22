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
        const res = await this.request('tools/call', { name: this.resolveToolName(name), arguments: args || {} });
        if (res.error) return { isError: true, text: res.error.message };
        const text = (res.result.content || []).map((c) => c.text).join('\n');
        let data;
        try { data = JSON.parse(text); } catch (_) { data = text; }
        return { isError: !!res.result.isError, data, text };
    }

    /**
     * 解析真实的工具名。
     *
     * ⚠️ hub 在**多编辑器**模式下会给所有编辑器工具加 `<短名>__` 前缀。
     *    而这些真机脚本写死的是无前缀名 —— 一旦同时有第二个编辑器实例
     *    （e2e 测试自己就会注册一个 fake-editor 并保持十几秒），
     *    所有调用都会变成「未知工具 xxx」，报告全篇失真。
     */
    async loadTools() {
        const res = await this.request('tools/list', {});
        const list = (res.result && res.result.tools) || [];
        this.toolNames = new Set(list.map((t) => t.name));
        this.prefixed = new Map();
        for (const n of this.toolNames) {
            const i = n.indexOf('__');
            if (i > 0) {
                const base = n.slice(i + 2);
                if (!this.prefixed.has(base)) this.prefixed.set(base, []);
                this.prefixed.get(base).push(n);
            }
        }
        return this.toolNames;
    }
    resolveToolName(name) {
        if (!this.toolNames) return name;
        if (this.toolNames.has(name)) return name;
        const cand = this.prefixed.get(name);
        if (cand && cand.length === 1) return cand[0];
        if (cand && cand.length > 1) {
            throw new Error(
                `工具 "${name}" 在当前有多个编辑器实例，必须先指定一个：` +
                `设置环境变量 COCOS_MCP_EDITOR_FILTER=<短名> 后重跑。候选：${cand.join('、')}`
            );
        }
        return name;
    }
    close() { try { this.proc.kill(); } catch (_) {} }
}

function log(...a) { if (!AS_JSON) console.log(...a); }

/**
 * 「引擎侧 scene 频道中毒」的判定特征。
 *
 * ⚠️ 只认这两个**精确**特征，别放宽 ——
 *    放宽了会把真正的 bug（比如某个工具返回了奇怪的错误）也当成引擎缺陷吞掉，
 *    冒烟测试就失去了它唯一的作用：**发现真回归**。
 *
 * 背景见调研报告 6.8 / 6.11 / 6.14：一次 scene:open-scene 挂死之后，
 * 整个 scene 频道就不再回应，此后所有场景操作都会以同样的信息失败。
 * 这是 **Cocos 引擎自身的缺陷**，不是本项目的 bug。
 */
const POISON_PATTERNS = [/场景频道\*\*暂时无响应\*\*/, /场景频道已经卡死/];

function isPoisonError(text) {
    const s = String(text || '');
    return POISON_PATTERNS.some((re) => re.test(s));
}

/**
 * 记录一条断言（不走 check()，因为它检查的是**已有响应**而不是再调一次工具）。
 * @param {boolean} cond 断言是否成立
 */
function assert(cond, name, detail) {
    results.push({ name, status: cond ? 'ok' : 'fail', ms: 0, detail: detail || '' });
    log(`  ${cond ? '✅' : '❌'} ${name}${detail ? '  ' + String(detail).slice(0, 110) : ''}`);
    return cond;
}

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
    // ⚠️ 引擎缺陷与真 bug 必须分开记 ——
    //    引擎侧 scene 频道中毒会让后续几十个场景检查以**同一条信息**失败。
    //    把它们算作「失败」，等于把「一个根因」变成「几十个症状」——
    //    既看不清问题，也会让冒烟测试的红绿失去意义（真正的回归会被淹没）。
    //    这里只认精确特征，所以真正的回归仍然是失败。
    if (rejected && isPoisonError(r.text)) {
        results.push({
            name,
            status: 'skip',
            ms,
            detail: firstLine(r.text),
            reason: '引擎缺陷：scene 频道中毒（调研报告 6.14）',
        });
        log(`  ⏭ ${name.padEnd(22)} ${String(ms).padStart(6)}ms  跳过：引擎缺陷 · scene 频道中毒`);
        return r;
    }
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
    // ⚠️ 先取真实工具清单 —— 多编辑器时 hub 会给工具名加 <短名>__ 前缀，
    //    写死的无前缀名会全部变成「未知工具」。
    await client.loadTools();
    if (client.prefixed.size && !client.toolNames.has('scene.tree')) {
        console.error(
            `检测到多个编辑器实例（${client.prefixed.size} 个带前缀的工具族），` +
            '请用环境变量 COCOS_MCP_EDITOR_FILTER=<短名> 指定一个后重跑。'
        );
        process.exit(2);
    }

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
    let staleDeleted = 0;
    for (const a of staleList) {
        if (!a.url) continue;
        const d = await client.call('asset.delete', { url: a.url, confirm: true });
        if (!d.isError) staleDeleted += 1;
        // 删不掉是有原因的（最常见：它正是当前打开的场景 ——
        // Bridge 会挡住，那是对的，删了会让编辑器中毒）
    }
    if (staleList.length) {
        log(`  ℹ️  清理上一轮残留场景 ${staleDeleted}/${staleList.length} 个` +
            (staleDeleted < staleList.length ? '（删不掉的通常是当前打开的场景，Bridge 会挡住）' : ''));
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
    let rootName = (tree.data && tree.data.root) || 'Scene';
    if (rootName === 'Scene' && !(tree.data && tree.data.root)) {
        log('  ⚠️  读不到场景根节点名，回退到 "Scene"（可能解析失败）');
    }

    // ── 2. 场景生命周期 ──
    // ⚠️ **必须排在节点操作之前** ——
    //    实测（干净编辑器、可重复）：先做一组节点操作
    //    （建节点 / 改激活 / 改 transform / 复制 / 移动 / 剪贴板复制），
    //    **下一次打开场景必挂死**（90s 超时 → 整个 scene 频道中毒）。
    //    对照组（只建一个节点 / 场景变脏 / 先保存 / 删掉上一个场景）全部正常。
    //    引擎侧没有任何报错，消息既不 resolve 也不 reject —— 属于 Cocos 自身的问题。
    //    所以本项目只能：把「打开场景」放在最前面（趁引擎还干净），
    //    并靠超时 + 健康闸门兜住剩下的极端情况。
    console.log('\n▸ 2. 场景生命周期');
    // ⚠️ 场景名必须**每次唯一** ——
    //    用固定名字会覆盖上一轮残留的同名场景，而覆盖后的资源导入状态是陈旧的，
    //    紧接着 scene.open 就会挂起（实测 120s 超时）。
    const sceneName = '__smoke_scene_' + Date.now().toString(36);
    await check('scene.create', { name: sceneName, path: 'db://assets/scenes' });
    const createdScene = await client.call('asset.query', { pattern: `db://assets/scenes/${sceneName}.scene` });
    const cs = (createdScene.data && createdScene.data.assets) || [];
    if (cs.length) {
        const u = await client.call('asset.uuid', { url: cs[0].url });
        const openRes = await check('scene.open', { uuid: u.data && u.data.uuid ? u.data.uuid : u.data });
        if (openRes && openRes.isError) {
            // ⚠️ 打开失败通常意味着**引擎侧的 scene 频道已经中毒** ——
            //    后面所有场景操作都会挂。继续跑只会刷出一堆同源失败，
            //    把「一个根因」变成「四个症状」，反而看不清问题。
            //    这里明确停掉本段，并说明后续检查为什么没跑。
            log('  ⚠️  scene.open 失败 → 引擎侧场景频道很可能已中毒，跳过本段剩余的场景检查');
            log('     （save / reload / close / 根节点守卫都依赖同一个频道，跑也是超时）');
        } else {
            await new Promise((r) => setTimeout(r, 1800));
            await check('scene.save', {});
            await check('scene.reload', { confirm: true });
            // ★ 真机验证新守卫：当前打开的场景**不能删** ——
            //   删了会让编辑器留下指向已删除资源的引用，之后打开任何场景都会挂死。
            await check('asset.delete', { url: cs[0].url, confirm: true }, { expectError: true });
            // ⚠️ 实测 3.8.8 在 general edit mode 下**关不掉**普通场景
            //    （引擎返回 false 并打 “Trying to close current edit scene ...”），
            //    所以关不掉 → 新建的场景**一直是「当前场景」** → 删不掉它。
            //    正确做法：**先打开另一个场景**，它就不再是当前场景了。
            const closeRes = await client.call('scene.close', { confirm: true });
            assert(
                closeRes.isError ? /引擎拒绝关闭/.test(String(closeRes.text)) : true,
                'scene.close 不报假成功（引擎拒绝关闭时要明确说出来）',
                closeRes.isError ? String(closeRes.text).slice(0, 100) : '已关闭'
            );
            // ⚠️ 「切回原场景」这一步**故意放到最后**（收尾段）——
            //    实测引擎在「已经有场景打开着」时再开另一个，会走「恢复上一个场景」
            //    的路径并卡死（调研报告 6.11 / 6.14：既不 resolve 也不 reject），
            //    一挂就是 90 秒，然后把整个 scene 频道拖死。
            //    放中间的话，后面几十个场景检查会全部同源失败，
            //    冒烟测试就从一个根因变成几十个症状 —— 真正的回归会被淹没。
        }
    } else {
        log('  ⚠️  scene.create 后没查到资源');
    }

    // ⚠️ 场景生命周期那一步可能已经切换了场景 —— 根节点名要**重新解析**，
    //    否则临时节点会建到旧场景里去（或者直接「找不到节点」）。
    {
        const t2 = await client.call('scene.tree');
        if (t2.data && t2.data.root) rootName = t2.data.root;
        log(`  ℹ️  当前场景根节点：${rootName}`);
    }

    // 临时对象（挂在场景根下，不依赖 Canvas 是否建成）
    const canvas = await client.call('node.create', { parent: rootName, name: '__SMOKE_CANVAS__', components: ['cc.Canvas', 'cc.UITransform'] });
    if (!canvas.isError && canvas.data && canvas.data.uuid) tempCanvasUuid = canvas.data.uuid;
    const n = await client.call('node.create', { parent: rootName, name: '__SMOKE_NODE__', components: ['cc.UITransform', 'cc.Label'] });
    if (!n.isError && n.data && n.data.uuid) tempNodeUuid = n.data.uuid;
    log(`  ℹ️  临时节点 ${tempNodeUuid || '(建失败)'} / 临时 Canvas ${tempCanvasUuid || '(建失败)'}`);

    // ── 3. 全局工具 ──
    console.log('\n▸ 3. 全局工具');
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
        // ⚠️ asset.query 返回的 `path` 是 **db:// URL**，不是文件系统路径 ——
        //    直接拿它当 filePath 会被拼成 "<项目>/db:/assets/xxx" 然后被护栏拒掉。
        //    真实路径要用 asset.path 工具查。
        const pRes = await client.call('asset.path', { url: plist[0].url });
        const fsPath = typeof pRes.data === 'string' ? pRes.data : null;
        if (!fsPath) {
            log('  ℹ️  拿不到 prefab 的文件系统路径，跳过离线 prefab 正例');
        } else {
            await check('cocos_prefab_query', { filePath: fsPath, selector: 'tree' });
        }
    } else {
        log('  ℹ️  工程内没有 .prefab，跳过离线 prefab 正例');
    }

    // ── 3. 场景 / 节点 / 组件 ──
    console.log('\n▸ 4. 场景 / 节点 / 组件');
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

    // ── 5. 资源 ──
    console.log('\n▸ 5. 资源');
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

    // ── 6. 视图 / 预览 / 构建 / 参考图 ──
    console.log('\n▸ 6. 视图 / 预览 / 构建 / 参考图');
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

    // ── 7. 编辑器 ──
    console.log('\n▸ 7. 编辑器');
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

    // ── 8. 清理临时节点 ──
    //    临时节点建在第 1 段的场景里；第 8 段会打开另一个场景，
    //    到那时这些 uuid 已经不属于当前场景，删它们只会得到「静默成功但什么都没删」。
    console.log('\n▸ 8. 清理临时节点');
    if (tempNodeUuid) await client.call('node.delete', { node: tempNodeUuid, confirm: true });
    if (tempCanvasUuid) await client.call('node.delete', { node: tempCanvasUuid, confirm: true });


    // ── 9. 收尾 ──
    console.log('\n▸ 9. 收尾');
    // ⚠️ 「切回原场景」放在**所有检查之后** ——
    //    实测引擎在「已经有场景打开着」时再开另一个场景，会卡死 90 秒
    //    并把整个 scene 频道拖死（调研报告 6.11 / 6.14）。
    //    这是引擎缺陷，本项目绕不开；但放在最后，
    //    它最多影响收尾，不会让前面几十个场景检查变成同源失败。
    if (sceneUrl) {
        log('  ℹ️  切回原场景（引擎缺陷高发点，可能耗时 90 秒并拖死 scene 频道）');
        const back = await client.call('asset.uuid', { url: sceneUrl });
        await check('scene.open', { uuid: back.data && back.data.uuid ? back.data.uuid : back.data });
        await new Promise((r) => setTimeout(r, 1200));
    }
    // 切回之后，本轮建出来的场景不再是「当前场景」，这时才删得掉
    if (cs.length) {
        await check('asset.delete', { url: cs[0].url, confirm: true });
    }

    // ⚠️ 根节点守卫要用**当前**场景的根节点名 ——
    //    第 1 段捕获的 rootName 属于旧场景，切换场景后它已经不是根了，
    //    拿它去测「根节点不可删」会误判（实测会真的删掉一个节点，守卫形同虚设）。
    const treeNow = await client.call('scene.tree');
    const rootNow = treeNow.data && treeNow.data.root;
    if (treeNow.isError) {
        // 场景频道已中毒 → 后面所有场景操作都必然超时，不该再刷一堆同源失败
        log('  ⚠️  场景频道已不可用，跳过根节点守卫与 scene.close 检查');
    } else {
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
        // 关闭场景放最后（引擎可能拒绝 → 明确报错，不报假成功）
        const closeRes2 = await client.call('scene.close', { confirm: true });
        assert(
            closeRes2.isError ? /引擎拒绝关闭/.test(String(closeRes2.text)) : true,
            'scene.close 不报假成功（引擎拒绝关闭时要明确说出来）',
            closeRes2.isError ? String(closeRes2.text).slice(0, 100) : '已关闭'
        );
    }

    // ── 汇总 ──
    const skipped = results.filter((r) => r.status === 'skip');
    const failed = results.filter((r) => r.status !== 'ok' && r.status !== 'skip');
    const byTool = new Map();
    for (const r of results) {
        if (!byTool.has(r.name)) byTool.set(r.name, []);
        byTool.get(r.name).push(r);
    }

    console.log('\n' + '='.repeat(74));
    console.log(`总调用 ${results.length} 次，覆盖 ${byTool.size} 个工具`);
    console.log(`通过 ${results.length - failed.length - skipped.length} / 失败 ${failed.length} / 跳过 ${skipped.length}`);
    if (skipped.length) {
        // ⚠️ 跳过项必须**显式说明**，不能悄悄消失 ——
        //    「本轮没测到」和「测了没问题」是两回事，混在一起就是自欺欺人。
        console.log('\n跳过明细（引擎缺陷，不是本项目的 bug —— 但本轮这些场景检查没覆盖到）：');
        const byReason = new Map();
        for (const s of skipped) {
            if (!byReason.has(s.reason)) byReason.set(s.reason, []);
            byReason.get(s.reason).push(s.name);
        }
        for (const [reason, names] of byReason) {
            console.log(`  ⏭ ${reason}：${names.length} 项 —— ${names.join(', ')}`);
        }
        console.log('  ⇒ 要拿到完整的场景覆盖，需要重启 Cocos Creator 后重跑（编辑器是单实例）。');
    }

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
