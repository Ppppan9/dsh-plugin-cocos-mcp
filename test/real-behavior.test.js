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
    notes.push(text);
    console.log(`  ℹ️  ${text}`);
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
        const res = await this.request('tools/call', { name, arguments: args || {} });
        if (res.error) return { isError: true, text: res.error.message, protocolError: true };
        const text = (res.result.content || []).map((c) => c.text).join('\n');
        let data;
        try { data = JSON.parse(text); } catch (_) { data = text; }
        return { isError: !!res.result.isError, data, text };
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
            note(`cut 的返回：${JSON.stringify(cut.data).slice(0, 140)}`);
            note(`paste 的返回：${JSON.stringify(paste.data).slice(0, 140)}`);

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
        }

        // ── 3. 资源 url 必须是 db://assets/ 前缀 ──────────────────
        console.log('\n▸ 3. 资源 url 白名单（防写到项目外）');
        for (const bad of ['/tmp/evil.json', 'db://../../evil.json', 'file:///tmp/evil.json']) {
            const r = await c.call('asset.save', { url: bad, content: '{}' });
            assert(r.isError, `拒绝写入 ${bad}`, String(r.text).slice(0, 90));
        }
        assert(!fs.existsSync('/tmp/evil.json'), '★ 项目外确实没有产生文件');

        // ── 4. preferences 真的落盘吗 ───────────────────────────
        console.log('\n▸ 4. preferences 读写');
        const pg = await c.call('preferences.get', { name: 'preview' });
        assert(!pg.isError && pg.data && typeof pg.data === 'object', 'preferences.get 读到内容', pg.isError ? pg.text : '');
        const ps = await c.call('preferences.set', { name: 'preview', key: '__cocos_mcp_probe__', value: 12345 });
        assert(!ps.isError, 'preferences.set 成功', ps.isError ? ps.text : '');
        const pg2 = await c.call('preferences.get', { name: 'preview', key: '__cocos_mcp_probe__' });
        assert(!pg2.isError, 'preferences.get 回读', pg2.isError ? pg2.text : '');
        note(`回读值：${JSON.stringify(pg2.data).slice(0, 120)}`);

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
        note(`当前参考图：${JSON.stringify(rc.data).slice(0, 160)}`);
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
            const p = list[0].path || list[0].url;
            const q = await c.call('cocos_prefab_query', { filePath: p, selector: 'tree' });
            assert(!q.isError, '能离线读工程内的 prefab', q.isError ? q.text : '');
            note(`prefab 节点数：${q.data ? q.data.count : '?'}`);
        } else {
            note('工程里没有 .prefab，跳过');
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
