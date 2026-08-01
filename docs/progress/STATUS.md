# CharaMate 当前状态

> 更新日期：2026-08-01

## 当前里程碑

**Phase 1 — 产品骨架与 Chats：implementing**

Phase 0 已完成。Phase 1 的 Renderer fixture、Data/IPC 与 Provider/Secret 三条路径已完成并通过集成验证；真实 Chat Service 尚未启动。

退出条件：

- [x] App Shell、六个一级页面入口、Chats 侧栏与空状态满足冻结 UI 方案；
- [x] Chat/Message/Attachment/Run/RunItem/Approval 当前 Schema、领域 Repository 与 append-first 事件重放成为唯一数据路径；
- [x] Main 对事件先事务持久化再广播，Renderer 可通过窄 typed Preload API 获取 Chat snapshot 并按 sequence 重放；
- [ ] Chat Service 完成多会话管理与同 Chat Turn 串行，不绕过领域 Repository；
- [x] Provider URL/Key/Model、连接测试、Model snapshot、async `safeStorage` 与 redaction 完成，Key 不进入 SQLite、日志、错误或 IPC 响应；
- [x] Composer、内容渲染、Run projection 与 Approval fixture 满足 UI 验收；
- [x] 受影响的 L0/L1/L2、React component、Electron Chats E2E、full offline、build/package 与 packaged smoke 通过。

## 活动工作包

- `P1-PROVIDER-SETTINGS-REFINE`：owner `main`，状态 `done`。按产品设计 §11.1 与 UI 设计 §11.5 把 Models 设置收紧为 `30–32px` 控件、细分隔线和内容宽按钮，并把单一 `provider.testConnection` 契约扩展为 Chat、Realtime、Image 三个显式目标；已保存 Key 可以测试当前未保存表单。一个 Profile 仍只保存一套凭据，三项能力共用；不同密钥由另一个 Profile 承载。Realtime 只做认证握手，Image 只读验证 URL/凭据/模型且不发起计费生图。`ws@8.21.1` 仅作为 Main runtime external 打包；不实现 Voice Driver、Image Driver、Voice Transport 或第二套 Provider 路径。
- `P1-APP-SHELL` + `P1-CHAT-UI` + `P1-CONTENT` + `P1-RUN-PROJECTION`（fixture lane）：owner `feat/phase1-chats-ui-fixtures` worktree，状态 `done`。App Shell、Chats/Composer、无头像消息、紧凑 Run/Approval、GFM/代码/KaTeX/Mermaid、附件与复制均由冻结 fixture 驱动；背景可选，一级页面名统一英文，品牌位读取当前 Persona 的图片源。已接入 Provider Models，不实现真实 Chat Service 或 Agent Runtime。
- `P1-CHAT-DATA` + Data/IPC integration：owner `feat/phase1-data-ipc` worktree，状态 `done`；shared Chat/Run/IPC Schema 与 SQLite 当前 Schema 已冻结，后续消费者通过指定 integration owner 变更。非目标仍为 Chat CRUD Service、Renderer 产品 UI、Provider、Agent Runtime、迁移框架及 Decision-gated SQLite 参数。
- `P1-PROVIDER`：owner `feat/phase1-provider-secret` worktree，状态 `done`。已实现产品设计 §11.1 与 UI 设计 §11.5 的 Provider Profile、模型发现/手填、连接测试、Model snapshot、异步 `safeStorage` 和统一 redaction。范围为 `provider.*` shared contract/IPC、Provider 领域表/Repository/Service、官方 SDK HTTP Adapter、secret asset、typed Preload 与 Settings Models 组件；非目标为 Chat 推理、Realtime/Image Driver、Voice Transport、通用权限或安全框架。Decision 阻塞为无；无实验候选代码。Models 组件已由 `P1-APP-SHELL` 接入同一 Settings 页面树。

## 依赖、阻塞与待决 Decision

- Phase 0 无阻塞。2026-08-01 一手 npm/GitHub 核对发现预登记的 `better-sqlite3@13.0.2` 与 Playwright `1.62.1` 未发布，已在实现前把权威设计修正为已发布的 `13.0.1` 与 `1.62.0`。
- Phase 1 Data/IPC 无 Decision 阻塞且已完成；shared Chat/Run/IPC Contract 与初始数据库 Schema 已由单一 integration owner 冻结。Provider 串行合入同一当前 Schema 与数据库连接，没有第二初始化路径。Renderer fixture lane 只消费已冻结契约；后续真实 Chat Service 接入若需变更，必须重新指定唯一 owner。
- Provider 来源刷新记录为 OpenAI JavaScript SDK `6.49.0`、OpenAI OpenAPI `2.3.0` Models/Image API、Realtime GA WebSocket 文档、`ws@8.21.1` 与 Electron `43.2.0` async `safeStorage`；Azure `apiVersion` 是外部协议必填项，不是产品运行时模式。Image 官方接口没有只读健康端点，因此配置测试明确不调用 Image Edit。
- 官方 Electron 43 ESM 文档要求 ESM Preload 使用 `.mjs`，并说明 sandboxed Preload 不支持 ESM；当前唯一配置保持 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: false`。目标机实测顶层 `await app.whenReady()` 不继续执行，当前实现把 `app.setPath` 留在 ready 前并以 Promise 生命周期启动；这是 Electron `43.2.0`/Forge `7.11.2` 的实测行为，不是协议硬限制或产品启发式。
- 生产 Agent Runtime 仍受 `HARNESS-LOOP`、`TOOL-DISCOVERY` 阻塞。
- 生产 Memory/Activity 仍受 `MEMORY-STORAGE`、`MEMORY-RETRIEVAL`、`CONTEXT-RECIPE`、`MEMORY-GRAPH`、`ACTIVITY-DISTILLATION`、`ACTIVITY-RETENTION` 阻塞。
- 生产 Voice 仍受 `VOICE-ARCHITECTURE`、`VOICE-TRANSPORT`、`VOICE-TOOL-JOIN` 阻塞。
- Multi-agent 与自进化分别受 `MULTI-AGENT`、`SELF-EVOLUTION` 阻塞；未晋级时对应生产协议、组件、表和设置不存在。

## 最近绿色验证

- 2026-08-01：Provider 设置 refinement 后 `test:contract` 39 项、`test:focused` 61 项、`test:integration` 16 项全部通过；覆盖三类 typed IPC 目标、真实本机 WebSocket 握手、Image 只读模型验证、未保存表单复用已保存密钥及组件反馈。
- 2026-08-01：`npm run build`、`npm run package`、`npm run smoke:package` 与 `npm run test:e2e` 通过；打包应用完成数据库/Renderer smoke，3 个 Electron E2E 全绿，ASAR 只额外包含 Main 所需 `node_modules/ws` runtime。开发版通过 Computer Use 实际检查 Models 折叠/展开态，Realtime 与 Image 测试入口均可达且控件密度符合冻结规范。
- 2026-08-01：UI fixture 合入 `main` 后 `npm ci`，`18.40s`；从精确 lockfile 干净安装 992 个 package，lockfile 无变化，SHA-256 为 `d9d3520520dbc5b91f6730253229b47bfc9b1a58c5595bcdd2a00b7246e3de05`。
- 2026-08-01：合入 `main` 后 `npm run verify:phase0`，`52.06s`；37 个 contract、55 个 focused/component、16 个 SQLite/domain integration、Main/Preload/Renderer build、dev smoke、Forge package、隔离 packaged smoke 与 3 个 Electron E2E 全部通过。覆盖 Chats fixture、桌宠图片、背景选择、内容渲染、Run/Approval、typed preload/事件重放以及 Provider 加密持久化和 Settings Models 可达性；packaged app 无图片或 KaTeX 字体 CSP 错误。
- 2026-08-01：当前精确 lockfile SHA-256 为 `07de250ab1f2ac32e0e814711a9a5cbf8c1a60f06cabafac2a146b84529fd206`；46 个直接依赖（21 production、25 development）均为精确版本，`npm ls --all --json` 无问题，`npm audit --omit=dev` 为 0。
- 2026-08-01：`npm run test:live && npm run test:benchmark`；两者按设计报告 `not-applicable`，当前没有对应外部 endpoint 或 Benchmark Decision owner，且未进入默认回归。
- 2026-08-01：`rg`/`find`/ASAR 单路径与密钥边界审计，`<1s`；无第二 lockfile/build path、Renderer 密钥读取 API、Renderer raw IPC、运行时代码密钥字面量、ORM、通用 Agent 框架或候选 Provider 分支；产物包含唯一 ESM Main/Preload/Renderer、官方 OpenAI SDK 与已解包原生模块。

## 已知产品影响问题

- Electron Forge Vite Plugin 在当前官方说明中仍标记为 experimental；已通过 Phase 0 的开发启动、原生模块、打包、隔离 packaged-app smoke 与 Electron E2E，并冻结为唯一构建路径。
- Forge 打包当前携带 `better-sqlite3` 的多平台预构建二进制及内容渲染依赖，macOS `.app` 约 348 MB；不阻塞当前正确性，发布优化需在不增加第二构建路径的前提下处理。
- 完整 `npm audit` 报告 33 个仅开发工具链告警（4 low、28 high、1 critical），均来自精确锁定的 Forge/Vite 间接依赖；生产依赖审计为 0，且 npm 没有为 Forge `7.11.2` 给出兼容的直接修复。后续 Forge 升级必须重新通过完整工具链兼容性套件，不能用报告建议的旧版替换已验证路径。
