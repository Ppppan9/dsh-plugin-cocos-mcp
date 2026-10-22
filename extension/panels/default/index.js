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
        <!-- ⚠️ 场景频道中毒后，**所有场景工具都会失败**，而表现只是「超时」。
             在这里明说，用户一眼就知道该重启，而不是以为 MCP 装错了。 -->
        <div class="row" v-if="status.sceneHealth">
            <label>场景频道</label>
            <code :style="status.sceneHealth.dead ? 'color:#e5534b' : 'color:#57ab5a'">
                {{ status.sceneHealth.dead ? '已中毒（所有场景工具会失败）' : '正常' }}
            </code>
        </div>
        <div class="row" v-if="status.sceneHealth && status.sceneHealth.dead">
            <label></label>
            <button @click="restart">重启 Bridge</button>
        </div>
        <div class="row" v-if="status.sceneHealth && status.sceneHealth.lastProbeError && !status.sceneHealth.dead">
            <label>最近探活</label>
            <code class="path">{{ status.sceneHealth.lastProbeError }}</code>
        </div>
    </div>
    <div class="block" v-if="!status || !status.running">
        <p class="hint">Bridge 未运行。尝试重启扩展，或检查控制台报错。</p>
        <button @click="restart">重启 Bridge</button>
    </div>

    <!-- ⚠️ 三个 IPC 各自分开失败，各说各的 ——
         之前共用一个 try：拿不到客户端配置会把「Bridge 未运行」也显示出来，
         用户会跑去重启 Bridge —— 而重启解决不了这个问题，纯误导。 -->
    <div class="block" v-if="statusError">
        <div class="block-title">状态读取失败</div>
        <p class="hint error">{{ statusError }}</p>
    </div>
    <div class="block" v-if="configError">
        <div class="block-title">客户端配置读取失败</div>
        <p class="hint error">{{ configError }}</p>
    </div>
    <div class="block" v-if="channelsError">
        <div class="block-title">消息清单读取失败</div>
        <p class="hint error">{{ channelsError }}</p>
    </div>

    <div class="block" v-if="hubInfo">
        <div class="block-title">Hub 位置</div>
        <div class="row"><label>路径</label><code class="path">{{ hubInfo.hub || '(未找到)' }}</code></div>
        <p class="hint" v-if="!hubInfo.found">
            找不到 hub/bin.js —— 请重新运行 <code>node scripts/install-extension.js &lt;项目路径&gt;</code>，
            或设置环境变量 <code>COCOS_MCP_HUB</code> 指向它。
        </p>
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
.hint.error { opacity: 1; color: #e5534b; }
pre.config { background: rgba(0,0,0,.28); padding: 8px; border-radius: 4px; font-size: 11px;
  white-space: pre-wrap; word-break: break-all; max-height: 180px; overflow: auto; }
button { padding: 4px 12px; cursor: pointer; }
.copied { color: #3cc551; margin-left: 8px; }
`,

    data() {
        return {
            status: null,
            hubInfo: null,
            clientConfig: '',
            copied: false,
            messageCount: 0,
            channelCount: 0,
        };
    },

    methods: {
        /** 面板要显示 hub 路径 —— 用户才知道配置为什么连不上。 */
        async loadHubInfo() {
            try {
                this.hubInfo = await Editor.Message.request('cocos-mcp', 'getHubInfo');
            } catch (e) {
                this.hubInfo = { hub: null, found: false };
            }
        },
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
            // ⚠️ 三个 IPC **各自分开 try** ——
            //    之前共用一个 try：getStatus 成功后，getClientConfig / getChannels
            //    任一失败就把 `this.status` 覆盖成 {running:false}，
            //    面板于是把「拿不到客户端配置」显示成「**Bridge 没运行**」，
            //    用户会跑去点「重启 Bridge」—— 重启也解决不了，纯粹误导。
            try {
                this.status = await api.getStatus();
            } catch (e) {
                this.status = { running: false };
                this.statusError = `读 Bridge 状态失败：${e && e.message ? e.message : e}`;
            }
            try {
                this.clientConfig = await api.getClientConfig();
            } catch (e) {
                this.clientConfig = null;
                this.configError = `读客户端配置失败：${e && e.message ? e.message : e}`;
            }
            try {
                const channels = await api.getChannels();
                this.channelCount = Object.keys(channels || {}).length;
                this.messageCount = Object.values(channels || {}).reduce((a, b) => a + b.length, 0);
            } catch (e) {
                this.channelCount = 0;
                this.messageCount = 0;
                this.channelsError = `读消息清单失败：${e && e.message ? e.message : e}`;
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
        this.loadHubInfo();
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
