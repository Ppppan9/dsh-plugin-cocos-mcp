'use strict';

/**
 * Cocos MCP 面板
 * ---------------------------------------------------------------------------
 * 展示 Bridge 状态，并给出「怎么把这个 MCP 接进 AI 客户端」的一键复制。
 * 面板本身不是必需的 —— 删掉它 MCP 也能跑 —— 但它把「怎么装」这件事从
 * 读文档变成点一下。
 */

// ⚠️ 不要 require('cc') —— Cocos 3.8 的内置 Vue 是 2.7.14，
//    'cc' 的 Module._load 补丁只打在主进程，面板跑在渲染进程，require 会抛
//    'Cannot find module cc' → 面板整个白屏。这两个变量本来也没用到。

// ⚠️ 路径要相对**当前文件目录**：面板在 <扩展>/panels/default/index.js，
//    '../..' 才是扩展包根。之前写 '../../../' 会跑到 <项目>/extensions/bridge/ → 不存在。
const { api } = require('../../bridge/status-client.js');

module.exports = {
    template: `
<div class="cocos-mcp-panel">
    <div class="status-line">
        <span class="dot" :class="statusClass"></span>
        <span class="status-text">{{ statusText }}</span>
    </div>
    <div class="block" v-if="status && status.running">
        <div class="row"><label>端点</label><code>{{ status.url }}</code></div>
        <div class="row"><label>实例短名</label><code>{{ status.shortName }}</code></div>
        <div class="row"><label>编辑器版本</label><code>{{ status.editorVersion }}</code></div>
        <div class="row"><label>项目路径</label><code class="path">{{ status.projectPath }}</code></div>
    </div>
    <div class="block" v-if="!status || !status.running">
        <p class="hint">Bridge 未运行。尝试重启扩展，或检查控制台报错。</p>
        <button @click="restart">重启 Bridge</button>
    </div>

    <div class="block">
        <div class="block-title">接入 AI 客户端</div>
        <p class="hint">把下面这段加到 MCP 客户端配置里（Claude Code / Cursor / Codex 均适用）：</p>
        <pre class="config">{{ clientConfig }}</pre>
        <button @click="copyConfig">复制配置</button>
        <span class="copied" v-if="copied">已复制 ✓</span>
    </div>

    <div class="block">
        <div class="block-title">可用编辑器消息</div>
        <p class="hint">本扩展只调用经 Cocos Creator 3.8.x 真机验证存在的编辑器消息。
        共 <b>{{ messageCount }}</b> 条 / <b>{{ channelCount }}</b> 个频道。</p>
    </div>
</div>
`,
    style: `
.cocos-mcp-panel { padding: 12px; font-size: 12px; }
.status-line { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: #888; display: inline-block; }
.dot.ok { background: #3cc551; box-shadow: 0 0 6px #3cc551; }
.dot.bad { background: #d9534f; }
.status-text { font-weight: 600; }
.block { margin-top: 16px; padding-top: 12px; border-top: 1px solid rgba(128,128,128,.25); }
.block-title { font-weight: 600; margin-bottom: 6px; }
.row { display: flex; gap: 8px; margin: 4px 0; align-items: baseline; }
.row label { width: 78px; opacity: .7; flex: none; }
.row code { word-break: break-all; }
.path { font-size: 11px; }
.hint { opacity: .72; line-height: 1.6; margin: 6px 0; }
pre.config { background: rgba(0,0,0,.28); padding: 8px; border-radius: 4px; font-size: 11px;
  white-space: pre-wrap; word-break: break-all; max-height: 180px; overflow: auto; }
button { padding: 4px 12px; cursor: pointer; }
.copied { color: #3cc551; margin-left: 8px; }
`,

    data() {
        return {
            status: null,
            clientConfig: '',
            copied: false,
            messageCount: 0,
            channelCount: 0,
        };
    },

    methods: {
        /**
         * ⚠️ 必须放在 methods 里 —— Vue 2 的选项合并只认 methods 对象的成员，
         *    顶层的自定义选项不会挂到实例上，`this._stopTimer` 会是 undefined。
         */
        _stopTimer() {
            if (this._timer) {
                clearInterval(this._timer);
                this._timer = null;
            }
        },
        async refresh() {
            try {
                this.status = await api.getStatus();
                this.clientConfig = await api.getClientConfig();
                const channels = await api.getChannels();
                this.channelCount = Object.keys(channels || {}).length;
                this.messageCount = Object.values(channels || {}).reduce((a, b) => a + b.length, 0);
            } catch (e) {
                this.status = { running: false };
            }
            return this.status;
        },
        async restart() {
            await api.restart();
            setTimeout(() => this.refresh(), 1200);
        },
        async copyConfig() {
            await api.copyClientConfig();
            this.copied = true;
            setTimeout(() => (this.copied = false), 2000);
        },
    },

    ready() {
        this.refresh();
        this._timer = setInterval(() => this.refresh(), 5000);
    },
    /**
     * ⚠️ Cocos 3.8 的面板生命周期是 ready / beforeClose / close ——
     *    **没有 beforeUnmount**（那是 Vue 3 的钩子，内置是 Vue 2.7.14，永不触发）。
     *    之前写 beforeUnmount → 面板关掉后 5 秒定时器继续跑，
     *    每开一次面板就多一个定时器并发跨进程刷新。两个钩子都实现最稳。
     */
    beforeClose() {
        this._stopTimer();
    },
    close() {
        this._stopTimer();
    },
};
