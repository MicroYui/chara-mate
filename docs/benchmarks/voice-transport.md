# VOICE-TRANSPORT 决策记录

> Decision ID：`VOICE-TRANSPORT`
> 状态：完成；选择 `W1 Azure GA WebRTC`
> 决策日期：2026-08-08

## 当前决策

生产媒体路径只实现 Azure GA WebRTC：Main 用已保存的 Provider 凭据向 `POST /openai/v1/realtime/client_secrets` 申请短期 client secret，Renderer 用 `RTCPeerConnection` 把麦克风和远端音频放在 media channel，把协议事件放在 data channel，并把 SDP offer 发往 `POST /openai/v1/realtime/calls`。

不保留 Direct WebSocket 音频 Driver、自动 fallback 或用户 Transport 选择。既有 Provider WebSocket 握手只承担“配置是否可连接”的 Provider 测试，不是 Voice 媒体实现。

## 选择协议

研究设计预先规定：先对 Microsoft 推荐的客户端路径 `W1` 做目标 deployment Contract Test；只有 W1 不支持或不能完成必要体验时，才实现 W0 的完整配对。W1 已通过 client secret、SDP、data channel、remote audio、VAD、输入转写、原生输出与 Function Call continuation，所以没有为对称比较额外造一套 WebSocket 音频采集、编码、缓冲和播放实现。`VOICE-ARCHITECTURE` 于 2026-08-09 修订后，生产 Realtime 直接决定 Function Call，Main 沿共享 Tool/Approval 边界执行并回注结果。

这不是“WebRTC 普遍优于 WebSocket”的主张。本决策只覆盖 CharaMate 的 Electron 客户端和当前 Azure deployment。

## 一手来源边界

查阅日期为 2026-08-08：

- [Azure WebRTC 指南](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio-webrtc?view=foundry-classic)，commit `ce66cc3b4f2a6be478aaa7ddedf9e2567fa638a5`：Microsoft 推荐浏览器/移动实时音频使用 WebRTC；GA 路径不使用 date-based `api-version`。
- [Azure WebSocket 指南](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio-websockets)，commit `1c7e2aa1afb5d81e65a3c0424b513b5a9e4698cd`，updated `2026-07-19`：WebSocket 面向 server-to-server，并由应用自行处理音频编码、分帧、缓冲和播放。
- [Azure Realtime 协议参考](https://learn.microsoft.com/en-us/rest/api/aifoundry/azureopenai/realtime)，commit `6462e3bdaa191c85756377a92350c4cdf6768346`。
- 2026-08-09 追加复核 [Azure GA Realtime client events reference](https://learn.microsoft.com/en-us/azure/foundry-classic/openai/realtime-audio-reference-ga)，source commit `777f84fbedeb0995f4fdea6c65bee2f2a4af1657`（updated `2026-06-05`）：`audio_end_ms` 超过实际音频长度会返回错误，客户端事件支持 `event_id`。目标 deployment 的最小 Contract Probe 实际返回 `code=invalid_value`、`error.event_id=null`、`param=null`；另实测完成后的 cancel 返回 `response_cancel_not_active`。生产仍发送唯一事件 ID并优先精确关联；仅在本地打断已生效且确有待确认 truncate 时收口这两个结构化结果，确认后移除待处理项。实现不匹配错误文案、不引入固定时长补偿，也不吞掉没有待处理 truncate 的同码错误。
- `openai@6.49.0` commit `04671d278ef1531692ae31a870251eec90f3c2d2` 用于核对事件和 session 字段；生产 WebRTC 使用浏览器原生 API，不把 SDK 的 WebSocket helper 当媒体 Driver。

端点、鉴权和事件名是协议事实；任何连接/首音频毫秒数只是本次目标环境观测，不是协议保证或产品常量。

## Contract Test 与复现标识

- 基线和环境同 `VOICE-ARCHITECTURE`。
- Contract 输入清单 SHA-256：`b06098a44fb03d280c6f36bad84dc6ff2736b478b3158ead4b27cd79a5ab7973`。
- 同一配对音频 SHA-256：`8882e1347ea90894c594e40d525579d6fb828bf4de7fa1e20ec3a11096660258`。
- Provider 配置中的 `gpt-realtime-2.1` 创建 client secret 返回 HTTP 200；产品设计旧 URI 中的 `gpt-realtime-2.1-2` 返回 HTTP 400 `OpperationNotSupported`，因此生产和设计统一为已实测 deployment 名。
- 输入转写在目标 resource 上使用 deployment `whisper-1` 成功；`gpt-4o-mini-transcribe`、`gpt-4o-transcribe` 与 `gpt-realtime-whisper` 返回 `DeploymentNotFound`。这是目标 resource 的当前部署行为，不是 Azure 全局限制。

## 结果

| 合约能力 | 结果 |
| --- | --- |
| ephemeral client secret | 通过；返回有效 session、过期时间和短期 value |
| SDP offer/answer | 通过；`calls` 返回 answer 并建立 peer connection |
| media/data channel | 通过；remote audio track 存在，收到 `session.created` |
| VAD + 手动 turn | 通过；收到 speech started/stopped，显式 response 生效 |
| 输入转写 | `whisper-1` 6/6 完成；固定音频文本一致，仅简繁体/标点差异 |
| 输出音频与转写 | 6/6 收到 first-audio、transcript done 和 response done |
| Function Call | 历史协议 Probe 与当前生产 issuer Live 均通过；Tool Result 后原生续答 |

三个 V1 和三个 V2 回合的 speech end → first audio 分别为 `673–727 ms` 与 `836–942 ms`；差异包含 turn-control Arm，不把合并数伪装成 Transport 对照。首次完整 tool Contract 回合从连接计时到 data-channel 首事件约 `4.22 s`，Function Call arguments done 约 `5.61 s`；这些只用于定位当前目标环境。

## 2026-08-09 多语言转写提示补充实验

### 问题与来源

用户需要在同一会话自然说普通话、英文或混合语言，普通话应落为简体中文，英文不应被翻译成韩文或中文。目标 resource 当前只有 `whisper-1` 能完成真实输入转写，因此本实验只比较该 deployment 的两种 `prompt` 写法，不把不可用模型伪装成候选结果。

2026-08-09 查阅的一手来源：

- [OpenAI Realtime 输入转写完成事件](https://platform.openai.com/docs/api-reference/realtime-server-events/conversation/item/input_audio_transcription/completed)：`whisper-1` 的 prompt 应使用与音频相关的关键词列表，而不是通用指令句。
- [OpenAI Whisper 模型页](https://developers.openai.com/api/docs/models/whisper-1)：该模型支持多语言语音识别、翻译和语言识别；本产品只使用识别，不请求翻译。
- [Azure Realtime Audio 指南](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio)：输入转写可设置模型、语言与 prompt；固定语言有助于已知单语输入，但会破坏本产品的自然语言切换，因此生产不发送 `language`。

协议事实是字段语义和目标 resource 的 deployment 可用性；“普通话使用简体中文”是产品要求，关键词内容是本次配对实验选出的单一路径。

### 环境、输入与 Arms

- 环境：Apple Silicon arm64，macOS `26.6.1` build `25G76`，Node `24.18.0`，Playwright/Chromium `1.62.0`，Azure GA WebRTC，Realtime deployment `gpt-realtime-2.1`，转写 deployment `whisper-1`。
- 三段配对合成音频分别覆盖普通话、英文、普通话与英文产品词混合；完整文件 SHA-256 依次为 `f8031979ea85231cd00407620c71fb72de44ee8fcfb77dc63cfb7e1cc0d96ae9`、`3df34b1758c6b5d6c0bbbfcdec227a3eff0ef66773de2780f129560272bc7556`、`581995558e4cc1ddceec7db1f7d65e5d3d5df97a99188fe727529cda39458e07`。
- 输入清单 SHA-256：`bf36b42acd872d8411e76b756c944f547bff9d4249f125ebb3d1d5ed80bc7864`。两 Arm 使用相同完整音频和 WebRTC 路径。
- `A 指令句`：要求逐字转写、保持英文、中文使用简体且不要翻译。
- `B 关键词表`：`简体中文, English, CharaMate, Chat, Agent, Settings, Voice, Model, Provider, Realtime, Azure OpenAI`。

### 配对结果

| 输入 | A 指令句 | B 关键词表 |
| --- | --- | --- |
| 普通话 | `請告訴我海淀區未來一週的天氣,今天準備開始工作。` | `请告诉我海淀区未来一周的天气,今天准备开始工作。` |
| 英文 | `Please tell me the weather in Haitian district next week.` | `Please tell me the weather in Haitian district next week.` |
| 中英混合 | `請打開Chairmate Settings,然後檢查Voice Model。` | `先打开CharaMate Settings,然后检查Voice Model。` |

两 Arm 都在 `3/3` 样本中保留了主要语言，没有把英文翻译成其他语言；含中文的 `2` 个样本中，A 的简体命中为 `0/2`，B 为 `2/2`。B 同时保留了混合样本中的 `CharaMate` 与 `Settings`。两 Arm 都把英文地名 Haidian 识别成 Haitian，说明本实验不能声称解决所有专名识别。

### 选择与生产收口

选择 `B 关键词表`。生产只保留 `whisper-1 + 关键词 prompt + 不固定 language`：没有运行时 Arm、模型 fallback、语言选择器、繁简转换、韩文检测或转写后正则修补。2026-08-09 修订后的 `npm run test:live` 用生产 issuer 在约 `24 s` 内通过 Voice `3/3`：无 Tool 的 Realtime 原生回答完成并同时收到远端音轨和输出转写；真实 Function Call 恰好调用一次，Main 回注 `function_call_output` 后第二个 response 完成并说出结果；中英混合假麦克风输入完成 VAD 与转写，保留简体中文、`CharaMate` 和 `Settings`，未出现样本检查的繁体字或韩文字。

一次性 runner、事件 trace 与合成音频只位于仓库外，仓库保留上述哈希和聚合证据；生产树没有候选 prompt 或实验开关。

## 限制、复杂度与删除证明

- 没有执行 W0 完整媒体对照，因此不报告 WebRTC/WebSocket 延迟效应量。
- headless Contract Test 确认收到 remote media，不等于真人已听感验收；真实麦克风、扬声器、自然插话和重连仍在 Live 验收中完成。
- 生产不新增 Transport interface 族、WebSocket PCM 编解码器、双协议配置、fallback 或协议选择 UI。
- 一次性 Contract runner 和合成音频不进入仓库；生产只有 WebRTC Driver。
