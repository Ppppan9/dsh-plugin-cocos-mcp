'use strict';

/**
 * 一致性自检 —— 文档 / 清单 / 实现 三者必须对齐
 * ---------------------------------------------------------------------------
 * 现有开源 Cocos MCP 最大的毛病之一就是「README 说的和代码做的不是一回事」
 * （有的项目 README 列了 10 个不存在的工具名，24 个真实工具没提）。
 * 这里把这类问题变成**可自动发现的测试**。
 *
 * 运行：node --test test/consistency.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const { EDITOR_TOOLS, GLOBAL_TOOLS } = require('../hub/src/tools');
const { CHANNELS, REFERENCE_IMAGE, ALIASES, KNOWN_MISSING, verify } = require('../extension/bridge/messages');
const handlersSrc = read('extension/bridge/handlers.js');
const editorToolsSrc = read('hub/src/tools/editor-tools.js');
const globalToolsSrc = read('hub/src/tools/global-tools.js');
const readme = read('README.md');
const sources = read('SOURCES.md');
const notice = read('NOTICE');

// ────────────────────────────── 工具面 ──────────────────────────────

test('工具清单：描述、schema、注解齐备', () => {
    const all = [...EDITOR_TOOLS, ...GLOBAL_TOOLS];
    for (const t of all) {
        assert.ok(t.name && /^[a-z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)*$/.test(t.name), `工具名格式异常：${t.name}`);
        assert.ok(t.title && t.title.length >= 2, `${t.name} 缺 title`);
        assert.ok(t.description && t.description.length >= 20, `${t.name} 描述过短（${(t.description || '').length}）`);
        assert.ok(t.inputSchema && t.inputSchema.type === 'object', `${t.name} 缺 inputSchema`);
        assert.ok(['read', 'write', 'danger'].includes(t.safety), `${t.name} safety 非法：${t.safety}`);
    }
});

test('工具名唯一', () => {
    const names = [...EDITOR_TOOLS, ...GLOBAL_TOOLS].map((t) => t.name);
    const dup = names.filter((n, i) => names.indexOf(n) !== i);
    assert.deepStrictEqual(dup, [], '工具名重复：' + dup.join(', '));
});

test('每个编辑器工具都有对应的 Bridge 实现（op 或 handler）', () => {
    for (const t of EDITOR_TOOLS) {
        if (t.handler) continue;
        assert.ok(t.op, `${t.name} 既没有 handler 也没有 op`);
        assert.ok(
            handlersSrc.includes(`'${t.op}'`),
            `${t.name} 的 op "${t.op}" 在 handlers.js 里找不到对应实现`
        );
    }
});

test('handlers.js 里每个 Bridge 操作都已被暴露成工具（或明确标注为内部）', () => {
    // 抓出 handlers.js 中定义的所有 op 名
    const defined = [...handlersSrc.matchAll(/^\s{8}'([a-z][a-zA-Z0-9_.]*)':\s*async/gm)].map((m) => m[1]);
    const exposed = new Set(EDITOR_TOOLS.map((t) => t.op).filter(Boolean));
    // 工具用自定义 handler 调用的 op（形如 ctx.call('xxx')）也算已暴露
    for (const mm of editorToolsSrc.matchAll(/ctx\.call\(\s*'([a-z][a-zA-Z0-9_.]*)'/g)) {
        exposed.add(mm[1]);
    }
    // 这些是内部实现细节：被更高层的组合工具调用，不直接暴露成工具
    const INTERNAL = new Set([
        'bridge.channels', // 由面板直接读静态清单
        'message',        // 已通过 cocos_message 工具暴露
        'scene.dirty',    // 组合进 scene.status
        'scene.ready',    // 组合进 scene.status
        'view.gizmo',     // 组合进 view.options
        'view.is2d',      // 组合进 view.options
        'view.grid',      // 组合进 view.options
        'view.icon',      // 组合进 view.options
    ]);
    const orphans = defined.filter((op) => !exposed.has(op) && !INTERNAL.has(op));
    assert.deepStrictEqual(orphans, [], '这些 Bridge 操作有能不用：' + orphans.join(', '));
});

test('danger 级工具的 confirm 约束在 schema 里成立', () => {
    const { ToolRegistry, EDITOR_TOOLS, GLOBAL_TOOLS } = require('../hub/src/tools');
    const reg = new ToolRegistry({ getClient: () => null, listEditors: () => [] });
    const list = reg.list();
    // ⚠️ 判定「这个工具危不危险」必须用**源定义**的 safety ——
    //    reg.list() 返回的是 MCP 形态（toMcpTool），**没有 safety 字段**，
    //    而 annotations.destructiveHint 又是从 safety 推导出来的。
    //    用推导结果去决定「要查哪些工具」就是**自指**：
    //    一旦推导逻辑坏了（destructiveHint 恒为 false），
    //    这条断言会**整体跳过**、一片绿，而破坏性工具早就没有 confirm 了。
    const raw = new Map();
    for (const t of [...EDITOR_TOOLS, ...GLOBAL_TOOLS]) raw.set(t.name, t);
    let dangerCount = 0;
    for (const t of list) {
        const base = t.name.includes('__') ? t.name.slice(t.name.indexOf('__') + 2) : t.name;
        const src = raw.get(base);
        const isDanger = !!(src && src.safety === 'danger');
        // 独立地核对一次标注：必须与源头的分级一致
        assert.strictEqual(
            !!(t.annotations && t.annotations.destructiveHint),
            isDanger,
            `${t.name} 的 destructiveHint 与 safety 不一致（客户端会据此决定要不要弹确认）`
        );
        if (!isDanger) continue;
        dangerCount++;
        assert.ok(
            (t.inputSchema.required || []).includes('confirm'),
            `${t.name} 标为破坏性但 confirm 不在 required`
        );
        assert.ok(t.inputSchema.properties.confirm, `${t.name} 缺 confirm 属性定义`);
    }
    // 非空断言：防止上面整段因为「一个 danger 工具都没识别出来」而空转
    assert.ok(dangerCount > 0, '一个 danger 工具都没识别出来 —— 判定逻辑本身坏了');
});

test('危险操作不会在 schema 里留下占位字段', () => {
    const { ToolRegistry } = require('../hub/src/tools');
    const reg = new ToolRegistry({ getClient: () => null, listEditors: () => [] });
    for (const t of reg.list()) {
        assert.ok(!('__confirmHint' in (t.inputSchema.properties || {})), `${t.name} 残留占位属性`);
    }
});

/**
 * 从 handlers.js 里精确提取某个 op 的函数体（括号配对）。
 * 用固定长度的窗口不可靠 —— 条件分支里的 invalidateTree 可能落在窗口外。
 */
function extractHandlerBody(src, opName) {
    const marker = `'${opName}':`;
    const idx = src.indexOf(marker);
    if (idx < 0) return null;
    const braceStart = src.indexOf('{', idx);
    if (braceStart < 0) return null;
    let depth = 0;
    for (let i = braceStart; i < src.length; i++) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return src.slice(braceStart, i + 1);
        }
    }
    return null;
}

// ────────────────────────────── 静态误用检查 ──────────────────────────────

/**
 * handlers.js 里所有 op 的形参叫 `args`（不是 `op` —— 那是离线模块的写法）。
 * 写错会变成运行时 ReferenceError，而这类错误只有在真机调用到那个 op 时才暴露。
 */
test('extension/bridge/handlers.js 不存在未定义的 op. 误用', () => {
    const src = read('extension/bridge/handlers.js');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const hits = [...code.matchAll(/\bop\.([a-zA-Z_][a-zA-Z0-9_]*)/g)].map((m) => m[0]);
    assert.deepStrictEqual(hits, [], 'handlers.js 里 op. 是未定义变量（形参叫 args）：' + hits.join(', '));
});

test('离线模块的 op 形参统一叫 op（避免与 handlers.js 混用）', () => {
    const src = read('hub/src/offline/ops.js');
    // 每个 handler 形参必须是 (ctx, op)
    const handlers = [...src.matchAll(/^\s{4}'([a-z0-9-]+)':\s*\(ctx,\s*(\w+)\)\s*=>/gm)];
    assert.ok(handlers.length >= 30, `解析到的 op 太少：${handlers.length}`);
    for (const h of handlers) {
        assert.strictEqual(h[2], 'op', `op "${h[1]}" 的形参是 "${h[2]}"，应为 op`);
    }
});

// ────────────────────────────── 场景脚本白名单 ──────────────────────────────

test('scene.script 的方法白名单与 scene.js 实际导出完全一致', () => {
    const sceneSrc = read('extension/scene.js');
    const exported = [...sceneSrc.matchAll(/^METHODS\.([a-zA-Z]+)\s*=/gm)].map((m) => m[1]);
    assert.ok(exported.length >= 5, `scene.js 解析出的方法太少：${exported.length}`);
    // scene.js 必须以 exports.methods 的形式导出 —— Cocos 的 execute-scene-script
    // 按 exports.methods[method] 派发，直接 module.exports = METHODS 的话方法找不到
    assert.ok(
        /module\.exports\s*=\s*\{\s*methods:\s*METHODS\s*\}/.test(sceneSrc),
        'scene.js 必须导出 { methods: METHODS }'
    );
    const m = handlersSrc.match(/const ALLOWED = \[([^\]]+)\]/);
    assert.ok(m, 'handlers.js 里找不到 scene.script 的 ALLOWED 白名单');
    const allowed = m[1].split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean);
    const missing = allowed.filter((a) => !exported.includes(a));
    const extra = exported.filter((e) => !allowed.includes(e));
    assert.deepStrictEqual(missing, [], '白名单里有的方法 scene.js 并未导出：' + missing.join(', '));
    assert.deepStrictEqual(extra, [], 'scene.js 导出了但白名单没放行的方法：' + extra.join(', '));
});

test('扩展清单的菜单是扁平结构（3.8 不支持嵌套 items）', () => {
    const pkg = JSON.parse(read('extension/package.json'));
    const menu = pkg.contributions && pkg.contributions.menu;
    assert.ok(Array.isArray(menu) && menu.length, '菜单必须是扁平数组');
    for (const item of menu) {
        assert.ok(!item.items, `菜单项不能有嵌套 items：${item.label}`);
        assert.ok(item.message, `菜单项 ${item.label} 缺 message`);
        assert.ok(typeof item.path === 'string', `菜单项 ${item.label} 缺 path`);
    }
    // 消息名必须在 contributions.messages 里注册
    for (const item of menu) {
        assert.ok(
            pkg.contributions.messages && pkg.contributions.messages[item.message],
            `菜单引用的消息 "${item.message}" 没有在 contributions.messages 里注册`
        );
    }
});

test('面板不 require("cc")，且路径能解析到真实文件', () => {
    const panelPath = path.join(ROOT, 'extension/panels/default/index.js');
    const raw = fs.readFileSync(panelPath, 'utf8');
    // 先剥掉注释 —— 注释里可能写着「不要 require('cc')」这种话，不能当成代码
    const code = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert.ok(
        !/require\(\s*['"]cc['"]\s*\)/.test(code),
        "面板不能 require('cc') —— Cocos 3.8 面板跑在渲染进程，会抛 MODULE_NOT_FOUND"
    );
    // 面板里的相对 require 必须能解析到真实文件
    for (const m of code.matchAll(/require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g)) {
        const target = path.resolve(path.dirname(panelPath), m[1]);
        assert.ok(fs.existsSync(target), `面板的 require("${m[1]}") 解析到不存在的路径：${target}`);
    }
    // 生命周期钩子：Cocos 3.8 的面板没有 beforeUnmount（那是 Vue 3 的）
    assert.ok(!/beforeUnmount\s*\(/.test(code), '面板不能依赖 beforeUnmount（Cocos 3.8 内置 Vue 是 2.7，永不触发）');
    assert.ok(
        /close\s*\(\s*\)/.test(code) || /beforeClose\s*\(\s*\)/.test(code),
        '面板必须实现 close 或 beforeClose 来清理定时器'
    );
});

test('扩展清单引用的文件都存在', () => {
    const pkg = JSON.parse(read('extension/package.json'));
    assert.ok(fs.existsSync(path.join(ROOT, 'extension', pkg.main)), `main 指向的文件不存在：${pkg.main}`);
    const panels = pkg.panels || {};
    for (const [name, def] of Object.entries(panels)) {
        assert.ok(fs.existsSync(path.join(ROOT, 'extension', def.main)), `面板 ${name} 的 main 不存在：${def.main}`);
    }
    const scene = pkg.contributions && pkg.contributions.scene && pkg.contributions.scene.script;
    if (scene) {
        assert.ok(fs.existsSync(path.join(ROOT, 'extension', scene)), `scene.script 不存在：${scene}`);
    }
});

// ────────────────────────────── 消息白名单 ──────────────────────────────

test('白名单里的消息都有参数数量与形状描述', () => {
    for (const [ch, msgs] of Object.entries(CHANNELS)) {
        for (const [name, d] of Object.entries(msgs)) {
            assert.ok(typeof d.params === 'number', `${ch}:${name} 缺 params`);
            assert.ok(d.readonly === true || d.readonly === false, `${ch}:${name} 缺 readonly 标记`);
        }
    }
    for (const [name, d] of Object.entries(REFERENCE_IMAGE)) {
        assert.ok(typeof d.params === 'number', `reference-image:${name} 缺 params`);
        assert.ok(d.readonly === true || d.readonly === false, `reference-image:${name} 缺 readonly 标记`);
    }
});

test('白名单里没有自相矛盾的条目（既在别名表又在正常表里）', () => {
    for (const alias of Object.keys(ALIASES)) {
        const [ch, msg] = alias.split(':');
        assert.ok(
            !describe(ch, msg),
            `${alias} 同时出现在别名表和白名单里，别名会失效`
        );
    }
    function describe(ch, msg) {
        if (ch === 'reference-image') return REFERENCE_IMAGE[msg] || null;
        return (CHANNELS[ch] || {})[msg] || null;
    }
});

test('verify() 对未知消息给出可用提示而不是空回复', () => {
    const r = verify('scene', '完全不存在的消息');
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason && r.reason.length > 10, '缺少原因说明');
    assert.ok(r.suggestion && r.suggestion.length > 10, '缺少建议');
});

test('别名表指向的消息名确实存在', () => {
    for (const [alias, target] of Object.entries(ALIASES)) {
        const [ch, msg] = target.split(':');
        const ok = ch === 'reference-image' ? !!REFERENCE_IMAGE[msg] : !!((CHANNELS[ch] || {})[msg]);
        assert.ok(ok, `别名 ${alias} → ${target} 指向不存在的消息`);
    }
});

// ────────────────────────────── 文档一致性 ──────────────────────────────

test('scene.open 的超时预算：hub 侧必须盖得住 Bridge 侧的最坏路径', () => {
    // ⚠️ 这是本轮差点漏掉的不变量：
    //    Bridge 的 scene.open 最坏路径 = 探活 + 查资源名 + open-scene + 失败后的强制探活。
    //    如果 hub 侧工具的 timeoutMs 小于它，客户端会先超时，
    //    而 Bridge 还在跑 —— 用户看到的是「请求超时」而不是真正的原因
    //    （场景频道是不是已经中毒），排查方向会被带偏。
    //
    // ⚠️ 预算数字必须**从 Bridge 直接 require 求值**，不能去正则解析源码 ——
    //    实测过正则解析的静默失效：`60_000` 数字分隔符、`60e3` 科学计数法
    //    都会让算出来的预算塌缩成 18120ms 而断言**照样通过**；
    //    常量改名后 `|| 兜底` 还会让它悄悄不再跟踪真实值。
    //    断言一旦静默失效，就等于没有断言。
    const { sceneOpenBudgetMs } = require('../extension/bridge/handlers');
    assert.strictEqual(typeof sceneOpenBudgetMs, 'function', 'Bridge 必须导出 sceneOpenBudgetMs()');
    const budget = sceneOpenBudgetMs();
    assert.ok(budget > 0, '算出来的预算必须为正数');

    const tool = EDITOR_TOOLS.find((t) => t.name === 'scene.open');
    assert.ok(tool, '缺 scene.open 工具');
    assert.ok(
        tool.timeoutMs > budget,
        `hub 侧 scene.open 的 timeoutMs=${tool.timeoutMs}ms 盖不住 Bridge 侧最坏预算 ${budget}ms` +
        '（客户端会先超时，Bridge 还在跑）'
    );
    // 也不能大得离谱 —— 用户干等太久同样是不可接受的体验。
    assert.ok(
        tool.timeoutMs < budget * 3,
        `hub 侧 scene.open 的 timeoutMs=${tool.timeoutMs}ms 相对最坏预算 ${budget}ms 过大` +
        '（用户要干等太久才拿到一个「请求超时」）'
    );
});

test('scene.script 的 method 白名单：schema 与 Bridge 实现必须一致', () => {
    // ⚠️ 这份名单在**两个地方**：hub 侧 inputSchema 的 enum（给模型看、参数校验用）
    //    与 bridge 侧的白名单（真正执行时拦）。
    //    两边一旦漂移，模型会收到「schema 说可以、实际被拒」或者反过来的错配。
    const schemaList = (EDITOR_TOOLS.find((t) => t.name === 'scene.script').inputSchema.properties.method.enum) || [];
    const m = handlersSrc.match(/const ALLOWED = \[([^\]]+)\]/);
    assert.ok(m, '解析不到 bridge 侧 scene.script 的 ALLOWED 白名单');
    const bridgeList = m[1]
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
    assert.deepStrictEqual(
        [...schemaList].sort(),
        [...bridgeList].sort(),
        'scene.script 的 method 名单两边不一致（schema 与 Bridge 实现必须同步）'
    );
    assert.ok(schemaList.length > 0, '白名单不能为空');
});

test('每个工具声明的 inputSchema 都是自洽的', () => {
    // ⚠️ 声明了却**从不执行**的 schema 是假的承诺（参数校验现在真的执行了，
    //    所以 schema 自相矛盾会直接变成「合法的调用被拒」）。
    for (const t of [...EDITOR_TOOLS, ...GLOBAL_TOOLS]) {
        const s = t.inputSchema || {};
        for (const key of s.required || []) {
            assert.ok(
                (s.properties || {})[key] !== undefined,
                `${t.name} 的 required 里有 "${key}"，但 properties 里没声明它`
            );
        }
        for (const [key, spec] of Object.entries(s.properties || {})) {
            if (spec.enum) {
                assert.ok(spec.enum.length > 0, `${t.name}.${key} 的 enum 是空的`);
            }
        }
        if (t.safety === 'danger') {
            assert.ok(
                (s.required || []).includes('confirm'),
                `${t.name} 是破坏性操作但 required 里没有 confirm`
            );
        }
    }
});

test('每个 handler 读取的参数都已在 schema 里声明（否则参数校验会误伤）', () => {
    // ⚠️ 参数校验现在真的会执行 —— 所以 handler 里读了、schema 却没声明的参数，
    //    会被当成「未知参数」把**合法调用**拒掉。
    //    这条断言就是防这个的（真踩过：scene.transaction 的 op.args.confirm
    //    一度被当成工具自身的参数）。
    //
    // ⚠️ 正则只匹配**工具自身的** args.X：
    //    `op.args.confirm` 这种嵌套 op 的参数不算（用负向断言排除）。
    const RE = /(?<![\w.$])args\.([A-Za-z_][A-Za-z0-9_]*)/g;
    for (const t of [...EDITOR_TOOLS, ...GLOBAL_TOOLS]) {
        if (!t.handler) continue;
        const declared = new Set(Object.keys((t.inputSchema || {}).properties || {}));
        const body = String(t.handler);
        const used = new Set([...body.matchAll(RE)].map((m) => m[1]));
        const missing = [...used].filter((k) => !declared.has(k));
        assert.deepStrictEqual(
            missing,
            [],
            `${t.name} 的 handler 读了未在 schema 里声明的参数：${missing.join('、')}（会被参数校验当成「未知参数」拒掉）`
        );
    }
});

test('工具 schema 必须覆盖 Bridge 侧真正支持的参数', () => {
    // ⚠️ 工具是把 args **原样透传**给 Bridge op 的 ——
    //    所以 Bridge 读的每一个参数，都应该在 schema 里声明，
    //    否则用户传了它会被参数校验当成「未知参数」硬拒（-32602）。
    //
    //    真踩过 6 处：scene.node(raw) / node.create(components, position, type,
    //    canvasRequired) / asset.query(dataKeys) / asset.info(dataKeys) /
    //    asset.dependencies(type) / scene.classes(options)。
    //
    //    比对逻辑放在 scripts/check-schema-args.js（可单独跑），
    //    那里用「顶层键切分」精确取每个 op 的源码 —— 用正则配对大括号会错位，
    //    把相邻 op 的参数算进来。
    const { extractOpBodies, argsUsed, hasDestructuring } = require('../scripts/check-schema-args');
    const ops = extractOpBodies(read('extension/bridge/handlers.js'));
    const problems = [];
    for (const t of EDITOR_TOOLS) {
        if (!t.op) continue;
        const body = ops.get(t.op);
        if (!body) {
            problems.push(`${t.name} → op "${t.op}" 在 handlers.js 里找不到`);
            continue;
        }
        // ⚠️ 解构式读取参数正则抓不到 —— 宁可吵，也不能让检查器**静默失效**
        if (hasDestructuring(body)) {
            problems.push(`${t.name} (op ${t.op}) 用了解构式读取参数，自动检查抓不到，需人工确认`);
            continue;
        }
        const declared = new Set(Object.keys((t.inputSchema || {}).properties || {}));
        const missing = argsUsed(body).filter((k) => !declared.has(k));
        if (missing.length) {
            problems.push(`${t.name} (op ${t.op}) → ${missing.join('、')}`);
        }
    }
    assert.deepStrictEqual(problems, [], '这些参数 Bridge 支持但 schema 没声明：\n  - ' + problems.join('\n  - '));
});

test('工具 schema 里没有重复 key（重复会被后写的静默覆盖）', () => {
    // ⚠️ JS 对象字面量里同一个 key 写两次，**后写的覆盖先写的** ——
    //    运行时对象里重复信息已经丢了，从对象上看不出来。
    //    真实踩过：node.create 的 properties 里 type/position/components 各写了两次，
    //    新加的描述全被丢弃，模型看到的仍是旧的（而且是错的那条）。
    //    而且这类问题**不会被任何基于「key 集合」的比对发现**。
    const { findDuplicateKeys } = require('../scripts/check-dup-schema-keys');
    const problems = [];
    for (const f of ['hub/src/tools/editor-tools.js', 'hub/src/tools/global-tools.js']) {
        for (const d of findDuplicateKeys(read(f))) {
            problems.push(`${f}:${d.second} "${d.key}" 重复（第 ${d.first} 行已写过）`);
        }
    }
    assert.deepStrictEqual(problems, [], 'schema 里有重复 key：\n  - ' + problems.join('\n  - '));
});

test('重复 key 检查器要能抓到「跨行展开」形态（那才是常见形态）', () => {
    // ⚠️ 之前的实现有个致命漏检：深度在**匹配 key 之前**就更新了，
    //    于是 `position: {` 这种跨行展开的行，自己就不算「第一层 key」
    //    → 第一次出现没被记进 seen → 重复也报不出来。
    //    而跨行展开恰恰是写 schema 时最常见的形态。
    //    （实测：旧版对真实的「修复前」文件只报出 3 处里的 1 处。）
    const { findDuplicateKeys } = require('../scripts/check-dup-schema-keys');
    // ⚠️ 缩进必须和真实文件一致（properties 的第一层 key 是 16 个空格）——
    //    检查器就是按「第一层缩进 + 深度」判定 key 的。
    const src = [
        "const T = () => ({",
        "    inputSchema: {",
        "        type: 'object',",
        "        properties: {",
        "            parent: { type: 'string' },",
        "            position: {",
        "                type: 'object',",
        "                properties: { x: { type: 'number' } },",
        "            },",
        "            name: { type: 'string' },",
        "            position: { type: 'object' },",
        "        },",
        "    },",
        "});",
    ].join('\n').replace(/^ {12}(?=[a-zA-Z_])/gm, '                ');
    const dupes = findDuplicateKeys(src);
    const keys = dupes.map((d) => d.key).sort();
    assert.deepStrictEqual(keys, ['position'], '跨行展开的重复 key 必须被抓到');
});

test('README 的工具清单与实际工具一致', () => {
    const all = [...EDITOR_TOOLS, ...GLOBAL_TOOLS];
    // README 里写的工具数量
    const m = readme.match(/## 工具清单（(\d+) 个）/);
    assert.ok(m, 'README 里找不到「## 工具清单（N 个）」标题');
    assert.strictEqual(Number(m[1]), all.length, `README 写 ${m[1]} 个，实际 ${all.length} 个`);

    // README 里逐个列出的工具名都必须真实存在
    const names = new Set(all.map((t) => t.name));
    const listed = new Set();
    for (const mm of readme.matchAll(/`([a-z][a-zA-Z0-9_]*\.[a-zA-Z0-9_.]+)`/g)) {
        // 跳过「多编辑器前缀」的示例写法（如 forest__scene.tree），那不是真实工具名
        if (mm[1].includes('__')) continue;
        listed.add(mm[1]);
    }
    const missing = [...listed].filter((n) => !names.has(n));
    assert.deepStrictEqual(missing, [], 'README 提到了不存在的工具：' + missing.join(', '));
});

test('README 提到的每个测试脚本都真实存在', () => {
    for (const mm of readme.matchAll(/npm run (test[\w:]*)/g)) {
        const script = mm[1];
        const pkg = JSON.parse(read('package.json'));
        assert.ok(pkg.scripts[script], `README 提到 npm run ${script}，但 package.json 里没有`);
    }
});

test('README 的验证章节：脚本存在，且可静态验证的数字与代码一致', () => {
    const pkg = JSON.parse(read('package.json'));
    for (const key of ['test', 'test:e2e', 'test:smoke', 'test:real']) {
        assert.ok(pkg.scripts[key], `package.json 缺脚本 ${key}`);
    }
    // 三层验证脚本引用的文件必须存在
    for (const f of [
        'test/e2e.js',
        'test/tool-smoke.js',
        'test/real-behavior.js',
        'hub/test/transaction.test.js',
        'hub/src/offline/test/offline.test.js',
    ]) {
        assert.ok(fs.existsSync(path.join(ROOT, f)), `缺少 ${f}`);
    }
    // README 的命令清单里必须提到每一个脚本入口 ——
    // 只查「README 提到的文件存在」不查反方向，脚本会悄悄从文档里消失。
    for (const cmd of ['npm test', 'npm run test:e2e', 'npm run test:smoke', 'npm run test:real']) {
        assert.ok(readme.includes(cmd), `README 的命令清单里没有 ${cmd}`);
    }
    // ⚠️ **可静态验证的数字**必须与代码一致。
    //    「覆盖全部 N 个工具」里的 N 是代码决定的，README 写错就该报错。
    //    （各层测试的通过数是**运行时结果**，不在这条断言的范围 ——
    //     把运行结果写进断言只会让它必然腐坏。）
    const all = [...EDITOR_TOOLS, ...GLOBAL_TOOLS];
    const cov = readme.match(/覆盖全部\s*(\d+)\s*个工具/);
    assert.ok(cov, 'README 里找不到「覆盖全部 N 个工具」这句话');
    assert.strictEqual(
        Number(cov[1]),
        all.length,
        `README 写「覆盖全部 ${cov[1]} 个工具」，实际有 ${all.length} 个`
    );
});

test('★ 扩展端实际发出的每个消息都必须在 3.8.8 契约里', () => {
    // ⚠️ 这条守的是「用了 3.8.8 上**不存在**的消息」——
    //    那种错只在**真机调用时**才炸（编辑器直接不回/报 not found），
    //    而扩展端的 catch 往往把它包成一句含糊的错，排查成本很高。
    //
    //    契约表在 extension/bridge/messages.js（3.8.8 的 app.asar 逆向出来的），
    //    verify() 是它的判定入口 —— 扩展端发消息前本来就过它，
    //    这里做的是**离线静态核对**：全部用到的消息现在就应该是合法的。
    const src = read('extension/bridge/handlers.js');
    const used = new Map();
    // ⚠️ 消息名要允许**数字**（`[a-z0-9-]+`）——
    //    只匹配字母的话，含数字的消息名会被**整条漏掉**，
    //    契约检查就成了「只查一部分」。
    for (const re of [/send\(\s*'([a-z0-9-]+)'\s*,\s*'([a-z0-9-]+)'/g, /Editor\.Message\.request\(\s*'([a-z0-9-]+)'\s*,\s*'([a-z0-9-]+)'/g]) {
        let m;
        while ((m = re.exec(src))) used.set(`${m[1]}:${m[2]}`, (used.get(`${m[1]}:${m[2]}`) || 0) + 1);
    }
    assert.ok(used.size >= 40, `应该扫到不少消息调用，实际只扫到 ${used.size} 个`);

    // ⚠️ **不能用变量拼出来的消息名** ——
    //    上面的正则只认字面量；`send(ch, msg)` 这种写法会被**整条漏掉**，
    //    于是「契约检查通过」是**假象**（那一条调用根本没被查）。
    //    ⇒ 把所有非字面量的调用抓出来，而不是默默放过。
    //
    //    唯一的例外是 `cocos_message` 的**透传**路径（channel/message 来自用户）——
    //    它靠**运行时**的白名单把关：send() 内部第一件事就是 verify()。
    //    所以这里要求：透传路径上必须真的有 verify(args.channel, args.message)。
    const hasRuntimeWhitelist = /verify\(\s*args\.channel\s*,\s*args\.message\s*\)/.test(src);
    const dynamic = [];
    for (const m of src.matchAll(/\bsend\s*\(/g)) {
        const tail = src.slice(m.index + m[0].length, m.index + m[0].length + 160);
        // ⚠️ 必须**两个参数都是字面量**才算「已扫到」——
        //    只看第一个参数会漏掉「频道是字面量、消息名是变量」这种
        //    （那正是最容易在重构时被写出来的形状）。
        if (/^\s*'[^']*'\s*,\s*'[^']*'/.test(tail)) continue;
        if (/^\s*\)/.test(tail)) continue;        // 无参调用（不可能，但别误报）
        if (/^\s*channel\s*,\s*message/.test(tail)) continue;  // 函数定义本身
        if (/^\s*args\.channel\s*,\s*args\.message/.test(tail)) {
            // 透传路径 —— 靠运行时 verify() 把关
            assert.ok(
                hasRuntimeWhitelist,
                'cocos_message 的透传路径必须有运行时的 verify(args.channel, args.message) 把关'
            );
            continue;
        }
        dynamic.push(tail.split('\n')[0].slice(0, 60));
    }
    assert.deepStrictEqual(
        dynamic,
        [],
        `这些 send() 调用不是字面量，静态契约检查覆盖不到：\n  ${dynamic.join('\n  ')}`
    );
    const bad = [];
    for (const key of used.keys()) {
        const i = key.indexOf(':');
        const v = verify(key.slice(0, i), key.slice(i + 1));
        if (!v.ok) bad.push(`${key} —— ${v.reason}`);
    }
    assert.deepStrictEqual(bad, [], `扩展端用了 3.8.8 契约之外的消息：\n  ${bad.join('\n  ')}`);
});

test('SOURCES.md 列出的每个调研仓库都真实存在对应引用', () => {
    const repos = [
        'DaxianLee/cocos-mcp-server',
        'listar/cocos-mcp-server',
        'harady/cocos-creator-mcp',
        'HappyLifeOk/cc-3-8-x-mcp',
        'JoseeRen/cc-3-8-x-mcp',
        'shiliyu1991-lang/cocos-mcp-3x',
        'lwsinclair/cocosMCP',
        'czh2774/cocosMCP',
    ];
    for (const r of repos) {
        assert.ok(sources.includes(r), `SOURCES.md 未提到 ${r}`);
        assert.ok(notice.includes(r), `NOTICE 未提到 ${r}`);
    }
    assert.ok(sources.includes('VberAI'), 'SOURCES.md 未提到闭源商业产品 VberAI');
});

test('SOURCES.md 声明了「未复制第三方代码」且给出核查数据', () => {
    assert.ok(/没有从上述任何项目复制代码|未复用任何代码/.test(sources), 'SOURCES.md 缺少原创性声明');
    assert.ok(/\d+\.\d+%/.test(sources), 'SOURCES.md 缺少核查数据');
    // 声明了「无许可证项目未使用其代码」
    assert.ok(/无 LICENSE|未附带许可证/.test(sources), 'SOURCES.md 未处理无许可证项目');
});

test('NOTICE 覆盖了所有调研来源', () => {
    for (const kw of ['DaxianLee', 'listar', 'harady', 'HappyLifeOk', 'JoseeRen', 'shiliyu1991-lang', 'lwsinclair', 'czh2774']) {
        assert.ok(notice.includes(kw), `NOTICE 缺少 ${kw}`);
    }
});

test('LICENSE 是 MIT 且 NOTICE 存在', () => {
    const lic = read('LICENSE');
    assert.ok(/MIT License/i.test(lic), 'LICENSE 不是 MIT');
    assert.ok(lic.includes('Permission is hereby granted, free of charge'), 'LICENSE 缺少 MIT 正文');
    assert.ok(notice.length > 200, 'NOTICE 内容过短');
});

// ────────────────────────────── 缓存失效完整性 ──────────────────────────────

test('所有会改场景的 op 都调用了 invalidateTree()', () => {
    // 列出 handlers.js 中所有会写场景的 op
    // ⚠️ 这份清单必须覆盖**所有**会改场景的 op。
    //    本轮恰恰给 node.clipboard / component.call / message 补了 invalidateTree()，
    //    而这三个不在原清单里 —— 删掉它们的失效调用，测试照样全绿。
    const MUTATING = [
        'node.create', 'node.delete', 'node.move', 'node.duplicate', 'node.active', 'node.transform',
        'node.clipboard',            // paste 会新建节点
        'component.add', 'component.remove', 'component.set',
        'component.call',            // 组件方法可能改场景
        'message',                   // 原始透传，可写
        'scene.script',              // 场景进程脚本可写
        'scene.open', 'scene.save', 'scene.close', 'scene.reload',
    ];
    for (const op of MUTATING) {
        const body = extractHandlerBody(handlersSrc, op);
        assert.ok(body, `找不到 op ${op}`);
        assert.ok(
            body.includes('invalidateTree()'),
            `${op} 会改场景但没调 invalidateTree() —— 2 秒 TTL 缓存会返回旧数据`
        );
    }
});

// ────────────────────────────── 离线模块契约 ──────────────────────────────

test('离线模块导出契约完整', () => {
    const off = require('../hub/src/offline');
    for (const fn of ['listOps', 'queryPrefab', 'editPrefab', 'batchPrefab', 'queryAnimation', 'editAnimation']) {
        assert.strictEqual(typeof off[fn], 'function', `离线模块缺 ${fn}`);
    }
    const ops = off.listOps();
    assert.ok(ops.length >= 30, `离线 op 太少：${ops.length}`);
    for (const o of ops) {
        assert.ok(o.name && Array.isArray(o.required) && Array.isArray(o.optional) && o.description, `op schema 不全：${o.name}`);
        assert.ok(typeof o.mutates === 'boolean', `op ${o.name} 缺 mutates`);
    }
    const names = ops.map((o) => o.name);
    assert.strictEqual(new Set(names).size, names.length, '离线 op 名称重复');
});

test('cocos_prefab_ops / cocos_anim_ops 的返回与实际 op 集合一致', async () => {
    const off = require('../hub/src/offline');
    const prefabTool = GLOBAL_TOOLS.find((t) => t.name === 'cocos_prefab_ops');
    const animTool = GLOBAL_TOOLS.find((t) => t.name === 'cocos_anim_ops');
    assert.ok(prefabTool, '缺 cocos_prefab_ops 工具');
    assert.ok(animTool, '缺 cocos_anim_ops 工具');

    const ctx = { listEditors: () => [] };
    const pr = await prefabTool.handler({}, ctx);
    const an = await animTool.handler({}, ctx);
    // ⚠️ 不能只断言 pr.count === listOps('prefab').length ——
    //    工具 handler 内部就是 listOps('prefab')，两边是同一个值，恒真。
    //    要断言的是「两个域加起来 == 全部」以及「每个 op 的 domain 与来源一致」。
    // ⚠️ 不要断言「prefab + anim === 全部」——
    //    listOps() 的实现本身就是「建一个数组、每项打 domain 标签、再按 domain 过滤」，
    //    那条等式是**构造上的恒等式**，写出来只是自我安慰。
    //    真正有效的是**与真源交叉校验**：工具返回的 op 集合必须恰好等于
    //    ops.js 的 OP_DEFS / anim.js 的 ANIM_OP_DEFS 的键集合。
    const { OP_DEFS: PREFAB_DEFS } = require('../hub/src/offline/ops');
    const { ANIM_OP_DEFS: ANIM_DEFS } = require('../hub/src/offline/anim');
    assert.deepStrictEqual(
        pr.ops.map((o) => o.name).sort(),
        Object.keys(PREFAB_DEFS).sort(),
        'cocos_prefab_ops 返回的 op 集合必须与 OP_DEFS 完全一致'
    );
    assert.deepStrictEqual(
        an.ops.map((o) => o.name).sort(),
        Object.keys(ANIM_DEFS).sort(),
        'cocos_anim_ops 返回的 op 集合必须与 ANIM_OP_DEFS 完全一致'
    );
    // 每个 op 的 domain 标记必须与它来自哪个表一致
    for (const o of pr.ops) assert.strictEqual(o.domain, 'prefab', `op ${o.name} 的 domain 应为 prefab`);
    for (const o of an.ops) assert.strictEqual(o.domain, 'anim', `op ${o.name} 的 domain 应为 anim`);
    // 每个声明的 op 都必须有执行器（否则是「注册了但调不到」）
    const { HANDLERS } = require('../hub/src/offline/ops');
    const { ANIM_HANDLERS } = require('../hub/src/offline/anim');
    for (const name of Object.keys(PREFAB_DEFS)) {
        assert.ok(HANDLERS[name], `prefab op "${name}" 没有执行器`);
    }
    for (const name of Object.keys(ANIM_DEFS)) {
        assert.ok(ANIM_HANDLERS[name], `anim op "${name}" 没有执行器`);
    }
    for (const name of Object.keys(HANDLERS)) {
        assert.ok(PREFAB_DEFS[name], `执行器 "${name}" 没有在 op 表里声明`);
    }
    for (const name of Object.keys(ANIM_HANDLERS)) {
        assert.ok(ANIM_DEFS[name], `anim 执行器 "${name}" 没有在 op 表里声明`);
    }
    // 两个工具不能互相串味
    assert.ok(pr.ops.every((o) => !off.listOps('anim').some((a) => a.name === o.name)), 'prefab 工具混入了 anim op');
    assert.ok(an.ops.every((o) => !off.listOps('prefab').some((p) => p.name === o.name)), 'anim 工具混入了 prefab op');
    // 每个 op 都带 domain
    for (const o of [...pr.ops, ...an.ops]) assert.ok(o.name, 'op 缺 name');
});

test('README 工具清单是自动生成的（内容与代码一致）', () => {
    const { execFileSync } = require('child_process');
    try {
        execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'gen-readme-tools.js'), '--check'], {
            cwd: ROOT,
            stdio: 'pipe',
        });
    } catch (e) {
        const msg = (e.stderr && e.stderr.toString()) || e.message;
        assert.fail(msg.trim() || 'README 工具清单与代码不一致');
    }
});

// ────────────────────────────── 路径护栏 ──────────────────────────────

test('路径护栏拒绝越界路径', () => {
    const { assertInsideProject } = require('../hub/src/tools/global-tools');
    const ctx = { listEditors: () => [{ projectPath: '/tmp/proj-a' }] };
    assert.ok(assertInsideProject(ctx, '/tmp/proj-a/assets/x.prefab'), '项目内路径应放行');
    assert.throws(() => assertInsideProject(ctx, '/etc/passwd'), /不在任何一个已注册的 Cocos 项目目录内/);
    assert.throws(() => assertInsideProject(ctx, '/tmp/proj-a/../proj-b/x.prefab'), /不在任何一个已注册的 Cocos 项目目录内/);
    assert.throws(() => assertInsideProject(ctx, '/tmp/proj-b/x.prefab'), /不在任何一个已注册的 Cocos 项目目录内/);
});

test('没有已注册项目时，路径护栏一律拒绝（不静默放行）', () => {
    const { assertInsideProject } = require('../hub/src/tools/global-tools');
    const ctx = { listEditors: () => [] };
    assert.throws(() => assertInsideProject(ctx, '/tmp/anything.prefab'), /没有已知的 Cocos 项目目录/);
});

// ────────────────────────────── 单测清单 ──────────────────────────────

test('★ 单测清单用通配（新增测试文件自动纳入）+ 真机脚本必须带守卫', () => {
    // ⚠️ 真机脚本**不叫 .test.js** ——
    //    `node --test`（不传文件参数）会**自动发现** test/ 下所有 *.test.js。
    //    真机脚本要是叫 *.test.js，一次手滑的 `node --test` 就会
    //    把它跑起来 —— 连带去连本机开着的 Cocos Creator（第 8 轮复审真踩到了）。
    //    ⇒ 真机脚本统一叫 `xxx.js`，单测统一叫 `xxx.test.js`。
    const files = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.test.js'));
    assert.ok(files.length >= 3, 'test/ 下应该有多份单测');
    // 反过来：**真机脚本**必须带守卫 ——
    //    `node --test`（不带路径）会把 test/ 下**所有 .js** 都自动发现并执行，
    //    真机脚本要是没有守卫，就会意外连上本机开着的 Cocos Creator、
    //    动用户的工程（第 8 轮独立复审真踩到了两次，且无法 100% 证明没碰到）。
    for (const f of ['e2e.js', 'tool-smoke.js', 'real-behavior.js']) {
        const src = read(`test/${f}`);
        assert.match(
            src,
            /process\.env\.NODE_TEST_CONTEXT/,
            `test/${f} 是真机脚本，必须在 NODE_TEST_CONTEXT 下立刻退出` +
            '（否则 node --test 的自动发现会意外连上本机开着的编辑器）'
        );
    }
    // 单测清单用通配 `test/*.test.js` → 新增的测试文件**自动**被纳入，
    // 不会再出现「忘了加进清单 → 静默不跑」。
    const pkg = JSON.parse(read('package.json'));
    assert.match(pkg.scripts.test, /test\/\*\.test\.js/, '单测清单必须用通配，新测试文件才会自动被纳入');
});

test('★ README 描述的单测范围要跟 package.json 实际跑的一致', () => {
    // 两边必须**同时**是通配，或同时是显式清单 ——
    // 不一致会让人以为新加的测试文件会自动被跑（其实不会，静默不跑）。
    const pkg = JSON.parse(read('package.json'));
    const script = pkg.scripts.test;
    const readmeSaysGlob = /test\/\*\.test\.js/.test(readme);
    const scriptUsesGlob = /test\/\*\.test\.js/.test(script);
    assert.strictEqual(
        readmeSaysGlob,
        scriptUsesGlob,
        'README 描述的单测范围与 package.json 实际跑的不一致（一个用通配、一个用显式清单）'
    );
    // 并且：单测清单里不该出现真机脚本
    assert.ok(
        !/real-behavior/.test(script),
        '单测清单里不该有真机脚本（它要开着 Cocos Creator 才跑得了）'
    );
});

test('★ 知识库不能把 rotation 说成四元数（引擎要的是欧拉角 cc.Vec3）', () => {
    // ⚠️ 背景：调研报告 6.x 有真机 dump 佐证 ——
    //    "rotation": {"name":"eulerAngles","value":{"x":-117.9,...},"type":"cc.Vec3"}
    //    知识库却教模型用 {x,y,z,w} 四元数 → inferDump 判成 cc.Vec4，
    //    而属性是 cc.Vec3 → 类型对不上，模型照着做就错。
    const kb = read('hub/src/knowledge/cocos-knowledge.json');
    const rules = (JSON.parse(kb).coordinates.uiLocalVsWorld.rules || []).join('\n');
    // ⚠️ 判据用**具体的假命题**，不用「出现四元数就算错」——
    //    正确写法里也会提到「不是四元数」以提醒模型（那是提醒，不是教法）。
    for (const lie of ['rotation 是四元数', 'rotation 是四元数；', '用四元数表示']) {
        assert.ok(!rules.includes(lie), `知识库不要说「${lie}」—— 引擎的 rotation 是欧拉角（cc.Vec3，度）`);
    }
    assert.ok(!/sin\(r\/2\)|cos\(r\/2\)/.test(rules), '知识库不能给四元数的换算公式（照着做引擎会收到 cc.Vec4）');
    assert.match(rules, /rotation[^\n]*欧拉角/, '知识库应说明 rotation 是欧拉角');
});

test('★ 工具描述不能承诺代码没做的事（node.transform 曾说「内部转成四元数」）', () => {
    const { EDITOR_TOOLS } = require('../hub/src/tools/editor-tools');
    const t = EDITOR_TOOLS.find((x) => x.name === 'node.transform');
    assert.ok(t, 'node.transform 必须存在');
    // ⚠️ 同上：用**具体的假命题**做判据（正确写法里也会出现「不是四元数」以作提醒）。
    assert.ok(
        !/内部转成四元数/.test(t.description),
        'node.transform 的描述不能承诺「内部转成四元数」—— 代码只把数字转成欧拉角 {x:0,y:0,z:角度}'
    );
    assert.match(t.description, /欧拉角/, '描述应说清引擎要的是欧拉角');
});

test('★ node.create 的描述不能承诺「自动补 UITransform」（那条路径上没有这个逻辑）', () => {
    // ⚠️ 自动补 UITransform 的逻辑只在 extension/scene.js 的 METHODS.createNode
    //    （scene.script 走的引擎级路径）里；
    //    node.create op 走的是 scene:create-node 编辑器消息，**那条路径上没有**。
    //    模型照描述以为会自动补 → 建出来的 UI 节点缺 UITransform → 设尺寸/锚点失败。
    const { EDITOR_TOOLS } = require('../hub/src/tools/editor-tools');
    const t = EDITOR_TOOLS.find((x) => x.name === 'node.create');
    assert.ok(t, 'node.create 必须存在');
    // ⚠️ 判据用**具体的假命题** —— 正确写法里也会出现「自动补 UITransform」
    //    作为**否定**（"**不会**自动补"），那是提醒，不是承诺。
    assert.ok(
        !/会自动补\s*UITransform/.test(t.description),
        'node.create 的描述不能承诺「会自动补 UITransform」—— 那条路径上没有这个逻辑'
    );
    assert.match(t.description, /不会[^\n]*UITransform/, '描述应明确说明不会自动补');
    assert.match(t.description, /components/, '描述应提示显式传 components');
});

test('★ 资源类 op 必须都过 requireAssetUrl（asset.copy 曾是同族里唯一的例外）', () => {
    // ⚠️ 同族的 move/create/save/delete 都过 requireAssetUrl，
    //    只有 copy 没有 —— 等于把「复制任意路径」的能力透给模型。
    const src = read('extension/bridge/handlers.js');
    for (const op of ['asset.create', 'asset.save', 'asset.move', 'asset.delete', 'asset.copy']) {
        const i = src.indexOf(`'${op}':`);
        assert.ok(i >= 0, `找不到 op ${op}`);
        const body = src.slice(i, i + 900);
        assert.match(
            body,
            /requireAssetUrl\(/,
            `${op} 必须过 requireAssetUrl（否则等于把任意路径透给编辑器）`
        );
    }
});
