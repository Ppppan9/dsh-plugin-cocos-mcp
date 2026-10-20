# cocos-mcp

**给 Cocos Creator 3.8.x 的 MCP（Model Context Protocol）服务。**
让 Claude Code / Cursor / Codex / 任何 MCP 客户端直接操控 Cocos Creator 编辑器与项目文件。

> 设计依据：全网 8 个开源 Cocos MCP 项目的逆向解构 + 对 Cocos Creator 3.8.8 真机二进制的交叉验证。
> 完整调研报告见 [`research/逆向调研报告.md`](research/逆向调研报告.md)。

## 来源与致谢

本项目**没有复制任何第三方代码** —— 这一点经过机械核查（逐行求交集），
详见 [`SOURCES.md`](SOURCES.md)。那里完整列出了：

- 调研过的 **8 个开源项目 + 1 个闭源商业产品**，各自的地址与许可证；
- **代码原创性核查数据**（与参考仓库的字面重合 2.64%，且全部是 `require('fs')` 这类通用样板）；
- **逐条设计借鉴对照表**（我们借鉴了谁的哪个做法、做了什么改动）；
- 许可证合规说明，以及哪些项目**没有**许可证（因此未使用其代码）。

同时，本项目与 Cocos 官方无隶属关系；Cocos Creator 是 Beijing Hode Information Technology
的商标。接口信息来自 Cocos Creator 3.8.8 随包发布的公开类型契约。

---

## 它解决什么问题

现存的 Cocos MCP 实现有三个通病，我们逐个修掉了：

| 通病 | 真实表现 | 本项目 |
|---|---|---|
| 工具注册成功但一调用就报错 | harady 的 10 个 `reference-image` 消息名在 3.8.8 **根本不存在** | **111 条消息白名单**，全部经 3.8.8 包体二进制扫描验证；模型照旧教程调用时会收到「正确名是 X」而不是 not found |
| 多步写操作中途失败留下半改场景 | listar 虽有 `scene:snapshot` 却没编排成事务；**且实测 Cocos 3.8.8 的 `snapshot-abort` / `cancel-recording` 根本不会回滚** | **`scene.transaction`**：自带 undo 日志 —— 执行前捕获逆操作，失败时逆序撤销（真机验证：失败事务后节点数 3 → 3） |
| 任意网页能驱动你的编辑器 | DaxianLee 绑 127.0.0.1 + CORS `*` + 无鉴权 | **Bearer token + Host/Origin 校验 + 4MiB 限额**；**不提供任意 eval** |

---

## 安装

### 1. 装扩展到你的 Cocos 工程

```bash
node scripts/install-extension.js ~/Documents/MyGame
```

或手动把 `extension/` 目录复制到 `<项目>/extensions/cocos-mcp`。

### 2. 打开 Cocos Creator

装完扩展后**重开**编辑器（或用扩展菜单里的「重启 Bridge」）。
面板显示「Bridge 已启动」即表示编辑器侧就绪。

### 3. 配 MCP 客户端

```json
{
  "mcpServers": {
    "cocos-mcp": {
      "command": "node",
      "args": ["/绝对路径/cocos-mcp/hub/bin.js"]
    }
  }
}
```

**零依赖、零配置**：不需要 `npm install`，不需要起 HTTP 服务，不需要配 token。

### 4. 自检

```bash
node hub/bin.js --probe      # 看是否连上编辑器
node hub/bin.js --print-tools # 看完整工具清单
```

---

## 架构

```
Claude Code / Cursor / Codex
        │  stdio + JSON-RPC（MCP 2025-06-18）
        ▼
┌────────────────────────────────────────────┐
│  hub/bin.js                                 │
│  ├─ MCP 协议层（手写，零依赖，完整实现）      │
│  ├─ 多编辑器聚合（短名前缀隔离 + 心跳 + 重连） │
│  ├─ 安全策略（read / write / danger 三级）    │
│  ├─ 知识库（组件属性表 / 坐标系 / 布局 / 踩坑） │
│  └─ 离线 prefab / animation 编辑器（35 op）   │
└───────────────┬────────────────────────────┘
                │  HTTP + Bearer token（仅 127.0.0.1）
                ▼
┌────────────────────────────────────────────┐
│  Cocos Creator 扩展                         │
│  ├─ Bridge：私有 JSON-RPC（不是 MCP endpoint）│
│  ├─ 消息白名单 + 别名纠错                    │
│  ├─ 节点三态解析（uuid / 层级路径 / 名字）     │
│  ├─ 属性值类型自动推断                       │
│  └─ 属性解包（IProperty → 普通值）            │
└───────────────┬────────────────────────────┘
                │  Editor.Message.request(channel, message, ...)
                ▼
        Cocos Creator 3.8.x
```

**为什么 Bridge 不是 MCP endpoint**：MCP 协议只在 hub 实现一次。多编辑器的聚合、工具面、安全策略全在 hub，编辑器侧只做一条窄通道。这样加工具不用改编辑器，重启编辑器不会掉 MCP 连接。

---

## 工具清单（58 个）

### 全局工具（与编辑器实例无关，始终无前缀）

| 工具 | 说明 |
|---|---|
| `cocos_knowledge` | Cocos 知识库：`components` / `coordinates` / `layout` / `workflow` / `traps` / `messages` |
| `cocos_prefab_query` | 离线读 prefab：`tree` / `node` / `find` / `field` / `overrides` |
| `cocos_prefab_edit` | 离线声明式改 prefab（**事务**：全成功才落盘） |
| `cocos_prefab_batch` | 从 JSON 文件读 ops 批量改 |
| `cocos_prefab_ops` | 列出全部 35 个离线 op 与参数 |
| `cocos_anim_query` / `cocos_anim_batch` | 离线读写 .anim |

### 编辑器工具（单实例时无前缀，多实例时 `<短名>__` 前缀）

| 域 | 工具 |
|---|---|
| 场景 | `scene.tree` `scene.node` `scene.find` `scene.open` `scene.create` `scene.save` `scene.reload` `scene.close` `scene.status` `scene.bounds` `scene.classes` `scene.components` `scene.snapshot` `scene.snapshot.abort` **`scene.transaction`** |
| 节点 | `node.create` `node.delete` `node.duplicate` `node.move` `node.active` `node.transform` |
| 组件 | `component.add` `component.remove` `component.list` `component.set` `component.call` |
| 资源 | `asset.query` `asset.info` `asset.create` `asset.save` `asset.delete` `asset.move` `asset.reimport` `asset.refresh` `asset.uuid` `asset.url` `asset.dependencies` |
| 视图/预览 | `preview.url` `view.focus` `view.options` |
| 构建 | `build.start` `build.status` `build.platforms` |
| 参考图 | `reference.add` `reference.remove` `reference.current` `reference.config` |
| 编辑器 | `editor.info` `editor.logs` `editor.console.clear` |
| 底层 | `cocos_message` 原始编辑器消息透传（危险级，白名单校验） |

---

## 典型用法

### 搭一个 UI

```
1. cocos_knowledge(topic="components")           → 确认 cc.Label / cc.Button 的属性名
2. scene.tree                                     → 看当前场景结构
3. scene.transaction(ops=[
     {op:"node.create",   args:{parent:"Canvas", name:"StartBtn", components:["cc.UITransform","cc.Button"]}},
     {op:"node.create",   args:{parent:"StartBtn", name:"Title", components:["cc.UITransform","cc.Label"]}},
     {op:"component.set", args:{node:"Title", component:"cc.Label", property:"string", value:"开始游戏"}}
   ])                                              → 失败自动回滚
4. scene.save
5. editor.logs(level=["error"])                    → 自检
```

### 离线批量改 prefab（编辑器关着也行）

```
1. cocos_prefab_ops                               → 看可用 op
2. cocos_prefab_query(filePath=".../Card.prefab", selector="tree")
3. cocos_prefab_edit(filePath="...", ops=[...], dryRun=true)   → 先看 diff
4. cocos_prefab_edit(filePath="...", ops=[...])                 → 正式执行
5. asset.reimport(url="db://assets/...")                        → 通知编辑器
```

---

## 安全模型

| 等级 | 工具 | 行为 |
|---|---|---|
| `read` | 全部只读工具 | 直接执行 |
| `write` | 改场景/资源 | 直接执行，可撤销 |
| `danger` | `node.delete` `component.remove` `asset.delete` | **必须同一次调用传 `confirm: true`**；`confirm` 被写进 inputSchema 的 `required`，模型绕不过，执行期再校验一次 |

另外：

- **路径护栏**：所有离线文件操作强制落在已注册的 Cocos 项目目录内，越界直接拒绝并说明允许的项目根。
- **无任意代码执行**：不提供 `new Function` / eval 通道。场景进程脚本只导出固定白名单方法。
- **Bridge 鉴权**：Bearer token + `timingSafeEqual`、Host 必须 loopback、拒绝浏览器 Origin、请求体 4MiB 上限。

---

## 多编辑器并行

每个编辑器实例向 `~/.cocos-mcp/editors/<pid>.json` 写心跳。hub 扫描目录发现实例，
按**短名**隔离工具（短名 = 项目目录名；同名冲突时自动加后缀）。

- 只开一个项目 → 工具名是 `scene.tree`
- 同时开两个 → 工具名变成 `forest__scene.tree` / `card__scene.tree`

hub 会在实例数量变化时发 `notifications/tools/list_changed`，客户端自动刷新工具列表。

---

## 改扩展代码后不用重启编辑器

```bash
echo "restart-package" > <你的项目>/.dev/refresh
```

扩展会禁用再启用自己，整个沙箱重建，所有 JS 重新加载。

---

## 开发与验证

```bash
npm test              # 全部单测（34 个用例：离线编辑器 26 + 事务回滚 8）
npm run test:e2e      # 端到端（需要 Cocos Creator 开着并装了扩展）
npm run test:smoke    # 全工具冒烟（67 次调用，覆盖全部 59 个工具）
```

> ⚠️ `node --test <目录>` 在 Node 22.22 上会把目录当模块加载而失败，**必须用文件通配符**。
> （这个坑现存开源项目里也踩过，README 里都没写。）

### 三层验证

| 层 | 脚本 | 覆盖 | 当前 |
|---|---|---|---|
| 单测 | `hub/test/` + `hub/src/offline/test/` | 离线 prefab/anim 读写、事务 undo 日志 | **34/34** |
| 端到端 | `test/e2e.js` | MCP 握手 → 工具面 → 真实读取 → **真实写入闭环** → **事务失败真回滚** → 安全护栏 → Resources → 离线能力 → 路径护栏 → 多编辑器前缀隔离 | **59/59** |
| 全工具冒烟 | `test/tool-smoke.js` | **每一个**工具都真跑一遍 + 工具面静态自检（描述/schema/安全标记） | **67/67** |

> 为什么要单独做「全工具冒烟」：现存开源实现最大的问题就是**工具注册成功但一调用就报错**。
> 声明 ≠ 能用。逐个真跑一遍，才知道工具面是真是假。
> 本项目的 `test/tool-smoke.js` 就是为此写的 —— 它在本轮就抓出了 4 个真缺陷（见下）。

### 本轮「仔细检查」抓出的真缺陷（已全部修掉）

| 缺陷 | 影响 | 修法 |
|---|---|---|
| `editor.logs` 调了不存在的 `console:query` 消息 | 工具**注册成功但一调用就报错** | 改用官方 `Editor.Logger.query()`（同步 API，字段 `{process,type,message,stack,time}`） |
| 8 个已实现的 Bridge 操作**没暴露**成 MCP 工具 | 有能不用 | 补 `scene.classes` / `scene.components` / `scene.snapshot` / `scene.snapshot.abort` / `scene.bounds` / `build.platforms` / `reference.current` / `reference.config` / `editor.console.clear` |
| `scene:query-classes` 参数用错（`{name}` 而非 `{extends}`） | 查组件类返回**空数组** | 改为 `{extends:'cc.Component', excludeSelf:true}` |
| 声称「`scene.snapshot` 可编排事务回滚」 | **回滚是假的** | 实测 snapshot-abort / cancel-recording 都不回滚 → 改为自带 undo 日志（`hub/src/tools/transaction.js`） |
| 路径护栏无法放宽 | 改不了项目外的美术资源库 | 新增 `COCOS_MCP_EXTRA_ROOTS` 环境变量，错误信息里给出用法 |
| `COCOS_MCP_EDITOR_FILTER` 只在扩展端写、hub 端没实现 | 复制出来的配置无效 | hub 端实现过滤 |
| `scene:open-scene` 失败时不 reject 消息 | 调用方干等到客户端超时 | Bridge 侧自己兜 60s 超时，并把「资源可能还没导入完」写进错误信息 |
| 删根节点 / 删不存在的组件 / 删不存在的资源**返回"成功"** | 假成功比报错更危险 | 三处都改成明确拦截或明确报错 |
| 缺少必填参数时编辑器只回一句 `parameter error` | 模型不知道是自己少传了东西 | Bridge 层前置参数校验，回中文明确错误 |

### 实测到的 Cocos 3.8.8 引擎行为（详见调研报告）

- **`scene:snapshot` / `snapshot-abort` / `begin-recording` / `cancel-recording` 全都不回滚任何修改**，
  尽管官方 i18n 描述写着 "for undo"。→ 事务必须自己实现 undo 日志。
- **`scene:open-scene` 失败时不 resolve 也不 reject** → 必须自己兜超时。
- **`console:query` 消息不存在**，读控制台只能用 `Editor.Logger.query()`。
- **`scene:query-classes` 的参数是 `{extends, excludeSelf}`**，传 `{}` 返回空数组。
- **`scene:query-node-tree` 不含 `__comps__`** → 树里不能输出 `components: []`（会误导模型）。
- **短 uuid 是 base64 字符集**（含 `g`/`x`/`k` 等非十六进制字符），不能按 hex 判。

---

## 目录结构

```
cocos-mcp/
├── hub/
│   ├── bin.js                    # stdio MCP Server 入口
│   └── src/
│       ├── mcp/server.js         # MCP 协议实现（零依赖）
│       ├── registry.js           # 编辑器实例发现 / 短名去重
│       ├── editor-client.js      # Bridge HTTP 客户端
│       ├── tools/
│       │   ├── editor-tools.js   # 编辑器侧工具（48 个里的编辑器部分）
│       │   ├── global-tools.js   # 知识库 + 离线工具
│       │   └── index.js          # 工具装配与调度（含安全策略）
│       ├── knowledge/
│       │   ├── cocos-knowledge.json    # 组件属性表 / 坐标系 / 布局 / 踩坑
│       │   └── editor-messages.json    # 111 条已验证消息清单
│       └── offline/               # 离线 prefab / animation 编辑器（35 op）
├── extension/
│   ├── package.json              # Cocos 扩展清单
│   ├── main.js                   # 扩展主进程（Bridge + 心跳 + .dev/refresh）
│   ├── scene.js                  # 场景进程脚本（白名单方法）
│   ├── bridge/
│   │   ├── server.js             # Bridge HTTP 服务（鉴权）
│   │   ├── handlers.js           # 操作层（消息白名单 / 节点解析 / 类型推断 / 解包）
│   │   └── messages.js           # ★ 111 条已验证消息白名单 + 别名纠错
│   └── panels/default/index.js   # 面板
├── scripts/install-extension.js
├── test/
│   ├── e2e.js               # 端到端（真机 Cocos）
│   └── tool-smoke.js        # 全工具冒烟（逐个真跑）
├── research/
│   └── 逆向调研报告.md       # 8 个项目的解构 + 引擎行为实测
├── SOURCES.md                # ★ 来源与致谢：调研对象 / 原创性核查 / 设计借鉴对照
├── NOTICE
├── LICENSE
└── package.json
```

## 环境要求

- Cocos Creator **3.8.0+**（在 3.8.8 上实测）
- Node.js **18+**（开发用 22.x）
- macOS / Windows / Linux（编辑器侧随平台；hub 侧纯 Node，跨平台）

## License

MIT
