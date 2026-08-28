# CharaMate 当前状态

> 更新日期：2026-08-28

## 当前里程碑

**Phase 7 — Done；Activity Agent Recall / Territory Narrative 维护包 done**

`MAINT-ACTIVITY-AGENT-RECALL` 已完成：Activity 保持独立 Episode/Digest 真源，Text/Voice Agent 通过 deferred `activity.search` 读取最多 8 条紧凑聚合；同一标签跨至少两个已完成自然周时，只以最近两个 Weekly Digest 提出待确认 `activity_digest`。pending 刷新、拒绝抑制、接受去重和旧累计时长 Memory 的用户确认替换均已覆盖，不再累计时长、Episode 来源或相同语义 Revision。

`MAINT-TERRITORY-NARRATIVE` 已完成：所有随包物件和仍停留在系统首版技术/原始 prompt 描述的既有 Definition 会在启动时通过一次幂等 World/Definition Revision 补全诗意故事；未来普通 Item、Agent Tool、Memory/Activity 来源、Zone 背景与独立陈设统一把名称/故事与视觉 prompt 分离。用户后续编辑的故事保持不变，Activity 来源只表达观察到的节奏。

`MAINT-MEMORY-EVIDENCE-BOUNDARY` 已完成：Text/Voice 的预注入 Memory 与 `memory.search` 只向模型投影事实文本、稳定字段、有效时间和来源计数/类型/跨度，不再发送 Memory/Revision/来源 UUID 或逐条来源 label/reference；`memory.record` 的模型 Schema、结果和 Run 展示同样无 UUID。稳定 profile/preference 改口由宿主以 `claimSlot + 当前 Run 私有 allowlist` 精确定位，旧式跨日累计时长与全部 Episode 来源不再直接形成长期 Memory 候选；已有已接受记录不自动改动。

`MAINT-EVOLUTION-VOICE-REVIEW` 已完成：Voice Run 不再把 Realtime deployment 交给严格 Structured Outputs Reviewer；没有兼容 Chat Model 时收口为 skipped。Memory 页的 Experience Review 候选进入左侧有界区域，失败状态支持重试/关闭，不再把搜索栏和列表/详情工作区挤出视口。

`MAINT-MEMORY-PROFILE-RECALL` 已完成：保留唯一 R0 FTS 路径，把已绑定 profile/preference 作为有界稳定画像注入 Text/Voice Context；证据不足时允许当前模型一次 evidence-oriented 结构化再检索；旧无字段记录只通过 Memory 详情的用户确认绑定/合并收口。稳定画像的全部 ID 可用于精确更新，但只有本次 R0 实际命中的 ID 参与跨 slot create 歧义防护，不会因为全量画像预注入而阻断无关新字段。

`VOICE-WAKE-ERROR-DISMISS` 已修复桌宠上的连接失败提示：沿用 Character Renderer 已有 `VoiceStore.clearError()` 增加明确关闭入口，点击只清本地展示态，不启动、结束或伪造 VoiceSession，也不改变 `wake_enabled`。下一次语音尝试仍按真实结果更新；没有新增未经验证的自动消失阈值。

`VOICE-WAKE` 已在独立 worktree 中完成固定短语 `Hi Mika` 的本地自动唤醒：待机音频只进入 Character Renderer 的 AudioWorklet/Web Worker，命中后复用现有桌宠 `Agent + full_access` Voice Runtime，不打开主窗口、不创建第二套 Voice/Run/Tool 状态机。ready cue 只确认本地命中；Realtime 就绪后立即进入回应，并由 Mika 通过 `conversation: "none"` 的 out-of-band response 说“我在，请说。”。真人复测发现并修正欢迎语被 10 秒静默计时截断的问题；现在连接、生成和播报都不占用回答窗口，欢迎语完整结束后才开始计时。

`MAINT-CHAT-CONTEXT-SNAPSHOT` 已完成：Chat 完整消息继续作为界面与审计真源，Schema v15 另行持久化滚动摘要、覆盖水位和同模型实际用量标定。Text、Automation、主动对话、inline conversation 与 Voice 统一读取“摘要 + 水位后已完成原文”；Run 内执行压缩和长期 Memory 保持各自边界。新 Run 不再重放已覆盖的全量历史，也不会因 terminal checkpoint 删除而丢失跨 Run 摘要。

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
- [x] 合并后的 Schema v16、Chat Context Snapshot、Voice Wake typed IPC、Renderer、离线、Build、Electron E2E 与 package/smoke 全链重新通过。
- [x] Chats 主内容无重复标题/操作框，重命名、置顶、归档、恢复和删除都从左侧完成；Automations 页面内只有一个持久“新建任务”入口。
- [x] Appearance 的主题、自定义基础色板与深色派生均持久化；Data 使用真实 typed IPC 且不提供越界删除。
- [x] 无模型、Foundation 加载失败、React 渲染失败与 Renderer 进程崩溃均有用户可恢复路径。
- [x] Dev Dashboard 与 macOS Forge DMG 单一路径完成；Apple 签名、公证只由发布环境凭据启用。
- [x] 最终 offline、build、dev/package smoke、24 条 Electron E2E、Live/benchmark 分项和单路径审计完成。

## 工作包状态

| 工作包 | Owner | 状态 | 结果 |
| --- | --- | --- | --- |
| `MAINT-ACTIVITY-AGENT-RECALL` | `codex/voice-wake` | `done` | Activity-owned deferred 紧凑检索、跨自然周稳定候选、旧累计时长 Memory 的用户确认替换与最近两个 Weekly Digest 有界来源完成 |
| `MAINT-TERRITORY-NARRATIVE` | `codex/voice-wake` | `done` | 随包/既有/未来 Territory Definition 的结构化名称与诗意故事完成；启动升级幂等，视觉 prompt 不再进入展示内容 |
| `MAINT-MEMORY-EVIDENCE-BOUNDARY` | `codex/voice-wake` | `done` | 模型可见 Memory evidence 与 Tool 展示无内部 UUID/逐条来源；稳定字段由宿主私有 allowlist 解析；旧式累计时长/全 Episode 来源候选被删除，既有已接受记录保持不变 |
| `MAINT-EVOLUTION-VOICE-REVIEW` | `codex/voice-wake` | `done` | Voice Review 只使用兼容 Structured Outputs 的 Chat Model；无兼容配置时 skipped；Memory 失败复盘紧凑、可重试/关闭且不再破坏工作区布局 |
| `MAINT-MEMORY-PROFILE-RECALL` | `codex/voice-wake` | `done` | Text/Voice 稳定画像 Context、一次结构化再检索、旧数据确认绑定/合并及手动新建字段约束完成；R0、top8、索引和排序保持不变 |
| `VOICE-WAKE-ERROR-DISMISS` | `codex/voice-wake` | `done` | 桌宠连接失败提示可显式关闭；仅清 Renderer 展示态，不改变真实 Session/唤醒开关；组件、离线、Build、E2E 与 packaged smoke 通过 |
| `VOICE-WAKE` | `codex/voice-wake` | `done` | 本地 KWS、既有 Voice quick-start、紧凑 out-of-band Mika 欢迎语和 phase-aware 静默收口已完成；Chat/Run/Memory 零污染，完整 `verify:phase0` 通过 |
| `MAINT-CHAT-CONTEXT-SNAPSHOT` | `main` | `done` | Schema v15 持久化 Chat 级滚动摘要、覆盖水位与同模型用量标定；Text/Automation/主动对话/inline/Voice 共用投影，完整聊天记录与 Run checkpoint/长期 Memory 保持分离 |
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

- `VOICE-WAKE` 只接受固定短语 `Hi Mika`。Realtime `server_vad` 只在已建立的 Realtime Session 内划分语音边界，不承担待机唤醒；唤醒命中与 out-of-band 连接欢迎语都不写 Chat/Run/Memory，只有后续非空 Realtime 用户转写才进入现有 Voice Run。
- 自动唤醒与桌宠通用声波入口相同，固定使用 `Agent + full_access`。误唤醒后的无语音激活会自动结束，但 10 秒窗口只从欢迎语完整停止并回到 listening 后开始；该等待值是 CharaMate 可用性启发式，不是 OpenAI/Azure 或 sherpa-onnx 协议限制。
- 当前 KWS 选择证据来自 macOS 合成语料与实际生产 Worker，不代表真实麦克风、多说话人、噪声房间或全天候 FAR/FRR 已通过；功能因此保持默认关闭，限制见 `docs/benchmarks/voice-wake.md`。
- Activity 只提供前台应用、应用 ID 与窗口标题事实；Agent 可按需通过 deferred `activity.search` 读取有界聚合，但只能表述为观察行为。是否沉默、发起新话题或续接既有 Chat 仍由 Agent 结合完整语义判断，不使用关键词表，也不让用户选择归属 Chat。
- 一次共处最多关联一个长期经历；可以保留多个未完成共处，但全局只有一个进行中，其余自动暂停。应用退出不会虚构后台共同在场。
- 角色主动内容先作为目标 Chat 中的真实助手消息持久化，再投影到桌宠气泡；气泡只是同一 Chat 的轻量表面，不是独立会话系统。
- Territory 的连续环境底图是可编辑 Definition；家具、附件、记忆物件、碰撞和寻路仍为结构化实体，不从图片反推可选几何。
- `MULTI-AGENT` 的机械 Execution Gate 为 no-winner；生产能力来自透明的结果后产品修订，只覆盖两个只读、资源互斥 child。
- 本机未提供 Developer ID 与 notarization keychain profile，因此 DMG 是可挂载、校验通过的本地验收包，不宣称已签名或公证；正式发布沿同一 Forge 配置注入凭据。
- Azure Voice Live 3/3 通过；Territory Image Live 因未提供 `CHARAMATE_LIVE_AZURE_IMAGE_*` 环境变量跳过。已有产品内 Azure Image 结果不被离线测试伪装为本次 Live 通过。
- 构建仍会报告大型懒加载内容 chunk 提示；已完成的产品旅程、启动和压力实测均通过，它不是当前 blocker。

## 最近绿色验证

- 2026-08-28 Activity Agent Recall / Territory Narrative：`npm run verify:offline` 通过（contract 108/108、focused/component 401/401、integration 192/192）；`npm run test:e2e` 含 production build 通过 24/24；arm64 `npm run package` 与 `npm run smoke:package` 通过，packaged smoke 确认 `visibleWindowCount=0`、`characterRendererReady=true`、`wakeAssetsReady=true`。新增回归覆盖 Activity 聚合不泄露窗口标题/内部 ID、跨周候选只保留最近两个 Weekly Digest、拒绝/大小写抑制、旧 Memory 原 ID Revision，以及领地既有描述一次升级、未来故事/prompt 分离。未运行 Live Provider。
- 2026-08-28 Memory evidence / Activity 长期化边界修复：`npm run verify:offline` 通过（contract 108/108、focused/component 392/392、integration 185/185）；`npm run test:e2e` 含 production build 通过 24/24，跨 Chat “徒步 → 游泳 → 回忆”保持同一 Memory 且 Provider 请求不含对应 Memory/Revision UUID；600 条来源压力回归的 `memory.search` 模型结果小于 2,000 字符且不含逐条来源；arm64 `npm run package` 与 `npm run smoke:package` 通过，packaged smoke 确认 `visibleWindowCount=0`、`characterRendererReady=true`、`wakeAssetsReady=true`。未运行 Live Provider。
- 2026-08-27 Experience Review / Memory 布局修复：`npm run verify:offline` 通过（contract 108/108、focused 392/392、integration 185/185）；`npm run test:e2e` 含 production build 通过 24/24，新增真实窗口几何断言覆盖失败 Review 出现和关闭；arm64 `npm run package` 与 `npm run smoke:package` 通过，packaged smoke 确认 `visibleWindowCount=0`、`characterRendererReady=true`、`wakeAssetsReady=true`。未运行 Live Provider；Voice 兼容 Chat Model 的选择与无配置 skipped 均由注入 Provider 的确定性回归覆盖。
- 2026-08-27 Memory 画像召回正确性修复：`npm run verify:offline` 通过（contract 108/108、focused 388/388、integration 184/184），`npm run build` 与 Electron E2E 23/23 通过；arm64 `npm run package`、`npm run smoke:package` 通过，packaged smoke 确认 `visibleWindowCount=0`、`characterRendererReady=true`、`wakeAssetsReady=true`。未运行 Live Provider；本修复的 Provider 行为只通过确定性 scripted Tool/Voice 回归验证。
- 2026-08-27 桌宠 Voice 错误提示收口：`npm run check:fast` 通过（contract 104/104），`npm run test:focused` 通过（383/383），`npm run test:integration` 通过（178/178），`npm run build`、arm64 `npm run package`、`npm run smoke:package` 与 Electron E2E 23/23 通过；packaged smoke 确认 `visibleWindowCount=0`、`characterRendererReady=true`、`wakeAssetsReady=true`。新增组件回归验证连接失败提示可关闭，关闭不会再次连接或结束 Session；未运行 Live Provider。
- 2026-08-27 真人复测修正：真实记录确认 wake-origin Session 从请求到 ready 为 11.470 秒，旧计时器又在连接后 7.742 秒结束 generation=0 的会话；`wake_enabled` 始终为 1。修复后 `npm run verify:phase0` 完整通过（contract 104/104，focused/component 382/382，integration 178/178，Electron E2E 23/23），build、dev/package smoke 与 arm64 package 通过；欢迎语期间不再计时，结束后重新获得完整窗口，response 级输入不再重复完整 Agent instructions。
- 2026-08-27 Mika 连接欢迎语：`npm run verify:phase0` 完整通过（contract 104/104，focused/component 382/382，integration 178/178，Electron E2E 23/23）；production build、开发态 smoke、macOS arm64 package 与 packaged smoke 均通过，两种 smoke 均确认 `visibleWindowCount=0`、`characterRendererReady=true`、`wakeAssetsReady=true`。定向测试覆盖欢迎语正常播完、播报中插话、`response.created` 迟到、原连接恢复和冷重连；欢迎语不创建 Chat Message 或 Run。未运行自动化 Live 套件，真实麦克风与当前 Azure Provider 体验由用户复测。
- 2026-08-25 本地 `Hi Mika` 自动唤醒：`npm run verify:phase0` 完整通过（contract 104/104，0.797 秒；focused/component 378/378，3.37 秒；integration 176/176，6.45 秒；Electron E2E 23/23，31.4 秒），production build、开发态 smoke、macOS arm64 package 与 packaged smoke 均通过；两种 smoke 都确认 `visibleWindowCount=0`、`characterRendererReady=true`、`wakeAssetsReady=true`。未调用真实 Provider，未在无人值守验收中申请系统麦克风权限，未运行 Live/benchmark/make。
- 2026-08-18 长会话上下文正确性修复：`npm run verify:offline` 通过（contract 100、focused/component 364、integration 176，共 640 项，27.6 秒）；`npm run build` 通过；Electron E2E 23/23 通过（含构建共 42.6 秒）；arm64 `npm run package` 通过（15.1 秒），`npm run smoke:package` 通过（4.4 秒），确认 `databaseRoundTrip=true`、`rendererReady=true`、`characterRendererReady=true`、`browserRoundTrip=true`。未调用真实 Provider，未运行 Live/benchmark/make。
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

- 2026-08-28 复核基线提交 `f7122f23e1ce3b6cce3008b9e0c59d43343c23f2` 的 Activity/Memory/Tool Search 与 Territory 全部 Definition 创建入口：`activity.search` 使用既有 deferred Tool Discovery，跨周候选来源固定为最近两个完成周；Territory 的展示故事与 Image prompt 分离，既有系统首版描述只通过幂等 Revision 升级。8 条检索结果和 180/120/240 字符守卫均为 CharaMate 产品边界，不是 Provider 协议限制。
- 2026-08-27 复核 OpenAI Realtime conversations、Realtime client events 与 Microsoft Azure GPT Realtime audio（页面更新于 2026-07-29）：`response.create` 可用 `conversation: "none"` 创建不进入默认 conversation 的 out-of-band response，并以 metadata 关联事件、自定义 input 提供临时上下文；response 级 instructions 只覆盖本次 response 的 Session 默认配置。VOICE-WAKE 因此在 Session ready 后用紧凑指令生成 Mika 连接欢迎语，不伪造持久消息或重复完整 Agent 上下文。
- 2026-08-25 复核 OpenAI Realtime VAD/WebRTC 指南：`speech_started/stopped` 属于已建立 Realtime Session，不是常驻 wake-word detector；客户端音频继续使用现有 WebRTC 路径。复核 sherpa-onnx `v1.13.6`（commit `1cb484af5e69d3c7803c1eb0b3b5ab8041e0e911`）的官方 WASM KWS/C API，以及当前 HEAD `34eba5a27220026b5981b633981c53205515067d`；固定英文短语使用 GigaSpeech 3.3M INT8 模型，下载包 SHA-256 为 `f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a`，包内 README 明示 Apache-2.0。选择、结果与外推限制见 `docs/benchmarks/voice-wake.md`。
- 2026-08-18 复核 OpenAI Compaction 指南、Codex `f47f77ada6699460bf13b0b7278e710692e0ea34` 与 LangChain `9f2d56e376ea926d334f8f99ed7c67b154c2f0bf`：成熟实现都让压缩结果替代已覆盖旧输入并成为后续上下文，而不是每个新执行重新注入全量原文。CharaMate 采用自己的 Chat 级滚动摘要与覆盖水位；既有 90% 触发比例、Provider 限额和实际 usage 标定不变，不复制外部默认消息数、重试数或固定窗口。
- 2026-08-15 复核 Apple [`NSWorkspace.didActivateApplicationNotification`](https://developer.apple.com/documentation/appkit/nsworkspace/didactivateapplicationnotification)、[`frontmostApplication`](https://developer.apple.com/documentation/appkit/nsworkspace/frontmostapplication)、Accessibility `AXUIElementCreateApplication`/焦点窗口与标题通知；复核锁定 `electron@43.2.0` 的 [`desktopCapturer.thumbnailSize`](https://www.electronjs.org/docs/latest/api/desktop-capturer)、`Display.size/scaleFactor`、`NativeImage.toPNG/getSize`，以及锁定 `pixi.js@8.19.0` 的 [Application/Ticker](https://pixijs.com/8.x/guides/components/ticker)、`AnimatedSprite.autoUpdate=false` 与 Assets cache。操作系统/库能力与 CharaMate 的 15 秒 idle 采样、15 分钟截图、15 FPS 桌宠上限已分别记录。
- 2026-08-14 复核锁定 `electron@43.2.0` 包内 `render-process-gone` reason 与 `forcefullyCrashRenderer`；主窗口只自动重建一次是 CharaMate 恢复策略。
- 2026-08-14 复核锁定 `@electron-forge/maker-dmg@7.11.2`、`electron-installer-dmg@5.0.1`、`appdmg@0.6.6`、`@electron/packager` 的 `osxSign`/`osxNotarize` 与 `@electron/notarize@2.5.0` keychain profile；Microsoft Defender DLP 对临时卷的持续 code 16 dissent 只在普通卸载失败后对该 Maker 临时卷强制卸载一次。
- 2026-08-14 复核锁定 `electron@43.2.0` 包内官方类型：`Tray`、`nativeImage.setTemplateImage`、`app.requestSingleInstanceLock` 与 `second-instance` 支持当前菜单栏和单实例实现；图标造型、自然文案和不展示任务数量属于 CharaMate 产品选择。
- 2026-08-14 复核锁定 `electron@43.2.0` 包内官方类型：`BrowserWindow` 支持独立 `setBounds`、`loadFile(..., { query })`、`focusable` 与 `acceptFirstMouse`；跟随窗口的布局与显示时机属于 CharaMate 产品启发式。
- 2026-08-14 复核 OpenAI Structured Outputs 支持的 Schema 与锁定 `openai@6.49.0`；仅 Provider wire 严格子集启用 `strict`，领域 TypeBox/Ajv 校验不变。
- 2026-08-13 复核 Chronicle 官方说明；它只作为“前台活动事实可成为后续对话上下文”的参考，触发、沉默、Chat 路由和长期同行建立仍由 CharaMate 定义。
- 2026-08-13 复核 `gpt-image-2`、OpenAI JavaScript SDK `6.49.0`、Azure Image 指南与 PixiJS 8.19.0；对应决策证据见 `docs/benchmarks/territory-scene-generation.md` 与 `docs/benchmarks/territory-world-performance.md`。
