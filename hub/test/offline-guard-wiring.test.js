'use strict';

/**
 * 护栏**接线**测试：hub 的离线工具是否真的把 allowedRoots 传到离线层。
 * ---------------------------------------------------------------------------
 * 为什么需要这一层测试：
 *   离线模块自己写着「anim 路径」护栏，但**只有拿到 allowedRoots 时才生效**。
 *   hub 之前调 `offline.editAnimation({filePath, ops, dryRun})` —— 少传一个参数，
 *   那道护栏就**从来没生效过**：看着有、其实没有。
 *
 *   顶层 filePath 由 hub 的 assertInsideProject 守着，所以当时**没有真实漏洞**，
 *   但纵深防御的那一层是空的 —— 一旦上层检查被削弱，就没有第二道闸。
 *
 * 怎么测「有没有传」：
 *   预置 require 缓存里的离线模块桩，把实际收到的参数抓出来。
 *   ⚠️ 不用解析源码文本断言（那条路有实测过的静默失效）。
 *
 * 运行：node --test hub/test/*.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tmpdir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-mcp-wiring-'));
}

/** 造一个「已注册项目」的假 ctx。 */
function fakeCtx(projectDir) {
    return {
        listEditors: () => [{ projectPath: projectDir }],
        extraRoots: [],
    };
}

/**
 * 用桩替换离线模块，调用一次 hub 的工具 handler，抓下离线层实际收到的参数。
 * @param {string} toolName 工具名
 * @param {string} methodName 要抓参数的方法名
 * @param {object} args 工具参数
 * @param {object} ctx 假 ctx
 * @param {object} [extra] 桩里额外要有的方法（键=方法名，值=返回值）
 */
async function captureOfflineArgs(toolName, methodName, args, ctx, extra) {
    const offlinePath = require.resolve('../src/offline');
    const hubPath = require.resolve('../src/tools/global-tools');
    const savedOffline = require.cache[offlinePath];
    const savedHub = require.cache[hubPath];
    let captured = null;
    try {
        const stub = { ...(extra || {}) };
        stub[methodName] = (a) => {
            captured = a;
            return { ok: true, data: { ok: true } };
        };
        require.cache[offlinePath] = {
            id: offlinePath,
            filename: offlinePath,
            loaded: true,
            exports: stub,
        };
        delete require.cache[hubPath];
        const { GLOBAL_TOOLS } = require(hubPath);
        const tool = GLOBAL_TOOLS.find((t) => t.name === toolName);
        assert.ok(tool, `${toolName} 必须存在`);
        await tool.handler(args, ctx);
        return captured;
    } finally {
        // ⚠️ 必须还原 —— 否则桩会把同一进程里其它测试的离线模块换掉
        if (savedOffline) require.cache[offlinePath] = savedOffline;
        else delete require.cache[offlinePath];
        if (savedHub) require.cache[hubPath] = savedHub;
        else delete require.cache[hubPath];
    }
}

test('★ cocos_anim_batch 必须把 allowedRoots 传给离线层（不传那道护栏是死的）', async () => {
    const project = tmpdir();
    const anim = path.join(project, 'a.anim');
    fs.writeFileSync(anim, '[]\n');
    const captured = await captureOfflineArgs(
        'cocos_anim_batch',
        'editAnimation',
        { filePath: anim, ops: [{ op: 'offset-curve', offset: 1 }] },
        fakeCtx(project)
    );
    assert.ok(captured, '应当调用到离线层');
    assert.ok(
        Array.isArray(captured.allowedRoots),
        '★ 离线层必须收到 allowedRoots —— 没有它，离线模块自己的路径护栏不会生效'
    );
    assert.ok(captured.allowedRoots.length > 0, '★ allowedRoots 不能是空的');
    assert.strictEqual(captured.allowedRoots[0], path.resolve(project));
});

test('cocos_prefab_edit 同样必须把 allowedRoots 传给离线层（守住这个接线）', async () => {
    const project = tmpdir();
    const prefab = path.join(project, 'a.prefab');
    fs.writeFileSync(prefab, '[]\n');
    const captured = await captureOfflineArgs(
        'cocos_prefab_edit',
        'editPrefab',
        { filePath: prefab, ops: [{ op: 'set-active', node: 'X', active: false }] },
        fakeCtx(project)
    );
    assert.ok(captured, '应当调用到离线层');
    assert.ok(Array.isArray(captured.allowedRoots), '★ 必须传 allowedRoots');
    assert.strictEqual(captured.allowedRoots[0], path.resolve(project));
});

test('cocos_prefab_batch 也必须把 allowedRoots 传给离线层', async () => {
    const project = tmpdir();
    const opsJson = path.join(project, 'ops.json');
    fs.writeFileSync(opsJson, '[]\n');
    const captured = await captureOfflineArgs(
        'cocos_prefab_batch',
        'batchPrefab',
        { opsJsonPath: opsJson },
        fakeCtx(project),
        // prefab_batch 的 handler 会先 peek 出 ops 清单再执行
        { peekBatchOps: () => ({ ok: true, data: { mode: 'single', filePath: 'x', ops: [] } }) }
    );
    assert.ok(captured, '应当调用到离线层');
    assert.ok(Array.isArray(captured.allowedRoots), '★ 必须传 allowedRoots');
    assert.strictEqual(captured.allowedRoots[0], path.resolve(project));
});
