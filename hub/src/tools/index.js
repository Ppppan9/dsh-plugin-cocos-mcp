'use strict';

const { EDITOR_TOOLS } = require('./editor-tools');
const { GLOBAL_TOOLS } = require('./global-tools');

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

const DANGER = 'danger';

function toSchema(tool) {
    const schema = {
        type: 'object',
        properties: { ...(tool.inputSchema.properties || {}) },
        required: [...(tool.inputSchema.required || [])],
    };
    if (tool.safety === DANGER) {
        schema.properties.confirm = {
            type: 'boolean',
            const: true,
            description: '破坏性操作确认位。必须显式传 true 才会执行。',
        };
        if (!schema.required.includes('confirm')) schema.required.push('confirm');
    }
    return schema;
}

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
        this._rebuild();
    }

    /**
     * 工具表只在「编辑器实例集合变化」时才需要重建。
     * 之前每次 tools/call 都重建一遍 56 个工具的 Map —— 在一个会话里
     * 几十次调用就白烧掉几十次重建（每次还要算 dedupeShortNames）。
     */
    _rebuild(force = false) {
        const editors = this.listEditors() || [];
        const sig = editors.map((e) => `${e.pid}:${e.shortName}`).join('|') + '#' + this.filter;
        if (!force && sig === this._sig && this._byName.size) {
            return this._cache;
        }
        this._sig = sig;
        this._byName.clear();
        if (this.filter) {
            const hit = editors.filter((e) => e.shortName === this.filter);
            if (!hit.length) {
                // 过滤的实例不在了就退回全部，避免整个服务不可用
                this._filterMiss = true;
            } else {
                editors = hit;
                this._filterMiss = false;
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
        const entry = this._byName.get(name);
        if (!entry) {
            const available = [...this._byName.keys()].slice(0, 40);
            throw new Error(
                `未知工具 "${name}"。当前可用工具（${this._byName.size} 个）示例：${available.join('、')}${available.length < this._byName.size ? ' …' : ''}`
            );
        }
        const { tool, kind } = entry;
        const client = entry.editor ? this.getClient(entry.editor) : null;

        // 危险操作二次校验（不依赖 schema）
        if (tool.safety === DANGER && args.confirm !== true) {
            throw new Error(
                `工具 "${name}" 是破坏性操作，必须显式传 confirm=true 才会执行。` +
                `如果你已经确认过，请把 confirm: true 和其它参数放在同一次调用里。`
            );
        }

        const ctx = {
            call: (op, opArgs) => {
                if (!client) throw new Error('当前没有连接到任何 Cocos Creator 实例。');
                return client.invoke(op, opArgs);
            },
            listEditors: this.listEditors,
            toolName: name,
        };

        if (kind === 'global') {
            return await tool.handler(args, ctx);
        }

        if (!entry.editor) {
            throw new Error('当前没有连接到任何 Cocos Creator 实例。请先打开项目并启用 cocos-mcp 扩展。');
        }
        if (tool.handler) {
            return await tool.handler(args, ctx);
        }
        const result = await client.invoke(tool.op, args, { timeoutMs: tool.timeoutMs });
        return result;
    }
}

module.exports = { ToolRegistry, EDITOR_TOOLS, GLOBAL_TOOLS };
