'use strict';

/**
 * 冒烟脚本的**假 MCP 客户端**（进程内，不起子进程）。
 * ---------------------------------------------------------------------------
 * 用途：让 `test/tool-smoke.js` 在**没有 Cocos Creator** 的环境里
 * 完整跑一遍真实的 main() 流程 —— 于是「真实路径里那个 finish() 调用」
 * 也被覆盖到了。
 *
 * ⚠️ 为什么需要它（第 8 轮独立复审实测出来的缺口）：
 *   之前只有 `--selftest-exit` 模式，它直接调用 finish() 这个**函数**。
 *   于是「main() 末尾那个真实的 finish() 调用」本身没有保护 ——
 *   把它删掉，用例**一片绿**，而真实运行时脚本会**根本不打印汇总、退出码 0**
 *   → CI 判绿。跟 H1 是同一类病（纯函数有测试，接线没有）。
 *
 * 假客户端答什么：所有工具都返回**成功** + 一个通用载荷。
 * 于是凡是 `expectError: true` 的检查（期望被拒绝的那些）会**失败** ——
 * 这正是我们要的：让这一轮**确定性地**以退出码 1 结束，
 * 从而「删掉真实 finish() 调用 → 退出码 0」能被区分出来。
 */

const FAKE_UUID = '00000000-0000-0000-0000-000000000000';

const ALL_TOOLS = [
    ...require('../hub/src/tools/editor-tools').EDITOR_TOOLS,
    ...require('../hub/src/tools/global-tools').GLOBAL_TOOLS,
];

/** 通用载荷：覆盖脚本里读到的各种形状。 */
function genericPayload(name) {
    return {
        // 场景
        root: 'Scene',
        count: 0,
        nodes: [],
        classes: [],
        components: [],
        bounds: { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 },
        ready: true,
        dirty: false,
        node: null,
        // 资源
        assets: [],
        url: 'db://assets/__fake.scene',
        uuid: '00000000-0000-0000-0000-000000000000',
        path: '/tmp/__fake',
        // 杂项
        total: 0,
        entries: [],
        opened: '00000000-0000-0000-0000-000000000000',
        name: '__fake.scene',
        saved: true,
        reloaded: true,
        deleted: 'db://assets/__fake.scene',
        created: true,
        imported: true,
        changed: 0,
        diff: [],
        steps: [],
        written: [],
        ok: true,
        data: {},
        result: {},
        channels: [],
        version: '3.8.8',
        note: 'fake',
        channels_available: [],
        aliases: {},
        knownMissing: [],
        traps: [],
        components_list: [],
        coordinates: {},
        domain: 'prefab',
        count_ops: 0,
        ops: [],
        name_tool: name,
    };
}

/**
 * 造一个假的 MCP 客户端，接口与 test/tool-smoke.js 里的 McpClient 一致。
 */
function makeFakeClient() {
    const toolNames = new Set(ALL_TOOLS.map((t) => t.name));
    return {
        proc: null,
        buf: '',
        pending: new Map(),
        nextId: 1,
        toolNames,
        prefixed: new Map(),
        closed: false,
        calls: [],

        async request(method, params) {
            if (method === 'tools/list') {
                return {
                    result: {
                        tools: ALL_TOOLS.map((t) => ({
                            name: t.name,
                            description: t.description,
                            inputSchema: t.inputSchema,
                            annotations: t.annotations,
                        })),
                    },
                };
            }
            return { result: {} };
        },
        notify() {},
        async call(name) {
            this.calls.push(name);
            // ⚠️ `asset.query` 必须**返回点东西** ——
            //    冒烟脚本里「场景生命周期」那一整段（scene.create / open / save /
            //    reload / delete，以及 asset.uuid / path / url / users /
            //    dependencies / isImported）都挂在这个查询的结果上。
            //    返回空数组 → 整段被跳过 → **10 个工具在「真实流程」模式下根本没被跑到**，
            //    接线看着被测了、真实路径的行为却没被测到。
            if (name === 'asset.query') {
                const payload = genericPayload(name);
                payload.assets = [
                    { url: 'db://assets/scenes/__fake.scene', uuid: FAKE_UUID, name: '__fake.scene' },
                ];
                return { isError: false, data: payload, text: JSON.stringify(payload) };
            }
            return { isError: false, data: genericPayload(name), text: JSON.stringify(genericPayload(name)) };
        },
        async loadTools() {
            return this.toolNames;
        },
        resolveToolName(name) {
            return name;
        },
        close() {
            this.closed = true;
            // 报告**跑到了几个工具** —— 载荷太假会让整段流程被跳过
            // （asset.query 返回空 → 场景生命周期那 10 个工具一个都跑不到），
            // 而接线看着被测了、真实路径的行为却没被测到。
            try {
                // ⚠️ 报的是**去重后的工具数** —— 调用次数会被重复调用放大，
                //    退化时看着仍然很高，就抓不住了。
                require('node:fs').appendFileSync('/dev/stderr', `FAKE_CALLED_TOOLS:${new Set(this.calls).size}\n`);
            } catch (_) {}
            // ⚠️ 打一个标记 —— 真实调用点如果把 cleanup 实参改成 null，
            //    客户端就永远不会被关掉（CI 上漏进程）。
            //    光看退出码测不出来（process.exit 紧跟其后），靠这个标记。
            process.stderr.write('FAKE_CLIENT_CLOSED\n');
        },
    };
}

module.exports = { makeFakeClient, genericPayload, ALL_TOOLS };
