# CharaMate 当前状态

> 更新日期：2026-08-15

## 当前里程碑

**Phase 7 — Done（首个完整产品版本，含桌宠系统卡顿修复）**

Phase 0–7 已完成。Chats 会话管理统一归左侧会话项，Automations 的“新建任务”固定归页面列表页头，窄屏侧栏入口不占常驻布局高度。

2026-08-14 按产品设计 §18/§20、UI 可用性验收与 ROADMAP 完成最终收口：同一组件树支持跟随系统/浅色/深色、三套预设和可编辑自定义背景；Settings → Data 可进入并读取真实分类占用、打开目录和复用 Activity 安全清理。首次无模型可直接进入 Models；React 错误提供恢复面，Renderer 进程崩溃会重建主窗口一次。Dev Dashboard 可查询 Memory/Storage/Image 聚合，唯一 Forge 路径可产出带应用图标的 arm64 `.app` 与 ULFO DMG。

无感陪伴保留内部 Journey/Together Session、全局唯一活跃态、Home Chat 自动归属、稀疏节点、一次约定跟进和共同记忆，但不要求用户管理这些名词。Activity 触发的全新话题先进入隐藏 provisional Chat；20 秒内首个文字或气泡 Voice 回复才把同一 Chat 转正，超时、关闭、开场失败或重启会删除临时 Chat、Run 与消息。已有 Chat/Journey 的续接保持正式历史。

自由领地使用可扩建 2.5D World。探索态左键只选择/查看，右键从当前插值位置平滑移动；实际 atlas running 行、抵达后的 idle 行和连续改道均已覆盖。主窗口可见且停留 Territory 时只显示场景桌宠，切页、隐藏、最小化或关闭主窗口后恢复桌面 Character Window。

当前集成退出条件：

- [x] Journey/Together Session 状态与用户可见 Chat/Run/Voice 共用既有 Runtime，不增加管理页面或第二套执行链。
- [x] 主动气泡绑定唯一 `chatId`，主窗口关闭时可连续文字/语音回复；临时邀请不进入最近、搜索或归档列表，也不显示倒计时或进度条。
- [x] World 合同、PixiJS 深度/碰撞/寻路、完整 Candidate/Preview/change-set 与 Memory/Activity 来源快照完成。
- [x] Character Window 同时支持 Territory 场景交接和独立主动对话跟随窗口，不复制桌宠或遮挡交互。
- [x] macOS 菜单栏使用单实例 18 px Template 图标，以自然语言投影桌宠、Voice 与 Activity 状态并复用现有领域控制。
- [x] 合并后的 Schema v14、typed IPC、Renderer、离线、Build、Electron E2E 与 package/smoke 全链重新通过。
- [x] Chats 主内容无重复标题/操作框，重命名、置顶、归档、恢复和删除都从左侧完成；Automations 页面内只有一个持久“新建任务”入口。
- [x] Appearance 的主题、自定义基础色板与深色派生均持久化；Data 使用真实 typed IPC 且不提供越界删除。
- [x] 无模型、Foundation 加载失败、React 渲染失败与 Renderer 进程崩溃均有用户可恢复路径。
- [x] Dev Dashboard 与 macOS Forge DMG 单一路径完成；Apple 签名、公证只由发布环境凭据启用。
- [x] 最终 offline、build、dev/package smoke、23 条 Electron E2E、Live/benchmark 分项和单路径审计完成。

## 工作包状态

| 工作包 | Owner | 状态 | 结果 |
| --- | --- | --- | --- |
| `ACTIVITY/PET-PERFORMANCE` | `main` | `done` | 前台应用改为 `NSWorkspace`/Accessibility 事件通知；Activity 截图使用逻辑像素、单次编码与异步摘要；Character Window 使用私有 15 FPS ticker、不可见停帧和纹理复用 |
| `P7-VISUAL-ACCESSIBILITY` | `main` | `done` | 同一语义 Token 树完成浅/深/跟随系统、自定义色板、深色自动派生、reduced motion、焦点和 1180×800 实图复核 |
| `P7-FIRST-RUN-RECOVERY` | `main` | `done` | 无模型就地进入 Models；Foundation/React/Renderer 失败均使用现有主窗口与状态真源恢复 |
| `P7-OBSERVABILITY-RELEASE` | `main` | `done` | Dev Dashboard 补齐 Memory/Storage/Image；可选签名/公证的唯一 Forge `.app`/DMG 路径通过 |
| `P7-ACCEPTANCE-AUDIT` | `main` | `done` | 六页/窗口、并发恢复/取消/审批/资源引用、Live、package/smoke、DMG 与单路径最终验收完成 |
| `P7-CONTENT-HIERARCHY` | `main` | `done` | 移除跨页面 Page Header；Chats 行内重命名与左侧完整生命周期菜单、Automations 页面内创建入口和窄屏侧栏浮动入口完成 |
| `P6-APP-TRAY-PRESENCE` | `main` | `done` | 18 px Template 图标、自然状态菜单、单实例激活与现有 Pet/Voice/Activity 控制完成单一路径接入 |
| `P5/6-COMPANIONSHIP-TERRITORY-INTEGRATION` | `main` | `done` | Schema v14、Pet IPC、Character Window 生命周期与两条桌面旅程完成单一路径集成 |
| `P5-PROACTIVE-INVITATION` | `main` | `done` | 全新话题使用隐藏 provisional Chat；首个回复转正，20 秒超时/关闭/失败/重启清理 |
| `P5-COMPANIONSHIP-SEAMLESS` | `main` | `done` | 内部状态机与语义 Tool 保留；普通界面只显示自然对话和轻量在场提示 |
| `P5-COMPANIONSHIP-MVP` | `main` | `done` | Home Chat 自动归属、多个可暂停/唯一活跃共处、一次跟进、Memory 节点与精确 Chat 气泡完成 |
| `P6-TERRITORY-SANDBOX-DESIGN` | `codex/territory-sandbox-design` | `done` | 产品/UI 改为单一可扩建 2.5D World，不保留固定场景或容量语义 |
| `P6-TERRITORY-WORLD-CONTRACT/RUNTIME` | `codex/territory-sandbox-design` | `done` | 原子网格、共享深度、结构遮挡、镜头、碰撞与寻路完成 |
| `P6-TERRITORY-BUILD/AI` | `codex/territory-sandbox-design` | `done` | 完整物件生命周期与单一 Candidate 生成路径完成 |
| `P6-TERRITORY-RICH-ROOM` | `codex/territory-sandbox-design` | `done` | 高密度起始房和环境/独立陈设生成完成 |
| `P6-TERRITORY-MEMORY-LIVING` | `codex/territory-sandbox-design` | `done` | Memory/Activity 来源、记忆演出与类型化桌宠行为完成 |
| `P6-TERRITORY-INPUT/PET-HANDOFF` | `codex/territory-sandbox-design` | `done` | 左右键职责、连续移动、实际纹理行与 Character Window 交接通过验收 |
| `P5-AUTOMATIONS-CONTRACT/CORE/UI` | `main` | `done` | Reminder/Agent Task 唯一生产路径完成 |
| `P5-MULTI-AGENT` | `main` | `done` | Agent 自主按需调用两个只读、资源互斥 child；无 Composer 开关或第二套 Harness |
| `P5-EVOLUTION/SKILL-DELETE` | `main` | `done` | 严格结构化 Reviewer、用户确认、Skill replay、管理与永久删除完成 |

## 依赖、边界与已知问题

- Activity 只提供前台应用、应用 ID 与窗口标题事实；是否沉默、发起新话题或续接既有 Chat 由 Agent 结合完整语义判断，不使用关键词表，也不让用户选择归属 Chat。
- 一次共处最多关联一个长期经历；可以保留多个未完成共处，但全局只有一个进行中，其余自动暂停。应用退出不会虚构后台共同在场。
- 角色主动内容先作为目标 Chat 中的真实助手消息持久化，再投影到桌宠气泡；气泡只是同一 Chat 的轻量表面，不是独立会话系统。
- Territory 的连续环境底图是可编辑 Definition；家具、附件、记忆物件、碰撞和寻路仍为结构化实体，不从图片反推可选几何。
- `MULTI-AGENT` 的机械 Execution Gate 为 no-winner；生产能力来自透明的结果后产品修订，只覆盖两个只读、资源互斥 child。
- 本机未提供 Developer ID 与 notarization keychain profile，因此 DMG 是可挂载、校验通过的本地验收包，不宣称已签名或公证；正式发布沿同一 Forge 配置注入凭据。
- Azure Voice Live 3/3 通过；Territory Image Live 因未提供 `CHARAMATE_LIVE_AZURE_IMAGE_*` 环境变量跳过。已有产品内 Azure Image 结果不被离线测试伪装为本次 Live 通过。
- 构建仍会报告大型懒加载内容 chunk 提示；已完成的产品旅程、启动和压力实测均通过，它不是当前 blocker。

## 最近绿色验证

- 2026-08-15 桌宠系统卡顿修复：`npm run verify:offline` 通过（contract 100、focused/component 362、integration 172，共 634 项），`npm run build`、开发态 smoke、arm64 package、packaged smoke 与 Electron E2E 23/23 通过；打包产物含可执行 arm64 Activity helper。真实进程确认 helper 常驻且空闲 CPU 为 0，跨 32 秒三次采样均无 Activity `osascript` 子进程；最新 Activity 截图由 3456×2234 Retina 原图降为 1728×1117 逻辑像素、473297 bytes，桌宠透明窗口实图与连续动画帧复核正常。
- 2026-08-15 修复前基线：`npm run verify:offline` 通过（contract 100、focused/component 358、integration 171，共 629 项），`npm run build` 通过；提交 `1213ab4`，仅保留 2 条既有 TanStack Virtual lint warning 和大型懒加载 chunk 提示。
- 2026-08-14 Phase 7 最终收口：`npm run verify:offline` 通过（contract 100、focused/component 358、integration 171，共 629 项）；`npm run build`、开发态 smoke、arm64 package、packaged smoke、完整 Electron E2E 23/23 与 `npm run make` 通过。312 MB ULFO DMG 通过 `hdiutil verify`、挂载内容/Applications 链接与 arm64 检查；Live 为 Azure Voice 3/3、Image 1 项按缺少专用环境变量跳过，benchmark 明确 `not-applicable`。
- 2026-08-14 内容层级收口：`npm run check:fast`、`npm run test:focused`（336/336）、`npm run build` 与完整 Electron E2E（22/22）通过；Chats/Automations 实际窗口截图复核无重复顶部框，页面内创建入口和左侧会话菜单可用。
- 2026-08-14 菜单栏在场入口：`npm run verify:phase0` 完整通过（contract 100、focused/component 336、integration 170，共 606 项；Electron E2E 22/22），production build、开发态 smoke、macOS arm64 package 与 packaged smoke 均通过；两种 smoke 均确认 `singleInstance=true`、`trayReady=true`，实际重复启动在约 0.28 秒内退出并复用现有实例。
- 2026-08-14 无感陪伴与自由领地合并：`npm run verify:phase0` 完整通过（contract 100、focused/component 331、integration 170，共 601 项；Electron E2E 22/22），production build、开发态 smoke、macOS arm64 package 与 packaged smoke 均通过；仅保留 2 条既有 TanStack Virtual lint warning 和大型懒加载 chunk 提示。
- 2026-08-14 无感陪伴分支：`npm run verify:phase0` 通过（contract 98、focused/component 329、integration 163，Electron E2E 23/23），production build、开发态 smoke、macOS arm64 package 与 packaged smoke 均通过。
- 2026-08-14 Phase 6 主线：`npm run verify:offline` 通过（contract 92、focused/component 294、integration 156，共 542 项）；production build、Electron E2E 20/20、macOS arm64 package 与 packaged smoke 均通过。
- `npm run test:live` 最近一次 Azure Voice 3/3 通过；产品内 Azure Image Live 已生成并应用完整 Zone。此次本地集成不要求新的远端调用。
- `npm run test:benchmark` 返回 `not-applicable`：候选 runner 已按生命周期删除，胜者证据保存在中文 Decision Record。

## 当前来源快照

- 2026-08-15 复核 Apple [`NSWorkspace.didActivateApplicationNotification`](https://developer.apple.com/documentation/appkit/nsworkspace/didactivateapplicationnotification)、[`frontmostApplication`](https://developer.apple.com/documentation/appkit/nsworkspace/frontmostapplication)、Accessibility `AXUIElementCreateApplication`/焦点窗口与标题通知；复核锁定 `electron@43.2.0` 的 [`desktopCapturer.thumbnailSize`](https://www.electronjs.org/docs/latest/api/desktop-capturer)、`Display.size/scaleFactor`、`NativeImage.toPNG/getSize`，以及锁定 `pixi.js@8.19.0` 的 [Application/Ticker](https://pixijs.com/8.x/guides/components/ticker)、`AnimatedSprite.autoUpdate=false` 与 Assets cache。操作系统/库能力与 CharaMate 的 15 秒 idle 采样、15 分钟截图、15 FPS 桌宠上限已分别记录。
- 2026-08-14 复核锁定 `electron@43.2.0` 包内 `render-process-gone` reason 与 `forcefullyCrashRenderer`；主窗口只自动重建一次是 CharaMate 恢复策略。
- 2026-08-14 复核锁定 `@electron-forge/maker-dmg@7.11.2`、`electron-installer-dmg@5.0.1`、`appdmg@0.6.6`、`@electron/packager` 的 `osxSign`/`osxNotarize` 与 `@electron/notarize@2.5.0` keychain profile；Microsoft Defender DLP 对临时卷的持续 code 16 dissent 只在普通卸载失败后对该 Maker 临时卷强制卸载一次。
- 2026-08-14 复核锁定 `electron@43.2.0` 包内官方类型：`Tray`、`nativeImage.setTemplateImage`、`app.requestSingleInstanceLock` 与 `second-instance` 支持当前菜单栏和单实例实现；图标造型、自然文案和不展示任务数量属于 CharaMate 产品选择。
- 2026-08-14 复核锁定 `electron@43.2.0` 包内官方类型：`BrowserWindow` 支持独立 `setBounds`、`loadFile(..., { query })`、`focusable` 与 `acceptFirstMouse`；跟随窗口的布局与显示时机属于 CharaMate 产品启发式。
- 2026-08-14 复核 OpenAI Structured Outputs 支持的 Schema 与锁定 `openai@6.49.0`；仅 Provider wire 严格子集启用 `strict`，领域 TypeBox/Ajv 校验不变。
- 2026-08-13 复核 Chronicle 官方说明；它只作为“前台活动事实可成为后续对话上下文”的参考，触发、沉默、Chat 路由和长期同行建立仍由 CharaMate 定义。
- 2026-08-13 复核 `gpt-image-2`、OpenAI JavaScript SDK `6.49.0`、Azure Image 指南与 PixiJS 8.19.0；对应决策证据见 `docs/benchmarks/territory-scene-generation.md` 与 `docs/benchmarks/territory-world-performance.md`。
