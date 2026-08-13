# CharaMate 当前状态

> 更新日期：2026-08-13

## 当前里程碑

**Phase 5 — implementing（Automations 与 Multi-agent 已完成；Territory Memory 并行工作包完成）**

Phase 0–4 已完成；结构化输入、图片输入、Agent、Memory、Context、Activity 与 Realtime Voice 均为单一生产路径。Phase 5 Automations Contract/Core/UI 已在 `main` 汇合；`P5-MULTI-AGENT` 已在独立 worktree 完成 source-first Decision Gate、真实模型实验、中文 Decision Record 与单一路径生产重写。Multi-agent 现在是 Agent 自主按需调用的两个只读 child 能力，不是 Composer/Settings 模式。Phase 6 Pet、Territory Base、结构化 Item Manifest、Azure Image 与 Territory Memory 也已完成。Phase 5 仍为 implementing，因为主动聊天与 Decision-gated 的 Evolution 是独立后续工作包。

当前工作包退出条件：

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
- [x] `MULTI-AGENT` 保留机械 no-winner 结果并透明记录产品修订；生产仅保留 `D2 + M2R` 的 Agent 自主、两 child、只读、资源互斥路径，无 Composer 开关、候选 Arm 或第二套 Harness。
- [x] Multi-agent 的资源门、并发、父 Join、取消/失败、持久化、观测、Chat 隔离与桌面旅程通过 offline、build、19/19 E2E、Forge package 和 packaged smoke。

## 工作包状态

| 工作包 | Owner | 状态 | 结果 |
| --- | --- | --- | --- |
| `P3-RUNTIME-MEMORY-ACTIVITY` | `main` | `done` | Chat/Agent、结构化输入、Memory/Context/Activity 单一路径完成 |
| `P2-RUNTIME-PLAN-CHECKPOINT` | `main` | `done` | Plan RunItem 保持历史/UI 真源，checkpoint 保存并恢复编译快照；普通 Tool、旧 checkpoint、重启与压缩回归完成 |
| `P6-PET-TERRITORY-IMAGE` | `main` | `done` | 桌宠、领地、Azure Image、候选确认与内建 Tool 完成 |
| `P6-TERRITORY-MEMORY` | `main` | `done` | Memory/Activity candidate、来源追溯、12 件容量回收、版本与 pin 完成 |
| `P5-AUTOMATIONS-CONTRACT` | `main` | `done` | Automations JSON Schema、Schema v9/迁移、完成事件与 typed IPC/Preload 已冻结；456 项 offline、16/16 E2E 与 package/smoke 通过 |
| `P5-AUTOMATIONS-CORE` | `main` | `done` | 唯一 schedule 计算、休眠恢复、Repository/Service、Reminder 投递记录、Agent Task 普通 Chat Run、事件发布与 Main IPC 注册完成；独立验证 474 项 offline、17/17 E2E 与 package/smoke 通过 |
| `P5-AUTOMATIONS-UI` | `main` | `done` | 卡片、四类计划表单、Reminder/Agent Task、暂停/恢复、编辑、试跑、运行历史与 Agent Task Chat Run 跳转完成；只消费 typed Preload，未修改 shared Schema、DB 或 Main Core |
| `P5-MULTI-AGENT` | `codex/multi-agent-decision-gate` | `done` | `CHM-MULTI-AGENT-20260813-W1` 机械 Gate 为 no-winner；按仓库所有者透明修订，以 `D2 + M2R` 落地 Agent 自主按需调用的两个只读 child 能力，失败候选与实验代码已删除 |
| `P4-SOURCE-CONTRACT` | `main` | `done` | Realtime conversation、WebRTC interruption、Function Call 与锁定 SDK 类型已复核 |
| `P4-VOICE-DECISIONS` | `main` | `done` | 透明修订为 Orchestrated Native Realtime；WebRTC + 串行 continuation |
| `P4-VOICE-RUNTIME` | `main` | `done` | 原生 response、共享 Tool/Approval、Run/Item、打断、历史与非阻塞标题完成 |
| `P4-VOICE-UI` | `main` | `done` | Voice Dock、设置、Composer 继承入口、桌宠完全访问声波入口与 Approval 气泡完成 |
| `P4-VOICE-LANGUAGE` | `main` | `done` | `whisper-1 + 关键词 prompt + 不固定 language` 单一路径；Azure Live 通过 |
| `P4-VOICE-CONNECTION-LIFECYCLE` | `main` | `done` | 暂停/恢复连接复用、配置变化或适配器不支持热刷新时冷重连、启动并行化与分阶段连接耗时完成并通过真人验收 |
| `P4-VOICE-ENTRY-HANGUP` | `main` | `done` | 桌宠与主窗口共享同一 Voice Chat 的暂停/恢复控制；Agent 明确告别后通过 Tool 在音频排空时主动挂断；真人验收通过 |

### 最近完成边界

- 结果：Agent 模式始终可见 `collaboration.dispatch`，由父 Agent 判断是否值得调用；一次固定两个资源互斥的只读 child，并发完成后由同一父 Run Join。Chat 保持单 Agent，正常 UI 没有 Multi-agent 开关或参数。
- 范围：Agent-owned Tool、现有 Harness/Provider/Tool Registry/Run checkpoint、一个 `subtask` Item、SQLite greenfield 当前 Schema CHECK、RunProcess 与本地观测；无新 IPC、Preload、表、进程、依赖或新的 Provider Adapter。既有 OpenAI Responses Adapter 在 wire 边界把所有 client namespace `x` 统一映射为 `charamate_x`，并通用反向映射结构化参数中的已知 Tool 引用；namespace Tool continuation 使用 `auto`，Harness 依据 Tool Search 已加载集合做最终执行校验。
- 非目标：不支持 child 写入、审批、Browser/Computer 可变会话、递归派生、四 child、动态团队规模、运行时 Arm、fallback chain 或实验设置。
- 依赖与合同：父 Agent 提议目标、资源 claim 与确切读取；宿主只验证当前 Run Tool scope、`read + idempotent`、资源互斥和 bounded input。两个 child 不继承父对话且不获得 Tool/web search；父取消信号和既有 Tool 恢复边界贯穿整次调用。
- 验收：资源重叠/越界/副作用拒绝、真实并发、父 Join、部分失败证据、父取消、Agent/Chat 隔离、Subtask 持久化与折叠、nested usage、真实本地文件桌面旅程均有确定性回归。
- Decision：Dispatch 的 `D2` 在 selection + untouched holdout 为 72/72；Execution 的 M0/M2S/M2R 质量均 18/18，但 M2R p95 慢于 M0 且 Token 增加约 39.77%，机械结论为 no-winner。仓库所有者结果后选择将 `D2 + M2R` 作为 Agent 按需能力，完整证据与限制见 `docs/benchmarks/multi-agent.md`。

## 依赖与已知边界

- Automations 与 Multi-agent 已完成且都没有第二条 fallback 路径；主动聊天与 Evolution 仍按各自依赖和 Decision Gate 推进，因此不把整个 Phase 5 标为完成。
- `MULTI-AGENT` 的机械 Execution Gate 没有证明平均质量或时延净收益；当前能力存在是透明的结果后产品修订。生产入口只覆盖两个只读、资源互斥 child，真实开放任务的选择质量仍需从开发观测复核，不能表述为通用并行加速。
- `TERRITORY-CAPACITY` 是一个场景、合成 `96×96` 物件的结构化目标窗口走查，不是多人偏好研究；真实证据若要求改变容量，需替换唯一常量和 Decision，不增加容量档位。
- Territory 保存来源内容、日期和 Memory revision ID 的历史快照；如果原 Memory 后续删除，“在 Memory 中查看”可能找不到活动记录，但 Territory 物件和快照仍保留，且不会成为新的 Memory 事实源。
- Azure Realtime 当前没有 Responses Provider 托管的 `web_search`；它获得同一个客户端 Tool Registry，但不伪造本地 `web.search`。Chat/Agent 入口均可使用既有 `browser.navigate + browser.snapshot` 幂等查询链；Agent 还可按当前审批模式使用既有 `command.run` 以只读 `curl` 查询公开 HTTP/API。空白页或空内容不再伪装成成功 snapshot，其他 Browser/命令操作仍遵循入口权限与审批。
- 目标 Azure `gpt-realtime-2.1` 于 2026-08-09 实测拒绝 Function Tool 根级 `anyOf`。Voice 仅在 Realtime 传输边界把对象联合投影为单一对象字段并集，实际调用仍由原 Tool Registry Schema 校验；这不是通用协议限制。

## 最近绿色验证

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
