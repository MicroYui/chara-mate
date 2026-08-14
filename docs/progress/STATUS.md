# CharaMate 当前状态

> 更新日期：2026-08-14

## 当前里程碑

**Phase 5 — implementing（全新主动话题的临时邀请生命周期已完成；广义主动聊天仍为后续工作包）**

Phase 0–4 已完成；结构化输入、图片输入、Agent、Memory、Context、Activity 与 Realtime Voice 均为单一生产路径。Phase 5 Automations Contract/Core/UI 已在 `main` 汇合；`P5-MULTI-AGENT` 已完成 source-first Decision Gate、真实模型实验、中文 Decision Record 与单一路径生产重写，提供 Agent 自主按需调用的两个只读 child；`SELF-EVOLUTION` 已完成 Decision、生产重写和真人体验修复，Reviewer 使用严格结构化输出，失败 Run 的 Plan 不再保留活跃状态。Phase 6 Pet、Territory Base、结构化 Item Manifest、Azure Image 与 Territory Memory 也已完成。Phase 5 仍为 implementing，因为主动聊天是独立后续工作包。

`P5-COMPANIONSHIP-SEAMLESS` 已完成：保留已验证的 Journey/Together Session、全局唯一活跃态、Home Chat 自动归属、稀疏节点、一次约定跟进和共同记忆，但把这些全部退回 Agent 与持久化内部。普通用户只看到原 Chat、自然对话和一条不带状态动作的当前在场提示；开始、切换、暂停、续接、完成与纠正由 Agent 依据 Activity 和完整对话语义处理，不要求用户理解或管理产品名词。角色主动内容继续是目标 Chat 中真实持久化的助手消息，并投影为可连续文字或语音回复的桌宠气泡；主窗口可以全程保持关闭。

`P5-PROACTIVE-INVITATION` 已完成：Activity 触发的全新话题先进入隐藏 provisional Chat，气泡可见后 20 秒内首个文字回复或从该气泡启动 Voice 才把同一个 Chat 转正；超时、关闭、开场失败或应用重启会级联删除临时 Chat、Run 与消息。已有 Chat/Journey 的续接保持正式历史，不套用短时删除规则。

当前工作包退出条件：

- [x] `P5-PROACTIVE-INVITATION` 为 Activity 全新话题增加隐藏 provisional Chat；首个文字/气泡语音回复转正，20 秒超时、关闭与异常重启清理，已有 Chat 行为不变。
- [x] 临时邀请不进入最近、搜索或归档列表，转正前不提供“打开完整 Chat”，气泡不显示倒计时或进度条。
- [x] Schema v14、Chat/气泡生命周期、Renderer、集成与 Electron E2E 回归通过，并以真实用户目录冷启动迁移供验收。
- [x] `P5-COMPANIONSHIP-MVP` 以一个 Journey 领域冻结 Journey/Together Session/稀疏节点契约与全局唯一活跃态；当前 Schema v14 保留“删除普通 Chat 同步移除其内部续接状态”的级联语义，并增加未接住主动邀请的 provisional Chat 状态。
- [x] Activity 只提供当前活动事实；陪伴 Agent 自行判断沉默、新开对话或路由到既有 Journey，统一 Run 先持久化助手消息再投影桌宠气泡，观察本身不创建 Session/Journey。
- [x] Agent 以始终可用的内部语义动作维护同行/共处，宿主解析 Home Chat 与状态不变量；Chat/Agent/Voice 继续复用同一 Run/Tool/Approval。
- [x] `P5-COMPANIONSHIP-SEAMLESS` 移除同行/共处分组、卡片、详情抽屉和手动状态动作；Home Chat 回到普通最近/已归档列表，跨页仅保留自然在场提示与对话式纠正。
- [x] Agent 在 Text/Voice 中不向用户说出 Journey/Together Session/Home Chat 或状态名，并根据日常表达自然开始、切换、暂停、续接、结束、长期提议、完成和纠正。
- [x] typed Preload 只向 Renderer 暴露只读陪伴快照与事件；状态变更继续只走统一 Agent Tool，组件、契约、集成和 Electron E2E 回归通过。
- [x] 一次明确约定的跟进复用 Automation 投递到 Home Chat；显著共同记忆复用 Memory 并保留 Journey/Session 关联。
- [x] 创建、切换、暂停、重启恢复、完成/重开、跟进与记忆沉淀通过离线、build 和受影响桌面旅程。
- [x] 主动气泡在创建时绑定唯一 `chatId`，直接复用该 Chat 的普通消息与 Run；主窗口关闭时可连续短文字对话。媒介动作本身不改状态，用户回复后由 Agent 根据是否实际参与当前活动的整体语义开始或恢复。

- [x] 一次、每天、每周与 POSIX 五段 Cron 使用唯一 Schedule 联合；重复计划显式记录 IANA 时区与 UTC `nextRunAt` 投影。
- [x] 锁定唯一 Cron 计算实现；DST gap/fold、DOM/DOW、无效扩展和显式时区均有确定性回归。
- [x] 启动、系统恢复和延迟 timer 原子 claim 一个持久化 occurrence；重复计划合并停机期间更早 occurrence，一次性计划完成且不会重复执行。
- [x] Reminder 与 Agent Task 通过 Repository/Service 和唯一完成事件运行；Reminder 记录投递结果，Agent Task 复用普通持久化 Chat/Run 与既有 Tool/Approval/取消路径。
- [x] Main 注册窄 typed IPC/Preload，桌面 E2E 覆盖创建、暂停、立即运行、编辑、历史与重启恢复。
- [x] Automations 卡片、一次/每天/每周/Cron 单页表单、暂停/恢复、编辑、试跑、历史和 Agent Task Chat Run 跳转完成；正常 UI 不暴露调度内部参数。
- [x] Memory 与 Activity Digest 可显式形成 Territory 候选，预填生成内容且同一来源幂等。
- [x] 已确认物件保留来源快照，可跳回 Memory；来源领域不依赖 Territory 表。
- [x] 同一来源只保留一个活动物件实例，重新生成形成不可变版本并可切回。
- [x] pin 与固定同屏容量生效；超限只回收藏库，不删除 Memory、候选或资产版本。
- [x] Automations 与 Territory Memory 合并后的 Schema、typed IPC/Preload、组件旅程、重启恢复和 milestone package/E2E 验收通过。
- [x] Run 完成后只按四类已定触发信号持久化异步 Review；同一 Run 幂等，queued/running 可在重启后恢复，Reviewer 是无 Tool 的单次结构化调用。
- [x] 四类成长候选全部要求用户确认；Memory/Persona 复用 `MemoryService`，Skill replay 通过后才激活，并支持失败编辑重试。Skill 生效后只作为普通 Agent Skill 管理，不再保留第二套候选管理入口。
- [x] Chats 与 Memory 展示待确认候选、证据、来源和状态；Settings → Skills 只管理当前或已归档 Skill。真实 Electron E2E 验证确认前不落库、确认后生效。
- [x] Reviewer 通过 Provider 结构化输出约束生成完整候选，不再因提示未列出必填字段而让整次 Review 失败。
- [x] Provider 失败后最新 Plan 只作为终态历史显示，未完成步骤不再保留“进行中”动画或文案。
- [x] Settings 允许二次确认后永久删除当前或已归档用户 Skill；当前 Skill 在删除事务内部先归档，目录、内部 revision 和候选绑定同步收口，workspace Skill 拒绝删除。
- [x] `MULTI-AGENT` 保留机械 no-winner 结果并透明记录产品修订；生产仅保留 `D2 + M2R` 的 Agent 自主、两 child、只读、资源互斥路径，无 Composer 开关、候选 Arm 或第二套 Harness。
- [x] Multi-agent 的资源门、并发、父 Join、取消/失败、持久化、观测、Chat 隔离与桌面旅程通过 offline、build、19/19 E2E、Forge package 和 packaged smoke。

## 工作包状态

| 工作包 | Owner | 状态 | 结果 |
| --- | --- | --- | --- |
| `P5-PROACTIVE-INVITATION` | `main` | `done` | 全新主动话题使用隐藏 provisional Chat；20 秒无回复、关闭、开场失败或重启级联清理，首次文字/气泡 Voice 回复原地转正，已有 Chat 续接保持正式历史 |
| `P5-COMPANIONSHIP-SEAMLESS` | `main` | `done` | 内部状态机与语义 Tool 保留；用户管理界面已移除，Renderer API 已收窄为只读，Text/Voice 当前 Chat 候选和自然语言生命周期验收通过 |
| `P5-COMPANIONSHIP-MVP` | `main` | `done` | Activity→Agent 主动对话→用户确认 Journey、Home Chat 自动归属、多个可暂停/唯一活跃共处、一次跟进、Memory 节点、绑定精确 Chat 的桌宠连续文字/语音气泡和 Chats 六页全局状态已完成 |
| `P3-RUNTIME-MEMORY-ACTIVITY` | `main` | `done` | Chat/Agent、结构化输入、Memory/Context/Activity 单一路径完成 |
| `P2-RUNTIME-PLAN-CHECKPOINT` | `main` | `done` | Plan RunItem 保持历史/UI 真源，checkpoint 保存并恢复编译快照；普通 Tool、旧 checkpoint、重启与压缩回归完成 |
| `P6-PET-TERRITORY-IMAGE` | `main` | `done` | 桌宠、领地、Azure Image、候选确认与内建 Tool 完成 |
| `P6-TERRITORY-MEMORY` | `main` | `done` | Memory/Activity candidate、来源追溯、12 件容量回收、版本与 pin 完成 |
| `P5-AUTOMATIONS-CONTRACT` | `main` | `done` | Automations JSON Schema、Schema v9/迁移、完成事件与 typed IPC/Preload 已冻结；456 项 offline、16/16 E2E 与 package/smoke 通过 |
| `P5-AUTOMATIONS-CORE` | `main` | `done` | 唯一 schedule 计算、休眠恢复、Repository/Service、Reminder 投递记录、Agent Task 普通 Chat Run、事件发布与 Main IPC 注册完成；独立验证 474 项 offline、17/17 E2E 与 package/smoke 通过 |
| `P5-AUTOMATIONS-UI` | `main` | `done` | 卡片、四类计划表单、Reminder/Agent Task、暂停/恢复、编辑、试跑、运行历史与 Agent Task Chat Run 跳转完成；只消费 typed Preload，未修改 shared Schema、DB 或 Main Core |
| `P5-EVOLUTION` | `codex/self-evolution-decision-gate` | `done` | 严格 JSON Schema Reviewer/replay 输出、失败 Run 计划终态、同毫秒 Memory current revision 排序和 513 项 offline、20/20 E2E 验收完成 |
| `P5-SKILL-DELETE` | `codex/self-evolution-decision-gate` | `done` | 当前 Skill 编辑/普通保存/归档/恢复/永久删除完成；Skills 移除成长候选与可见版本历史，左栏仅显示小号名称和 description，并以“当前 / 已归档”分组；531 项 offline、build 与 21/21 E2E 通过 |
| `P5-MULTI-AGENT` | `codex/multi-agent-decision-gate` | `done` | `CHM-MULTI-AGENT-20260813-W1` 机械 Gate 为 no-winner；按仓库所有者透明修订，以 `D2 + M2R` 落地 Agent 自主按需调用的两个只读 child 能力，失败候选与实验代码已删除 |
| `P4-SOURCE-CONTRACT` | `main` | `done` | Realtime conversation、WebRTC interruption、Function Call 与锁定 SDK 类型已复核 |
| `P4-VOICE-DECISIONS` | `main` | `done` | 透明修订为 Orchestrated Native Realtime；WebRTC + 串行 continuation |
| `P4-VOICE-RUNTIME` | `main` | `done` | 原生 response、共享 Tool/Approval、Run/Item、打断、历史与非阻塞标题完成 |
| `P4-VOICE-UI` | `main` | `done` | Voice Dock、设置、Composer 继承入口、桌宠完全访问声波入口与 Approval 气泡完成 |
| `P4-VOICE-LANGUAGE` | `main` | `done` | `whisper-1 + 关键词 prompt + 不固定 language` 单一路径；Azure Live 通过 |
| `P4-VOICE-CONNECTION-LIFECYCLE` | `main` | `done` | 暂停/恢复连接复用、配置变化或适配器不支持热刷新时冷重连、启动并行化与分阶段连接耗时完成并通过真人验收 |
| `P4-VOICE-ENTRY-HANGUP` | `main` | `done` | 桌宠与主窗口共享同一 Voice Chat 的暂停/恢复控制；Agent 明确告别后通过 Tool 在音频排空时主动挂断；真人验收通过 |

### 最近完成边界

- 同行触发边界：Activity 只采集当前应用、应用 ID 与窗口标题事实，不直接创建 Chat、Session 或 Journey。Agent 基于事实与既有 Journey 做整体语义判断；无合适话题时沉默，有自然切口时发送普通助手消息，命中既有 Journey 时自动使用它唯一的 Home Chat。没有关键词表、用户选 Chat 或“陪我”命令入口。
- 同行会话边界：一次共处最多关联一个 Journey；可同时保留多个未完成共处，但全局只有一个 `active`，开始或恢复另一个时原活动共处自动变为 `paused`。应用退出或异常重启把活动共处恢复为暂停，绝不虚构后台共同在场；Journey 完成会结束其未完成共处，重开 Journey 不自动恢复共处。
- 同行交互边界：角色主动气泡是已经落入准确目标 Chat 的真实助手消息投影，创建时即绑定唯一 `chatId`；新 Activity 话题先落入不出现在最近、搜索或归档中的 provisional Chat，命中 Journey/跟进则归入其唯一正式 Home Chat，不依赖当前主窗口或用户选 Chat。用户第一次文字回复或从气泡启动 Voice 会原地转正同一 Chat，随后可在不打开主窗口时连续短文字/语音往返；每一轮都作为该 Chat 的普通消息与 Chat-mode Run 持久化。完整历史、附件、富内容、结构化输入、Approval 与复杂执行仍进入转正后提供的“打开完整 Chat”。用户未回复的新话题在 20 秒超时或关闭时级联删除气泡、Chat、Run 与消息；已有 Chat 或已经回复的气泡关闭时只结束投影，不删除历史，也不改变 Journey/Session。仅打开或切换文字、语音、完整 Chat 不改变同行状态，回复后才由 Agent 根据是否实际参与当前活动的整体语义开始或恢复。主动开场 Run 不获得 Tool、交互请求或原生 Web Search，因此气泡不等同后台 Agent Task；用户回复产生的普通 Chat Run 继续拥有始终可用的内部陪伴动作。
- 同行沉淀边界：长期事项必须由 Agent 在自然对话中提出并获得用户确认后创建；一次明确约定的跟进复用 Automation，完成 Journey 会取消待执行跟进；活动共处中的 Memory 创建会形成关联记忆节点，详情按共处、跟进、关键节点和共同回忆四类稀疏呈现。
- Self-evolution 结果：`SELF-EVOLUTION` 选择 E4；terminal Run 只在明确纠正、明确教学、客观验证成功或重复流程时进入异步 Experience Review，生成 Memory、Persona 偏好、Skill patch 或新 Skill 草稿，任何候选都不自动生效。
- Self-evolution 范围：Evolution JSON Schema/types、SQLite Schema v11 与 v10→v11 迁移、Repository/Service、无 Tool Model Reviewer、Skill replay、Memory/Skill 激活、Main/Preload typed IPC，以及 Chats/Memory 的候选 UI；生效后的 Skill 只进入普通 Settings 管理面。
- Self-evolution 非目标：不修改源码、系统根指令、Provider/凭据、审批规则或 Schema 本身；不保留每 Run Review、直接写、Reviewer 自批、固定 Tool 次数、自动归档天数、实验模式或旧 Schema 兼容分支。
- Self-evolution 依赖与合同：Evolution 是本次 shared contract、IPC 与 Schema 的唯一集成 owner；复用 source Run 的 Provider/Model、既有 `MemoryService` 和用户 Skill 目录，不创建第二套 Harness。workspace、archived 或 pinned Skill 不接受成长 patch；patch 固定并复核目标 revision/hash。
- Self-evolution 验收：同 Run/事件 replay 幂等、queued/running 重启恢复、证据与 Item 绑定、确认前不落库、Skill replay 失败编辑重试、激活意图崩溃恢复、旧 patch 不覆盖后续手动保存、Settings/Agent Skill 变更同步结果状态、窄 typed preload 和真实桌面确认旅程均有确定性回归。用户不操作内部 revision 历史。
- Skill 删除边界：只有用户在 Settings 二次确认后才能永久删除用户 Skill；当前 Skill 在删除事务内部先归档，workspace Skill 不可删除。Extension 删除目录与全部内部 revision，Evolution 仅保留来源证据并解除激活绑定；普通 UI 不提供从旧成长记录再次恢复或创建 Skill 的第二入口。
- Self-evolution Decision：30 个配对场景中 E4 相对 E0 的正例成功率从 12/16 提升到 16/16；相对 E3 Review 调用减少 46.7%、Token 减少 37.7%。补充 replay 确认层只拦截 5/10 有害 patch，因此生产保留“全部候选用户确认，Skill 再 replay”的串联。一次性 runner、Arm 代码和核对后的原始产物均已删除。
- Multi-agent 结果：Agent 模式始终可见 `collaboration.dispatch`，由父 Agent 判断是否值得调用；一次固定两个资源互斥的只读 child，并发完成后由同一父 Run Join。Chat 保持单 Agent，正常 UI 没有 Multi-agent 开关或参数。
- Multi-agent 范围：Agent-owned Tool、现有 Harness/Provider/Tool Registry/Run checkpoint、一个 `subtask` Item、SQLite greenfield 当前 Schema CHECK、RunProcess 与本地观测；无新 IPC、Preload、表、进程、依赖或新的 Provider Adapter。既有 OpenAI Responses Adapter 在 wire 边界把所有 client namespace `x` 统一映射为 `charamate_x`，并通用反向映射结构化参数中的已知 Tool 引用；namespace Tool continuation 使用 `auto`，Harness 依据 Tool Search 已加载集合做最终执行校验。
- Multi-agent 非目标：不支持 child 写入、审批、Browser/Computer 可变会话、递归派生、四 child、动态团队规模、运行时 Arm、fallback chain 或实验设置。
- Multi-agent 依赖与合同：父 Agent 提议目标、资源 claim 与确切读取；宿主只验证当前 Run Tool scope、`read + idempotent`、资源互斥和 bounded input。两个 child 不继承父对话且不获得 Tool/web search；父取消信号和既有 Tool 恢复边界贯穿整次调用。
- Multi-agent 验收：资源重叠/越界/副作用拒绝、真实并发、父 Join、部分失败证据、父取消、Agent/Chat 隔离、Subtask 持久化与折叠、nested usage、真实本地文件桌面旅程均有确定性回归。
- Multi-agent Decision：Dispatch 的 `D2` 在 selection + untouched holdout 为 72/72；Execution 的 M0/M2S/M2R 质量均 18/18，但 M2R p95 慢于 M0 且 Token 增加约 39.77%，机械结论为 no-winner。仓库所有者结果后选择将 `D2 + M2R` 作为 Agent 按需能力，完整证据与限制见 `docs/benchmarks/multi-agent.md`。

## 依赖与已知边界

- Automations、Multi-agent、`SELF-EVOLUTION` 与同行 MVP 已完成且都没有第二条 fallback 路径；广义主动聊天仍按自身依赖推进，因此不把整个 Phase 5 标为完成。
- `MULTI-AGENT` 的机械 Execution Gate 没有证明平均质量或时延净收益；当前能力存在是透明的结果后产品修订。生产入口只覆盖两个只读、资源互斥 child，真实开放任务的选择质量仍需从开发观测复核，不能表述为通用并行加速。
- `TERRITORY-CAPACITY` 是一个场景、合成 `96×96` 物件的结构化目标窗口走查，不是多人偏好研究；真实证据若要求改变容量，需替换唯一常量和 Decision，不增加容量档位。
- Territory 保存来源内容、日期和 Memory revision ID 的历史快照；如果原 Memory 后续删除，“在 Memory 中查看”可能找不到活动记录，但 Territory 物件和快照仍保留，且不会成为新的 Memory 事实源。
- Azure Realtime 当前没有 Responses Provider 托管的 `web_search`；它获得同一个客户端 Tool Registry，但不伪造本地 `web.search`。Chat/Agent 入口均可使用既有 `browser.navigate + browser.snapshot` 幂等查询链；Agent 还可按当前审批模式使用既有 `command.run` 以只读 `curl` 查询公开 HTTP/API。空白页或空内容不再伪装成成功 snapshot，其他 Browser/命令操作仍遵循入口权限与审批。
- 目标 Azure `gpt-realtime-2.1` 于 2026-08-09 实测拒绝 Function Tool 根级 `anyOf`。Voice 仅在 Realtime 传输边界把对象联合投影为单一对象字段并集，实际调用仍由原 Tool Registry Schema 校验；这不是通用协议限制。

## 最近绿色验证

- 2026-08-14 `P5-PROACTIVE-INVITATION`：`npm run verify:phase0` 完整通过，其中 contract 98、focused/component 329、integration 163，共 590 项（仅 2 条既有 TanStack Virtual lint warning）；production build、开发态 smoke、macOS arm64 package 与打包态 smoke 通过；Electron E2E 23/23 通过（Playwright 26.2s）。新增回归覆盖隐藏列表/搜索/归档、同一 Chat 转正、20 秒超时、文字与气泡 Voice 接住、关闭/启动残留清理、Chat/Run/消息级联和转正前不提供完整 Chat。真实用户目录随后由 Schema v13 冷启动迁移到 v14，`is_provisional` 列唯一存在、临时记录为 0、`foreign_key_check` 为 0；当前开发实例保持运行供验收。本工作包没有必须调用的远端测试端点，因此 Live 未运行。
- 2026-08-14 `P5-COMPANIONSHIP-SEAMLESS`：`npm run verify:phase0` 完整通过，其中 contract 98、focused/component 324、integration 162，共 584 项（仅 2 条既有 TanStack Virtual lint warning）；production build、开发态 smoke、macOS arm64 package 与打包态 smoke 通过；E2E 23/23 通过（Playwright 26.1s）。桌面旅程验证用户只用日常表达即可继续论文、切换到电影并结束当前活动；长期求职话题先由 Agent 自然询问是否以后继续关心，确认后才创建内部长期续接。普通 Chats、跨页自然在场提示、对话式纠正、只读 Renderer 陪伴 API、Schema v12→v13 级联迁移和删除普通 Chat 同步清理内部状态均有回归。随后以真实用户目录冷启动，现有 Schema v12 数据已由正式迁移升级到 v13，两个 Chat 外键均为 `ON DELETE CASCADE`，`foreign_key_check` 无异常，开发实例保持运行供验收。本工作包没有必须调用的远端端点，因此 Live 未运行。
- 2026-08-14 主动气泡 Voice 卡死与空过程框修复：真实 Run `22ff930a-23c6-4df1-aa62-b82e7b2e4966` 只完成用户转写后永久停在 running；定位为 Voice Run 的 `run.started` 被主动对话表面误判为外部接管，同 Chat 气泡因此销毁了持有唯一 WebRTC Driver 的跟随窗口。当前 Voice Run 保留该连接 owner，普通 text Run 仍按原规则把 Chat 交回完整表面。完成 Run 若只有用户/助手消息或内部 `companionship.update` / `memory.record`，不再附加“已处理”空壳，摘要项数只统计用户可见过程。`npm run check:fast` 通过（contract 98；仅 2 条既有 TanStack Virtual lint warning），focused/component 323/323、integration 160/160、production build、绑定气泡定向 E2E 1/1 与完整 E2E 23/23 通过。首次完整 E2E 的 22/23 仅暴露 Foundation 仍断言旧空过程框；改为断言无空壳后单项与全套均复跑通过。Live 未自动触发，冷重启后的真实气泡 Voice 留给人工验收。
- 2026-08-14 Provider Function Tool 严格 Schema 兼容修复：新增的 `companionship.update` 含 `format`、`pattern` 与长度约束，旧适配器只检查 `required/additionalProperties` 后误发 `strict: true`，导致主动气泡的首条无 Tool 消息成功、用户回复恢复完整 Tool Registry 后被端点拒绝。当前仅在 Provider wire Schema 属于官方严格子集时启用 strict；完整 TypeBox/Ajv 领域校验保持不变。`npm run check:fast` 通过（contract 98；仅 2 条既有 TanStack Virtual lint warning），`npm run test:focused` 320/320、`npm run test:integration` 160/160、`npm run build`、绑定 Chat 连续回复定向 E2E 1/1 与完整 E2E 23/23 通过。本轮未自动发送真实 Provider 请求，避免未经确认产生远端调用；保留给当前开发实例中的人工气泡验收。
- 2026-08-14 主动气泡跟随小窗：`npm run check:fast` 通过（contract 98；仅 2 条既有 TanStack Virtual lint warning）；气泡定位/窗口/Preload focused unit 11/11、Character component 5/5、Voice/Journey integration 24/24、绑定 Chat 的连续文字桌面旅程 1/1 通过，production build 随 E2E 通过。桌面旅程同时验证桌宠 hover 声波入口显示时气泡仍可见、两个窗口不相交且气泡位于当前工作区；实际 Electron 渲染截图复核为浅色半透明大圆角卡片，无进度条和可见滚动条。本轮未重跑完整 `verify:phase0`、package 或 live。
- 2026-08-14 主动气泡连续文字 Chat：`npm run verify:phase0` 完整通过，其中 contract 98、focused/component 316、integration 160，共 574 项（仅 2 条既有 TanStack Virtual lint warning）；production build、开发态 smoke、macOS arm64 package 与打包态 smoke 通过；E2E 23/23 通过（Playwright 29.9s）。新增真实桌面旅程从 Journey 跟进产生气泡，在主窗口数量始终为 0 时连续完成两轮用户/助手回复，随后打开完整 Chat 验证五条消息均属于同一 Chat，且未创建 Together Session。Live 未运行，因为该路径完全由本地 fake Provider 验证且没有远端端点要求。
- 2026-08-13 `P5-COMPANIONSHIP-MVP`：最终 `npm run verify:phase0` 完整通过，其中 offline 为 contract 98、focused/component 309、integration 159，共 566 项（仅 2 条既有 TanStack Virtual lint warning）；production build、开发态 smoke、macOS arm64 package 与打包态 smoke 通过；E2E 22/22 通过（Playwright 26.5s）。完整桌面旅程覆盖活动共处启动恢复、跨六页全局栏、自动暂停/恢复、退出与重启后暂停、完成与回忆查看。首次完整 E2E 仅暴露 Foundation preload shape 白名单未同步；补齐 Journey 和原 Chat 导航契约后，Foundation 单项 1/1 与完整验收链均复跑通过。Live 未运行，因为本工作包没有必须调用的远端端点。
- 2026-08-13 Skills 真实使用逻辑收口：`npm run verify:offline` 通过（contract 90、focused/component 292、integration 149，共 531 项；仅 2 条既有 TanStack Virtual lint warning）；`npm run test:e2e` 包含 production build，21/21 通过（Playwright 23.5s）。Settings 不再展示成长候选、revision/SHA 元信息或版本恢复网格；左栏仅以紧凑字号显示名称和两行 description，并分为“当前 / 已归档”。普通保存、归档、恢复和永久删除被拆为明确操作，未保存内容会阻止归档；生效后的 Skill 成长记录压缩为来源 Chat 中的“成长结果”，不再展开旧 `SKILL.md`，也不提供归档、Pin 或恢复入口。应用从 `chara-mate-self-evolution` 完整退出并冷启动后，以真实的 `charamate-quick-delivery-check` Skill 只读复核了结果卡片、当前列表、description、普通保存态、编辑器软换行、行为项和底部管理区；未修改用户 Skill。
- 2026-08-13 `P5-SKILL-DELETE` 与侧栏溢出修复：`npm run verify:offline` 24.4s 通过（contract 90、focused/component 290、integration 149，共 529 项；仅 2 条既有 TanStack Virtual lint warning）；`npm run test:e2e` 包含 production build，21/21 通过（Playwright 27.2s）。真实桌面旅程覆盖活动用户 Skill 编辑、保存 revision 与确认式直接删除；30 条会话回归确认列表独立滚动且 Mika/Settings 固定可见。集成回归覆盖活动/已归档用户 Skill 删除、workspace 拒绝、目录与全部 revision 清理、删除中断恢复、成长候选解绑，以及已删除 Skill patch 恢复为重新确认的 new Skill 草稿。
- 2026-08-13 Self-evolution 合并与真实验收：合入 `main` 的 Provider namespace/continuation 修复后，`npm run verify:offline` 24.4s 通过（contract 90、focused/component 287、integration 148，共 525 项；仅 2 条既有 TanStack Virtual lint warning），`npm run build` 通过，Electron E2E 21/21、23.7s 通过并同时覆盖 Multi-agent、自进化确认和 Provider 失败 Plan 终态。正常用户数据中的旧 Memory Review `d810d20c-6bfc-49b6-b0b6-3d7ab72fdb40` 真实重试后从 failed 变为 completed，因来源 Run 已直接保存长期记忆而正确生成 0 个重复候选。真实 Skill Run `46b92cc1-9cb1-44ca-99d1-8f3abc74132d` 越过原 Provider 失败点并完成；异步 Review `5fc8012a-de42-4865-9f70-ca7b696669c5` 生成一个 `new_skill` 草稿，用户确认后的 replay passed，`user:charamate-quick-delivery-check` r1 已激活并在 Settings → Skills 可见。
- 这次真实 Skill Run 按 Agent 设置在主 worktree 执行：`check:fast` 成功，`test:focused` 失败。单独复核确认主 worktree 当前缺少本地 `vitest` 可执行文件，而开发 Electron 继承了启动 worktree 的 PATH，导致命令误用另一 worktree 的 Vitest 与不匹配的 matcher 环境；68 项组件失败不作为产品回归或自进化失败证据。该本地多 worktree 依赖边界应通过恢复主 worktree 的锁定依赖后另行处理。
- 2026-08-13 `P5-EVOLUTION`：`npm run verify:offline` 19.5s 通过（contract 90、focused/component 278、integration 143，共 511 项；仅 2 条既有 TanStack Virtual lint warning）；`npm run test:e2e` 28.8s、19/19 通过（Playwright 17.2s）并包含 production build，其中新增真实确认前/后旅程；macOS arm64 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run package` 16.2s 与 `npm run smoke:package` 3.7s 通过，Electron ZIP SHA-256 与官方清单一致。默认 GitHub checksum 请求在当前代理上多次 `ECONNRESET`，未关闭 checksum 校验。Live 模型实验及 replay 确认层结果单独记录在 `docs/benchmarks/self-evolution.md`。
- 2026-08-13 `P5-MULTI-AGENT`：初始完整验收、macOS arm64 package 与 packaged smoke 已通过；真实 Provider 后续暴露三层兼容边界：保留 namespace、namespaced `allowed_tools` 不受支持、wire Tool 引用进入结构化参数。最终实现统一 `charamate_` namespace wire 前缀、namespace continuation `auto`、Harness 已加载 Tool 校验和全部已知 Tool 引用的通用反向映射。最终 `npm run verify:offline` 23.7s 通过（contract 83、focused/component 275、integration 142，共 500 项；仅 2 条既有 TanStack Virtual lint warning），`npm run test:e2e` 19/19 通过并包含 production build。应用完整重启后，真实 Provider Run `a57c8778-c1ab-4ab5-8708-9dd06181db22` 59 秒、10 Item 正常完成；第一次 collaboration 即成功，两个 child 各自只读一个指定文件，父 Agent 输出中文对照表，无 Provider/协作失败。通用 `npm run test:live` 未运行。
- 2026-08-11 Automations + Territory Memory 合并验收：`npm run verify:offline` 21.4s 通过（contract 83、focused/component 267、integration 138，共 488 项；仅 2 条既有 TanStack Virtual lint warning）；`npm run test:e2e` 29.3s、18/18 通过并包含 production build；macOS arm64 `npm run package` 15.3s 与 `npm run smoke:package` 4.5s 通过。Live 未运行，因为本次合并没有远端端点要求。
- 2026-08-11 Automations 合并验收：`npm run verify:offline` 21.2s 通过（contract 83、focused/component 263、integration 135，共 481 项；仅 2 条既有 TanStack Virtual lint warning）；`npm run test:e2e` 29.2s、18/18 通过并包含 production build；macOS arm64 `npm run package` 15.3s 与 `npm run smoke:package` 4.7s 通过。Computer Use 直接操作本次 `.app`，确认 Reminder 创建/试跑/暂停/恢复/编辑/历史快照/重启恢复、Revision 2、页头和“提醒记录”语义；Live 未运行，因为本工作包没有远端端点要求。
- 2026-08-11 `P6-TERRITORY-MEMORY`：`npm run verify:offline` 20.3s 通过（contract 83、focused/component 247、integration 133，共 463 项）；`npm run build` 通过；Electron E2E 最终 16/16、16.6s 通过（首次完整运行只暴露 preload shape 期望未同步，更新契约回归后单项与全套复跑通过）；macOS arm64 `npm run package` 15.5s 与 `npm run smoke:package` 4.2s 通过。容量目标窗口一次性走查 1/1、9.9s 通过并已删除 runner/原图。
- 2026-08-11 `P5-AUTOMATIONS-CONTRACT`：`npm run verify:offline` 21.1s 通过（contract 83、focused/component 243、integration 130，共 456 项）；`npm run build` 12.3s 通过；`npm run test:e2e` 约 30.0s、16/16 通过；macOS arm64 `npm run package` 15.5s 与 `npm run smoke:package` 4.6s 通过。
- 2026-08-11 用户完成目标硬件人工验收，确认 Phase 4 Voice 连接复用、跨 Chat 归属、桌宠暂停/恢复和 Agent 主动挂断达到当前产品预期。
- 2026-08-11 Voice 入口归属与 Agent 挂断：`npm run verify:offline` 通过（contract 69、focused/component 239、integration 128，共 436 项）；`npm run build` 通过；Electron E2E 最终 16/16 通过（首次并发运行仅 Territory 场景附件等待超时，单项与完整套件立即复跑均通过）；macOS arm64 `npm run package` 与 `npm run smoke:package` 通过。
- 2026-08-11 Voice 连接生命周期优化：`npm run verify:offline` 通过（contract 69、focused/component 236、integration 127，共 432 项）；`npm run build` 通过；`npm run test:e2e` 16/16 通过；macOS arm64 `npm run package` 与 `npm run smoke:package` 通过。
- 2026-08-10 Plan checkpoint 修复：`npm run verify:offline` 通过（contract 69、focused/component 232、integration 123，共 424 项）；`npm run build` 通过。
- 主线 `aefac18`：`npm run verify:phase0` 通过；offline 382 项、Electron E2E 16/16、开发/打包 smoke 与 macOS arm64 package 通过。
- 当前 Voice 路径：`npm run verify:offline` 通过（contract 69、focused/component 230、integration 122，共 421 项）；`npm run test:e2e` 16/16 通过，其中桌宠声波入口的 hover 显示、点击后移开隐藏与不唤起主窗口已有桌面回归；build、macOS arm64 package、开发与打包 smoke 均通过。
- 使用正常用户数据、真实 Azure 凭据和完整生产 Tool Registry 的冷启动 `voice.start → voice.end` 通过；标题 Provider 凭据不可读的回归用例也确认不会再阻断 Realtime Session。
- 正常 Forge 进程中重新封装当前 Azure/本地 Chat 凭据后，普通无调试参数冷启动的实际 Voice 设置页完成音色试听，未再出现 `PROVIDER.STORAGE_FAILED`。
- 真人输入暴露的 Turn 指令生命周期错误已修复：说话期间时间或 Memory 上下文变化时，最终指令作为本 Turn 快照更新，不再被误判为 immutable identity；延迟转写回归已覆盖。
- 真人输入暴露的多输出 Item 错位已修复：同一 Voice Turn 按 Realtime `response_id/item_id/output_index` 维护唯一助手草稿，Chat、Run Item、Voice Dock 与最终转写共享同一聚合结果。
- 真人查询日志确认首次天气查询已经成功；后续受管页变成 `about:blank` 时，旧实现把空 snapshot 错标为成功，用户打断后的新 Turn 又被 Realtime 误述为“查询仍在加载”。当前空白/空内容 snapshot 会返回真实工具失败，Realtime 收到结果后不得声称旧调用仍在进行，并按入口能力重新导航或使用既有只读查询工具。
- 真人 Tool continuation 暴露的后半段静音已修复：工具前 response 与结果回注后的 response 共享一个 generation，旧实现收到前者的延迟停止事件时误停整个 generation。当前 WebRTC 播放开始、停止和清空均按 `response_id` 精确管理，旧 response 排空不会静音正在播放的新 response。
- `npm run test:live` 曾在目标 Azure `gpt-realtime-2.1` 上 Voice 3/3 通过。本次完整复测中原生回答与 Function Call 2/2 通过，中英混合样本首次误识别后单项立即复测通过；该项是远端识别波动，不能表述为每次稳定通过。未配置的 Territory Image Live 1 项按预期跳过。
- 旧 Shared Runtime 的 323 项 offline、9/9 E2E 与 2/2 Live 只作历史回归参考，不作为当前路径证据。

## 来源快照

- 2026-08-14 复核 OpenAI 官方 [Structured Outputs 支持的 Schema](https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas) 与锁定 `openai@6.49.0`：strict Function Tool 仅支持 JSON Schema 子集，字符串长度、`pattern`、`format` 与数值范围等约束不在该子集内。CharaMate 据此只决定 Provider wire 的 strict 资格，不删改领域 Schema，也不绕过 Tool Registry 的 TypeBox/Ajv 输入校验。
- 2026-08-14 复核锁定 `electron@43.2.0` 包内官方类型 `electron.d.ts`：`BrowserWindow` 支持独立 `setBounds`、`loadFile(..., { query })`、`focusable` 与 `acceptFirstMouse`。当前桌宠 panel 始终不可聚焦，主动对话存在时才创建可聚焦的跟随 panel，并在关闭投影时销毁；双窗口、上/下方翻转与工作区内约束是 CharaMate 产品启发式，不是 Electron 协议限制。
- 2026-08-13 复核 Chronicle 官方说明（页面未标独立版本）：其 Activity context 只作为“前台活动事实可成为后续对话上下文”的参考；何时沉默、发起普通对话、路由既有 Journey，以及何时在用户确认后创建长期同行，均是 CharaMate 产品语义，不继承为协议约束或固定触发规则。
- 2026-08-13 复核锁定 `openai@6.49.0` 的官方 Responses 类型：`text.format` 的 `json_schema` 启用 Structured Outputs，`strict: true` 要求输出遵循所给 Schema；Reviewer/replay 仍在应用持久化边界做 TypeBox/Ajv 校验。
- 2026-08-13 复核 Hermes Agent `main` commit `a871948d8d4b0f774d4ec40467bab1078a9f28d5`、`background_review.py` commit `35cbad5854155de5541adbe4578008269d60c5af`、`curator.py` commit `bc3fa54f5748fd6c735ad6ced8bacebb752ce3e6` 与 Agent Skills specification commit `217be548739f21d6008915c29aefe320ea1a90af`；Hermes 的后台派生 Agent、直接写、16 iterations 和 7/30/90 天只是当前源码行为，不是 CharaMate 协议限制。
- 2026-08-13 复核 Codex subagents 官方手册（页面未标独立版本）与 Codex 公开源码 commit `95aada11c4150e4ba28d6279c50f0995c1d93e5a`（提交时间 `2026-08-12T15:31:47Z`）：推荐边界清楚、读多写少的协作任务并明确 child Token/冲突成本；v2 spawn、共享 session registry 与 mailbox/event-driven wait 是当前参考实现行为。其 session slot 默认值不是公开协议限制，CharaMate 的两个 child、资源门与阈值均为本 Decision 的启发式。
- 2026-08-13 真实 Provider 验收：目标 Responses 端点先明确拒绝保留 namespace `collaboration`；统一 `charamate_` 前缀后，最小复现确认下一处真实错误是 `Unknown parameter: 'tool_choice.tools[0].namespace'`，不是此前根据归一化日志推测的 bare `file` 保留词。该端点对 namespaced Tool 的 `allowed_tools` 三种引用形状均拒绝，而 `tool_choice: "auto"` HTTP 200。随后实机暴露结构化参数中的 `charamate_file.read` wire 引用泄漏；最终 Adapter 通用反向映射全部已知 Tool 引用，Harness 保留 Tool Search 已加载范围校验。干净实机 Run `a57c8778-c1ab-4ab5-8708-9dd06181db22` 59 秒、10 Item 正常完成，首次 collaboration 即成功，无 Provider/协作失败。
- 2026-08-11 `TERRITORY-CAPACITY` 以产品设计 §10.6、UI 设计 §11.1/§14 和锁定 Electron `43.2.0` 的 `1180×800` 默认/`900×640` 最小窗口为边界，比较 8/12/16 并冻结 12；该数值是 CharaMate 启发式，不是 Electron 或 PixiJS 协议限制。
- 2026-08-11 复核 Electron `powerMonitor` suspend/resume、Node.js v24 timers（计时器不承诺精确触发）、ECMA-402 时区解析、IANA TZDB 与 POSIX.1-2024 `crontab`；锁定运行时 Node `24.18.0`、ICU `78.3`、tz `2026b`，当日 IANA 最新发布为 `2026c`。同时复核并锁定 `cron-parser@5.6.2` tag/commit `750c9a26e8602aed8ece36ed2ce1b7fceb1e0b18`；协议事实与 CharaMate 的补跑、DST、并发策略分别记录。
- OpenAI Responses Compaction 文档于 2026-08-10 复核（页面未标独立版本）；Codex `main` commit `c9c6c0daa994109cec50fddcb57d076fdf9e738c` 的 Plan Tool、协议类型与远端压缩保留逻辑已检查。它们用于区分协议约束、当前参考实现与 CharaMate 自身不变量。
- OpenAI Realtime conversations 与 WebRTC 文档于 2026-08-09 复核：Realtime Session 是有状态 speech-to-speech conversation，支持 Function Call；WebRTC VAD 可中断活动 response 并自动截断未播放音频。
- 2026-08-11 再次复核 Azure GA WebRTC 指南 commit `ce66cc3b4f2a6be478aaa7ddedf9e2567fa638a5`、Azure GA client events commit `777f84fbedeb0995f4fdea6c65bee2f2a4af1657` 与 Azure Voice Live 指南 commit `0186eb438fa9be7a8e6d6988f74d90b3e9cdb21f`：会话内配置刷新与媒体连接生命周期分层；未来 Provider 是否热复用由适配器能力决定，不改变共享 Voice/Run 状态机。
- 2026-08-11 复核 official OpenAI documentation 的 GPT-Realtime model 与 Realtime server events：Realtime 支持 Function Calling；WebRTC/SIP 的 `output_audio_buffer.stopped` 表示输出缓冲已完全排空，并位于 `response.done` 之后。它是 Agent 告别后挂断的协议事件；“何时应结束通话”仍由 CharaMate Tool 描述和模型选择决定，不写死关键词。
- 锁定 `openai@6.49.0` tag commit `04671d278ef1531692ae31a870251eec90f3c2d2`；类型确认 `RealtimeFunctionTool`、`response.function_call_arguments.done`、`function_call_output`、`response.create`、输出音频转写的 `item_id/output_index` 与 Server VAD 当前字段。
- Azure WebRTC 指南 source commit `ce66cc3b4f2a6be478aaa7ddedf9e2567fa638a5`（updated `2026-07-31`）与 Azure Realtime 协议 commit `6462e3bdaa191c85756377a92350c4cdf6768346`（updated `2026-07-09`）；目标 deployment 为 `gpt-realtime-2.1`。
