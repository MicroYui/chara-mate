# CharaMate 当前状态

> 更新日期：2026-08-08

## 当前里程碑

**Phase 2 — Done**

Phase 0、Phase 1 与 Phase 2 已完成。Phase 2 将已接受的 `HARNESS-LOOP`、`TOOL-DISCOVERY` 与 `PROVIDER-PROMPT-CACHE` 结果重写为一条 CharaMate 自有生产路径；实验候选、fallback、Arm 开关、调参入口和 runner 均未进入生产树。

退出条件：

- [x] 唯一 `AgentRuntime` 支持 Direct、同 Chat 历史、steering、checkpoint、显式继续、取消、恢复、自动压缩和无进展 Guard；没有全局固定步数、墙钟、Token 或成本静默截断。
- [x] `ContextCompiler` 固定采用 90% resolved-input trigger、结构化 handoff 和最新用户消息保留；Adapter 按 Provider/模型动态归一化有效输入预算并随 checkpoint 冻结，未知限额时不臆造阈值，真实 context-limit 仅进行一次强制压缩恢复。
- [x] 统一 JSON Schema Tool Registry 使用 native client Tool Search、metadata BM25、limit 8、结构化 Tool Result、artifact、AbortSignal 和可见增量输出；Chat 模式在暴露层和执行层都禁止 CharaMate action Tool，但保留 Provider 原生只读 Web Search。
- [x] 三档 Approval、Chat Card 与桌宠气泡共享同一持久化 Approval；审批前、拒绝后和取消后的副作用边界有确定性覆盖。
- [x] File、Command、App、Managed Browser、macOS Computer、MCP stdio/Streamable HTTP 与 Agent Skills 全部接入同一 Run/Tool/Approval 路径。
- [x] OpenAI-compatible `gpt-5.6-sol` 只保留已选 implicit `30m` Cache On 请求形状；无 key、无显式 breakpoint、无 Cache Off fallback，其他模型不套用该证据。
- [x] Settings、typed Main/Preload/Renderer IPC、Runtime 指标、仅开发环境 Dev Dashboard、Run/Item 错误与恢复交互已接通。
- [x] 活跃 Run 的 Composer 可继续发送纯文本 steering，并保留独立 Stop；同一 Run 在时间线只投影一次；运行摘要按真实墙钟耗时逐秒刷新，首字返回前不再停在 `0 秒`。
- [x] 新建 Chat 先进入右侧未持久化草稿态，首次发送时才进入侧栏；标题立即使用首条用户消息兜底，首轮成功后由可用 Provider 无 Tool 异步生成摘要并实时替换，失败或用户已重命名时不覆盖。
- [x] 多步骤 Agent 直接获得始终加载的核心工具 `plan.update`，无需先经 Tool Search；它生成并更新有序、扁平的完整计划快照，不承担 DAG 依赖或并发调度。活跃 Plan 以 `1/5` 形式悬浮在 Composer 上方，hover、键盘聚焦或点击后展开完整计划；Run 结束后从悬浮层移除并保留在“已处理”历史中。`plan` RunItem 的持久化、实时事件和最新快照替换已端到端接通，简单任务不强制建计划。
- [x] Agent 默认设置下拉框不再因延迟读取 React Event 而使 Renderer 白屏；Browser & Computer 已收敛为紧凑能力、Profile 与 macOS 权限状态行。
- [x] 固定 Chromium 已进入 Forge package；开发版和 packaged app 都实际启动/关闭 Chromium，并完成 SQLite、主 Renderer、桌宠 Renderer round-trip。
- [x] 主窗口与桌宠窗口在数据库关闭前持久化位置并销毁；E2E 与 smoke 会拒绝 `database connection is not open`、未捕获异常和未处理 Promise。
- [x] 空 Provider 库首次写入 `copilot_api` 与 `azure` 的非密钥元数据；真实 Key 仍只在本机 `secrets.bin`，SQLite/源码不含明文。发布资源随附 Columbinya v2 与 Linnea v1，首次启动复制且不覆盖已有同 ID 桌宠或选择。
- [x] 单路径审计未发现生产 Arm 身份、候选开关或第二套 Harness；MCP Client/Server 均锁定 `2.0.0`。

## 工作包状态

- `P1-CONTENT-CJK`：owner `main`，状态 `done`。在既有 `react-markdown`/GFM 单一路径中以 parse-only 扩展兼容 CJK 紧邻标点/正文的粗体、斜体与删除线，不改写源 Markdown、不增加渲染模式；`MarkdownRenderer` component regression、L0 与 production build 已验证。
- `P2-CONTEXT-LIMIT-RESOLUTION`：owner `main`，状态 `done`。标准模型列表优先、详情补充，覆盖 Copilot 嵌套 limits、Codex effective percent 与普通 OpenAI-compatible 顶层字段；同名模型不再共用硬编码窗口，恢复同一 Run 沿用已保存预算。
- `P1-CHAT-DRAFT-TITLE`：owner `main`，状态 `done`。新建按钮只切换 Renderer 草稿态；首次发送创建真实 Chat，Main 生成首条消息兜底并在首轮成功后请求 AI 摘要标题，通过 typed Chat change event 同步 Header/侧栏，且条件更新保护手工重命名。
- `P2-CHAT-STEERING-UI`、`P2-PLAN-ITEM-UI`、`P2-SETTINGS-POLISH`、`P2-RUN-LIVE-DURATION`：owner `main`，状态 `done`。补齐既有 steering 的 Composer 接线、Plan Item 端到端能力与 Composer 上方悬浮交互、设置白屏修复、Browser/Computer 信息层级、活跃 Run 实时耗时和不抢前台的 Electron 回归启动方式；未改变已接受的 Harness 路径。
- `P2-RUNTIME`、`P2-TOOLS`、`P2-APPROVAL`：owner `main`，状态 `done`。
- `P2-LOCAL`、`P2-BROWSER`、`P2-COMPUTER`、`P2-EXTENSIONS`、`P2-OBSERVABILITY`：owner `main`，状态 `done`。
- `P3-STRUCTURED-INPUT`、`P3-MULTIMODAL-INPUT`：owner `main`，状态 `specified`。前者补齐直接 `request_user_input`、持久化回答卡和同 Run continuation；后者补齐用户图片附件与条件直载 `image.inspect` 共用的真实像素 → Provider 多模态输入路径。两者只依赖 Phase 1/2，可与 Memory Decision 并行。
- `P2-AGENT-DECISION-EVIDENCE`：owner `main`，状态 `done`。完整设置校准、逐轮晋升/淘汰、机械结论、产品 amendment、限制和外部证据 hash 分别保存在 [`HARNESS-LOOP`](../benchmarks/harness-loop.md)、[`TOOL-DISCOVERY`](../benchmarks/tool-discovery.md) 与 [`PROVIDER-PROMPT-CACHE`](../benchmarks/provider-prompt-cache.md)。
- `P6-PET-FOUNDATION`、`P6-TERRITORY-BASE`、`P6-TERRITORY-ITEM-MANIFEST`：状态 `done`；Pet foundation 已补齐随包分发与幂等首次安装，其他已完成实现保持不变。
- `P6-TERRITORY-IMAGE`：owner `codex/phase6-territory-image`，状态 `done`。同一 Azure Image deployment 的 Generation/Edit、统一场景 style prompt、本地透明背景处理、持久化候选确认、显式重试和启动恢复已贯通；内建延迟发现 Tool `territory.generate_item` 只要求 Agent 提供名称、含义与视觉意图，宿主解析活动场景和 Image Provider，可选结构参数覆盖最终尺寸、2.5D 占地、锚点及承载插槽。Tool 只创建候选，不自动确认；确认后只调用 `TerritoryService.installGeneratedItem`。取舍见 [`TERRITORY-IMAGE-PROCESSING`](../benchmarks/territory-image-processing.md)，生产树没有第二资产路径、Provider fallback、运行时 Arm 或调参设置。
- 下一主线为 Phase 3：结构化输入/多模态输入可先与 Memory 决策并行；Voice Contract/实验、Automation 基础、独立 Multi-agent 实验也可按不重叠所有权并行。`P6-TERRITORY-MEMORY` 继续等待 Memory/Activity 真源，不与本次 Image 完成状态混写。

## Decision 与阻塞

- Phase 2 Decision Gate 已关闭。H7 W2 Quality 为 `300/300` valid；预注册机械失败与产品综合选择均保留。专用 H7 Timing 100 已由 owner waive，Quality raw 延迟只作描述性遥测，不能表述为 timing Gate 通过。
- Phase 3 生产实现受 `MEMORY-STORAGE`、`MEMORY-RETRIEVAL`、`CONTEXT-RECIPE`、`MEMORY-GRAPH`、`ACTIVITY-DISTILLATION` 与 `ACTIVITY-RETENTION` 阻塞。
- Phase 4 受 `VOICE-ARCHITECTURE`、`VOICE-TRANSPORT` 与 `VOICE-TOOL-JOIN` 阻塞。
- Multi-agent 与自进化分别受 `MULTI-AGENT`、`SELF-EVOLUTION` 阻塞；未晋级前没有生产协议、表、组件或设置。
- `TERRITORY-IMAGE-PROCESSING` 已接受：`1024x1024 + medium + opaque`、Edit `high` fidelity、纯洋红 prompt、边缘中位色四连通移除、色差 `96` 与确认后默认 `96x96` 归一化成为唯一生产路径；Tool 可显式提供 `visualSizePx`，但仍复用同一归一化与安装入口，不形成尺寸模式或第二资产路径。付费质量与真实图片观感没有被离线小样本夸大为已证明结论。

## 最近绿色验证

- 2026-08-08 `npm run verify:offline`：15.15 秒通过；9 个 contract 文件 / 65 项、42 个 focused/component 文件 / 181 项、13 个 integration 文件 / 61 项，typecheck、ESLint 与全仓 Prettier 同时通过。
- `npm run test:e2e`：22.03 秒通过，production build 与完整 11/11 Electron E2E 全绿；除 Azure 429 持久化失败、显式重试、Generation、去背景、Edit 和候选确认外，新增 Agent → Tool Search → `territory.generate_item` → Azure Adapter → 持久化候选 → Territory 预览旅程，验证自定义 `144x120`、`3x2` 占地与单插槽参数，并确认 Tool 不会自动安装物件。
- `npm run package`：14.25 秒通过；`npm run smoke:package` 4.44 秒、`npm run smoke:dev` 4.99 秒通过，SQLite、主/桌宠 Renderer、内置 Chromium 均完成 round-trip，后台测试没有可见窗口。
- `npm run test:live` 正确发现 P6 Azure Generation/Edit live case；环境变量未单独注入，自动 live suite 因而为 1/1 skipped。另使用隔离的 Electron 用户目录和现有本机 Image Profile 完成真实桌面点击验收：Generation 在 `42.286s` 后返回带透明背景的候选，Edit 保留 alpha，确认后 `96x96` PNG 出现在收藏库；该单样本只证明真实产品链路可用，不代表视觉质量、成本或延迟分布已完成统计验证。
- 单路径审计、`git diff --check` 与顶层依赖树检查通过；没有新增依赖、实验 runner、模型包、候选 Adapter、质量/阈值开关或残留测试进程。

## 来源快照

- P6 Image 于 2026-08-08 复核 OpenAI Image guide、Microsoft Azure OpenAI REST `2025-04-01-preview`、锁定 `openai@6.49.0` tag commit `04671d278ef1531692ae31a870251eec90f3c2d2` 与 Electron `43.2.0` `nativeImage`。协议硬约束、SDK 当前行为与 CharaMate 启发式已分列在 [`TERRITORY-IMAGE-PROCESSING`](../benchmarks/territory-image-processing.md)。
- Context 窗口解析于 2026-08-08 复核 OpenAI 官方 `gpt-5.6-sol` 模型页、`codex-cli 0.145.0` catalog 与 Codex commit `3aae5d885bac39c1262491aa3fd100dfd8b3919f`：Codex 当前 `272,000 × 95% = 258,400` 是该 runtime 的有效窗口；本机 `copilot_api 1.15.2` commit `ded2357a5a0486422e925d4f2e8107d1b57693a1` 列表端点则为同名模型返回 `922,000` max prompt、详情端点 404。生产按 Provider 元数据解析，不把二者混成 Model ID 常量；90% 仍是 CharaMate 已选启发式。
- 生产重写于 2026-08-08 复核 Codex 公开源码 commit `3aae5d885bac39c1262491aa3fd100dfd8b3919f`（提交时间 `2026-08-08T04:57:06Z`）；本轮另核对其 `update_plan` 由 core utility 直接注册、`defer_loading: None`、普通模式 exposure 为 `Direct`，参数是完整有序快照与 `pending / in_progress / completed` 三态。该计划没有节点依赖边，也不同于 Codex Plan mode；CharaMate 以命名空间核心工具 `plan.update` 接入既有 Run/Item。其当前行为是参考候选，不是协议硬限制或运行时依赖。
- 同一 Codex 快照的其余 core/direct 家族均有能力门控：Shell、Patch 与 Image 依赖执行环境和模型；MCP Resource 依赖已连接 Server；结构化用户输入、权限请求、Token Budget、当前时间/等待、插件安装与 Collaboration 分别依赖 feature、模式或版本。CharaMate 当前始终直载的客户端工具精确为 `plan.update`；Provider 原生 Tool Search/Web Search 按支持情况直出，其余 action capability 继续遵循已接受的延迟发现路径。当前日期/时区由每轮请求注入，Context 与 Approval 由宿主管理，因此本轮未发现另一个应无条件直载的 Phase 2 核心工具。
- 后台 E2E 生命周期于 2026-08-08 对照当前锁定的 Electron `43.2.0` 类型与窗口事件复核：测试 App 在 ready 后隐藏 Dock，`ready-to-show` 只完成加载而不显示窗口；普通开发与生产启动不设置该环境变量，行为保持不变。
- OpenAI Adapter 锁定 `openai@6.49.0` tag commit `04671d278ef1531692ae31a870251eec90f3c2d2`；Tool Search、Responses streaming、Compaction/Conversation、错误、取消与 Prompt Cache 文档于 2026-08-05 复核，原生 Web Search 文档于 2026-08-08 追加复核。
- MCP 规范快照为 `2026-07-28` commit `5c4f1768b97198a149d7db05f5026b30c6a3cb12`；生产实际锁定 Client/Server `2.0.0`，当前 SDK 协商版本与规范发布日期不混写。

## 已知产品影响问题

- H7 专用 Timing 没有运行，不能把描述性延迟改写成机械门通过；实际 TTFT、成本和缓存命中继续由单路径可观测性记录。
- 自动 live suite 尚未通过独立环境变量形成可重复批次，因此仍为 1/1 skipped；本轮真实桌面单样本已验证 Azure Generation/Edit、去背景和确认链路，但不能外推视觉质量、成本或延迟分布。完整发布环境 Live 批次仍留在 Phase 7。
- Electron Forge Vite Plugin 仍由上游标为 experimental；当前精确版本已经过开发、native module、build、package、packaged smoke 和 Electron E2E，升级时必须重跑同一兼容链。
- packaged `.app` 仍较大；发布优化不得引入第二构建路径或破坏内容渲染、Pixi、native SQLite 与内置 Chromium。
- 结构化 `request_user_input` 与本地图片语义读取尚未实现，现已分别由 Phase 3 的 `P3-STRUCTURED-INPUT` 与 `P3-MULTIMODAL-INPUT` 正式拥有；它们不再是无归属的“以后再做”，但也不回写成 Phase 2 已完成能力。
