'use strict';

const { EDITOR_TOOLS } = require('./editor-tools');
const { GLOBAL_TOOLS } = require('./global-tools');
const { DEFAULT_TIMEOUT_MS } = require('../editor-client');

/**
 * 工具面装配与调度
 * ---------------------------------------------------------------------------
 * 命名策略：
 *   - 只连了一个编辑器 → 编辑器工具用**无前缀**名（`scene.tree`），最好用；
 *   - 连了多个编辑器 → 编辑器工具用 `<短名>__` 前缀（`forest__scene.tree`），
 *     避免两个项目的工具撞名。
 *   - 全局工具（知识库 / 离线 prefab）**永远无前缀**，因为它们与编辑器实例无关。
 *
 * 安全执行：
 *   - safety=danger 的工具，inputSchema 里强制带 `confirm`（boolean、const true），
 *     模型必须显式确认才可能调用成功。
 *   - 执行前再校验一次 args.confirm === true，不靠 schema 兜底。
 */


function typeName(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return '数组';
    return { string: '字符串', number: '数字', boolean: '布尔值', object: '对象' }[typeof v] || typeof v;
}

/**
 * 按**声明的** inputSchema 校验参数。
 *
 * ⚠️ 为什么必须做：schema 是我们对调用方的**承诺**。
 *    声明了却从不执行 = 承诺是假的，错误会变成静默的：
 *      - `waitMs: "abc"` → Number() 得 NaN → 等待循环一次都不跑 →
 *        立刻返回「未导入完成」，看起来像引擎问题，其实是参数写错了；
 *      - 把 `waitSeconds` 拼成 `waitsecond` → **静默忽略** → 用默认值，
 *        调用方以为设了、其实没设；
 *      - `enum` 写错（比如 selector 传 'tre'）→ 静默走兜底分支。
 *    这些都属于「静默的错误答案比报错危险得多」。
 *
 * @throws 协议级错误（-32602），调用方能明确知道是参数问题
 */
function validateArgs(tool, args) {
    // ⚠️ 必须用 **toSchema(tool)** —— 那才是**客户端看到的** schema。
    //    原始 inputSchema 里没有 danger 工具自动加上的 `confirm`，
    //    用原始的会把合法的 confirm=true 判成「未知参数」。
    const schema = toSchema(tool);
    const props = schema.properties || {};
    const required = schema.required || [];
    const errors = [];

    if (args === undefined || args === null) args = {};
    if (typeof args !== 'object' || Array.isArray(args)) {
        throw invalidArgs(tool.name, ['参数必须是一个对象']);
    }

    for (const key of required) {
        if (args[key] === undefined || args[key] === null) {
            if (key === 'confirm' && tool.safety === DANGER) {
                // ⚠️ confirm 缺失要给出**最有指导性**的那句话 ——
                //    「这是破坏性操作」比「缺少必填参数 confirm」有用得多。
                //    （之前危险操作检查在前、schema 校验在后，恰好是反过来的，
                //      差点把这条提示覆盖掉。）
                errors.push(
                    `这是破坏性操作，必须显式传 confirm=true 才会执行` +
                    `（如果你已经确认过，请把 confirm: true 和其它参数放在同一次调用里）`
                );
                continue;
            }
            errors.push(`缺少必填参数 "${key}"`);
        }
    }

    for (const key of Object.keys(args)) {
        const value = args[key];
        const spec = props[key];
        if (!spec) {
            errors.push(
                `未知参数 "${key}"（可用参数：${Object.keys(props).join('、') || '无'}）`
            );
            continue;
        }
        // ⚠️ null **不是**「没传」——
        //    它会一路传到 handler 里变成 0 / NaN / 空串，
        //    让「等待 90 秒」变成「一次都不等」（实测：waitMs: null → 0 次轮询，
        //    立刻返回「未导入完成」——和 waitMs:"abc" 是同一类静默错误）。
        //    所以 null 也要按类型校验，不能悄悄跳过。
        if (value === undefined) continue;
        if (value === null) {
            errors.push(`参数 "${key}" 不能是 null（要清掉它就别传这个参数）`);
            continue;
        }
        const t = spec.type;
        if (t === 'string' && typeof value !== 'string') {
            errors.push(`参数 "${key}" 应为字符串，实际收到${typeName(value)}`);
        } else if (t === 'number' && typeof value !== 'number') {
            errors.push(`参数 "${key}" 应为数字，实际收到${typeName(value)}`);
        } else if (t === 'boolean' && typeof value !== 'boolean') {
            errors.push(`参数 "${key}" 应为布尔值，实际收到${typeName(value)}`);
        } else if (t === 'array' && !Array.isArray(value)) {
            errors.push(`参数 "${key}" 应为数组，实际收到${typeName(value)}`);
        } else if (t === 'object' && (typeof value !== 'object' || Array.isArray(value))) {
            errors.push(`参数 "${key}" 应为对象，实际收到${typeName(value)}`);
        }
        if (spec.minimum !== undefined && typeof value === 'number' && value < spec.minimum) {
            errors.push(`参数 "${key}" 不能小于 ${spec.minimum}`);
        }
        if (spec.maximum !== undefined && typeof value === 'number' && value > spec.maximum) {
            errors.push(`参数 "${key}" 不能大于 ${spec.maximum}`);
        }
        if (spec.enum && !spec.enum.includes(value)) {
            errors.push(`参数 "${key}" 只能是 ${spec.enum.map((v) => JSON.stringify(v)).join(' / ')}，实际收到 ${JSON.stringify(value)}`);
        }
        if (spec.const !== undefined && value !== spec.const) {
            errors.push(`参数 "${key}" 必须是 ${JSON.stringify(spec.const)}`);
        }
    }

    if (errors.length) throw invalidArgs(tool.name, errors);
}

/** 参数非法 → 协议级错误（-32602），按 MCP 规范，客户端据此知道是「参数问题」而不是「工具失败」。 */
function invalidArgs(toolName, errors) {
    const err = new Error(`工具 "${toolName}" 的参数不合法：\n  - ${errors.join('\n  - ')}`);
    err.protocolCode = -32602;
    return err;
}

// ⚠️ toSchema 直接用共享模块的实现 —— 仓库里只能有**一份** schema 定义。
const { toSchema, DANGER } = require('./schema');

function toMcpTool(tool, name) {
    return {
        name,
        title: tool.title,
        description: tool.description,
        inputSchema: toSchema(tool),
        annotations: {
            readOnlyHint: tool.safety === 'read',
            destructiveHint: tool.safety === DANGER,
            idempotentHint: tool.safety === 'read',
            openWorldHint: false,
        },
    };
}

class ToolRegistry {
    /**
     * @param {object} opts
     * @param {(entry:object) => import('../editor-client').EditorClient} opts.getClient
     * @param {() => Array} opts.listEditors  当前已连接的编辑器实例
     */
    constructor(opts) {
        this.getClient = opts.getClient;
        this.listEditors = opts.listEditors;
        // 过滤器：环境变量指定只连某一个编辑器实例（扩展面板的「复制 MCP 配置」会带上它）
        this.filter = (process.env.COCOS_MCP_EDITOR_FILTER || '').trim();
        this.editorTools = EDITOR_TOOLS;
        this.globalTools = GLOBAL_TOOLS;
        this._byName = new Map();
        this._filterMiss = false;
        this._filterMissDetail = '';
        this._rebuild();
    }

    /**
     * 「过滤器没命中」的说明（没有就是空串）。
     *
     * ⚠️ 这段以前**写了从不读**（`_filterMiss` 置了 true 却没人看），
     *    于是 `COCOS_MCP_EDITOR_FILTER` 写错时 hub 会静默连上**全部**实例，
     *    用户完全看不出来（第 11 轮复审 G-6）。
     *    ⇒ 现在它有明确的出口：启动时打一条 stderr 警告，
     *      并且并进 MCP 的 instructions（让模型也知道「过滤没生效」）。
     *
     * @returns {string}
     */
    filterMissNotice() {
        return this._filterMiss ? this._filterMissDetail : '';
    }

    /**
     * 工具表只在「编辑器实例集合变化」时才需要重建。
     * 之前每次 tools/call 都重建一遍 56 个工具的 Map —— 在一个会话里
     * 几十次调用就白烧掉几十次重建（每次还要算 dedupeShortNames）。
     */
    _rebuild(force = false) {
        // ⚠️ 必须是 `let` —— 下面过滤器命中时要做 `editors = hit`。
        //    之前写成 `const`，于是**过滤器一旦命中就抛**
        //    「Assignment to constant variable」⇒
        //    设了 `COCOS_MCP_EDITOR_FILTER` 且短名写对时，hub 直接起不来
        //    （写错反而「能用」—— 退回全部实例那条路不赋值）。
        //    ⚠️ 这条路径**没有任何测试覆盖**，是写 G-6 的回归用例时撞出来的。
        let editors = this.listEditors() || [];
        // ⚠️ 签名必须包含 url、token **和 stale**：
        //   - url/token：扩展的「重启 Bridge」会**重新生成 token 并换端口**，
        //     但 pid 与 shortName 不变。签名里少了它们，_rebuild 会认为「没变化」
        //     而保留旧 entry，之后每次调用都打已经关掉的旧端口 —— hub 永久失联。
        //   - stale：编辑器会从「健康」变成「正忙」（心跳停）。
        //     签名里少了它，entry 就一直是当初那个**没有 stale 标记**的对象 →
        //     「编辑器正忙就立刻失败」这道闸门**永远不会触发**，
        //     反而变成「干等 60 秒的错误答案」。（真实踩到。）
        const sig =
            editors.map((e) => `${e.pid}:${e.shortName}:${e.url}:${e.token}:${e.stale ? 1 : 0}`).join('|') +
            '#' +
            this.filter;
        if (!force && sig === this._sig && this._byName.size) {
            return this._cache;
        }
        this._sig = sig;
        this._byName.clear();
        if (this.filter) {
            const hit = editors.filter((e) => e.shortName === this.filter);
            if (!hit.length) {
                // 过滤的实例不在了就退回全部，避免整个服务不可用。
                // ⚠️ 但**必须说出来**（第 11 轮复审 G-6）：
                //    之前这里只置了一个 `_filterMiss = true`，
                //    而全仓库**没有任何一处读它** ⇒
                //    `COCOS_MCP_EDITOR_FILTER=xxx` 写错时，hub 会静默连上**全部**编辑器实例，
                //    用户完全看不出自己的过滤没生效 ——
                //    而「调错实例」正是多编辑器场景下最高发的那类错误。
                this._filterMiss = true;
                this._filterMissDetail = `没有找到短名为 "${this.filter}" 的编辑器实例，已退回使用全部实例。`;
            } else {
                editors = hit;
                this._filterMiss = false;
                this._filterMissDetail = '';
            }
        }
        const multi = editors.length > 1;

        for (const t of this.globalTools) {
            this._byName.set(t.name, { tool: t, kind: 'global' });
        }
        for (const t of this.editorTools) {
            if (multi) {
                for (const e of editors) {
                    const name = `${e.shortName}__${t.name}`;
                    this._byName.set(name, { tool: t, kind: 'editor', editor: e, shortName: e.shortName });
                }
            } else {
                this._byName.set(t.name, { tool: t, kind: 'editor', editor: editors[0] || null });
            }
        }
        this._cache = this._byName;
        return this._cache;
    }

    /** 当前工具清单（供 tools/list）。 */
    list() {
        this._rebuild(false);
        const out = [];
        for (const [name, entry] of this._byName) {
            out.push(toMcpTool(entry.tool, name));
        }
        // 全局工具排前面，编辑器工具按域排序 —— 让模型先看到最常用/最安全的
        out.sort((a, b) => {
            const ga = a.name.includes('__') || GLOBAL_TOOLS.some((t) => t.name === a.name) ? 0 : 1;
            const gb = b.name.includes('__') || GLOBAL_TOOLS.some((t) => t.name === b.name) ? 0 : 1;
            if (ga !== gb) return ga - gb;
            return a.name.localeCompare(b.name);
        });
        return out;
    }

    get count() {
        return this._byName.size;
    }

    /**
     * 执行一个工具。
     * @param {string} name
     * @param {object} args
     */
    async call(name, args = {}) {
        this._rebuild(false);
        // ⚠️ 这个标志必须放在**本次调用的 ctx** 里，不能存注册表实例上 ——
        //    MCP 服务器并发处理请求时，A 的 rollback:false 会被 B 的调用重置，
        //    导致事务意外回滚。
        const entry = this._byName.get(name);
        if (!entry) {
            const available = [...this._byName.keys()].slice(0, 40);
            const err = new Error(
                `未知工具 "${name}"。当前可用工具（${this._byName.size} 个）示例：${available.join('、')}${available.length < this._byName.size ? ' …' : ''}`
            );
            // 协议级错误：MCP 规范里「未知工具」属于调用本身有问题，应走 JSON-RPC error，
            // 客户端据此不会当成「工具跑了但失败」去重试。
            err.protocolCode = -32602;
            throw err;
        }
        const { tool, kind } = entry;
        const client = entry.editor ? this.getClient(entry.editor) : null;

        // ⚠️ 按声明的 schema 校验参数 —— schema 是承诺，声明了就得执行。
        //    危险操作的 confirm 检查已经并进校验里（错误信息更完整，
        //    见 validateArgs 里的说明），这里不再单独抛。
        validateArgs(tool, args);

        const ctx = {
            call: (op, opArgs) => {
                if (!client) throw new Error('当前没有连接到任何 Cocos Creator 实例。');
                return client.invoke(op, opArgs);
            },
            listEditors: this.listEditors,
            toolName: name,
            rollbackEnabled: args.rollback !== false,
        };

        if (kind === 'global') {
            return await this._withTimeout(tool, () => tool.handler(args, ctx));
        }

        if (!entry.editor) {
            throw new Error('当前没有连接到任何 Cocos Creator 实例。请先打开项目并启用 cocos-mcp 扩展。');
        }
        // ⚠️ 编辑器**在跑但没心跳**（正忙 / 场景频道卡死）——
        //    这时再发消息过去只会干等到超时，而且报出来的是
        //    「请求超时」这种没信息量的话。直接快速失败并说清楚。
        if (entry.editor.stale) {
            throw new Error(
                `Cocos Creator 实例 "${entry.editor.shortName}" **没有响应**（心跳超时，进程还在）。` +
                '它可能正忙（批量导入 / 构建 / 场景操作卡住）。请稍后重试；' +
                '如果一直这样，重启 Cocos Creator。'
            );
        }
        if (tool.handler) {
            // ⚠️ handler 型工具也必须走超时 ——
            //    之前只有 op 型路径有超时，handler 型直接 await，
            //    一个卡住的 handler（比如 scene.create 轮询导入）能把请求挂到天荒地老。
            return await this._withTimeout(tool, () => tool.handler(args, ctx));
        }
        const result = await client.invoke(tool.op, args, { timeoutMs: tool.timeoutMs });
        return result;
    }

    /**
     * 给工具调用加超时。
     *
     * ⚠️ 超时必须是**硬超时** —— 超时后请求已经发出去了，
     *    引擎那边可能还在跑。所以错误信息要说清楚是「客户端等超时了」，
     *    而不是「操作失败」（后者会误导模型以为没执行）。
     */
    async _withTimeout(tool, fn) {
        const timeoutMs = tool.timeoutMs || DEFAULT_TIMEOUT_MS;
        if (!timeoutMs || timeoutMs <= 0) return await fn();
        let timer = null;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => {
                const err = new Error(
                    `工具 "${tool.name}" 执行超时（${timeoutMs}ms）。` +
                    '调用可能仍在编辑器里继续执行，请先查询实际状态再决定是否重试。'
                );
                err.code = 'TOOL_TIMEOUT';
                reject(err);
            }, timeoutMs);
        });
        try {
            return await Promise.race([fn(), timeout]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
}

module.exports = { ToolRegistry, EDITOR_TOOLS, GLOBAL_TOOLS };
