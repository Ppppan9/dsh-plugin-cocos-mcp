'use strict';

/**
 * 编辑器侧工具定义
 * ---------------------------------------------------------------------------
 * 设计原则：
 *   - **少而准**：现存实现有 51 / 64 / 153 个工具三个版本。工具越多，
 *     模型选择成本越高、描述 token 越贵、误调用概率越大。
 *     我们按「一个工具一件事」收敛到 40 个左右。
 *   - **描述写清约束**：每个描述都注明「什么时候用 / 什么时候别用」，
 *     这是降低无效调用最有效的手段（DaxianLee 的 README 与实现脱节，
 *     纯粹因为工具描述没起到约束作用）。
 *   - **安全分级**：read / write / dangerous。dangerous 必须在参数里显式传
 *     confirm=true 才会执行，且 confirm 会被写进 inputSchema 的 required，
 *     模型无法绕过。
 *
 * safety:
 *   read     —— 只读
 *   write    —— 会改状态但可撤销
 *   danger   —— 破坏性 / 不可撤销，必须显式 confirm
 */

const fs = require('fs');
const path = require('path');

const { runTransaction } = require('./transaction');
const { T } = require('./schema');


/**
 * 空白场景模板
 * ---------------------------------------------------------------------------
 * .scene 不是随便写个空文件就能用的 —— Cocos 要能反序列化成 cc.SceneAsset / cc.Scene /
 * cc.SceneGlobals 这一整套结构，字段名还随版本变。
 * 这里直接用从 Cocos Creator 3.8.8 自身包里提取并精简过的合法模板，
 * 保证 scene.create 出来的场景一定能被编辑器打开。
 */
const SCENE_TEMPLATE = path.join(__dirname, '..', '..', '..', 'extension', 'templates', 'empty-scene.scene');

function readSceneTemplate() {
    try {
        return fs.readFileSync(SCENE_TEMPLATE, 'utf8');
    } catch (e) {
        throw new Error(
            `读不到空白场景模板（${SCENE_TEMPLATE}）：${e.message}。` +
            '请确认 cocos-mcp 包完整（extension/templates/empty-scene.scene 应存在）。'
        );
    }
}

const EDITOR_TOOLS = [
    // ────────────────────────── 场景 ──────────────────────────
    T('scene.tree', {
        title: '场景节点树',
        description:
            '读取当前场景的节点树（扁平列表：uuid / 名字 / 层级路径 / 类型 / 组件 / 深度）。\n' +
            '这是所有场景操作的入口——先查树再改，不要凭空猜 uuid。\n' +
            '参数：uuid=只看某节点的子树；maxDepth=限制深度。',
        inputSchema: {
            type: 'object',
            properties: {
                uuid: { type: 'string', description: '可选：根节点 uuid' },
                maxDepth: { type: 'number', description: '可选：最大深度（根=0）' },
            },
        },
        op: 'scene.tree',
    }),
    T('scene.node', {
        title: '节点详情',
        description: '读取单个节点的完整 dump（含每个组件的全部属性）。node 可传 uuid、层级路径（Canvas/Button）或节点名。',
        inputSchema: {
            type: 'object',
            properties: {
                node: { type: 'string', description: 'uuid / 层级路径 / 节点名' },
                raw: { type: 'boolean', description: '额外返回未解包的原始 dump（排查用，体积大）' },
            },
            required: ['node'],
        },
        op: 'scene.node',
    }),
    T('scene.find', {
        title: '按名字找节点',
        description: '按名字模糊搜索场景节点，返回 uuid 与层级路径。比 scene.tree 更省 token，适合「我要找那个叫 Start 的按钮」。',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: '名字片段' },
                type: { type: 'string', description: '可选：按节点/组件类型过滤' },
                maxDepth: { type: 'number', description: '可选：最大深度' },
            },
            required: ['name'],
        },
        op: 'scene.find',
    }),
    T('scene.open', {
        title: '打开场景',
        description:
            '打开指定场景资源。需要场景的 uuid（先用 asset.uuid 查）。\n' +
            '⚠️ 引擎在资产库做自动刷新时，打开场景实测要 **26~54 秒** —— 这是引擎行为不是卡死。',
        inputSchema: { type: 'object', properties: { uuid: { type: 'string' } }, required: ['uuid'] },
        op: 'scene.open',
        safety: 'write',
        // ⚠️ 必须大于 Bridge 侧的最坏预算（见 handlers.js 的 sceneOpenBudgetMs()，
        //    当前 111s），否则客户端先超时、而 Bridge 还在跑 ——
        //    用户拿到的是一句没信息量的「请求超时」，而不是真正的原因。
        //    预算与这个值的关系由 test/consistency.test.js 的断言守着。
        timeoutMs: 150000,
    }),
    T('scene.create', {
        title: '新建场景',
        description: '在 assets 下创建 .scene 资源。创建后用 scene.open 打开。',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: '场景名' },
                path: { type: 'string', description: '目录，如 db://assets/scenes' },
                waitMs: {
                    type: 'number',
                    minimum: 0,
                    description:
                        '等待引擎导入完成的上限（毫秒），默认 90000。超时后仍会返回，只是 imported=false。' +
                        '传 0 表示不等（立即返回当前状态）。',
                },
            },
            required: ['name'],
        },
        handler: async (args, ctx) => {
            const dir = args.path || 'db://assets';
            const url = `${dir.replace(/\/$/, '')}/${args.name}.scene`;
            // overwrite: true —— 同名场景已存在时覆盖它。
            // 不覆盖的话 create-asset 会失败，而「上一轮残留的同名场景」是常态。
            await ctx.call('asset.create', { url, content: readSceneTemplate(), overwrite: true });
            // ⚠️ 必须等引擎把场景**导入完**再返回 ——
            //    场景刚创建就打开会失败，而一次失败就会让整个 scene 频道卡死
            //    （query-node-tree 永远不返回，所有场景工具全挂）。
            //    判据用 bridge 的 asset.isImported（查本地库文件是否存在）——
            //    asset-info / imported 字段都会**提前**变真，不能用。
            // ⚠️ waitMs 要**自己**也兜住：即使校验层放过了脏值
            //    （比如从别的调用路径进来的），也不能让等待循环一次都不跑。
            //    语义：
            //      未传 / 非法值（非有限数） → 用默认 90s；
            //      0 → **如实尊重**（不等，立即返回 imported:false），
            //           这和「非法值静默变成 0」是两回事 —— 前者是用户的明确要求，
            //           后者是会误导人的静默错误；
            //      负数 → 报错（校验层也会拦）。
            const waitRaw = Number(args.waitMs);
            let waitMs = 90000;
            if (args.waitMs !== undefined && Number.isFinite(waitRaw)) {
                if (waitRaw < 0) throw new Error(`waitMs 不能是负数（收到 ${waitRaw}）`);
                waitMs = waitRaw;
            }
            const deadline = Date.now() + waitMs;
            let ready = false;
            let lastReason = null;
            while (Date.now() < deadline) {
                // ⚠️ 别把错误吞掉 —— 吞掉的话 lastReason 永远是 null，
                //    超时提示只能说「（未知）」，模型完全不知道发生了什么。
                let st = null;
                try {
                    st = await ctx.call('asset.isImported', { url });
                } catch (e) {
                    lastReason = `查询导入状态失败：${e.message}`;
                }
                if (st && st.imported) {
                    ready = true;
                    break;
                }
                if (st && st.reason) lastReason = st.reason;
                await new Promise((r) => setTimeout(r, 400));
            }
            return {
                url,
                created: true,
                imported: ready,
                hint: ready
                    ? '场景已导入完成，可以直接 scene.open。'
                    : `⚠️ 场景在超时内仍未导入完成（${lastReason || '未知'}）—— ` +
                      '现在 scene.open 会失败并让场景操作卡住，请稍后再试。',
            };
        },
        safety: 'write',
        // ⚠️ handler 型工具**不会**自动继承 hub 的默认超时
        //    （ToolRegistry 只在 op 型路径上用 tool.timeoutMs），
        //    所以阻塞型的 handler 必须自己声明 timeoutMs。
        //    这里默认等 90s 导入，留 30s 余量。
        timeoutMs: 120000,
    }),
    T('scene.save', {
        title: '保存场景',
        description: '保存当前打开的场景。改完场景必须保存，否则改动丢失。',
        inputSchema: { type: 'object', properties: {} },
        op: 'scene.save',
        safety: 'write',
        timeoutMs: 120000,
    }),
    T('scene.reload', {
        title: '软重载场景',
        description: '重新加载当前场景（保留编辑器状态）。用于外部改了 prefab 文件后让编辑器重新读取。',
        inputSchema: { type: 'object', properties: {} },
        op: 'scene.reload',
        safety: 'danger',
        timeoutMs: 120000,
    }),
    T('scene.close', {
        title: '关闭场景',
        description: '关闭当前打开的场景（编辑器会回到没有场景的状态）。慎用：未保存的改动会丢失。',
        inputSchema: { type: 'object', properties: {} },
        op: 'scene.close',
        safety: 'danger',
    }),
    T('scene.status', {
        title: '场景状态',
        description: '一次性拿到：是否就绪、是否有未保存改动、场景包围盒（设计分辨率可视范围）。',
        inputSchema: { type: 'object', properties: {} },
        handler: async (args, ctx) => ({
            ready: await ctx.call('scene.ready', {}),
            dirty: await ctx.call('scene.dirty', {}),
            bounds: await ctx.call('scene.bounds', {}),
        }),
    }),
    T('scene.classes', {
        title: '可用组件类',
        description:
            '列出当前 Cocos 版本里可用的类名。\n' +
            '默认列出**全部组件类**（cc.Label / cc.Button / cc.ScrollView …），' +
            '挂组件前不确定类名时先查这里，避免把不存在的类名挂上去。\n' +
            'extends 可指定基类（如 "cc.Node" 列出节点类）；excludeSelf 默认 true（不含基类自身）。',
        inputSchema: {
            type: 'object',
            properties: {
                extends: { type: 'string', description: '基类名，默认 cc.Component' },
                options: {
                    type: 'object',
                    description:
                        'Cocos 原生的 QueryClassesOptions 形态（{extends, excludeSelf}）。' +
                        '与扁平的 extends/excludeSelf 等价，二选一。',
                    properties: {
                        extends: { type: 'string' },
                        excludeSelf: { type: 'boolean' },
                    },
                },
                excludeSelf: { type: 'boolean', description: '是否排除基类自身，默认 true' },
            },
        },
        op: 'scene.classes',
    }),
    T('scene.bounds', {
        title: '场景包围盒',
        description: '场景的可视范围（x / y / width / height）。用于判断元素是否越界。',
        inputSchema: { type: 'object', properties: {} },
        op: 'scene.bounds',
    }),
    T('scene.components', {
        title: '场景脚本组件',
        description:
            '列出当前场景里所有**脚本组件**（不是内置组件）：name / cid / 所在节点路径 / 资源 uuid。\n' +
            '用来查「这个场景用了哪些自定义脚本」。',
        inputSchema: { type: 'object', properties: {} },
        op: 'scene.components',
    }),
    T('scene.snapshot', {
        title: '开始场景快照',
        description:
            '开始一次场景快照（记录变更前状态）。\n' +
            '通常不需要手动调用 —— scene.transaction 会自动做快照与回滚。\n' +
            '手动用的话：snapshot → 改一堆 → 出问题就 scene.snapshot.abort。',
        inputSchema: { type: 'object', properties: {} },
        op: 'scene.snapshot',
        safety: 'write',
    }),
    T('scene.snapshot.abort', {
        title: '中止场景快照',
        description: '中止当前快照并回滚到快照时的状态。需要先 scene.snapshot。',
        inputSchema: { type: 'object', properties: {} },
        op: 'scene.snapshot.abort',
        safety: 'write',
    }),
    T('scene.transaction', {
        title: '场景事务（快照→批量操作→失败回滚）',
        description:
            '按顺序执行一串场景操作；任一步失败则**按 undo 日志逆序撤销已完成的步骤**，返回失败原因。\n' +
            '这是本项目相对其它实现的独有能力：\n' +
            '  · Cocos 3.8.8 的 scene:snapshot / scene:snapshot-abort / scene:cancel-recording ' +
            '**实测都不回滚**（建节点后调 snapshot-abort，节点数不变），所以本实现自带 undo 日志，不依赖它们。\n' +
            '  · 可逆操作：node.create / node.duplicate / node.move / node.active / node.transform / ' +
            'component.add / component.set / component.remove（标量属性）。\n' +
            '  · node.delete 只支持叶子节点；component.call 与 scene.save 不可放进事务（会直接拒绝并说明原因）。\n' +
            'ops 形如：{"op":"node.create","args":{...}}，op 必须是场景类操作名；破坏性 op 要带 confirm: true。',
        inputSchema: {
            type: 'object',
            properties: {
                ops: {
                    type: 'array',
                    description: '有序操作列表',
                    items: {
                        type: 'object',
                        properties: {
                            op: {
                                type: 'string',
                                enum: [
                                    'node.create', 'node.duplicate', 'node.delete', 'node.move', 'node.active', 'node.transform',
                                    'component.add', 'component.remove', 'component.set',
                                ],
                                description: '可放进事务的场景操作名',
                            },
                            args: { type: 'object', description: '该操作的参数' },
                        },
                        required: ['op'],
                    },
                },
                rollback: { type: 'boolean', description: '失败时是否回滚，默认 true' },
            },
            required: ['ops'],
        },
        handler: async (args, ctx) => {
            const ops = args.ops || [];
            if (!ops.length) throw new Error('ops 为空，没有要执行的操作');

            // 执行器：把事务里的 op 名映射到对应的工具
            const execute = async (op) => {
                const tool = EDITOR_TOOLS.find((t) => t.name === op.op);
                if (!tool) {
                    throw new Error(`"${op.op}" 不是有效的场景操作名`);
                }
                if (tool.safety === 'danger') {
                    // 破坏性 op 在事务里要自己带 confirm
                    if (!op.args || op.args.confirm !== true) {
                        throw new Error(`事务里的破坏性操作 "${op.op}" 必须带 confirm: true`);
                    }
                }
                return tool.handler ? await tool.handler(op.args || {}, ctx) : await ctx.call(tool.op, op.args || {});
            };

            const r = await runTransaction(ops, ctx, { execute, rollback: ctx.rollbackEnabled !== false });
            if (!r.ok) {
                // 事务失败要作为工具错误抛出去，让 MCP 客户端看到 isError。
                // ⚠️ 回滚结果必须写进错误信息 —— 模型要靠它判断「场景现在脏不脏」，
                //    只说「失败了」而不说「回滚了没有」是不够的。
                // ⚠️ 文案要分三档 ——
                //    模型主要消费的是**错误文本**，不是结构化字段。
                //    把「按要求未回滚」说成「回滚失败」会让模型手工再补一次 → 重复应用。
                const rollbackNote = r.outcomeUnknown
                    ? '⚠️ 结果未知：编辑器可能已经执行了该操作但响应没有回来，场景状态不确定。' +
                      '请先用 scene.tree 核对当前状态，再决定是否重试。'
                    : r.rollbackSkipped
                      ? `⚠️ 按要求未回滚（rollback=false）：已完成的 ${r.completed} 步仍在场景里，请手工处理。`
                      : r.rolledBack
                        ? '已回滚：场景已恢复到事务执行前的状态，无需手工清理。'
                        : `⚠️ 回滚未完全成功，场景可能处于中间态，请检查并手工修复。${
                              r.rollbackErrors && r.rollbackErrors.length
                                  ? '回滚出错：' + r.rollbackErrors.join('；')
                                  : ''
                          }`;
                const err = new Error(`${r.error}（${rollbackNote}）`);
                err.transaction = r;
                throw err;
            }
            return r;
        },
        safety: 'write',
    }),

    // ────────────────────────── 节点 ──────────────────────────
    T('node.create', {
        title: '创建节点',
        description:
            '在父节点下创建子节点。parent 可传 uuid / 层级路径 / 名字。\n' +
            'components 可批量挂组件（如 ["cc.UITransform","cc.Label"]）。\n' +
            'position 传 {x,y,z}，在 UI 父节点下会自动补 UITransform。',
        inputSchema: {
            type: 'object',
            properties: {
                parent: { type: 'string', description: '父节点 uuid / 路径 / 名字' },
                name: { type: 'string' },
                type: { type: 'string', description: '节点类型，如 cc.Node / cc.EmptyNode' },
                position: {
                    type: 'object',
                    description: '初始位置 {x, y, z}',
                    properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
                },
                components: {
                    type: 'array',
                    items: { type: 'string' },
                    description: '要挂的组件类型，如 ["cc.UITransform"]',
                },
                canvasRequired: {
                    type: 'boolean',
                    description: '要求父节点是 Canvas（UI 节点必须）',
                },
                type: { type: 'string', description: '可选：资源类型（如 cc.Sprite）' },
                position: {
                    type: 'object',
                    properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
                },
                components: { type: 'array', items: { type: 'string' }, description: '要挂的组件类型列表' },
            },
            required: ['parent', 'name'],
        },
        op: 'node.create',
        safety: 'write',
    }),
    T('node.delete', {
        title: '删除节点',
        description: '删除节点及其所有子节点。不可撤销，需要 confirm=true。',
        inputSchema: {
            type: 'object',
            properties: { node: { type: 'string' } },
            required: ['node', 'confirm'],
        },
        op: 'node.delete',
        safety: 'danger',
    }),
    T('node.duplicate', {
        title: '复制节点',
        description: '复制节点（含子树），返回新节点 uuid 列表。',
        inputSchema: { type: 'object', properties: { node: { type: 'string' } }, required: ['node'] },
        op: 'node.duplicate',
        safety: 'write',
    }),
    T('node.move', {
        title: '移动节点',
        description:
            '把节点挂到另一个父节点下（改变层级）。\n' +
            'node / parent 都可以传 uuid、层级路径（Canvas/Panel）或节点名。\n' +
            '注意：父节点若挂了 cc.Layout 或 cc.Widget，层级变化后子节点位置会被它们接管。',
        inputSchema: {
            type: 'object',
            properties: { node: { type: 'string' }, parent: { type: 'string' } },
            required: ['node', 'parent'],
        },
        op: 'node.move',
        safety: 'write',
    }),
    T('node.active', {
        title: '启用/隐藏节点',
        description: '设置节点的 active 状态（隐藏用这个，比改 opacity 更符合游戏逻辑）。',
        inputSchema: {
            type: 'object',
            properties: { node: { type: 'string' }, active: { type: 'boolean' } },
            required: ['node', 'active'],
        },
        op: 'node.active',
        safety: 'write',
    }),
    T('node.transform', {
        title: '设置节点变换',
        description:
            '设置 position / scale / rotation。rotation 传角度（度）即可，内部转成四元数。\n' +
            'position 传 {x,y}（2D 项目）或 {x,y,z}。',
        inputSchema: {
            type: 'object',
            properties: {
                node: { type: 'string' },
                position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
                scale: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
                rotation: { type: 'number', description: '绕 Z 轴角度（度）' },
            },
            required: ['node'],
        },
        op: 'node.transform',
        safety: 'write',
    }),

    // ────────────────────────── 组件 ──────────────────────────
    T('node.clipboard', {
        title: '节点剪贴板',
        description:
            '节点的复制 / 剪切 / 粘贴。action 取值：copy（复制）、cut（剪切）、paste（粘贴）。\n' +
            'copy 只需要 node —— 把节点放进剪贴板，原节点保留，返回 clipboardKey（粘贴时用）。\n' +
            'cut 需要 node —— 放进剪贴板**并从场景里删掉**（破坏性，要 confirm=true），' +
            '返回 clipboardKey 与被删节点的 uuid。\n' +
            '（注：Cocos 自带的 cut-node 在 3.8.8 上只备剪贴板不删节点，本工具自己补上了删除这一步。）\n' +
            'paste 需要 node（剪贴板里的那个 uuid，即上一步的 clipboardKey）和 target（粘贴到哪个父节点），' +
            '返回新节点 uuid 列表。',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['copy', 'cut', 'paste'] },
                node: { type: 'string', description: '操作哪个节点' },
                target: { type: 'string', description: 'paste 时粘贴到哪个父节点（action=paste 时必填）' },
                confirm: { type: 'boolean', const: true, description: 'action=cut 时必须显式传 true' },
            },
            required: ['action', 'node'],
        },
        handler: async (args, ctx) => {
            if (args.action === 'cut' && args.confirm !== true) {
                throw new Error(
                    '剪切（cut）会把节点从场景层级里移走，属于破坏性操作，必须显式传 confirm=true。' +
                    '如果只是想复制一份，请用 action="copy"。'
                );
            }
            if (args.action === 'paste' && !args.target) {
                throw new Error('粘贴（paste）必须指定 target（粘贴到哪个父节点）。');
            }
            return await ctx.call('node.clipboard', {
                action: args.action,
                node: args.node,
                target: args.target,
            });
        },
        safety: 'write',
    }),

    T('component.add', {
        title: '挂组件',
        description:
            '给节点挂一个组件。component 用 Cocos 类名，如 "cc.Sprite"、"cc.Button"、"cc.Label"。\n' +
            '自定义脚本用 @ccclass 里的名字（如 "MyCard"）。',
        inputSchema: {
            type: 'object',
            properties: { node: { type: 'string' }, component: { type: 'string' } },
            required: ['node', 'component'],
        },
        op: 'component.add',
        safety: 'write',
    }),
    T('component.remove', {
        title: '摘组件',
        description: '从节点上移除组件。不可撤销，需要 confirm=true。',
        inputSchema: {
            type: 'object',
            properties: { node: { type: 'string' }, component: { type: 'string' } },
            required: ['node', 'component', 'confirm'],
        },
        op: 'component.remove',
        safety: 'danger',
    }),
    T('component.list', {
        title: '列出组件',
        description: '列出节点上挂了哪些组件（带组件下标，下标用于 component.set 的自动定位）。',
        inputSchema: { type: 'object', properties: { node: { type: 'string' } }, required: ['node'] },
        op: 'component.list',
    }),
    T('component.set', {
        title: '设置组件属性',
        description:
            '设置组件上的一个属性。value 的类型会被自动推断（数字/字符串/布尔/Vec2/Vec3/Color/Size/节点引用）。\n' +
            '例：component.set {node:"Button", component:"cc.Label", property:"string", value:"开始"}；\n' +
            '    component.set {node:"Button", component:"cc.Button", property:"interactable", value:false}\n' +
            '注意：修改 **prefab 资源文件** 请优先用 cocos_prefab_edit（离线直接改文件，不需要编辑器在线）。',
        inputSchema: {
            type: 'object',
            properties: {
                node: { type: 'string' },
                component: { type: 'string', description: '组件类型，如 cc.Label' },
                property: { type: 'string', description: '属性名，如 string / fontSize / color / interactable' },
                value: { description: '属性值' },
            },
            required: ['node', 'component', 'property', 'value'],
        },
        op: 'component.set',
        safety: 'write',
    }),
    T('component.call', {
        title: '调用组件方法',
        description: '调用节点组件上的一个方法（如 "play"、"open"、"refresh"）。只应调用你自己项目里的自定义方法。',
        inputSchema: {
            type: 'object',
            properties: {
                node: { type: 'string' },
                method: { type: 'string' },
                args: { type: 'array', items: {}, description: '参数列表' },
            },
            required: ['node', 'method'],
        },
        op: 'component.call',
        safety: 'write',
    }),

    // ────────────────────────── 资源 ──────────────────────────
    T('asset.query', {
        title: '查询资源',
        description:
            '按 glob 列出资源。pattern 用 db://assets/**/*.prefab 这类 Cocos 资源 URL 语法。\n' +
            'ccType 可按类型过滤（如 cc.Prefab、cc.Texture2D）。',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: '如 db://assets/**/*.prefab' },
                dataKeys: {
                    type: 'array',
                    items: { type: 'string' },
                    description: '额外要返回的字段（asset-db 的 dataKeys）',
                },
                ccType: { type: 'string', description: '如 cc.Prefab' },
            },
        },
        op: 'asset.query',
    }),
    T('asset.info', {
        title: '资源详情',
        description: '查单个资源的元信息（uuid、类型、路径、大小、子资源列表）。url 可传 db://assets/xxx 或 uuid。',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string' },
                dataKeys: {
                    type: 'array',
                    items: { type: 'string' },
                    description: '额外要返回的字段（asset-db 的 dataKeys）',
                },
            },
            required: ['url'],
        },
        op: 'asset.info',
    }),
    T('asset.isImported', {
        title: '资源是否导入完成',
        description:
            '查资源是否已经**导入完成**（能不能安全地打开/引用它）。url 传 db://assets/xxx.scene，uuid 传资源 uuid，二选一。\n' +
            '⚠️ 别用 asset.info 的 imported 字段判断 —— 那个字段在资源刚创建时就会**提前**返回 true，' +
            '而此时引擎还没导入完，强行打开场景会让**整个场景操作卡死**（所有场景工具无响应）。\n' +
            '判据是本地库产物文件是否已生成，这个才准。',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'db://assets/xxx.scene' },
                uuid: { type: 'string', description: '资源 uuid（与 url 二选一）' },
            },
        },
        op: 'asset.isImported',
    }),
    T('asset.create', {
        title: '创建资源',
        description:
            '在资源库里创建一个新资源文件（如 .scene / .prefab / .json）。content 传文件内容。\n' +
            'overwrite=true 时同名资源会被覆盖（默认不覆盖）。\n' +
            '⚠️ Cocos 会在创建后触发一次资源导入，**可能要十几秒**才返回，这是引擎行为不是卡死。',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string' },
                content: { type: 'string' },
                overwrite: { type: 'boolean', description: '同名资源已存在时覆盖，默认 false' },
            },
            required: ['url'],
        },
        op: 'asset.create',
        safety: 'write',
    }),
    T('asset.save', {
        title: '保存资源',
        description: '保存资源内容（覆盖写入）。会触发编辑器重新导入。',
        inputSchema: {
            type: 'object',
            properties: { url: { type: 'string' }, content: { type: 'string' } },
            required: ['url', 'content'],
        },
        op: 'asset.save',
        safety: 'write',
    }),
    T('asset.delete', {
        title: '删除资源',
        description: '删除资源文件。不可撤销，需要 confirm=true。',
        inputSchema: {
            type: 'object',
            properties: { url: { type: 'string' } },
            required: ['url', 'confirm'],
        },
        op: 'asset.delete',
        safety: 'danger',
    }),
    T('asset.move', {
        title: '移动/重命名资源',
        description:
            '把资源移动到新路径（等价于重命名）。from / to 都用 db://assets/xxx 形式。\n' +
            '跨目录移动时目标目录必须已存在；移动后旧路径不再有该资源。',
        inputSchema: {
            type: 'object',
            properties: { from: { type: 'string' }, to: { type: 'string' } },
            required: ['from', 'to'],
        },
        op: 'asset.move',
        safety: 'write',
    }),
    T('asset.reimport', {
        title: '重新导入资源',
        description: '强制编辑器重新导入某个资源。离线改了 .prefab 文件后必须调用，否则编辑器看到的还是旧内容。',
        inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
        op: 'asset.reimport',
        safety: 'write',
    }),
    T('asset.refresh', {
        title: '刷新资源',
        description: '刷新资源库（导入新增文件、丢弃已删除文件）。传 url 刷新单个，不传刷新全库。',
        inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
        op: 'asset.refresh',
        safety: 'write',
    }),
    T('asset.uuid', {
        title: '路径转 uuid',
        description: '把 db://assets/xxx 路径转成资源 uuid。',
        inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
        op: 'asset.uuid',
    }),
    T('asset.url', {
        title: 'uuid 转路径',
        description: '把资源 uuid 转成 db://assets/xxx 路径。',
        inputSchema: { type: 'object', properties: { uuid: { type: 'string' } }, required: ['uuid'] },
        op: 'asset.url',
    }),
    T('asset.copy', {
        title: '复制资源',
        description: '把资源复制到另一个路径（from / to 都用 db://assets/xxx 形式）。原资源保留。',
        inputSchema: {
            type: 'object',
            properties: { from: { type: 'string' }, to: { type: 'string' } },
            required: ['from', 'to'],
        },
        op: 'asset.copy',
        safety: 'write',
    }),
    T('asset.path', {
        title: '资源本地路径',
        description: '把资源 URL 转成本地文件系统路径（用于知道文件在磁盘哪儿）。',
        inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
        op: 'asset.path',
    }),
    T('asset.users', {
        title: '资源被谁引用',
        description:
            '反查：哪些资源或脚本引用了这个资源。\n' +
            'type 可选：asset（默认）/ script / all。改动共享资源前先用它评估影响面。',
        inputSchema: {
            type: 'object',
            properties: { url: { type: 'string' }, type: { type: 'string', enum: ['asset', 'script', 'all'] } },
            required: ['url'],
        },
        op: 'asset.users',
    }),
    T('asset.dependencies', {
        title: '资源依赖',
        description: '查一个资源依赖了哪些资源（贴图、预制体、脚本）。',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string' },
                type: { type: 'string', enum: ['asset', 'script', 'all'], description: '依赖类型' },
            },
            required: ['url'],
        },
        op: 'asset.dependencies',
    }),

    // ────────────────────────── 视图 / 预览 ──────────────────────────
    T('preview.url', {
        title: '预览地址',
        description: '获取当前预览服务器的 URL（浏览器预览地址）。',
        inputSchema: { type: 'object', properties: {} },
        op: 'preview.url',
    }),
    T('view.align', {
        title: '对齐视图',
        description:
            '对齐场景视图与节点。mode 取值：with-view（把视图的相机位姿应用到选中节点）、' +
            'view-with-node（把节点位姿应用到视图）。',
        inputSchema: {
            type: 'object',
            properties: { mode: { type: 'string', enum: ['with-view', 'view-with-node'] } },
        },
        op: 'view.align',
        safety: 'write',
    }),
    T('view.focus', {
        title: '镜头对准节点',
        description: '把场景视图镜头对准指定节点（nodes 可传多个，uuid/路径/名字都行）。',
        inputSchema: {
            type: 'object',
            properties: { nodes: { type: 'array', items: { type: 'string' } } },
            required: ['nodes'],
        },
        op: 'view.focus',
        safety: 'write',
    }),
    T('view.options', {
        title: '场景视图选项',
        description:
            '读取/设置场景视图选项：gizmo 工具(translate/rotate/scale)、pivot、坐标系(World/Local)、2D/3D、网格、图标尺寸。\n' +
            '只传要改的字段，其余保持不变；不传任何字段则纯读取。',
        inputSchema: {
            type: 'object',
            properties: {
                tool: { type: 'string', description: 'translate / rotate / scale' },
                pivot: { type: 'string' },
                coordinate: { type: 'string', description: 'World / Local' },
                is2D: { type: 'boolean' },
                grid: { type: 'boolean' },
                icon3D: { type: 'boolean' },
                iconSize: { type: 'number' },
            },
        },
        handler: async (args, ctx) => {
            const out = {};
            if (args.tool !== undefined || args.pivot !== undefined || args.coordinate !== undefined) {
                out.gizmo = await ctx.call('view.gizmo', args);
            }
            if (args.is2D !== undefined) out.is2D = await ctx.call('view.is2d', { value: args.is2D });
            if (args.grid !== undefined) out.grid = await ctx.call('view.grid', { visible: args.grid });
            if (args.icon3D !== undefined || args.iconSize !== undefined) {
                out.icon = await ctx.call('view.icon', { is3D: args.icon3D, size: args.iconSize });
            }
            if (!Object.keys(out).length) {
                out.gizmo = await ctx.call('view.gizmo', {});
                out.is2D = await ctx.call('view.is2d', {});
                out.grid = await ctx.call('view.grid', {});
                out.icon = await ctx.call('view.icon', {});
            }
            return out;
        },
        safety: 'write',
    }),

    // ────────────────────────── 构建 ──────────────────────────
    T('build.start', {
        title: '发起构建',
        description:
            '发起一次构建任务。platform 如 "web-desktop" / "web-mobile" / "android"。\n' +
            'shouldWait 默认 true（等构建完成再返回，结果更确定，但耗时更长）。',
        inputSchema: {
            type: 'object',
            properties: {
                platform: { type: 'string', description: '如 web-desktop' },
                options: { type: 'object', description: '构建配置，缺省用编辑器里保存的配置' },
                shouldWait: { type: 'boolean', description: '是否等待完成，默认 true' },
            },
            required: ['platform'],
        },
        op: 'build.start',
        safety: 'write',
        timeoutMs: 600000,
    }),
    T('build.platforms', {
        title: '可构建平台',
        description: '列出当前工程可用的构建平台与配置（web-desktop / web-mobile / android / ios …）。构建前先查这里。',
        inputSchema: {
            type: 'object',
            properties: { platform: { type: 'string', description: '可选，指定平台；不传则列出全部' } },
        },
        op: 'build.platforms',
    }),
    T('build.status', {
        title: '构建状态',
        description: '查询构建任务状态（type: build / bundle）。',
        inputSchema: {
            type: 'object',
            properties: { type: { type: 'string', enum: ['build', 'bundle'] } },
        },
        op: 'build.status',
    }),

    // ────────────────────────── 参考图 ──────────────────────────
    T('reference.add', {
        title: '叠加参考图',
        description:
            '在场景视图里叠加一张参考图（设计稿），AI 可以「看着设计稿搭界面」。\n' +
            'paths 是本地图片绝对路径的数组。\n' +
            '这是 Cocos 官方的 reference-image 扩展能力，消息名为 reference-image:add-image。',
        inputSchema: {
            type: 'object',
            properties: { paths: { type: 'array', items: { type: 'string' } } },
            required: ['paths'],
        },
        op: 'reference.add',
        safety: 'write',
    }),
    T('reference.set', {
        title: '设置参考图变换',
        description:
            '调整当前叠加的参考图。key 取值：path（换图）/ x / y（位置）/ sx / sy（缩放）/ opacity（透明度）。',
        inputSchema: {
            type: 'object',
            properties: {
                key: { type: 'string', enum: ['path', 'x', 'y', 'sx', 'sy', 'opacity'] },
                value: { description: '新值' },
            },
            required: ['key', 'value'],
        },
        op: 'reference.set',
        safety: 'write',
    }),
    T('reference.current', {
        title: '当前参考图',
        description: '读取当前叠加在场景视图里的参考图信息（路径 / 位置 / 缩放 / 透明度）。',
        inputSchema: { type: 'object', properties: {} },
        op: 'reference.current',
    }),
    T('reference.config', {
        title: '参考图配置',
        description: '读取参考图功能的整体配置（可用参考图列表等）。',
        inputSchema: { type: 'object', properties: {} },
        op: 'reference.config',
    }),
    T('reference.remove', {
        title: '移除参考图',
        description: '移除叠加在场景视图里的参考图。paths 不传表示清空全部参考图。',
        inputSchema: {
            type: 'object',
            properties: { paths: { type: 'array', items: { type: 'string' }, description: '不传则清空全部' } },
        },
        op: 'reference.remove',
        safety: 'write',
    }),

    // ────────────────────────── 编辑器 / 日志 ──────────────────────────
    T('cocos_message', {
        title: '原始编辑器消息',
        description:
            '直接调用一条**已验证存在**的 Cocos 编辑器消息（白名单外一律拒绝并给出正确名）。\n' +
            '用途：工具面没覆盖到的场景操作。\n' +
            '⚠️ 这条路**绕过了**高层工具的节点三态解析、值类型推断与安全分级，' +
            'channel/message/args 都要自己写对。作为危险操作，必须显式传 confirm=true。',
        inputSchema: {
            type: 'object',
            properties: {
                channel: { type: 'string', description: '频道名，如 scene / asset-db / preview / builder' },
                message: { type: 'string', description: '消息名，如 query-node / set-property / query-assets' },
                args: { type: 'array', items: {}, description: '位置参数数组' },
            },
            required: ['channel', 'message', 'confirm'],
        },
        handler: async (args, ctx) => {
            return await ctx.call('message', {
                channel: args.channel,
                message: args.message,
                args: args.args || [],
            });
        },
        safety: 'danger',
    }),

    T('preferences.get', {
        title: '读编辑器偏好',
        description:
            '读取 Cocos 编辑器的偏好设置。name 是偏好分类（如 "general"、"preview"、"inspector"），' +
            'key 可选（不传返回整类）；protocol 取 "default" / "global" / "local"。',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string' },
                key: { type: 'string' },
                protocol: { type: 'string', enum: ['default', 'global', 'local'] },
            },
            required: ['name'],
        },
        op: 'preferences.get',
    }),
    T('preferences.set', {
        title: '写编辑器偏好',
        description:
            '修改 Cocos 编辑器的偏好设置。name 是偏好分类，key 是条目名，value 是新值，' +
            'protocol 取 "default" / "global" / "local"。会立即生效。',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string' },
                key: { type: 'string' },
                value: {},
                protocol: { type: 'string', enum: ['default', 'global', 'local'] },
            },
            required: ['name', 'key', 'value'],
        },
        op: 'preferences.set',
        safety: 'write',
    }),
    T('project.config', {
        title: '读项目配置',
        description: '读取当前 Cocos 工程的项目级配置（键值对）。具体有哪些键取决于工程设置。',
        inputSchema: { type: 'object', properties: { key: { type: 'string' } } },
        op: 'project.config',
    }),

    T('scene.script', {
        title: '场景进程脚本',
        description:
            '在 Cocos 的**场景/渲染进程**里执行扩展脚本的固定方法（那里才有 cc 引擎运行时）。\n' +
            'method 可选：getSceneSummary（场景概览）/ findNodesByName（按名字找节点）/ ' +
            'getNodeInfo（节点引擎级信息）/ getWorldBounds（世界包围盒）/ ' +
            'setNodeProperty（按引擎类型写属性）/ createNode（建节点）。\n' +
            '⚠️ 只开放上面这几个方法，没有通用 eval —— 但 setNodeProperty / createNode ' +
            '确实能改场景，属于破坏性操作，必须传 confirm=true。',
        inputSchema: {
            type: 'object',
            properties: {
                method: {
                    type: 'string',
                    enum: ['getSceneSummary', 'findNodesByName', 'getNodeInfo', 'getWorldBounds', 'setNodeProperty', 'createNode'],
                },
                args: { type: 'array', items: {}, description: '传给该方法的参数列表' },
                extension: { type: 'string', description: '扩展包名，默认 cocos-mcp' },
                confirm: { type: 'boolean', const: true, description: '破坏性方法（setNodeProperty / createNode）必须显式传 true' },
            },
            required: ['method'],
        },
        handler: async (args, ctx) => {
            const MUTATING = new Set(['setNodeProperty', 'createNode']);
            if (MUTATING.has(args.method) && args.confirm !== true) {
                throw new Error(
                    `场景脚本方法 "${args.method}" 会修改场景，必须显式传 confirm=true。` +
                    '只读方法（getSceneSummary / findNodesByName / getNodeInfo / getWorldBounds）不需要。'
                );
            }
            // ⚠️ extension 必须一起转发 —— schema 声明了它，丢掉就是「传了没效果」。
            return await ctx.call('scene.script', {
                method: args.method,
                args: args.args || [],
                extension: args.extension,
            });
        },
        // ⚠️ 不是 danger —— 只读方法（getSceneSummary / findNodesByName / getNodeInfo /
        //    getWorldBounds）不需要 confirm，而 danger 门禁会在 handler 之前
        //    把所有调用都拦掉，与描述自相矛盾。危险分级交给 handler 里的 MUTATING 集合。
        safety: 'write',
    }),

    T('editor.info', {
        title: '编辑器信息',
        description: '当前 Cocos Creator 版本、项目路径、项目 uuid、进程 pid。',
        inputSchema: { type: 'object', properties: {} },
        op: 'editor.info',
    }),
    T('editor.console.clear', {
        title: '清空编辑器控制台',
        description: '清空 Cocos 编辑器控制台的日志。排查问题时先清一次，再复现，日志更干净。',
        inputSchema: { type: 'object', properties: {} },
        op: 'editor.console.clear',
        safety: 'write',
    }),
    T('editor.logs', {
        title: '读编辑器日志',
        description:
            '读取 Cocos 编辑器控制台日志。level 可选 error/warn/log；contains 按关键字过滤；limit 默认 100。\n' +
            '排查「改完没效果」「脚本报错」时先读这里。',
        inputSchema: {
            type: 'object',
            properties: {
                level: { type: 'array', items: { type: 'string' } },
                contains: { type: 'string' },
                limit: { type: 'number' },
            },
        },
        op: 'editor.logs',
    }),
];

module.exports = { EDITOR_TOOLS };
