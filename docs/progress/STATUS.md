# CharaMate 当前状态

> 更新日期：2026-08-08

## 当前里程碑

**Phase 2 — Done**

Phase 0、Phase 1 与 Phase 2 已完成。Phase 2 将已接受的 `HARNESS-LOOP`、`TOOL-DISCOVERY` 与 `PROVIDER-PROMPT-CACHE` 结果重写为一条 CharaMate 自有生产路径；实验候选、fallback、Arm 开关、调参入口和 runner 均未进入生产树。

退出条件：

- [x] 唯一 `AgentRuntime` 支持 Direct、同 Chat 历史、steering、checkpoint、显式继续、取消、恢复、自动压缩和无进展 Guard；没有全局固定步数、墙钟、Token 或成本静默截断。
- [x] `ContextCompiler` 固定采用 90% resolved-input trigger、结构化 handoff 和最新用户消息保留；未知 Provider 限额时不臆造阈值，真实 context-limit 仅进行一次强制压缩恢复。
- [x] 统一 JSON Schema Tool Registry 使用 native client Tool Search、metadata BM25、limit 8、结构化 Tool Result、artifact、AbortSignal 和可见增量输出；Chat 模式在暴露层和执行层都禁止 CharaMate action Tool，但保留 Provider 原生只读 Web Search。
- [x] 三档 Approval、Chat Card 与桌宠气泡共享同一持久化 Approval；审批前、拒绝后和取消后的副作用边界有确定性覆盖。
- [x] File、Command、App、Managed Browser、macOS Computer、MCP stdio/Streamable HTTP 与 Agent Skills 全部接入同一 Run/Tool/Approval 路径。
- [x] OpenAI-compatible `gpt-5.6-sol` 只保留已选 implicit `30m` Cache On 请求形状；无 key、无显式 breakpoint、无 Cache Off fallback，其他模型不套用该证据。
- [x] Settings、typed Main/Preload/Renderer IPC、Runtime 指标、仅开发环境 Dev Dashboard、Run/Item 错误与恢复交互已接通。
- [x] 固定 Chromium 已进入 Forge package；开发版和 packaged app 都实际启动/关闭 Chromium，并完成 SQLite、主 Renderer、桌宠 Renderer round-trip。
- [x] 主窗口与桌宠窗口在数据库关闭前持久化位置并销毁；E2E 与 smoke 会拒绝 `database connection is not open`、未捕获异常和未处理 Promise。
- [x] 空 Provider 库首次写入 `copilot_api` 与 `azure` 的非密钥元数据；真实 Key 仍只在本机 `secrets.bin`，SQLite/源码不含明文。发布资源随附 Columbinya v2 与 Linnea v1，首次启动复制且不覆盖已有同 ID 桌宠或选择。
- [x] 单路径审计未发现生产 Arm 身份、候选开关或第二套 Harness；MCP Client/Server 均锁定 `2.0.0`。

## 工作包状态

- `P2-RUNTIME`、`P2-TOOLS`、`P2-APPROVAL`：owner `main`，状态 `done`。
- `P2-LOCAL`、`P2-BROWSER`、`P2-COMPUTER`、`P2-EXTENSIONS`、`P2-OBSERVABILITY`：owner `main`，状态 `done`。
- `P2-AGENT-DECISION-EVIDENCE`：owner `main`，状态 `done`。完整设置校准、逐轮晋升/淘汰、机械结论、产品 amendment、限制和外部证据 hash 分别保存在 [`HARNESS-LOOP`](../benchmarks/harness-loop.md)、[`TOOL-DISCOVERY`](../benchmarks/tool-discovery.md) 与 [`PROVIDER-PROMPT-CACHE`](../benchmarks/provider-prompt-cache.md)。
- `P6-PET-FOUNDATION`、`P6-TERRITORY-BASE`、`P6-TERRITORY-ITEM-MANIFEST`：状态 `done`；Pet foundation 已补齐随包分发与幂等首次安装，其他已完成实现保持不变。
- 下一主线为 Phase 3 Memory 决策与实现；Voice Contract/实验、Automation 基础、独立 Multi-agent 实验和后继 Territory 图片工作可按不重叠所有权并行。

## Decision 与阻塞

- Phase 2 Decision Gate 已关闭。H7 W2 Quality 为 `300/300` valid；预注册机械失败与产品综合选择均保留。专用 H7 Timing 100 已由 owner waive，Quality raw 延迟只作描述性遥测，不能表述为 timing Gate 通过。
- Phase 3 生产实现受 `MEMORY-STORAGE`、`MEMORY-RETRIEVAL`、`CONTEXT-RECIPE`、`MEMORY-GRAPH`、`ACTIVITY-DISTILLATION` 与 `ACTIVITY-RETENTION` 阻塞。
- Phase 4 受 `VOICE-ARCHITECTURE`、`VOICE-TRANSPORT` 与 `VOICE-TOOL-JOIN` 阻塞。
- Multi-agent 与自进化分别受 `MULTI-AGENT`、`SELF-EVOLUTION` 阻塞；未晋级前没有生产协议、表、组件或设置。
- 生产 Image Generation/Edit、去背景、style prompt 与候选确认仍属于 `P6-TERRITORY-IMAGE`；当前 Territory 只接收已落盘候选图片和 manifest。

## 最近绿色验证

- `npm run verify:offline`：通过；65 个 contract、142 个 focused/component、50 个 integration，共 257 个测试；typecheck、ESLint 与全仓 Prettier 同时通过。
- `npm run test:e2e`：通过；production build 与 8/8 Electron E2E 全绿，覆盖 Agent 审批、一次性副作用、重启不重放、Managed Browser、Chats、Provider、Pet、Territory 和干净退出。
- `npm run smoke:dev`：通过；四项 round-trip 均为 `true`，首次启动可见 `azure`、`copilot_api`、`columbinya` 与 `linnea`，且 Renderer 无 CSP 报错。
- `npm run package && npm run smoke:package`：通过；macOS arm64 `.app` 同样加载两份初始 Provider 元数据与两只内置桌宠，四项 round-trip 均为 `true`，native `better-sqlite3` 与内置 Chromium 可用。
- `git diff --check` 与顶层依赖树检查通过；没有残留 Electron/Forge/CharaMate 测试进程。
- Copilot API `gpt-5.6-sol` Live 通过：原生 `web_search` probe 实际发出 1 次搜索；桌面 Chat 以“今天海淀的天气怎么样”复测，5 秒完成、未打开 Managed Browser，并按系统日期返回 2026-08-08 的实时天气。Phase 2 默认回归仍为离线确定性套件。
- MCP 配置查询补充只读 `mcp_config.server_list`；`file.search` 不再递归扫描依赖、版本库与构建产物。桌面 Agent 以“你现在下载了哪些MCP”复测，专用工具 14ms 返回、整轮 8 秒完成并正确列出已连接的 Playwright MCP；未再调用文件搜索。

## 来源快照

- 生产重写于 2026-08-08 复核 Codex 公开源码 commit `3aae5d885bac39c1262491aa3fd100dfd8b3919f`（提交时间 `2026-08-08T04:57:06Z`）；其当前行为是参考候选，不是协议硬限制或运行时依赖。
- OpenAI Adapter 锁定 `openai@6.49.0` tag commit `04671d278ef1531692ae31a870251eec90f3c2d2`；Tool Search、Responses streaming、Compaction/Conversation、错误、取消与 Prompt Cache 文档于 2026-08-05 复核，原生 Web Search 文档于 2026-08-08 追加复核。
- MCP 规范快照为 `2026-07-28` commit `5c4f1768b97198a149d7db05f5026b30c6a3cb12`；生产实际锁定 Client/Server `2.0.0`，当前 SDK 协商版本与规范发布日期不混写。

## 已知产品影响问题

- H7 专用 Timing 没有运行，不能把描述性延迟改写成机械门通过；实际 TTFT、成本和缓存命中继续由单路径可观测性记录。
- Azure、已登录网页与 macOS Accessibility/Screen Recording 仍需对应用户环境和系统权限；本轮已补充 Copilot API 原生 Web Search Live，完整发布环境 Live 旅程仍留在 Phase 7。
- Electron Forge Vite Plugin 仍由上游标为 experimental；当前精确版本已经过开发、native module、build、package、packaged smoke 和 Electron E2E，升级时必须重跑同一兼容链。
- packaged `.app` 仍较大；发布优化不得引入第二构建路径或破坏内容渲染、Pixi、native SQLite 与内置 Chromium。
