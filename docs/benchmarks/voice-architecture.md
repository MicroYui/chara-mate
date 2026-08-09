# VOICE-ARCHITECTURE 决策记录

> Decision ID：`VOICE-ARCHITECTURE`
> 状态：实现验证中；2026-08-09 产品取舍修订为 `V2 Orchestrated Native Realtime`
> 原始实验日期：2026-08-08；最近修订：2026-08-09

## 当前决策

生产只保留一条 Realtime 原生语音路径：文字 Chat/Agent 继续使用 CharaMate `AgentRuntime`；Voice 由 Azure Realtime 的 speech-to-speech Agent 理解语音、决定 Function Call，并同时生成输出音频与输出转写。应用使用显式 `response.create` 管理 Run 身份、持久化和 Tool continuation，但不再让文字 Agent 先回答，也不再把文字切句交给 Realtime/TTS 朗读。

两个模型循环共用同一个产品能力边界：

- Chat 历史、核心行为 instructions、Persona/Voice instructions、Workspace Skill instructions 与相关 Memory evidence；
- 同一个客户端 Tool Registry，以及入口继承的 Chat/Agent 权限过滤和三档 Approval；
- 同一个 Chat、Run/Item、Approval、标题服务、事件流和持久化边界；
- 同一个 Tool executor。Realtime Function Call 的结构化结果以 `function_call_output` 回注并继续原 generation。

当前 Azure Realtime 没有文字 Responses Provider 的托管 `web_search`。该能力不属于客户端 Tool Registry，因此生产不会伪造本地 `web.search` 或把文字 Agent 暗中接回 Voice。既有 `browser.navigate + browser.snapshot` 作为幂等只读查询链在 Chat/Agent 两种入口均可调用；Agent 还可在现有审批模式内使用同一个 `command.run` 以只读 `curl` 查询公开 HTTP/API。点击、填写、下载及命令执行仍只在 Agent 入口按原审批规则开放，不新增 Voice 专用 curl 或搜索 Tool。

## 为什么再次修订

这是透明的产品取舍修订，不是把未运行的新 Arm 写成实验胜者。

2026-08-08 的 V1/V2 原始配对已经证明 Realtime 原生回答、显式 response 和 Function Call continuation 在目标 deployment 可用。随后为追求“Voice 与文字使用同一个模型/Harness”，生产一度改成 `Shared Runtime Voice`：文字 Agent 生成 Chat 文本，Realtime 只承担输入转写和分句朗读。

真人使用暴露了该链路的结构性体验代价：

- 必须等文字模型产出稳定句界后才能开始下一段语音，句间存在额外等待；
- Realtime 被要求“朗读”时仍可能与已经显示的文字不完全一致；
- 打断跨越文字 Run、句子队列和音频 response，出现过“正在思考”无法收口；
- 播放、文字和工具状态需要跨两个模型协调，修复不断增加状态而没有改善原生对话感。

用户因此明确选择恢复 Realtime 自己的语音 Agent，并接受文字和语音看起来像两个 Agent；新的硬要求是两者获得相同客户端 Tools、权限与产品上下文。当前选择优先原生连续对话、首音频、自然插话和更小状态机，接受 Voice 与文字模型能力并非完全相同，尤其 Azure Realtime 暂无托管网页搜索。

## 原始问题、Arms 与单一变量

固定 Azure resource、deployment `gpt-realtime-2.1`、WebRTC、音色 `verse`、同一中文输入与 instructions，只改变 VAD 后 response 的创建权：

| Arm | VAD 后谁创建 response | 回答模型 |
| --- | --- | --- |
| `V1 Native Realtime` | `create_response=true`，服务自动回答 | Realtime |
| `V2 Orchestrated Native Realtime` | `create_response=false`，应用持久化输入后显式创建 | Realtime |

`Shared Runtime Voice` 是后续产品修订：Realtime 输入转写 → 文字 Agent → Realtime 分句朗读。它没有与 V1/V2 做完整延迟配对，因此下方原始延迟不能被挪作其结果。

## 一手来源边界

2026-08-09 复核：

- [Microsoft Azure WebRTC 指南](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio-webrtc?view=foundry-classic)，source commit `ce66cc3b4f2a6be478aaa7ddedf9e2567fa638a5`，updated `2026-07-31`：GA 浏览器路径使用 `client_secrets`、`calls`、media channel 与 data channel。
- [Microsoft Azure Realtime 协议参考](https://learn.microsoft.com/en-us/rest/api/aifoundry/azureopenai/realtime)，source commit `6462e3bdaa191c85756377a92350c4cdf6768346`，updated `2026-07-09`：Session、Function Call、`call_id`、`function_call_output` 与后续 response 的当前合同。
- [OpenAI Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations)：Realtime Session 是有状态 speech-to-speech conversation，支持 Function Calling；WebRTC VAD 可中断活动 response 并自动截断未播放音频。
- 锁定 `openai@6.49.0`，tag commit `04671d278ef1531692ae31a870251eec90f3c2d2`：类型确认 `RealtimeFunctionTool`、`response.function_call_arguments.done`、`conversation.item.create`、`function_call_output`、`response.create` 与 `server_vad.create_response/interrupt_response`；输出音频转写事件携带必需的 `response_id/item_id/output_index`，一个 response 可包含多个有序输出 Item。
- [Azure OpenAI Web Search](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/web-search)，updated `2026-05-13`：托管 `web_search` 属于 Responses 能力；同日 Realtime 参考仍未提供等价的 Azure 托管搜索。

协议没有要求 CharaMate 采用 V1 或 V2。先创建可恢复 Run、Tool/Approval 正确性和旧 generation 不触发新回答是产品要求；`create_response=false` 是满足这些要求的最小编排。

## 原始输入、环境与结果

- 基线 commit：`d539dff367a5e8af544d6dcf28e1112e8311d63b`。
- Apple Silicon arm64，macOS `26.6.1` build `25G76`，Node `24.18.0`，Chromium/Playwright `1.62.0`。
- Azure OpenAI GA deployment `gpt-realtime-2.1`。
- 配对 WAV `3.303 s`，SHA-256 `8882e1347ea90894c594e40d525579d6fb828bf4de7fa1e20ec3a11096660258`。
- 输入清单 SHA-256：`1ec994997ff51eba6fac5ec19ecfad125ad988cc0154af0e9b7e65766dab231b`。

| 指标 | V1 | V2 |
| --- | ---: | ---: |
| 有效 Realtime turns | 3/3 | 3/3 |
| speech stop → response.created，ms | `1 / 3 / 10` | `228 / 235 / 241` |
| speech stop → first audio，ms | `673 / 705 / 727` | `836 / 840 / 942` |
| 输入转写完成 | 3/3 | 3/3 |
| remote audio + 输出转写 + response.done | 3/3 | 3/3 |

另一个真实合约回合收到 `response.function_call_arguments.done`；应用写入匹配的 `function_call_output` 并只创建一次 continuation，最终 `response.done=completed` 且存在远端音轨。该样本只证明目标 endpoint 的协议能力，不估计自然对话中的 Tool 成功率。

## 当前生产收口

1. `server_vad.create_response=false`、`interrupt_response=true`。完整非空输入转写先创建 Voice Run 和用户消息，再显式请求 Realtime 回答。
2. 每条用户话语拥有一个普通 Voice Run；自然插话中断旧 Run，下一条完整转写创建新 Run，语义与文字 Chat 的逐消息 Run 一致。
3. Realtime 输出转写是 Chat 助手消息的来源；同一 Turn 的多个 response/output Item 按 `response_id/item_id/output_index` 聚合到唯一一条持续更新的助手消息，音频与最终持久化文本使用同一聚合值。没有文字 Agent 输出、TTS、逐句队列或“忠实朗读”prompt。
4. Session 创建时注入当前入口允许的全部客户端 Tool。名称只做稳定 alias 映射；目标 Azure 实测不接受根级 `anyOf`，因此 Realtime 传输边界将对象联合投影为单一对象字段并集，但原 Tool Registry Schema 仍是调用参数校验的唯一权威，executor、Approval 和 Tool Result 也仍由其拥有。
5. Tool Result 回注后显式创建下一 response。一次只允许一个待执行/待审批调用；并发取舍见 `VOICE-TOOL-JOIN`。
6. 既有完整 Chat 历史在连接或重连时按原角色写入 Realtime conversation。每回合额外注入当前 Skill instructions 和相关 Memory evidence。
7. 标题仍复用 `ChatTitleService`：“语音对话” → 首转写兜底 → 首轮完成后的文字 Chat Provider 摘要。标题模型按需惰性创建，不参与 Voice 回答；其凭据或请求失败只保留当前兜底标题，不能阻断 Realtime 启动或回合。
8. Browser snapshot 只有非空、非 `about:blank` 的当前页才算成功。2026-08-09 真人日志中，首次天气查询已从 Bing snapshot 获得结果；后续空白页被旧实现误标成功，用户打断后的下一 Turn 又被模型误述为“查询仍在加载”。生产现已把空白/空内容作为真实 Tool Error，并明确要求收到 Tool Result 或打断后不得把旧调用描述为仍在运行。
9. 工具前 response 与 Tool Result continuation 共享同一个 Voice generation，但保留各自独立的协议 `response_id`。2026-08-09 真人天气查询中，工具和后续文本均成功，旧播放器却在工具前 response 延迟排空时把同 generation 的 continuation 一并标成停止，造成只听到前半段。生产现按 `response_id` 精确管理音频开始、停止和清空；旧 response 的停止事件只清理自身，不再静音当前 response。

## 当前验证与待补证据

截至本次文档更新，确定性回归覆盖原生回答、权限过滤、Function Call 回注、写 Tool Approval、自然插话、多输出 Item 顺序聚合、Tool continuation 的 response 级音频收口、Chat/Run/Item 投影、标题复用、标题凭据失败隔离、对象联合 Tool Schema 投影、历史注入、空白 Browser snapshot 失败和播放失败上报。`npm run verify:offline` 共 `421/421` 通过（contract 69、focused/component 230、integration 122）；Electron E2E `16/16`、build、macOS arm64 package、开发与打包 smoke 均通过。目标 Azure Live 曾以生产 issuer 完整 `3/3` 通过；本次复测中原生回答与 Function Call 2/2 通过，中英混合样本首次把英文专名误识别为另一英文短语，单项立即复测通过，因此只证明链路可用，不能证明混合语言识别逐次稳定。另以正常用户数据、真实凭据和完整生产 Tool Registry 冷启动 `voice.start → voice.end` 成功。真人麦克风、扬声器、自然插话和审批气泡仍需用户在目标硬件体验确认。旧 Shared Runtime 的 `323` 项 offline、`9/9` E2E 与 `2/2` Live 不能充当新路径结果。

## 限制、复杂度与删除证明

- 原始配对每 Arm 只有 3 个合成音频回合，不能外推 p95、自然度、复杂网络或真人打断。
- 当前选择是用户在实际体验后的产品 amendment，不声称 V2 在新的完整配对上统计显著优于 Shared Runtime。
- Azure Realtime 与文字 Responses 模型可能在能力、计划习惯和回答质量上不同；共享 Tool/Context 不能消除 Provider 自身差异。
- 2026-08-09 目标 Azure 对根级 `anyOf` 返回 `invalid_function_parameters`，并要求 Function Tool 参数根为不含 `oneOf`/`anyOf`/`allOf` 的 `object`；这是目标部署实测而非 OpenAI Realtime 的通用硬限制。生产投影只覆盖对象联合，无法无损表达的顶层 Schema 会在启动时显示不支持，不添加第二套 Schema 或宽松执行路径。
- 生产已删除 `RealtimeSpeechOutput`、句子扫描/排队、`speech.create`、`startWithRuntime`、`resumeVoiceWithRuntime` 和 Shared Runtime Voice 测试。不保留 TTS fallback、架构开关、第二 Tool Registry、`ToolJoinGroup` 或实验 runner。
