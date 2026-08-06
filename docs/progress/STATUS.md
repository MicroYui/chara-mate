# CharaMate 当前状态

> 更新日期：2026-08-06

## 当前里程碑

**Phase 1 — 产品骨架与 Chats：done**

Phase 0 与 Phase 1 已完成。Chats 当前只走真实 Chat Service、领域 Repository、typed IPC 与 Renderer snapshot；冻结 fixture 仅保留为确定性测试输入。下一里程碑是 Phase 2，生产 Agent Runtime 在 `HARNESS-LOOP` 与 `TOOL-DISCOVERY` Decision 完成前不开始实现。互不依赖 Harness 的 `P6-TERRITORY-BASE` 已在独立 worktree 完成实现、集成验证与仓库 owner 验收；尚未合并，且未接触 Agent Runtime 或实验文件。

退出条件：

- [x] App Shell、六个一级页面入口、Chats 侧栏与空状态满足冻结 UI 方案；
- [x] Chat/Message/Attachment/Run/RunItem/Approval 当前 Schema、领域 Repository 与 append-first 事件重放成为唯一数据路径；
- [x] Main 对事件先事务持久化再广播，Renderer 可通过窄 typed Preload API 获取 Chat snapshot 并按 sequence 重放；
- [x] Chat Service 完成多会话管理与同 Chat Turn 串行，不绕过领域 Repository；
- [x] Provider URL/Key/Model、连接测试、Model snapshot、async `safeStorage` 与 redaction 完成，Key 不进入 SQLite、日志、错误或 IPC 响应；
- [x] Composer、内容渲染、Run projection 与 Approval fixture 满足 UI 验收；
- [x] 受影响的 L0/L1/L2、React component、Electron Chats E2E、full offline、build/package 与 packaged smoke 通过。

## 工作包状态

- `P6-TERRITORY-BASE`：owner `codex/p6-territory-base` worktree，状态 `integration-verified`，已通过仓库 owner 验收、尚未合并。四个本地基础像素场景、首次选场景、PixiJS 固定图层、nav grid/A*、当前桌宠移动、游览/布置、合法网格、直接拖拽、旋转/翻转、收回/重新放置，以及 SQLite + typed IPC 的确定性重启恢复已成为一条实现路径；首次进入不等待生图。主窗口 CSP 已按 Pixi `Assets` 的真实 fetch/worker 路径补齐受控 `chara-mate-pet:` 与 blob worker，v1/v2 实际图集均完成主窗口渲染。验收中确认点击物品时可能因角色已位于最近可达格而返回单点路径；Renderer 现将其作为已完成的无位移请求，不再锁住后续移动，并已移除与点击地面主交互重复、语义不清的右下角方向键。行走中再次点击会读取 Pixi 当前浮点坐标，以最近网格作为新 A* 起点并从当前视觉位置连续播放，不再忽略第二次点击或从数据库中的旧终点重放路线；该起点通过 typed IPC 显式校验，最终目标仍按确定性事务保存。非目标仍为 Memory/Activity 候选与来源、容量回收、场景/asset 版本、Image Generation/Edit Driver、Run/Approval/Voice 投影及任何 Harness 代码。shared Territory contract、当前 greenfield Schema 与 IPC 的本次 integration owner 为该 worktree。
- `P1-CHAT-SERVICE-INTEGRATION`：owner `main`，状态 `done`。多会话创建、重命名、置顶、搜索、归档、恢复、删除、同 Chat Turn 串行、真实 Chat/Run snapshot + sequence event 投影、Provider Chat Model 选择及窗口/侧栏恢复已经成为唯一产品路径；模型采样、Tool/Approval 执行、steering 合并与附件资产导入仍属于 Phase 2。
- `P1-IMAGE-CAPABILITY-CORRECTION`：owner `main`，状态 `done`。依据 OpenAI Image guide 与 Microsoft Learn Azure image REST `2025-04-01-preview`（`ms.date=2026-05-19`，页面更新 `2026-06-24`）及目标 deployment 配对实测，文档与设置已统一为一套 Image deployment 配置确定性派生 `/images/generations` 与 `/images/edits`；Phase 6 才实现实际 Image Driver，不增加第二套密钥或静默 fallback。
- `P1-AZURE-IMAGE-GENERATION-ENDPOINT`：owner `main`，状态 `done`。按用户提供的 Azure `gpt-image-2` Target URI 与 Microsoft Learn 2025-04-01-preview Image REST reference（`ms.date=2026-05-19`），把 Image deployment 的唯一配置基准更正为 `/images/generations`，并同步 shared contract、当前 SQLite Schema、Renderer 与只读配置测试。实际 Generation/Edit Driver 属于 Phase 6；不会保留两套字段、两套密钥或旧字段迁移层。
- `P1-AZURE-REALTIME-GA-FIX`：owner `main`，状态 `done`。Provider Realtime 测试按 Azure GA `/openai/v1/realtime?model=<deployment>` 组装 URL，并以前置一致性校验阻止 Azure resource 误用 `OpenAI-compatible` Bearer 鉴权触发 302、把凭据迁入重定向 URL。能力级 API Version 已收口：Realtime GA 不读取版本号，Azure HTTP 能力按动作校验，Image 优先读取自身 Endpoint 查询。非目标为自动跟随重定向、真实 Voice Driver、媒体事件或旧 Preview 协议兼容分支。
- `P1-PROVIDER-SETTINGS-REFINE`：owner `main`，状态 `done`。按产品设计 §11.1 与 UI 设计 §11.5 把 Models 设置收紧为 `30–32px` 控件、细分隔线和内容宽按钮，并把单一 `provider.testConnection` 契约扩展为 Chat、Realtime、Image 三个显式目标；已保存 Key 可以测试当前未保存表单。一个 Profile 仍只保存一套凭据，三项能力共用；不同密钥由另一个 Profile 承载。Realtime 只做认证握手，Image 只读验证 URL/凭据/模型且不发起计费生图。`ws@8.21.1` 仅作为 Main runtime external 打包；不实现 Voice Driver、Image Driver、Voice Transport 或第二套 Provider 路径。
- `P1-APP-SHELL` + `P1-CHAT-UI` + `P1-CONTENT` + `P1-RUN-PROJECTION`（fixture lane）：owner `feat/phase1-chats-ui-fixtures` worktree，状态 `done`。App Shell、Chats/Composer、无头像消息、紧凑 Run/Approval、GFM/代码/KaTeX/Mermaid、附件与复制均由冻结 fixture 驱动；背景可选，一级页面名统一英文，品牌位读取当前 Persona 的图片源。已接入 Provider Models，不实现真实 Chat Service 或 Agent Runtime。
- `P1-CHAT-DATA` + Data/IPC integration：owner `feat/phase1-data-ipc` worktree，状态 `done`；shared Chat/Run/IPC Schema 与 SQLite 当前 Schema 已冻结，后续消费者通过指定 integration owner 变更。非目标仍为 Chat CRUD Service、Renderer 产品 UI、Provider、Agent Runtime、迁移框架及 Decision-gated SQLite 参数。
- `P1-PROVIDER`：owner `feat/phase1-provider-secret` worktree，状态 `done`。已实现产品设计 §11.1 与 UI 设计 §11.5 的 Provider Profile、模型发现/手填、连接测试、Model snapshot、异步 `safeStorage` 和统一 redaction。范围为 `provider.*` shared contract/IPC、Provider 领域表/Repository/Service、官方 SDK HTTP Adapter、secret asset、typed Preload 与 Settings Models 组件；非目标为 Chat 推理、Realtime/Image Driver、Voice Transport、通用权限或安全框架。Decision 阻塞为无；无实验候选代码。Models 组件已由 `P1-APP-SHELL` 接入同一 Settings 页面树。
- `P6-PET-FOUNDATION`：owner `main`，状态 `done`，提交 `7e61a03` 已快进合并。已实现透明 Character Window、自由拖动与多屏 DIP 恢复、PixiJS v1/v2 动画和 CharaMate 自有目录导入；验收修正跨原生窗口拖动的非有限坐标异常，方向改按相邻采样点判定，Character 设置收紧为真实图像预览列表，大小使用 `30%–150%`、速度使用 `10%–150%` 的连续滑杆且不显示比例文本，并细化轨道、滑块和聚焦反馈；左上角 CharaMate 品牌图标实时使用当前桌宠的首帧缩略图，v1 悬停动作播放三轮。主面板入口统一交给一个生命周期 owner，销毁后单飞重建，等待 Renderer ready 后再发送 typed 页面导航。Chats 搜索框聚焦描边不再被裁切；标题栏继续保留会话操作，左侧会话支持鼠标右键及键盘上下文菜单，可重命名、置顶/取消置顶、归档/恢复和删除，并避免菜单关闭时的焦点恢复立即提交重命名。不接入仍受 Phase 2 阻塞的 Run/Approval/Voice 状态投影，也不改 Harness 实验文件、共享 Run/Item Schema 或现有数据库迁移。

## 依赖、阻塞与待决 Decision

- Phase 0 无阻塞。2026-08-01 一手 npm/GitHub 核对发现预登记的 `better-sqlite3@13.0.2` 与 Playwright `1.62.1` 未发布，已在实现前把权威设计修正为已发布的 `13.0.1` 与 `1.62.0`。
- Phase 1 无 Decision 阻塞且已完成；shared Chat/Run/IPC Contract、当前数据库 Schema、Provider 与真实 Renderer 消费链已由单一 integration owner 收口，没有第二初始化或 fixture 运行路径。
- Provider 来源刷新记录为 OpenAI JavaScript SDK `6.49.0`、OpenAI OpenAPI `2.3.0` Models/Image API、OpenAI Realtime GA WebSocket 文档、Microsoft Learn Azure Realtime WebSocket 文档（`ms.date=2026-07-13`，更新于 `2026-07-19`）、Microsoft Learn Azure Image REST reference `2025-04-01-preview`（`ms.date=2026-05-19`，更新于 `2026-06-24`）、`ws@8.21.1` 与 Electron `43.2.0` async `safeStorage`。Azure `apiVersion` 在 Profile 层可选：SDK 驱动的 HTTP 动作按需校验，Azure GA Realtime 明确不使用 date-based API Version 或 `api-version` 查询，Image 验证优先使用 Generation 基准 Endpoint 自带版本。Image Generation/Edit 没有独立只读健康端点，因此配置测试明确不调用可能计费的图片动作。
- 官方 Electron 43 ESM 文档要求 ESM Preload 使用 `.mjs`，并说明 sandboxed Preload 不支持 ESM；当前唯一配置保持 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: false`。目标机实测顶层 `await app.whenReady()` 不继续执行，当前实现把 `app.setPath` 留在 ready 前并以 Promise 生命周期启动；这是 Electron `43.2.0`/Forge `7.11.2` 的实测行为，不是协议硬限制或产品启发式。
- 桌宠基础来源刷新于 `2026-08-06`：锁定 Electron `43.2.0` 的透明/无边框 `BrowserWindow`、`screen` DIP 显示器坐标与自定义 `protocol.handle` 行为，Forge Vite Plugin `7.11.2` 的多 Renderer 构建，以及 PixiJS `8.19.0` 的 `Application.init`、`Assets`、`AnimatedSprite` 与 strict-CSP static uniform sync。真实兼容样本为 Columbinya v2 manifest/atlas `bf7208f2…1a4` / `22013dd1…194` 与 Linnea v1 `fc9a5f5b…500` / `ac20b759…049`；样本只复制到隔离临时 `userData/pets` 验证，没有进入仓库。
- 领地基础来源刷新于 `2026-08-06`：联网检索当前官方页面时搜索服务不可用，已回退核对精确锁定的 PixiJS `8.19.0` 发布包类型/实现（异步 `Application.init`、federated pointer、`eventMode`、Ticker/Graphics，以及 `Assets` 图像加载默认的 fetch + blob worker）与 `better-sqlite3@13.0.1` 所带 SQLite `3.53.3`；这些是当前源代码行为候选。CharaMate 选择固定本地场景、单事务初始化/变更和简单 nav grid/A* 是本工作包的产品实现，不将其误称为外部协议限制；网格尺寸与动画时长属于场景/UI 常量，物件容量仍等待后续可用性测试。
- 生产 Agent Runtime 仍受 `HARNESS-LOOP`、`TOOL-DISCOVERY` 阻塞。
- 生产 Memory/Activity 仍受 `MEMORY-STORAGE`、`MEMORY-RETRIEVAL`、`CONTEXT-RECIPE`、`MEMORY-GRAPH`、`ACTIVITY-DISTILLATION`、`ACTIVITY-RETENTION` 阻塞。
- 生产 Voice 仍受 `VOICE-ARCHITECTURE`、`VOICE-TRANSPORT`、`VOICE-TOOL-JOIN` 阻塞。
- Multi-agent 与自进化分别受 `MULTI-AGENT`、`SELF-EVOLUTION` 阻塞；未晋级时对应生产协议、组件、表和设置不存在。

## 最近绿色验证

- 2026-08-06：`P6-TERRITORY-BASE` 的 `npm run check:fast`、`npm run test:focused` 与 `npm run test:integration` 全绿：55 个 contract、110 个 focused/component 与 23 个 integration tests；production build 通过，定向运行 Territory 与 Pet 两个 Electron E2E 均通过。新增覆盖行走中第二次点击使用当前渲染网格重新寻路、切换瞬间位移小于一格并最终到达新目标；原有首次选场景、A* 移动、单点路径后继续移动、Pixi 直接拖拽、收回/重新放置、精确重启 snapshot、方向键移除与 v1/v2 真实资源加载覆盖保持绿色。此前完整 `npm run test:e2e` 的 5 个 Electron E2E、`npm run package` 与 `npm run smoke:package` 已通过，packaged smoke 为 `characterRendererReady=true`、`databaseRoundTrip=true`、`rendererReady=true`。Computer Use 在重启后的同一开发版使用 Columbinya 实机连续点击，确认不再显示契约错误且角色落到后点目标；未调用 Image API，未把桌宠素材加入仓库。已通过 owner 验收并获提交授权，尚未合并。
- 2026-08-06：`P6-PET-FOUNDATION` 最新 `npm run verify:offline` 全绿：49 个 contract、102 个 focused/component 与 21 个 integration tests；`npm run test:e2e` 的 4 个 Electron E2E 全绿，覆盖双窗口、透明 Pixi canvas、v1/v2 切换、连续滑杆与持久化、品牌缩略图、拖动/窗口恢复、主面板单飞重建，以及 Chats 搜索框聚焦边界和侧栏右键重命名/归档/删除。`npm run build`、Forge package 与 `npm run smoke:package` 通过，packaged smoke 为 `characterRendererReady=true`、`databaseRoundTrip=true`、`rendererReady=true`。打包后的 `.app` 使用隔离目录中的 Columbinya v2/Linnea v1 WebP 实机确认桌宠入口重建导航正常，并确认搜索框四边聚焦描边完整、右键菜单含重命名/置顶/归档/删除、重命名输入框保持焦点；终端无异常。提交 `7e61a03` 已快进合并到 `main`。
- 2026-08-01：Phase 1 最终验收 `npm run verify:offline`，`8.33s`；39 个 contract、76 个 focused/component 与 19 个 integration 全绿。`npm run test:e2e`（含 production build），`10.97s`；真实 SQLite/typed IPC 会话 CRUD、搜索、归档/恢复/删除、Chat→Agent 草稿保留、窗口/侧栏重启恢复、Provider secret 与事件重放共 3 个 Electron E2E 全绿。`npm run package`，`9.18s`；`npm run smoke:package`，`2.53s`，结果为 `databaseRoundTrip=true`、`rendererReady=true`。最终单路径审计确认产品 Renderer 不读取冻结 fixture，模型采样与 Tool/Approval 执行未伪造并继续由 Phase 2 Gate 阻塞。
- 2026-08-01：Azure Image 配置基准修正后 `npm run verify:offline`、`npm run build`、`npm run test:e2e` 通过；39 个 contract、71 个 focused/component、16 个 integration 与 3 个 Electron E2E 全绿。契约、持久化与真实 Electron 设置页只保存 `/images/generations` 规范地址，不增加 Edit 专用字段；后续配对实测已确认同一 deployment 可确定性派生 `/images/edits`。开发数据库完整性为 `ok`，原有 1 个 Provider Profile 保留并切换到当前列名。
- 2026-08-01：Azure Realtime GA 与能力级 API Version 修复后 `npm run verify:offline`、`npm run build`、`npm run test:e2e` 通过；39 个 contract、69 个 focused/component、16 个 integration 与 3 个 Electron E2E 全绿。本机协议用例确认 Realtime-only Azure Profile 无需版本号，握手只有 `/openai/v1/realtime?model=<deployment>` 与 `api-key` header；Image 验证保留 Endpoint 的 `api-version`。开发数据库保留原有 Profile 完成当前 Schema 调整，开发服务已完整重启并加载新 Main bundle。
- 2026-08-01：Provider 设置 refinement 后 `test:contract` 39 项、`test:focused` 61 项、`test:integration` 16 项全部通过；覆盖三类 typed IPC 目标、真实本机 WebSocket 握手、Image 只读模型验证、未保存表单复用已保存密钥及组件反馈。
- 2026-08-01：`npm run build`、`npm run package`、`npm run smoke:package` 与 `npm run test:e2e` 通过；打包应用完成数据库/Renderer smoke，3 个 Electron E2E 全绿，ASAR 只额外包含 Main 所需 `node_modules/ws` runtime。开发版通过 Computer Use 实际检查 Models 折叠/展开态，Realtime 与 Image 测试入口均可达且控件密度符合冻结规范。
- 2026-08-01：UI fixture 合入 `main` 后 `npm ci`，`18.40s`；从精确 lockfile 干净安装 992 个 package，lockfile 无变化，SHA-256 为 `d9d3520520dbc5b91f6730253229b47bfc9b1a58c5595bcdd2a00b7246e3de05`。
- 2026-08-01：合入 `main` 后 `npm run verify:phase0`，`52.06s`；37 个 contract、55 个 focused/component、16 个 SQLite/domain integration、Main/Preload/Renderer build、dev smoke、Forge package、隔离 packaged smoke 与 3 个 Electron E2E 全部通过。覆盖 Chats fixture、桌宠图片、背景选择、内容渲染、Run/Approval、typed preload/事件重放以及 Provider 加密持久化和 Settings Models 可达性；packaged app 无图片或 KaTeX 字体 CSP 错误。
- 2026-08-01：当前精确 lockfile SHA-256 为 `07de250ab1f2ac32e0e814711a9a5cbf8c1a60f06cabafac2a146b84529fd206`；46 个直接依赖（21 production、25 development）均为精确版本，`npm ls --all --json` 无问题，`npm audit --omit=dev` 为 0。
- 2026-08-01：`npm run test:live && npm run test:benchmark`；两者按设计报告 `not-applicable`，当前没有对应外部 endpoint 或 Benchmark Decision owner，且未进入默认回归。
- 2026-08-01：`rg`/`find`/ASAR 单路径与密钥边界审计，`<1s`；无第二 lockfile/build path、Renderer 密钥读取 API、Renderer raw IPC、运行时代码密钥字面量、ORM、通用 Agent 框架或候选 Provider 分支；产物包含唯一 ESM Main/Preload/Renderer、官方 OpenAI SDK 与已解包原生模块。

## 已知产品影响问题

- 当前 Territory 基础物件仍是单层 placement：`blocksMovement=false` 的地毯可行走，但所有物件的完整 placement 网格都参与互斥放置；桌子/壁炉也以完整宽高作为地面碰撞范围。尚未实现“视觉高度与地面碰撞分离”的 2.5D 遮挡，也没有桌面承载小物件的一层 support/slot 关系；这需要先更新产品 placement 契约，再作为独立工作包实现，不能在当前基础包中隐式加入另一套放置语义。
- Electron Forge Vite Plugin 在当前官方说明中仍标记为 experimental；已通过 Phase 0 的开发启动、原生模块、打包、隔离 packaged-app smoke 与 Electron E2E，并冻结为唯一构建路径。
- Forge 打包当前携带 `better-sqlite3` 的多平台预构建二进制及内容渲染依赖，macOS `.app` 约 348 MB；不阻塞当前正确性，发布优化需在不增加第二构建路径的前提下处理。
- 完整 `npm audit` 报告 33 个仅开发工具链告警（4 low、28 high、1 critical），均来自精确锁定的 Forge/Vite 间接依赖；生产依赖审计为 0，且 npm 没有为 Forge `7.11.2` 给出兼容的直接修复。后续 Forge 升级必须重新通过完整工具链兼容性套件，不能用报告建议的旧版替换已验证路径。
