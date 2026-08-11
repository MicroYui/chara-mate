# CharaMate 当前状态

> 更新日期：2026-08-11

## 当前里程碑

**Phase 4 — done（Realtime 原生语音 Agent）**

Phase 0–4 已完成；结构化输入、图片输入、Agent、Memory、Context、Activity 与 Realtime Voice 均为单一生产路径。Phase 6 Pet、Territory、结构化 Item Manifest 与 Azure Image 工作包也已完成。Voice 由 Azure Realtime 原生 speech-to-speech Agent 回答，同时复用客户端 Tool Registry、入口权限、Approval、Skill/Memory/Chat Context、Run/Item、标题和持久化边界；连接复用、跨 Chat 归属、桌宠暂停/恢复与 Agent 主动挂断已于 2026-08-11 经用户验收。

退出条件：

- [x] `VOICE-ARCHITECTURE`、`VOICE-TRANSPORT` 与 `VOICE-TOOL-JOIN` 记录最新产品选择、一手来源、实验边界与旧路径删除证明。
- [x] Azure GA WebRTC 以显式 response 完成原生回答、Function Call continuation 和中英混合输入 Live，文字 Agent 不参与 Voice 回答。
- [x] Realtime 获得入口允许的同一客户端 Tools，并沿现有 execution/Approval/Run Item 边界执行和回注 `function_call_output`。
- [x] Voice 输入、输出转写、Tool/Approval 和标题进入现有 Chat/Run/Item；旧 `RealtimeSpeechOutput`、句子队列、TTS 与双回答链已删除。
- [x] 最新 main 上的 focused、integration、完整 offline、build、Electron E2E、package/smoke 全绿。
- [x] 目标硬件完成真人麦克风、扬声器、自然插话和审批气泡人工验收，并带 Azure 配置启动供体验。

## 工作包状态

| 工作包 | Owner | 状态 | 结果 |
| --- | --- | --- | --- |
| `P3-RUNTIME-MEMORY-ACTIVITY` | `main` | `done` | Chat/Agent、结构化输入、Memory/Context/Activity 单一路径完成 |
| `P2-RUNTIME-PLAN-CHECKPOINT` | `main` | `done` | Plan RunItem 保持历史/UI 真源，checkpoint 保存并恢复编译快照；普通 Tool、旧 checkpoint、重启与压缩回归完成 |
| `P6-PET-TERRITORY-IMAGE` | `main` | `done` | 桌宠、领地、Azure Image、候选确认与内建 Tool 完成 |
| `P4-SOURCE-CONTRACT` | `main` | `done` | Realtime conversation、WebRTC interruption、Function Call 与锁定 SDK 类型已复核 |
| `P4-VOICE-DECISIONS` | `main` | `done` | 透明修订为 Orchestrated Native Realtime；WebRTC + 串行 continuation |
| `P4-VOICE-RUNTIME` | `main` | `done` | 原生 response、共享 Tool/Approval、Run/Item、打断、历史与非阻塞标题完成 |
| `P4-VOICE-UI` | `main` | `done` | Voice Dock、设置、Composer 继承入口、桌宠完全访问声波入口与 Approval 气泡完成 |
| `P4-VOICE-LANGUAGE` | `main` | `done` | `whisper-1 + 关键词 prompt + 不固定 language` 单一路径；Azure Live 通过 |
| `P4-VOICE-CONNECTION-LIFECYCLE` | `main` | `done` | 暂停/恢复连接复用、配置变化或适配器不支持热刷新时冷重连、启动并行化与分阶段连接耗时完成并通过真人验收 |
| `P4-VOICE-ENTRY-HANGUP` | `main` | `done` | 桌宠与主窗口共享同一 Voice Chat 的暂停/恢复控制；Agent 明确告别后通过 Tool 在音频排空时主动挂断；真人验收通过 |

### 最近完成边界

- 结果：一个活动 VoiceSession 始终绑定一个 Voice Chat；Voice Dock 与桌宠共享开始、暂停和恢复控制，主窗口浏览其他 Chat 或关闭窗口不迁移、不误断该连接；Agent 可在用户明确结束通话时调用 `voice.end`，说完简短告别并等远端音频排空后断开。
- 范围：Voice Tool、Main 会话生命周期、桌宠按钮、主窗口保活与 Chat 导航、产品/UI/Decision/进度文档及对应测试。
- 非目标：不跨 Chat 热迁移 Realtime conversation，不新增连接池、后台 TTL、关键词硬编码挂断或 GPT Live/Voice Live Provider。
- 依赖与合同：消费既有 VoiceSession、Tool Registry、Function Call continuation、`response.done` 与 WebRTC `output_audio_buffer.stopped`；不改变普通 Chat/Run 状态机。
- 验收：桌宠首次点击新建 Voice Chat，活动时点击暂停、暂停时点击原连接恢复；选择 Chat B 后 Voice 仍属于 Chat A，活动语音期间关闭主窗口仅隐藏以保留连接；`voice.end` 无审批且仅接受当前 Voice Run，请求后继续一次简短告别并在音频排空后完成 Session/Run/Item。
- Decision：无新候选 Arm；沿用 `VOICE-TRANSPORT` 与 `VOICE-TOOL-JOIN`，补充入口归属与事件驱动挂断策略。生产完成后没有候选代码可删除。

## 依赖与已知边界

- Azure Realtime 当前没有 Responses Provider 托管的 `web_search`；它获得同一个客户端 Tool Registry，但不伪造本地 `web.search`。Chat/Agent 入口均可使用既有 `browser.navigate + browser.snapshot` 幂等查询链；Agent 还可按当前审批模式使用既有 `command.run` 以只读 `curl` 查询公开 HTTP/API。空白页或空内容不再伪装成成功 snapshot，其他 Browser/命令操作仍遵循入口权限与审批。
- 目标 Azure `gpt-realtime-2.1` 于 2026-08-09 实测拒绝 Function Tool 根级 `anyOf`。Voice 仅在 Realtime 传输边界把对象联合投影为单一对象字段并集，实际调用仍由原 Tool Registry Schema 校验；这不是通用协议限制。

## 最近绿色验证

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

- OpenAI Responses Compaction 文档于 2026-08-10 复核（页面未标独立版本）；Codex `main` commit `c9c6c0daa994109cec50fddcb57d076fdf9e738c` 的 Plan Tool、协议类型与远端压缩保留逻辑已检查。它们用于区分协议约束、当前参考实现与 CharaMate 自身不变量。
- OpenAI Realtime conversations 与 WebRTC 文档于 2026-08-09 复核：Realtime Session 是有状态 speech-to-speech conversation，支持 Function Call；WebRTC VAD 可中断活动 response 并自动截断未播放音频。
- 2026-08-11 再次复核 Azure GA WebRTC 指南 commit `ce66cc3b4f2a6be478aaa7ddedf9e2567fa638a5`、Azure GA client events commit `777f84fbedeb0995f4fdea6c65bee2f2a4af1657` 与 Azure Voice Live 指南 commit `0186eb438fa9be7a8e6d6988f74d90b3e9cdb21f`：会话内配置刷新与媒体连接生命周期分层；未来 Provider 是否热复用由适配器能力决定，不改变共享 Voice/Run 状态机。
- 2026-08-11 复核 official OpenAI documentation 的 GPT-Realtime model 与 Realtime server events：Realtime 支持 Function Calling；WebRTC/SIP 的 `output_audio_buffer.stopped` 表示输出缓冲已完全排空，并位于 `response.done` 之后。它是 Agent 告别后挂断的协议事件；“何时应结束通话”仍由 CharaMate Tool 描述和模型选择决定，不写死关键词。
- 锁定 `openai@6.49.0` tag commit `04671d278ef1531692ae31a870251eec90f3c2d2`；类型确认 `RealtimeFunctionTool`、`response.function_call_arguments.done`、`function_call_output`、`response.create`、输出音频转写的 `item_id/output_index` 与 Server VAD 当前字段。
- Azure WebRTC 指南 source commit `ce66cc3b4f2a6be478aaa7ddedf9e2567fa638a5`（updated `2026-07-31`）与 Azure Realtime 协议 commit `6462e3bdaa191c85756377a92350c4cdf6768346`（updated `2026-07-09`）；目标 deployment 为 `gpt-realtime-2.1`。
