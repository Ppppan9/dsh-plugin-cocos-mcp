'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { realpathBestEffort, isInsideAnyRoot } = require('../util/path-guard');

/**
 * 全局工具（不需要编辑器在线）
 * ---------------------------------------------------------------------------
 *   - cocos_knowledge：Cocos 知识库（组件属性表 / 坐标系 / 布局配方 / 踩坑清单）
 *   - cocos_prefab_*   ：离线 prefab 读写
 *   - cocos_anim_*     ：离线动画读写
 *
 * 离线能力的意义：编辑器关着也能改 prefab；批量改 prefab 不用反复走编辑器 UI；
 * 改 prefab 文件不会被编辑器用旧内存数据覆盖。
 */

const KNOWLEDGE = require('../knowledge/cocos-knowledge.json');
const EDITOR_MESSAGES = require('../knowledge/editor-messages.json');

/**
 * `cocos_knowledge` 的**全部**合法 topic（唯一真相）。
 *
 * ⚠️ 为什么要单列一份：enum 与 index 返回的 topic 列表**必须一致** ——
 *    之前 index 直接 `Object.keys(KNOWLEDGE)`，把知识库 JSON 里的 `version`
 *    也列了出来，而 enum 不接受它 ⇒ 模型照着 index 调 `topic=version` 就被拒
 *    （「声明 ≠ 能用」，第 11 轮复审 G-4）。
 */
const KNOWLEDGE_TOPICS = ['components', 'coordinates', 'layout', 'workflow', 'traps', 'messages', 'all', 'index'];

/**
 * index 返回的 topic 列表 = **真正查得到内容**的那些。
 * ⚠️ 用「enum ∩ 知识库实际有的键」算出来，而不是手写 ——
 *    手写就会和 enum / 知识库内容**三处漂移**。
 *    （`version` 是知识库 JSON 里的元信息键，不是可查询主题 → 自动被排除。）
 */
const KNOWLEDGE_INDEX_TOPICS = KNOWLEDGE_TOPICS.filter(
    (t) => t === 'messages' || t === 'all' || t === 'index' || Object.prototype.hasOwnProperty.call(KNOWLEDGE, t)
);

/**
 * 按名字找组件，支持 `cc.Label` / `Label` / `label` 三种写法。
 *
 * ⚠️ 之前只做**全名**匹配（`k.toLowerCase() === component.toLowerCase()`），
 *    于是 `component: 'Label'` 匹配不到 `cc.label` ⇒ 走进「查不到」分支
 *    （第 11 轮复审 G-5）。
 *
 * @param {string} name 用户给的组件名
 * @returns {string|null} 知识库里的真实键名（如 `cc.label`）
 */
function findComponentKey(name) {
    const wanted = String(name).trim().toLowerCase();
    if (!wanted) return null;
    const keys = Object.keys(KNOWLEDGE.components);
    return (
        keys.find((k) => k.toLowerCase() === wanted) ||
        keys.find((k) => k.toLowerCase() === `cc.${wanted}`) ||
        keys.find((k) => k.toLowerCase().endsWith(`.${wanted}`)) ||
        null
    );
}

const { T } = require('./schema');

// ─────────────────────────────────────────────────────────────
// 路径护栏：所有离线文件操作必须落在某个已知项目目录内
// ─────────────────────────────────────────────────────────────

function projectRoots(ctx) {
    const roots = new Set();
    for (const e of ctx.listEditors()) {
        if (e.projectPath) roots.add(path.resolve(e.projectPath));
    }
    if (ctx.extraRoots) for (const r of ctx.extraRoots) roots.add(path.resolve(r));
    // 环境变量：允许额外的根目录（美术共享库、跨项目的公共资源目录等）
    // 格式：冒号分隔的**绝对路径**，例 COCOS_MCP_EXTRA_ROOTS="/Users/x/ArtLib:/Users/x/Shared"
    const env = process.env.COCOS_MCP_EXTRA_ROOTS;
    if (env) {
        for (const part of env.split(':').map((x) => x.trim()).filter(Boolean)) {
            // 只支持 `~`（当前用户家目录），不支持 `~user`（其它用户家目录）
            // —— 展开 `~user` 会得到一个看似合法的路径，静默放进白名单反而更危险。
            if (/^~[^/\\]/.test(part)) {
                throw new Error(
                    `COCOS_MCP_EXTRA_ROOTS 里的 "${part}" 不是合法的路径：` +
                    '只支持 `~`（当前用户家目录）或绝对路径，不支持 `~其它用户` 形式。'
                );
            }
            const expanded = part.startsWith('~/') || part === '~'
                ? path.join(os.homedir(), part.slice(1))
                : part;
            if (!path.isAbsolute(expanded)) {
                // 相对路径会按 cwd 解析 —— 进程工作目录不确定，静默接受等于白给。
                throw new Error(
                    `COCOS_MCP_EXTRA_ROOTS 里的 "${part}" 不是绝对路径。` +
                    '请写成绝对路径（可用 ~ 表示当前用户家目录）。'
                );
            }
            roots.add(path.resolve(expanded));
        }
    }
    return [...roots];
}

/**
 * 断言 target 落在某个项目根目录内。
 * 防的是「模型给一个 /etc/passwd 或 ~/.ssh/id_rsa，让工具去读/写」，
 * 以及通过**符号链接**绕过。
 */
function assertInsideProject(ctx, target, label = '文件路径') {
    const resolved = path.resolve(target);
    const roots = projectRoots(ctx);
    if (!roots.length) {
        throw new Error(
            `没有已知的 Cocos 项目目录，拒绝执行离线文件操作。` +
            `请先用 cocos_prefab_* 之外的方式确认项目路径，或先打开 Cocos Creator（扩展会注册项目目录）。`
        );
    }
    // 词法判断 + 真实路径判断，两者都要过（realpath 感知，防符号链接逃逸）
    if (isInsideAnyRoot(resolved, roots)) {
        return resolved;
    }
    throw new Error(
        `${label} "${resolved}" 不在任何一个已注册的 Cocos 项目目录内（允许的项目根：${roots.join('、')}）。已拒绝。` +
        '如需操作项目外的目录，设置环境变量 COCOS_MCP_EXTRA_ROOTS="/你的/目录1:/你的/目录2" 后重启 MCP。'
    );
}

/** 离线模块懒加载：worker 产出前也能正常启动。 */
let offlineModule = null;
let offlineError = null;
function getOffline() {
    if (offlineModule || offlineError) return offlineModule;
    try {
        offlineModule = require('../offline');
    } catch (e) {
        offlineError = e;
        offlineModule = null;
    }
    return offlineModule;
}

function requireOffline() {
    const m = getOffline();
    if (!m) {
        throw new Error(`离线 prefab/animation 模块不可用：${offlineError ? offlineError.message : '未安装'}`);
    }
    return m;
}

/**
 * 把离线模块的 `{ok:false, error}` 结果**转成真正的错误**。
 *
 * ⚠️ 事务型操作失败时必须让 MCP 层把 isError 置为 true ——
 *    之前离线编辑失败也返回「工具调用成功」，只是数据里带着 ok:false。
 *    模型/脚本如果只看 isError 就会以为改成功了 —— 这正是本项目
 *    反复强调的「假成功比报错更危险」。
 */
function assertOfflineOk(result, toolName) {
    if (result && result.ok === false) {
        throw new Error(`${toolName} 失败：${result.error || '未知原因'}`);
    }
    return result;
}

/**
 * 把离线模块的 `{ok, data}` 结果**拍平**成业务数据。
 *
 * ⚠️ 之前离线工具直接把 `{ok:true, data:{...}}` 交给模型，于是：
 *   cocos_prefab_query → {ok:true, data:{count, nodes}}   ← 要再取一层 .data
 *   scene.tree         → {count, nodes}                   ← 直接就是数据
 * 同一套工具面里两种形状，模型很容易取错字段。
 * 失败时抛错（见 assertOfflineOk），成功时直接返回业务数据 —— 与编辑器侧工具一致。
 */
function unwrapOffline(result, toolName) {
    assertOfflineOk(result, toolName);
    if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'data')) {
        return result.data;
    }
    return result;
}

// ─────────────────────────────────────────────────────────────
// 工具定义
// ─────────────────────────────────────────────────────────────

const GLOBAL_TOOLS = [
    T('cocos_knowledge', {
        title: 'Cocos 知识库',
        description:
            '查询 Cocos Creator 3.8.x 的实操知识，避免反复试错。topic 取值：\n' +
            '  components    —— 常用组件的属性表（cc.Label / cc.Sprite / cc.Button / cc.Layout / cc.ScrollView / cc.UITransform …）\n' +
            '  coordinates   —— 坐标系与锚点规则\n' +
            '  layout        —— 布局配方（横排、网格、九宫格、自适应）\n' +
            '  workflow      —— 推荐操作顺序\n' +
            '  traps         —— 已知踩坑清单\n' +
            '  messages      —— 3.8.8 已验证的编辑器消息清单（哪些频道/消息真实存在）\n' +
            '  all           —— 全部内容\n' +
            '不传 topic 返回索引。',
        inputSchema: {
            type: 'object',
            properties: {
                topic: {
                    type: 'string',
                    enum: KNOWLEDGE_TOPICS,
                    description: '要查询的知识主题',
                },
                component: { type: 'string', description: 'topic=components 时可指定具体组件，如 cc.Label' },
            },
        },
        handler: async (args) => {
            const topic = args.topic || 'index';
            if (topic === 'index') {
                // ⚠️ **只能列真正查得到的 topic** ——
                //    之前这里直接 `Object.keys(KNOWLEDGE)`，把知识库 JSON 里的
                //    `version` 也列了出来，而 enum 不接受它 ⇒
                //    模型先调 index 看到 "version"，再调 topic=version 就被拒
                //    （「声明 ≠ 能用」，第 11 轮复审 G-4）。
                return {
                    topics: KNOWLEDGE_INDEX_TOPICS,
                    hint: '传 topic 参数查询具体主题；components 主题还可传 component 参数精确到单个组件。',
                };
            }
            if (topic === 'messages') {
                return EDITOR_MESSAGES;
            }
            if (topic === 'all') {
                return { knowledge: KNOWLEDGE, messages: EDITOR_MESSAGES };
            }
            if (topic === 'components') {
                if (args.component) {
                    const key = findComponentKey(args.component);
                    if (!key) {
                        // ⚠️ **必须抛错，不能「成功 + 一个 error 字段」** ——
                        //    后者会让 MCP 层标 isError=false，
                        //    脚本只判 isError 就把失败当成功（本项目最忌讳的「假成功」）。
                        throw new Error(
                            `没有组件 "${args.component}" 的属性表。` +
                            `可用：${Object.keys(KNOWLEDGE.components).join('、')}`
                        );
                    }
                    return { component: key, ...KNOWLEDGE.components[key] };
                }
                return { components: KNOWLEDGE.components };
            }
            return { [topic]: KNOWLEDGE[topic] };
        },
    }),

    T('cocos_prefab_query', {
        title: '离线查询 prefab',
        description:
            '直接读 .prefab 文件（不需要编辑器运行）。\n' +
            'filePath 是 .prefab 文件的绝对路径，或项目内的相对路径。\n' +
            'selector 取值：tree（节点树）/ node（单节点详情）/ find（按名字找）/ field（查某个属性）/ overrides（查嵌套 prefab 的 override）。\n' +
            '嵌套 prefab 的节点会自动识别，输出带 isStub 标记。',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: { type: 'string', description: '.prefab 文件路径' },
                selector: {
                    type: 'string',
                    enum: ['tree', 'node', 'find', 'field', 'overrides'],
                    description: '查询方式',
                },
                target: { type: 'string', description: 'selector=node/find/field/overrides 时的目标（节点名或路径）' },
                maxDepth: { type: 'number', description: 'selector=tree 时的最大深度' },
            },
            required: ['filePath', 'selector'],
        },
        handler: async (args, ctx) => {
            const offline = requireOffline();
            const filePath = assertInsideProject(ctx, args.filePath, 'prefab 路径');
            return unwrapOffline(
                offline.queryPrefab({
                    filePath,
                    selector: args.selector,
                    target: args.target,
                    maxDepth: args.maxDepth,
                    // ⚠️ 必须传 —— 离线层的读路径护栏（queryPrefab 的自守）
                    //    只在拿到 allowedRoots 时才生效，不传就等于那道闸是死的。
                    allowedRoots: projectRoots(ctx),
                }),
                'cocos_prefab_query'
            );
        },
    }),

    T('cocos_prefab_edit', {
        title: '离线编辑 prefab',
        description:
            '声明式批量修改 .prefab 文件。**所有 op 全部成功才会落盘，任一失败磁盘零写入**（事务语义）。\n' +
            'ops 形如 [{"op":"set-label-text","node":"Title","text":"开始游戏"}]。\n' +
            '可用 op 列表见 cocos_prefab_ops 工具。\n' +
            'dryRun=true 只做校验并返回 diff，不写盘 —— 建议先 dryRun。\n' +
            '改完记得用 asset.reimport 通知编辑器。',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: { type: 'string', description: '.prefab 文件路径' },
                ops: { type: 'array', items: { type: 'object' }, description: '操作列表' },
                dryRun: { type: 'boolean', description: '只校验不落盘' },
            },
            required: ['filePath', 'ops'],
        },
        handler: async (args, ctx) => {
            const offline = requireOffline();
            const filePath = assertInsideProject(ctx, args.filePath, 'prefab 路径');
            assertOpPathsInsideProject(ctx, args.ops, 'op 内路径');
            return unwrapOffline(
                offline.editPrefab({
                    filePath,
                    ops: args.ops,
                    dryRun: !!args.dryRun,
                    allowedRoots: projectRoots(ctx),
                }),
                'cocos_prefab_edit'
            );
        },
        safety: 'write',
        // ⚠️ handler 型工具现在也会走 hub 的统一超时（默认 60s）。
        //    大 prefab 的批量改动可能超过，给足预算 —— 超时砍掉一个**正在写盘**的
        //    操作比慢更糟（调用方会以为失败，实际可能已经写完了）。
        timeoutMs: 120000,
    }),

    T('cocos_prefab_batch', {
        title: '离线批量编辑 prefab',
        description:
            '从 JSON 文件读取 ops 后批量编辑。opsJsonPath 是 JSON 文件的**绝对路径**（单文件或 {"files":[...]} 多文件形态）。\n' +
            '内容有两种形态：\n' +
            '  · 单文件：{"filePath": "<prefab 绝对路径>", "ops": [ ...op 数组... ]}\n' +
            '  · 多文件：{"files": [{"filePath": "...", "ops": [...]}, ...]}\n' +
            '多文件是**跨文件原子**的 —— 任一文件失败则整批不写盘（已写的会回滚）。\n' +
            '适合一次性改几十个 prefab 的重复性改动。事务语义同 cocos_prefab_edit。',
        inputSchema: {
            type: 'object',
            properties: {
                opsJsonPath: { type: 'string', description: '包含 ops 数组的 JSON 文件绝对路径' },
                dryRun: { type: 'boolean' },
            },
            required: ['opsJsonPath'],
        },
        handler: async (args, ctx) => {
            const offline = requireOffline();
            const opsJsonPath = assertInsideProject(ctx, args.opsJsonPath, 'ops 文件路径');
            // ⚠️ batch 的目标文件与 op 里的路径都来自**不可信的 JSON 文件** ——
            //    必须和 edit 一样接上 op 级护栏，否则项目 A 里的 ops.json
            //    能改写项目 B（甚至项目外）的文件。
            //
            // ⚠️ 检查必须在**写盘之前** ——
            //    之前这段读的是 `res.data.ops`，而 editPrefab / batchPrefab 的返回里
            //    **根本没有 ops 字段** → 这道护栏从来没生效过（看着有、其实没有）。
            //    现在改成先 peek 出 ops 清单，检查通过再交给离线层执行。
            const peeked = offline.peekBatchOps(opsJsonPath);
            if (peeked && peeked.ok && peeked.data) {
                const plan = peeked.data;
                const allOps = plan.mode === 'multi'
                    ? plan.files.map((f) => (f && Array.isArray(f.ops) ? f.ops : []))
                    : [plan.ops];
                for (const ops of allOps) assertOpPathsInsideProject(ctx, ops, 'op 内路径');
            }
            const res = offline.batchPrefab({
                opsJsonPath,
                dryRun: !!args.dryRun,
                allowedRoots: projectRoots(ctx),
            });
            return unwrapOffline(res, 'cocos_prefab_batch');
        },
        safety: 'write',
        // 一次改几十个 prefab，默认 60s 远远不够
        timeoutMs: 300000,
    }),

    T('cocos_prefab_ops', {
        title: '可用 prefab op 清单',
        description:
            '列出 cocos_prefab_edit / cocos_prefab_batch 支持的全部 **prefab** op、必填参数与可选参数。' +
            '不确定某个操作叫什么名字时先查这里。动画相关 op 见 cocos_anim_ops。不需要参数。',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => {
            const offline = getOffline();
            if (!offline) {
                return { error: '离线模块不可用', ops: [] };
            }
            const ops = offline.listOps('prefab');
            return {
                domain: 'prefab',
                count: ops.length,
                ops: ops.map((o) => ({
                    name: o.name,
                    domain: o.domain,
                    required: o.required,
                    optional: o.optional,
                    description: o.description,
                    mutates: o.mutates,
                })),
            };
        },
    }),

    T('cocos_anim_ops', {
        title: '可用动画 op 清单',
        description:
            '列出 cocos_anim_batch 支持的全部 **动画** op、必填参数与可选参数。' +
            'prefab 相关 op 见 cocos_prefab_ops。不需要参数。',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => {
            const offline = getOffline();
            if (!offline) {
                return { error: '离线模块不可用', ops: [] };
            }
            const ops = offline.listOps('anim');
            return {
                domain: 'anim',
                count: ops.length,
                ops: ops.map((o) => ({
                    name: o.name,
                    domain: o.domain,
                    required: o.required,
                    optional: o.optional,
                    description: o.description,
                    mutates: o.mutates,
                })),
            };
        },
    }),

    T('cocos_anim_query', {
        title: '离线查询动画',
        description:
            '读 .anim 文件（不需要编辑器运行）。selector 取值：tree（轨道树）/ node（某节点的轨道）/ find（按名字找）/ field（查属性）。',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: { type: 'string', description: '.anim 文件路径' },
                selector: { type: 'string', enum: ['tree', 'node', 'find', 'field'] },
                target: { type: 'string' },
            },
            required: ['filePath', 'selector'],
        },
        handler: async (args, ctx) => {
            const offline = requireOffline();
            const filePath = assertInsideProject(ctx, args.filePath, 'anim 路径');
            return unwrapOffline(
                offline.queryAnimation({
                    filePath,
                    selector: args.selector,
                    target: args.target,
                    // ⚠️ 同 queryPrefab：必须传，否则离线层的读路径护栏是死的
                    allowedRoots: projectRoots(ctx),
                }),
                'cocos_anim_query'
            );
        },
    }),

    T('cocos_anim_batch', {
        title: '离线批量编辑动画',
        description:
            '批量修改 .anim 文件的轨道与关键帧。op 支持 offset-curve（整体平移曲线）与 set-keyframe-value（改关键帧值）。\n' +
            '事务语义同 prefab：全成功才落盘。',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: { type: 'string', description: '.anim 文件路径' },
                ops: { type: 'array', items: { type: 'object' } },
                dryRun: { type: 'boolean' },
            },
            required: ['filePath', 'ops'],
        },
        handler: async (args, ctx) => {
            const offline = requireOffline();
            const filePath = assertInsideProject(ctx, args.filePath, 'anim 路径');
            // ⚠️ 必须传 allowedRoots —— 离线层自己的「anim 路径」护栏
            //    只在拿到 allowedRoots 时才生效；不传就等于**那道护栏是死的**
            //    （看着有、其实没有）。传了它语义完全等价：
            //    两边用的是同一个 isInsideAnyRoot 实现，同一批 projectRoots。
            return unwrapOffline(
                offline.editAnimation({
                    filePath,
                    ops: args.ops,
                    dryRun: !!args.dryRun,
                    allowedRoots: projectRoots(ctx),
                }),
                'cocos_anim_batch'
            );
        },
        safety: 'write',
        timeoutMs: 120000,
    }),
];

/**
 * op **内部**携带的路径同样必须过护栏。
 *
 * 顶层 filePath 过了护栏不代表 op 里的路径也过了 ——
 * `ensure-meta.path` / `add-nested-prefab.prefabPath` /
 * `replace-nested-prefab.prefabPath` 都能指向项目外的任意文件，
 * 造成「项目外任意写」与「项目外任意读」。
 */
// ⚠️ 清单来自**离线模块**（op 定义在那里）——
//    之前这里和离线层各有一份手工白名单，两份各自独立、必须同步改：
//    新增带路径字段的 op 忘了同步 → 护栏对新 op 静默失效。
const OP_PATH_FIELDS = require('../offline/ops').OP_PATH_FIELDS;

function assertOpPathsInsideProject(ctx, ops, label = 'op 内路径') {
    if (!Array.isArray(ops)) return;
    for (const op of ops) {
        if (!op || typeof op !== 'object') continue;
        for (const rule of OP_PATH_FIELDS) {
            if (op.op !== rule.op) continue;
            // ⚠️ 离线 op 是**扁平**结构：{ op:'ensure-meta', path:'...' }，
            //    没有 args 嵌套层。之前读 op.args[field] → 永远取不到 → 护栏形同虚设。
            const p = op[rule.field];
            if (typeof p !== 'string' || !p) continue;
            assertInsideProject(ctx, p, `${label}（${rule.op}.${rule.field}）`);
        }
    }
}

module.exports = {
    GLOBAL_TOOLS,
    assertInsideProject,
    assertOpPathsInsideProject,
    projectRoots,
    realpathBestEffort,
    // ⚠️ 导出 OP_PATH_FIELDS —— 它是一份**手工维护的白名单**，
    //    新增带路径字段的 op 时忘了加，就会复现本轮修的那种
    //    「看着有、其实没有」的护栏。
    //    导出它是为了让一致性测试能自动发现漏项（见
    //    hub/test/offline-guard-wiring.test.js）。
    OP_PATH_FIELDS,
};
