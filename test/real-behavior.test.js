#!/usr/bin/env node
'use strict';

/**
 * 真机行为验证 —— 把「存疑，需真机验证」的条目逐条跑清楚
 * ---------------------------------------------------------------------------
 * 前两轮审查留下了一批「代码看不出对错、必须真机才能定论」的条目。
 * 这一层专门把它们变成可重复执行的验证。
 *
 * 前提：Cocos Creator 开着、装了扩展、且有已打开的场景。
 * 运行：node test/real-behavior.test.js
 */

const { spawn } = require('child_process');
const { requireSceneChannel } = require('./editor-health');
const path = require('path');
const fs = require('fs');
const os = require('os');

const HUB = path.join(__dirname, '..', 'hub', 'bin.js');

let pass = 0;
let fail = 0;
const failures = [];
const notes = [];

function ok(name, detail) {
    pass++;
    console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`);
}
function bad(name, detail) {
    fail++;
    failures.push(`${name}: ${detail}`);
    console.log(`  ❌ ${name} — ${detail}`);
}
function note(text) {
    notes.push(String(text));
    console.log(`  ℹ️  ${text}`);
}
/**
 * 安全地 JSON 化一个可能为 undefined 的值。
 * ⚠️ JSON.stringify(undefined) 返回 undefined（不是字符串），
 *    再调 .slice(0,120) 会抛 TypeError —— 而这会被外层 catch 吞成
 *    「执行中断」，导致**后半程的整段测试都没跑**，报告数字严重低估失败面。
 */
function safeJson(v, max = 120) {
    try {
        const s = JSON.stringify(v === undefined ? null : v);
        return String(s).slice(0, max);
    } catch (_) {
        return '(无法序列化)';
    }
}
function assert(cond, name, detail) {
    if (cond) ok(name, detail);
    else bad(name, detail || '断言失败');
    return cond;
}

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
        if (res.error) return { isError: true, text: res.error.message, protocolError: true };
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
     *    （比如 e2e 测试自己会注册一个 fake-editor 并保持十几秒），
     *    所有调用都会变成「未知工具 xxx」，报告全篇失真。
     *
     * 所以：先 tools/list 拿到真实工具清单，按需解析。
     *    解析不到就**明确报错**，而不是让调用方拿到一句「未知工具」。
     */
    async loadTools() {
        const res = await this.request('tools/list', {});
        const list = (res.result && res.result.tools) || [];
        this.toolNames = new Set(list.map((t) => t.name));
        this.prefixed = new Map(); // 基础名 → [带前缀的真实名]
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

async function main() {
    console.log('Cocos MCP 真机行为验证\n' + '='.repeat(68));

    // 前置
    const probe = spawn(process.execPath, [HUB, '--probe'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let probeOut = '';
    probe.stdout.setEncoding('utf8');
    probe.stdout.on('data', (d) => (probeOut += d));
    await new Promise((r) => probe.on('close', r));
    let pj;
    try { pj = JSON.parse(probeOut); } catch (_) { console.error('probe 输出异常'); process.exit(2); }
    if (!pj.ok) { console.error('没有可用的 Cocos 实例，先启动编辑器'); process.exit(2); }
    const ed = pj.editors.find((e) => e.ok);
    console.log(`  编辑器：${ed.shortName} / ${ed.editorVersion}\n`);

    const c = new McpClient();
    await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'real', version: '1' } });
    c.notify('notifications/initialized');
    // ⚠️ 先取真实工具清单 —— 多编辑器时 hub 会给工具名加 <短名>__ 前缀，
    //    写死的无前缀名会全部变成「未知工具」。
    await c.loadTools();
    if (c.prefixed.size && !c.toolNames.has('scene.tree')) {
        console.error(
            `检测到多个编辑器实例（${c.prefixed.size} 个带前缀的工具族），` +
            '请用环境变量 COCOS_MCP_EDITOR_FILTER=<短名> 指定一个后重跑。'
        );
        process.exit(2);
    }

    // ⚠️ 前置：场景频道必须是活的 ——
    //    引擎的 open-scene 挂死会毒死整个 scene 频道且再也回不来
    //    （调研报告 6.8 / 6.11 / 6.14）。那种状态下继续跑，
    //    得到的是一堆同源失败，看起来像回归，其实是环境坏了。
    await requireSceneChannel((n, a) => c.call(n, a), '真机行为验证');

    const marker = 'RB' + Date.now().toString(36);

    try {
        // ── 1. node.clipboard 的 cut 语义 ────────────────────────
        console.log('▸ 1. node.clipboard 的 cut 语义');
        const rootTree = await c.call('scene.tree');
        const rootName = rootTree.data && rootTree.data.nodes.length ? rootTree.data.nodes[0].name : 'Scene';
        const made = await c.call('node.create', { parent: rootName, name: marker, components: ['cc.UITransform'] });
        assert(!made.isError, '建测试节点', made.isError ? made.text : '');
        const uuid = made.data && made.data.uuid;

        if (uuid) {
            const beforeCut = await c.call('scene.tree');
            const inTreeBefore = !!(beforeCut.data && beforeCut.data.nodes.find((n) => n.uuid === uuid));

            const cut = await c.call('node.clipboard', { action: 'cut', node: uuid, confirm: true });
            assert(!cut.isError, 'cut 调用成功', cut.isError ? cut.text : '');

            const afterCut = await c.call('scene.tree');
            const inTreeAfter = !!(afterCut.data && afterCut.data.nodes.find((n) => n.uuid === uuid));
            assert(inTreeBefore && !inTreeAfter, '★ cut 后节点确实从层级里消失', `before=${inTreeBefore} after=${inTreeAfter}`);

            // paste 用 cut 返回的 clipboardKey
            const key = (cut.data && cut.data.clipboardKey) || uuid;
            const paste = await c.call('node.clipboard', { action: 'paste', node: key, target: rootName });
            assert(!paste.isError, 'paste 调用成功', paste.isError ? paste.text : '');

            const afterPaste = await c.call('scene.tree');
            const pasted = afterPaste.data && afterPaste.data.nodes.filter((n) => n.name === marker);
            assert(pasted.length === 1, '★ paste 后同名节点恰好 1 个', `实际 ${pasted.length} 个`);
            assert(pasted.length && pasted[0].uuid !== uuid, '★ paste 产生的是新节点（uuid 不同）');
            note(`cut 的返回：${safeJson(cut.data, 140)}`);
            note(`paste 的返回：${safeJson(paste.data, 140)}`);

            // 清理（节点可能已被 cut 掉）
            const t3 = await c.call('scene.tree');
            const leftover = t3.data && t3.data.nodes.find((n) => n.name === marker);
            if (leftover) await c.call('node.delete', { node: leftover.uuid, confirm: true });
        }

        // ── 2. 危险操作必须带 confirm ──────────────────────────
        console.log('\n▸ 2. 危险操作的 confirm 门禁');
        for (const t of ['node.delete', 'component.remove', 'asset.delete', 'cocos_message']) {
            const r = await c.call(t, t === 'cocos_message'
                ? { channel: 'scene', message: 'query-is-ready', args: [] }
                : { node: 'x', component: 'cc.Label', url: 'db://assets/x' });
            assert(r.isError && /confirm/i.test(r.text), `${t} 缺 confirm 被拒绝`, String(r.text).slice(0, 80));
        }

        // ── 2b. component.remove 要真的摘掉组件（不是假成功）─────
        console.log('\n▸ 2b. component.remove 的真伪');
        // ⚠️ 必须用**新节点** —— 第 1 节的 cut 已经把原节点删掉了
        const compNode = await c.call('node.create', { parent: rootName, name: marker + '_C', components: ['cc.UITransform'] });
        const compUuid = compNode.data && compNode.data.uuid;
        if (compUuid) {
            const compList = await c.call('component.list', { node: compUuid });
            const types = compList.data && compList.data.components ? compList.data.components.map((x) => x.type) : [];
            // 找一个可以摘的组件
            const removable = types.find((t) => t && t !== 'cc.UITransform' && t !== 'cc.Canvas') || 'cc.UITransform';
            const add = await c.call('component.add', { node: compUuid, component: 'cc.Button' });
            assert(!add.isError, '挂 cc.Button 成功', add.isError ? add.text : '');
            const rm = await c.call('component.remove', { node: compUuid, component: 'cc.Button', confirm: true });
            assert(!rm.isError, '摘 cc.Button 成功', rm.isError ? rm.text : '');
            const after2 = await c.call('component.list', { node: compUuid });
            const types2 = after2.data && after2.data.components ? after2.data.components.map((x) => x.type) : [];
            assert(!types2.includes('cc.Button'), '★ cc.Button 真的被摘掉了（不是假成功）', types2.join(','));
            // ⚠️ 必须清理 —— 否则每跑一轮就在场景里留一个孤儿节点，
            //    跑几次之后场景被测试垃圾塞满，后续断言的节点示例都会被干扰。
            await c.call('node.delete', { node: compUuid, confirm: true });
        }

        // ── 3. 资源 url 必须是 db://assets/ 前缀 ──────────────────
        console.log('\n▸ 3. 资源 url 白名单（防写到项目外）');
        // ⚠️ 用临时目录里的专属文件名，别用固定的 /tmp/evil.json ——
        //    别的进程或上一轮残留会造成假失败。
        const evilFile = path.join(os.tmpdir(), `__cocos_mcp_evil_${Date.now()}.json`);
        for (const bad of [evilFile, 'db://../../evil.json', 'file:///tmp/evil.json']) {
            const r = await c.call('asset.save', { url: bad, content: '{}' });
            assert(r.isError, `拒绝写入 ${bad}`, String(r.text).slice(0, 90));
        }
        assert(!fs.existsSync(evilFile), '★ 项目外确实没有产生文件');

        // ── 4. preferences 真的落盘吗 ───────────────────────────
        console.log('\n▸ 4. preferences 读写');
        const pg = await c.call('preferences.get', { name: 'preview' });
        assert(!pg.isError && pg.data && typeof pg.data === 'object', 'preferences.get 读到内容', pg.isError ? pg.text : '');
        const ps = await c.call('preferences.set', { name: 'preview', key: '__cocos_mcp_probe__', value: 12345 });
        assert(!ps.isError, 'preferences.set 成功', ps.isError ? ps.text : '');
        const pg2 = await c.call('preferences.get', { name: 'preview', key: '__cocos_mcp_probe__' });
        assert(!pg2.isError, 'preferences.get 回读', pg2.isError ? pg2.text : '');
        note(`回读值：${safeJson(pg2.data, 120)}`);

        // ── 5. reference.set 真的改到参考图了吗 ──────────────────
        console.log('\n▸ 5. reference.set');
        const refImg = path.join(os.tmpdir(), '__cocos_mcp_ref.png');
        fs.writeFileSync(refImg, Buffer.from('89504e470d0a1a0a', 'hex'));
        const ra = await c.call('reference.add', { paths: [refImg] });
        assert(!ra.isError, 'reference.add 成功', ra.isError ? ra.text : '');
        const rs = await c.call('reference.set', { key: 'opacity', value: 0.42 });
        assert(!rs.isError, 'reference.set 成功', rs.isError ? rs.text : '');
        const rc = await c.call('reference.current');
        assert(!rc.isError, 'reference.current 读回', rc.isError ? rc.text : '');
        note(`当前参考图：${safeJson(rc.data, 160)}`);
        await c.call('reference.remove', { paths: [refImg] });

        // ── 6. view.align / view.focus 真的作用到编辑器吗 ────────
        console.log('\n▸ 6. 场景视图操作');
        const va = await c.call('view.align', { mode: 'view-with-node' });
        assert(!va.isError, 'view.align 成功', va.isError ? va.text : '');
        const vf = await c.call('view.focus', { nodes: [rootName] });
        assert(!vf.isError, 'view.focus 成功', vf.isError ? vf.text : '');
        const vo = await c.call('view.options', {});
        assert(!vo.isError && vo.data && vo.data.gizmo, 'view.options 读回', vo.isError ? vo.text : '');

        // ── 7. preferences.set 对不存在的分类必须报错 ────────────
        console.log('\n▸ 7. 偏好分类不存在时必须报错');
        const pne = await c.call('preferences.set', { name: '__不存在的分类__', key: 'k', value: 1 });
        assert(pne.isError, '不存在的偏好分类被拒绝', String(pne.text).slice(0, 90));

        // ── 8. cocos_message 原始透传的边界 ─────────────────────
        console.log('\n▸ 8. cocos_message 原始透传');
        const cm1 = await c.call('cocos_message', { channel: 'scene', message: 'query-is-ready', args: [], confirm: true });
        assert(!cm1.isError, '白名单内的消息可透传', cm1.isError ? cm1.text : '');
        const cm2 = await c.call('cocos_message', { channel: 'scene', message: '不存在的消息', args: [], confirm: true });
        assert(cm2.isError, '白名单外的消息被拒绝', String(cm2.text).slice(0, 90));

        // ── 9. 并发调用 ────────────────────────────────────────
        console.log('\n▸ 9. 并发调用（20 个并行）');
        const t0 = Date.now();
        const results = await Promise.all(
            Array.from({ length: 20 }, (_, i) => c.call('scene.find', { name: marker + i }))
        );
        const bads = results.filter((r) => r.isError);
        assert(bads.length === 0, '20 个并发调用全部成功', `失败 ${bads.length} 个，耗时 ${Date.now() - t0}ms`);

        // ── 10. 场景事务的失败回滚（真机）──────────────────────
        console.log('\n▸ 10. 真机事务回滚');
        const before = await c.call('scene.tree');
        const n0 = before.data ? before.data.count : 0;
        const tx = await c.call('scene.transaction', {
            ops: [
                { op: 'node.create', args: { parent: rootName, name: marker + '_TX1' } },
                { op: 'node.create', args: { parent: rootName, name: marker + '_TX2' } },
                { op: 'component.set', args: { node: '__不存在的节点__', component: 'cc.Label', property: 'string', value: 'x' } },
            ],
        });
        assert(tx.isError, '失败的事务被标记为失败', String(tx.text).slice(0, 100));
        assert(/已回滚/.test(String(tx.text)), '错误信息里明确告知已回滚', String(tx.text).slice(0, 140));
        await new Promise((r) => setTimeout(r, 600));
        const after = await c.call('scene.tree');
        const n1 = after.data ? after.data.count : 0;
        assert(n1 === n0, '★ 回滚后节点数与事务前一致', `${n0} → ${n1}`);

        // ── 11. 离线 prefab 编辑在真工程上的往返 ────────────────
        console.log('\n▸ 11. 离线 prefab 编辑（项目内真实文件）');
        const assets = await c.call('asset.query', { pattern: 'db://assets/**/*.prefab' });
        const list = assets.data && assets.data.assets ? assets.data.assets : [];
        if (list.length) {
            // ⚠️ asset.query 返回的 `path` 是 **db:// URL**，不是文件系统路径 ——
            //    直接拿它当 filePath 会被拼成 "<项目>/db:/assets/xxx" 然后被护栏拒掉。
            //    真实文件系统路径要用 asset.path 工具查。
            const pRes = await c.call('asset.path', { url: list[0].url });
            // asset.path 直接返回路径**字符串**（不是 {path:...}）
            const p = typeof pRes.data === 'string' ? pRes.data : null;
            if (!p) {
                note(`拿不到 prefab 的文件系统路径（asset.path 返回：${safeJson(pRes.data, 80)}）`);
            } else {
                const q = await c.call('cocos_prefab_query', { filePath: p, selector: 'tree' });
                assert(!q.isError, '能离线读工程内的 prefab', q.isError ? q.text : '');
                // ⚠️ 离线工具的结果已**拍平** —— 与 scene.tree 同形状（不再多包一层 data）
                assert(
                    q.data && typeof q.data.count === 'number' && Array.isArray(q.data.nodes),
                    '★ 离线查询的结果与编辑器侧工具同形状（直接是 {count, nodes}）',
                    safeJson(q.data, 120)
                );
                note(`prefab 节点数：${q.data ? q.data.count : '?'}`);
            }
        } else {
            note('工程里没有 .prefab，跳过');
        }

        // ── 12. 参数过滤必须真的生效 ─────────────────────────────
        // ⚠️ scene.classes 之前把 extends **静默丢了**（hub 传扁平、bridge 读嵌套），
        //    传什么都返回全部组件类 —— 看起来"能用"，其实参数完全无效。
        //    这类 bug 只有真机比对类数才能发现。
        console.log('\n▸ 12. 参数过滤真的生效');
        {
            const all = await c.call('scene.classes', {});
            const onlyNode = await c.call('scene.classes', { extends: 'cc.Node' });
            const countAll = (all.data && all.data.count) || 0;
            const countNode = (onlyNode.data && onlyNode.data.count) || 0;
            assert(
                !all.isError && !onlyNode.isError,
                'scene.classes 两种调用都成功',
                (all.isError ? all.text : '') + (onlyNode.isError ? onlyNode.text : '')
            );
            assert(
                onlyNode.data && onlyNode.data.extends === 'cc.Node',
                '★ 返回的 extends 与请求一致（过滤器真的生效了）',
                onlyNode.data ? onlyNode.data.extends : '(无)'
            );
            assert(
                countNode < countAll,
                `★ 过滤后类数确实变少（${countNode} < ${countAll}）—— 说明 extends 传到了引擎`
            );
        }

        // ── 13. 声明了的参数必须**真的生效** ───────────────────
        // ⚠️ node.create 的 position 之前是**声明了但不生效**的：
        //    引擎的 create-node 会忽略它（真机实测：建完回读 position 仍是 {0,0,0}），
        //    而同样的值走 node.transform 就生效。
        //    现在 bridge 在建完节点后补一次 set-property，所以它真的生效了。
        //    这条断言防的就是「声明了却静默无效」这一类。
        console.log('\n▸ 13. 声明了的参数真的生效');
        {
            const tree2 = await c.call('scene.tree', {});
            const root2 = tree2.data && tree2.data.root;
            if (!root2) {
                note('读不到场景根节点，跳过参数生效验证');
            } else {
                const mk = await c.call('node.create', {
                    parent: root2,
                    name: marker + '_POS',
                    position: { x: 123, y: 456, z: 7 },
                });
                const uuid2 = mk.data && mk.data.uuid;
                if (!uuid2) {
                    bad('node.create 带 position 失败', mk.isError ? String(mk.text).slice(0, 90) : '没拿到 uuid');
                } else {
                    const back = await c.call('scene.node', { node: uuid2 });
                    const pos = back.data && back.data.dump && back.data.dump.position;
                    assert(
                        pos && pos.x === 123 && pos.y === 456 && pos.z === 7,
                        '★ node.create 的 position 真的生效了（不是声明了但不生效）',
                        safeJson(
                            {
                                pos,
                                positionError: mk.data && mk.data.positionError,
                                readError: back.isError ? String(back.text).slice(0, 90) : null,
                            },
                            200
                        )
                    );
                    await c.call('node.delete', { node: uuid2, confirm: true });
                }
            }
        }

        // ── 14. 「未导入的场景」必须被**前置拦截**，且不能把频道搞挂 ──
        // 这是本轮最核心的一条：打开一个还没导入完的场景会让**整个 scene 频道中毒**
        // （query-node-tree 永远不返回，后面所有场景操作全挂）。
        // 做法：把一个已导入场景的 library 库产物挪走 → 模拟「还没导入完」。
        console.log('\n▸ 14. 未导入场景的前置拦截');
        {
            const projRoot = ed.projectPath;
            const u = await c.call('asset.uuid', { url: 'db://assets/scenes/e2e-scene.scene' });
            const suuid = u.data && u.data.uuid ? u.data.uuid : u.data;
            const libFile = path.join(projRoot, 'library', String(suuid).slice(0, 2), `${suuid}.json`);
            if (!suuid || !fs.existsSync(libFile)) {
                note('拿不到 e2e-scene 的库产物，跳过「未导入拦截」验证');
            } else {
                const bak = libFile + '.bak_real_test';
                fs.renameSync(libFile, bak);
                try {
                    const st = await c.call('asset.isImported', { uuid: suuid });
                    assert(
                        st.data && st.data.imported === false,
                        '库产物缺失时 asset.isImported 判为未导入',
                        safeJson(st.data || st.text, 120)
                    );
                    assert(
                        st.data && st.data.reason && st.data.reason.length > 4,
                        '未导入时给出可行动的原因',
                        st.data && st.data.reason ? st.data.reason : '(无)'
                    );

                    const openRes = await c.call('scene.open', { uuid: suuid });
                    assert(openRes.isError, '未导入的场景被拒绝打开', String(openRes.text).slice(0, 100));
                    assert(
                        /还没导入完成/.test(String(openRes.text)),
                        '拒绝原因明确指向「导入未完成」',
                        String(openRes.text).slice(0, 140)
                    );

                    // ★ 关键：拒绝之后频道必须还健康
                    const treeAfter = await c.call('scene.tree');
                    assert(
                        !treeAfter.isError,
                        '★ 拦截没有把 scene 频道搞挂（拒绝后 scene.tree 仍可用）',
                        String(treeAfter.text).slice(0, 100)
                    );
                } finally {
                    fs.renameSync(bak, libFile);
                }
            }
        }

        // ── 15. 离线 prefab 编辑器的**写盘路径**（真实文件上跑）──
        // ⚠️ 之前只测过「读」，写盘路径在真机上从没跑过 ——
        //    而写盘恰恰是最容易出事的地方（原子写、.meta 事务、失败零写入）。
        console.log('\n▸ 15. 离线 prefab 写盘路径（真实文件）');
        {
            const prefabPath = path.join(ed.projectPath, 'assets', 'smoke-sample.prefab');
            if (!fs.existsSync(prefabPath)) {
                note('工程里没有 smoke-sample.prefab，跳过离线写盘验证');
            } else {
                const before = fs.readFileSync(prefabPath, 'utf8');

                // ⚠️ 节点名必须**先查出来**再用 ——
                //    写死一个名字（比如 "default"）会「操作失败但工具报成功」，
                //    因为离线编辑把 op 执行失败也包在 {ok:true} 里。
                //    而且 Cocos 会把 prefab 的根节点名改成与文件名一致。
                const tree0 = await c.call('cocos_prefab_query', { filePath: prefabPath, selector: 'tree' });
                const nodes0 = (tree0.data && tree0.data.nodes) || [];
                const root0 = nodes0[0] && (nodes0[0].name || nodes0[0].path);
                if (!root0) {
                    note('读不到 prefab 根节点名，跳过离线写盘验证');
                } else {
                    const NEW_NAME = 'RENAMED_BY_MCP';

                    // 1) dryRun：只校验不落盘
                    const dry = await c.call('cocos_prefab_edit', {
                        filePath: prefabPath,
                        ops: [{ op: 'rename-node', node: root0, name: NEW_NAME }],
                        dryRun: true,
                    });
                    assert(!dry.isError, 'dryRun 校验通过', dry.isError ? dry.text : '');
                    assert(
                        fs.readFileSync(prefabPath, 'utf8') === before,
                        '★ dryRun 之后磁盘内容**一字未改**'
                    );

                    // 2) 真正落盘
                    const edit = await c.call('cocos_prefab_edit', {
                        filePath: prefabPath,
                        ops: [{ op: 'rename-node', node: root0, name: NEW_NAME }],
                    });
                    assert(!edit.isError, '离线编辑落盘成功', edit.isError ? edit.text : '');
                    const after = fs.readFileSync(prefabPath, 'utf8');
                    assert(after !== before, '★ 磁盘内容确实变了');
                    assert(
                        after.includes(NEW_NAME),
                        '★ 改后的名字真的写进了文件',
                        after.slice(0, 80)
                    );

                    // 3) 回读（走 query 工具，不是直接读文件）
                    const q = await c.call('cocos_prefab_query', { filePath: prefabPath, selector: 'tree' });
                    assert(!q.isError, '改完能离线回读', q.isError ? q.text : '');
                    const names = q.data && q.data.nodes ? q.data.nodes.map((n) => n.name) : [];
                    assert(
                        names.includes(NEW_NAME),
                        '★ 回读到的名字是改后的',
                        names.slice(0, 5).join(',')
                    );

                    // 4) 失败的操作必须**零写入**，而且必须**报成错误**
                    //    （不能「工具成功 + 数据里 ok:false」—— 那是假成功）
                    const before2 = fs.readFileSync(prefabPath, 'utf8');
                    const badEdit = await c.call('cocos_prefab_edit', {
                        filePath: prefabPath,
                        ops: [
                            { op: 'rename-node', node: NEW_NAME, name: 'SHOULD_NOT_PERSIST' },
                            { op: 'rename-node', node: '__不存在的节点__', name: 'X' },
                        ],
                    });
                    assert(badEdit.isError, '含无效 op 的批量编辑必须报成错误（不能是假成功）', String(badEdit.text).slice(0, 110));
                    assert(
                        fs.readFileSync(prefabPath, 'utf8') === before2,
                        '★ 失败的事务对磁盘零写入（第一条 op 也没留下）'
                    );

                    // 5) 还原
                    fs.writeFileSync(prefabPath, before);
                }
            }
        }

    } catch (e) {
        bad('执行中断', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
    } finally {
        c.close();
    }

    console.log('\n' + '='.repeat(68));
    console.log(`通过 ${pass} / 失败 ${fail}`);
    if (notes.length) {
        console.log('\n观察记录：');
        for (const n of notes) console.log('  · ' + n);
    }
    if (failures.length) {
        console.log('\n失败项：');
        for (const f of failures) console.log('  - ' + f);
    }
    process.exit(fail === 0 ? 0 : 1);
}

main();
