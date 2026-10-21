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

const T = (name, spec) => ({ name, safety: 'read', ...spec });

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
                    enum: ['components', 'coordinates', 'layout', 'workflow', 'traps', 'messages', 'all', 'index'],
                    description: '要查询的知识主题',
                },
                component: { type: 'string', description: 'topic=components 时可指定具体组件，如 cc.Label' },
            },
        },
        handler: async (args) => {
            const topic = args.topic || 'index';
            if (topic === 'index') {
                return {
                    topics: Object.keys(KNOWLEDGE).concat(['messages']),
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
                    const key = Object.keys(KNOWLEDGE.components).find((k) => k.toLowerCase() === String(args.component).toLowerCase());
                    if (!key) {
                        return {
                            available: Object.keys(KNOWLEDGE.components),
                            error: `没有组件 "${args.component}" 的属性表。`,
                        };
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
            return offline.queryPrefab({
                filePath,
                selector: args.selector,
                target: args.target,
                maxDepth: args.maxDepth,
            });
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
            return offline.editPrefab({
                filePath,
                ops: args.ops,
                dryRun: !!args.dryRun,
                allowedRoots: projectRoots(ctx),
            });
        },
        safety: 'write',
    }),

    T('cocos_prefab_batch', {
        title: '离线批量编辑 prefab',
        description:
            '从 JSON 文件读取 ops 后批量编辑。opsJsonPath 是 JSON 文件的**绝对路径**，内容是 op 数组。\n' +
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
            const res = offline.batchPrefab({
                opsJsonPath,
                dryRun: !!args.dryRun,
                allowedRoots: projectRoots(ctx),
            });
            if (res && res.ok && res.data && Array.isArray(res.data.ops)) {
                assertOpPathsInsideProject(ctx, res.data.ops, 'op 内路径');
            }
            return res;
        },
        safety: 'write',
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
            return offline.queryAnimation({ filePath, selector: args.selector, target: args.target });
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
            return offline.editAnimation({ filePath, ops: args.ops, dryRun: !!args.dryRun });
        },
        safety: 'write',
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
const OP_PATH_FIELDS = [
    { op: 'ensure-meta', field: 'path' },
    { op: 'add-nested-prefab', field: 'prefabPath' },
    { op: 'replace-nested-prefab', field: 'prefabPath' },
];

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

module.exports = { GLOBAL_TOOLS, assertInsideProject, assertOpPathsInsideProject, projectRoots, realpathBestEffort };
