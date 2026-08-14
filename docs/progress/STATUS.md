# CharaMate 当前状态

> 更新日期：2026-08-14

## 当前里程碑

**Phase 6 — Done（自由领地、桌宠与无感陪伴主路径已收口）**

Phase 0–4 已完成。Phase 5 的 Automations、Multi-agent、Self-evolution、无感同行/共处与全新主动话题邀请均已完成单一路径生产实现；Phase 6 已完成 24 px 原子空间、2.5D 深度、高密度起始房、完整生成/编辑/删除生命周期，以及 Memory/Activity 生活化联动。

无感陪伴保留内部 Journey/Together Session、全局唯一活跃态、Home Chat 自动归属、稀疏节点、一次约定跟进和共同记忆，但不要求用户管理这些名词。Activity 触发的全新话题先进入隐藏 provisional Chat；20 秒内首个文字或气泡 Voice 回复才把同一 Chat 转正，超时、关闭、开场失败或重启会删除临时 Chat、Run 与消息。已有 Chat/Journey 的续接保持正式历史。

自由领地使用可扩建 2.5D World。探索态左键只选择/查看，右键从当前插值位置平滑移动；实际 atlas running 行、抵达后的 idle 行和连续改道均已覆盖。主窗口可见且停留 Territory 时只显示场景桌宠，切页、隐藏、最小化或关闭主窗口后恢复桌面 Character Window。

当前集成退出条件：

- [x] Journey/Together Session 状态与用户可见 Chat/Run/Voice 共用既有 Runtime，不增加管理页面或第二套执行链。
- [x] 主动气泡绑定唯一 `chatId`，主窗口关闭时可连续文字/语音回复；临时邀请不进入最近、搜索或归档列表，也不显示倒计时或进度条。
- [x] World 合同、PixiJS 深度/碰撞/寻路、完整 Candidate/Preview/change-set 与 Memory/Activity 来源快照完成。
- [x] Character Window 同时支持 Territory 场景交接和独立主动对话跟随窗口，不复制桌宠或遮挡交互。
- [x] 合并后的 Schema v14、typed IPC、Renderer、离线、Build、Electron E2E 与 package/smoke 全链重新通过。

## 工作包状态

| 工作包 | Owner | 状态 | 结果 |
| --- | --- | --- | --- |
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
- 构建仍会报告大型懒加载内容 chunk 提示；已完成的产品旅程、启动和压力实测均通过，它不是当前 blocker。

## 最近绿色验证

- 2026-08-14 无感陪伴与自由领地合并：`npm run verify:phase0` 完整通过（contract 100、focused/component 331、integration 170，共 601 项；Electron E2E 22/22），production build、开发态 smoke、macOS arm64 package 与 packaged smoke 均通过；仅保留 2 条既有 TanStack Virtual lint warning 和大型懒加载 chunk 提示。
- 2026-08-14 无感陪伴分支：`npm run verify:phase0` 通过（contract 98、focused/component 329、integration 163，Electron E2E 23/23），production build、开发态 smoke、macOS arm64 package 与 packaged smoke 均通过。
- 2026-08-14 Phase 6 主线：`npm run verify:offline` 通过（contract 92、focused/component 294、integration 156，共 542 项）；production build、Electron E2E 20/20、macOS arm64 package 与 packaged smoke 均通过。
- `npm run test:live` 最近一次 Azure Voice 3/3 通过；产品内 Azure Image Live 已生成并应用完整 Zone。此次本地集成不要求新的远端调用。
- `npm run test:benchmark` 返回 `not-applicable`：候选 runner 已按生命周期删除，胜者证据保存在中文 Decision Record。

## 当前来源快照

- 2026-08-14 复核锁定 `electron@43.2.0` 包内官方类型：`BrowserWindow` 支持独立 `setBounds`、`loadFile(..., { query })`、`focusable` 与 `acceptFirstMouse`；跟随窗口的布局与显示时机属于 CharaMate 产品启发式。
- 2026-08-14 复核 OpenAI Structured Outputs 支持的 Schema 与锁定 `openai@6.49.0`；仅 Provider wire 严格子集启用 `strict`，领域 TypeBox/Ajv 校验不变。
- 2026-08-13 复核 Chronicle 官方说明；它只作为“前台活动事实可成为后续对话上下文”的参考，触发、沉默、Chat 路由和长期同行建立仍由 CharaMate 定义。
- 2026-08-13 复核 `gpt-image-2`、OpenAI JavaScript SDK `6.49.0`、Azure Image 指南与 PixiJS 8.19.0；对应决策证据见 `docs/benchmarks/territory-scene-generation.md` 与 `docs/benchmarks/territory-world-performance.md`。
