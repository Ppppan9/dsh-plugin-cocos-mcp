# 来源与致谢 / Sources & Attribution

本文件说明 `cocos-mcp` 这个项目的**一切外部来源**：调研对象、借鉴的设计、
代码原创性、以及许可证合规情况。

> 原则：**来源写在明处**。借鉴了谁的设计、参考了谁的实现、哪些结论来自
> 哪个项目的实测，都逐条列出，方便任何第三方复核。

---

## 一、调研对象（8 个开源项目 + 1 个闭源商业产品）

本项目在设计前，对下列项目做了完整的源码级解构。它们**没有被包含进本仓库**
（见第四节），仅作为调研与设计参考。

| # | 项目 | 地址 | 许可证 | 我们从中借鉴了什么 |
|---|---|---|---|---|
| 1 | `DaxianLee/cocos-mcp-server` | https://github.com/DaxianLee/cocos-mcp-server | **无 LICENSE 文件**（默认全部版权） | 仅调研：工具分域思路、`ToolDefinition`/`ToolExecutor` 的形态。作为反面教材：README 与实现脱节、无鉴权、硬编码路径 |
| 2 | `listar/cocos-mcp-server` | https://github.com/listar/cocos-mcp-server | **无 LICENSE 文件**（默认全部版权） | 仅调研：官方 MCP SDK + Streamable HTTP 的接法、**逐工具安全策略表 + 双向强校验**的思路（未复制代码） |
| 3 | `harady/cocos-creator-mcp` | https://github.com/harady/cocos-creator-mcp | MIT © 2026 Yusuke Harada | 仅调研：MCP Resources 的 `cocos://` URI 面、节点名兜底解析、`tool-base` 统一返回形状。作为反面教材：10 个 reference-image 消息名在 3.8.8 不存在 |
| 4 | `HappyLifeOk/cc-3-8-x-mcp` | https://github.com/HappyLifeOk/cc-3-8-x-mcp | **Apache-2.0** | 仅调研：多实例 Router + 短名前缀隔离、离线 prefab 编辑的**延迟写盘即免回滚**的事务模型。作为反面教材：prefab 写回无原子写、`.meta` 绕过事务、Windows 不兼容 |
| 5 | `JoseeRen/cc-3-8-x-mcp` | https://github.com/JoseeRen/cc-3-8-x-mcp | **Apache-2.0** | 仅调研：扩展内直接跑 MCP + 子模块 SDK 的形态（上一代架构） |
| 6 | `shiliyu1991-lang/cocos-mcp-3x` | https://github.com/shiliyu1991-lang/cocos-mcp-3x | MIT © 2026 cocosMcp | 仅调研：Python 侧「编辑器拨入」连接方向、**双通道日志采集**（编辑器 console + 浏览器预览注入）的产品思路。作为反面教材：任意 `new Function` 逃逸口 |
| 7 | `lwsinclair/cocosMCP` | https://github.com/lwsinclair/cocosMCP | MIT © 2025 czh2774 | 仅调研：TCP 桥接 + 日志桥接的形态 |
| 8 | `czh2774/cocosMCP` | https://github.com/czh2774/cocosMCP | MIT © 2025 czh2774 | 与 #7 经 `diff -rq` 验证**字节级完全相同**（同一份代码的两个 fork）。仅调研：`Editor.Message.request('scene','execute-scene-script')` 的正确用法 |
| ★ | VberAI Cocos MCP **Pro**（闭源商业） | https://vberai.com | 闭源，仅可试用 | 仅调研其**公开宣传的能力清单**（16 意图级工具 / 231 操作 / Token 优化 / 场景构建器 / 参考图叠加 / 节点树缓存 / 快照回滚），用来推导我们该做什么。**未使用其任何代码**；其中「快照回滚」一项经我方实测证伪（见 `research/逆向调研报告.md` 第 6.1 节） |

---

## 二、代码原创性声明

**本仓库的代码为独立实现，没有从上述任何项目复制代码。**

我们做过一次机械核查：对本仓库每个 `.js` 文件去掉空行/注释后，逐行与上述 8 个仓库
的全部 `.js`/`.ts` 求交集，结果如下。

| 指标 | 数值 |
|---|---|
| 本仓库有实质内容的代码行 | 3446 行 |
| 与「重合最多的那个参考仓库」的交集 | 91 行（**2.64%**） |
| 交集的实际内容 | **全部是通用样板语句**，例如 `const fs = require('fs')`、`return new Promise((resolve, reject) => {`、`fs.mkdirSync(dir, { recursive: true })`、`'Content-Length': Buffer.byteLength(data)` |

**没有任何一条实质逻辑（算法、控制流、错误处理）是从参考项目复制来的。**
不可回避的共同点只有「用 Node 读文件」「用 Promise 包异步」这类语言层面的必然写法。

> 本仓库 `hub/src/offline/` 的实现参考了 Apache-2.0 项目 #4 的**问题清单**（已知缺陷）
> 与**格式知识**（Cocos 的 `.prefab` / `.anim` JSON 结构），但实现是重写的，
> 并且修掉了那 8 个缺陷（原子写、`.meta` 事务化、纯 Node 目录遍历等）。

---

## 三、逐条设计借鉴（Design Influences）

代码是原创的，但**设计思路**确实来自前人的实践。逐条列明：

| 我们的设计 | 借鉴自 | 我们做的改动 |
|---|---|---|
| 编辑器侧 Bridge 与 MCP endpoint 分离，MCP 协议只在 hub 实现一次 | #4 HappyLifeOk | 增加 Bearer token 鉴权 + Host/Origin 校验 + 4MiB 限额 |
| 多编辑器用短名前缀隔离 | #4 HappyLifeOk | 两级去重（同项目双开 / 跨项目同名）、心跳保活、僵尸注册清理 |
| 离线 prefab「延迟写盘即免回滚」的事务模型 | #4 HappyLifeOk | 补上 tmp+rename 原子写、`.meta` 纳入事务、纯 Node 目录遍历（跨平台） |
| 逐工具安全策略登记（read / write / danger 三级） | #2 listar | 改为 schema 层强制 `confirm` + 执行期二次校验；危险工具清单由我们自己定义 |
| MCP Resources 把只读数据挪出 tool 面 | #3 harady | 资源 URI 加短名前缀，支持多编辑器 |
| 节点名兜底解析（不必先查 uuid） | #3 harady | 扩展为 **uuid / 层级路径 / 节点名** 三态解析 |
| 官方 MCP SDK + Streamable HTTP | #2 listar | **没有采用 SDK**：改为手写完整协议，换取零依赖零配置 |
| 「编辑器开端口 / Python 连出」vs「编辑器拨入」的取舍 | #6/#7 家族C | 采用**编辑器拨入**方向，并补上自动重连与心跳 |
| 双通道日志采集（编辑器 + 浏览器预览注入） | #6 shiliyu1991 | 尚未实现，已列入规划 |
| 内置知识库（组件属性表 / 坐标系 / 布局配方 / 踩坑清单） | #★ VberAI Pro 的公开能力清单 | 内容由我们依据 Cocos Creator 3.8.8 官方文档自行整理 |
| 工具描述写清「何时用 / 何时别用」 | #1 DaxianLee 的反面教材 | 全部 58 个工具的描述都带使用边界 |

---

## 四、本仓库**没有**包含的内容

- **没有**包含上述 8 个参考仓库的代码。二者均**未**被复制进本仓库，
  仅在本机调研目录 `cocos-mcp-research/repos/` 下留有 clone 供内部复核。
- **没有**包含任何 Cocos Creator 的安装包内容。二进制、官方类型定义等仅用于本地分析。

---

## 五、Cocos Creator 相关声明

- **Cocos Creator** 与 **Cocos** 是 Beijing Hode Information Technology Co., Ltd. 的商标。
  本项目是**第三方社区工具**，与 Cocos 官方无隶属、无背书关系。
- 本项目调用的全部编辑器接口均来自 **Cocos Creator 3.8.8 随包发布的公开类型契约**
  （`@cocos/creator-types`，`node_modules/@cocos/creator-types/editor/**`，共 896 个文件 /
  504 个 `.d.ts`）与随包附带的 i18n 消息描述表
  （`builtin/scene/i18n/en/contributions/messages.js`）。这些都是**接口事实**，
  不构成对 Cocos 代码的复制。
- `extension/templates/empty-scene.scene` 是一个**空白场景的数据模板**，
  其结构由 Cocos Creator 的序列化格式决定，其中的数值均为**引擎默认配置**
  （环境光、阴影、天盒、雾效的出厂默认值）。它是「格式 + 默认值」，
  不是创作内容。
- 引擎源码 `cocos/cocos-engine` 为 MIT 许可；本项目未复制其代码，
  但使用了其公开的 `.prefab` / `.anim` 文件格式知识。

---

## 六、许可证

| 项目 | 许可证 |
|---|---|
| 本项目代码（`hub/`、`extension/`、`scripts/`、`test/`） | **MIT**（见 `LICENSE`） |
| 本项目文档 | MIT |
| 调研对象 #3 #6 #7 #8（MIT） | 未复制代码；设计借鉴已在第三节标注 |
| 调研对象 #4 #5（Apache-2.0） | 未复制代码；设计借鉴已在第三节标注 |
| 调研对象 #1 #2（无许可证） | **未复用任何代码**，仅作调研对象 |

> 按惯例，无 LICENSE 文件的项目默认保留全部著作权，因此本项目未使用其代码。
> 本仓库未包含任何来自上述项目的第三方代码，因此无须附上 Apache-2.0 的
> NOTICE 转发条款；作为额外保险，本仓库仍附带一份 `NOTICE` 说明来源。

---

## 七、可复核性

本项目自带的验证脚本可复现报告中的关键结论：

```bash
npm test              # 单测：离线编辑器 + 事务回滚
npm run test:e2e      # 端到端：真机 Cocos Creator 3.8.8
npm run test:smoke    # 全工具冒烟：逐个真跑每个工具
```

调研报告见 [`research/逆向调研报告.md`](research/逆向调研报告.md)，
其中每条结论都标注了出处（哪个仓库的哪个文件）或标注为「实测」并给出验证方法。
