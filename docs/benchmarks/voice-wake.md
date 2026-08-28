# VOICE-WAKE：本地固定短语语音唤醒

> 状态：已选择并完成生产实现
>
> 日期：2026-08-25
> Decision ID：`VOICE-WAKE`

## 问题

在不打开完整主界面的情况下，用户说出固定短语 `Hi Mika` 后，如何可靠地进入现有桌宠 Voice 模式，同时保证待机阶段不建立 Realtime Session、不上传麦克风音频，也不复制 Voice、Run、Tool 或 Approval 状态机？

## 来源快照

- OpenAI [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations)、[Realtime client events](https://platform.openai.com/docs/api-reference/realtime-client-events) 与 Microsoft [Azure GPT Realtime audio](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio)，复核日期 2026-08-27；Azure 页面标注更新于 2026-07-29。官方协议明确支持 `response.create` 的 `conversation: "none"` out-of-band response、response 级 `instructions`、用途 `metadata` 和自定义 `input`。VOICE-WAKE 因此用紧凑 response 级指令生成连接欢迎语，而不伪造持久用户消息或重复发送完整 Agent 上下文。
- OpenAI [Realtime VAD](https://developers.openai.com/api/docs/guides/realtime-vad) 与 [Realtime WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc)，复核日期 2026-08-25。协议事件 `input_audio_buffer.speech_started/stopped` 只存在于已建立的 Realtime Session；它不是待机 KWS。浏览器/客户端媒体路径仍推荐 WebRTC，长期 API Key 留在服务端。
- sherpa-onnx `v1.13.6`，commit `1cb484af5e69d3c7803c1eb0b3b5ab8041e0e911`，发布日期 2026-08-18；同时核对 2026-08-25 HEAD `34eba5a27220026b5981b633981c53205515067d`。官方 `wasm/kws` 提供 WebAssembly KWS、流式 waveform 输入、命中后 reset 和可配置 keyword score/threshold。
- 英文 GigaSpeech 3.3M 模型包 `sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2`，SHA-256 `f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a`。包内 README 明示 Apache License 2.0；生产只携带 INT8 encoder/decoder/joiner、tokens 与 BPE model。WASM 使用 Emscripten `4.0.23`、SIMD、64 MiB 初始内存并允许按需增长；上游 512 MiB 和验证过的 128 MiB 构建均未保留。

## 约束分层

### 协议硬约束

- OpenAI/Azure Realtime VAD 不能在 Session 外承担 wake-word detection。
- 长期 Provider 凭据不能进入 Renderer；命中后继续使用现有 Main 申请临时凭据、Renderer WebRTC 的路径。

### 上游源码行为

- sherpa-onnx KWS 接受 16 kHz float waveform，decode ready 后读取 keyword result，命中后必须 reset stream。
- 上游 WASM 示例预加载模型资产并允许 keyword boosting score、trigger threshold 和 trailing blanks；这些默认值不是 CharaMate 协议约束。

### CharaMate 产品启发式

- 固定短语为 `Hi Mika`，BPE 为 `▁HI ▁MI K A`，keyword label 为无空格的 `Hi_Mika`；V1 不支持自定义短语，也不把同一口气中唤醒词后的音频作为指令 pre-roll。
- 开关默认关闭。开启时使用持久 Character Renderer、AudioWorklet 与 Web Worker；命中前音频只存在于本机内存。
- 命中后播放短 ready cue，再复用 wake-origin Voice quick-start；无绑定 Chat 的 quick-start 已由 Main 固定为 `Agent + full_access`。Main 接受 `session.created` 或恢复后的 `session.updated` 后，发送一次以 `Hi Mika` 为临时输入的 out-of-band 音频 response；Mika 的简短欢迎语确认 Realtime 已可对话，但不进入默认 conversation、Chat、Run 或 Memory。
- 欢迎语完整停止后仍无真实用户输入的自动结束窗口暂定 10 秒。连接、生成和播放欢迎语不计入该窗口；它是首版可用性与误唤醒副作用边界，不是协议限制，离线测试使用 fake clock 验证收口。

## 候选

| 候选 | 结论 | 原因 |
| --- | --- | --- |
| sherpa-onnx WASM + GigaSpeech INT8 | 选择 | 官方浏览器 KWS/C API；本地运行；固定英文短语模型许可明确；合成语料上不弱于体积更大的 FP32；可放入现有 Character Renderer Worker |
| sherpa-onnx WASM + GigaSpeech FP32 | 拒绝 | 同一 `score=2.5 / threshold=0.05` 合成集合为 10/16 正例、8/64 负例命中，未优于 INT8，却让预加载数据从约 5.2 MiB 增至约 13 MiB |
| Picovoice Porcupine | 拒绝 | 需要 AccessKey，并引入额外商业运行时与账户依赖；当前固定短语没有证明需要该复杂度 |
| openWakeWord | 拒绝 | 主要生产路径为 Python，缺少与当前 Electron Renderer 同级的官方浏览器 JS 路径；预训练模型许可也不适合直接作为本产品默认资产 |
| Apple Speech 全量识别 | 拒绝 | 它是完整 ASR 而非固定短语 KWS，会增加第二套语音识别/权限语义，且不能形成跨平台单一 Voice 边界 |
| Realtime VAD 常驻 Session | 拒绝 | VAD 只在已建立 Session 内工作；会让待机阶段长期占用 Provider 连接并上传音频，且混淆 wake 与 Voice 生命周期 |

## 生产路径

```text
Voice Wake enabled
  → persistent Character Renderer owns local microphone lease
  → AudioWorklet sends mono frames to local Web Worker
  → sherpa-onnx WASM matches only “Hi Mika”
  → pause KWS + play local ready cue
  → existing Character VoiceStore wake-origin quickStart/resume
  → existing Main VoiceService accepts Realtime session ready
  → out-of-band “Hi Mika” input → Mika connection greeting
  → existing Azure WebRTC / Tool / Approval / Run for real user speech
  → Voice ends or silent activation closes
  → resume the same local KWS path
```

Main 持久化唯一 `wake_enabled` 设置并投影系统休眠/锁屏、活动 Voice 与 Renderer 上报状态。Character Renderer 是 KWS controller，Main 仍是 VoiceSession 与 Run 真源。活动 Voice、输出播放和连接期间 KWS 关闭，避免角色自身声音触发；暂停 Voice 时 KWS 可重新监听，命中后恢复同一 Session。连接欢迎语使用 `conversation: "none"`、空工具列表和用途 metadata；Session ready 后立即进入 thinking，response 只携带 Voice 人格/语言设置与极短欢迎约束，简体中文固定为“我在，请说。”。它可被用户插话取消，usage 进入 Voice 指标，但其临时输入、转写和输出不落 Chat/Run/Memory。

网络或握手失败仍保留真实 Voice 错误与 Session 记录；桌宠上的错误只是 Character Renderer 投影。用户可关闭该提示，操作只调用既有 `VoiceStore.clearError()` 清理本地展示态，不改变 `wake_enabled`、不伪造成功，也不触发新的连接或结束请求。下一次语音尝试会先清旧提示，再按真实连接结果更新。

## 验收与结果

### 离线短语定标

环境为当前 Apple Silicon Mac、Node `24.18.0` 与同一生产 WASM/C API。正例由 macOS `say` 的 8 个英语音色、155/195 两档语速生成，共 16 条；负例为 16 个短语 × 4 个音色，共 64 条，其中 12 条是 `Hi Micah / Hi Miko / Hi maker` 近音，52 条是 `Hey Siri / Hi Google / Open my calendar / What time is it / Play music` 等非近音或普通指令。正例集合聚合 SHA-256 为 `95a289d341f2c28a47aeaa433d99793d57e2d6fa9a6a4bede2294a25f9a8dd4d`，负例为 `44a893c412a01d8c07c57ab4557ec93cf49e41ec66da49ce29303ee2dfcda6d6`，负例标签清单为 `42d695dd097dc12f8242204692761314524d9229f5987594e0957d0b5a32ea1e`。原始合成文件不进入仓库。

选择配置为单一 token 序列、`keywordsScore=2.5`、`keywordsThreshold=0.05`、`numTrailingBlanks=1`：

| 集合 | 结果 | 解释 |
| --- | ---: | --- |
| 文字输入 `Hi Mika` 正例 | 11/16 命中（68.75%） | 不同系统音色对 `Mika` 的发音差异明显；不能外推真人 FRR |
| 发音提示 `Hi Meeka` 补充正例 | 12/16 命中（75.00%） | 集合聚合 SHA-256 `f40a8c04d152c8caeed5299b6d67e0cca02e6b2950bbe88411f0fd44f6966c31`；只用于说明拼写到发音差异 |
| 全部负例 | 9/64 命中（14.06%） | 命中全部来自三组近音短语 |
| 非近音/普通指令负例 | 0/52 命中（0%） | 小样本上没有普通指令误触发，不能外推长时间 FAR |

20 组 score/threshold 网格在 80 条集合上运行 51.185 秒。更高 threshold 能减少近音命中，但同时显著降低本就有限的合成正例召回；没有预注册的数字 veto，因此按“固定短语功能可用、默认关闭、误唤醒无输入自动收口、生产路径最小”选择上述点，而不是伪造一个已通过真人可靠性门槛的结论。

### Worker、资源与打包边界

- 生产构建后的 classic Web Worker 在与 Character Window 相同的 CSP（`'wasm-unsafe-eval'`）下完成 runtime/model 初始化，并对一条 `Hi Mika` 样本返回 `Hi_Mika`；`Open my calendar` 样本未命中。这个探针验证实际 Worker/importScripts/WASM 路径，不代表语料统计扩展。
- 64 MiB WASM 在 Node 同一 runtime 上连续处理 15 秒 16 kHz 静音后仍保持 `67,108,864` bytes heap；128 MiB 构建没有质量或稳定性收益，已删除。
- Headless Chromium 五进程探针中，Worker ready 为 461 ms；按每 100 ms 输入 1,600 个静音样本运行 15 秒，进程树累计 CPU 为单核口径约 8.4%，结束 RSS 为 614,656 KiB、相对无 Worker 页面基线增加 281,888 KiB。该数包含 Chromium 进程与分配器，不等价于 packaged Electron 的纯增量功耗，只用于锁定本机量级。
- `AudioWorklet` 只复制单声道帧；`MicrophoneLease` 合并并发采集请求，Voice WebRTC 使用基流的 clone。活动 Voice、暂停/恢复、锁屏/休眠和停止路径都有确定性状态机测试；应用退出释放 Worker、AudioContext 和基流。
- production E2E 直接从 Character 构建产物解析并初始化真实 Worker；dev/package smoke 还检查五个 wake runtime 资产存在。设置、Tray、Character preload、Schema v15→v16、10 秒无输入收口和 VoiceStore 注入租约均由 typed/focused/integration 测试覆盖。

### 2026-08-27 真人复测修正

首次 packaged app 真人复测的持久记录显示，wake-origin VoiceSession 从唤醒请求到 `session.ready` 为 11.470 秒，随后在连接后 7.742 秒、generation 仍为 0 时被结束。设置表中的 `wake_enabled=1` 没有改变；用户看到的“语音关闭”是活动 VoiceSession 被结束，不是自动唤醒开关被关闭。结合源码事件顺序可确定：旧实现从 WebRTC DataChannel open 后就启动 10 秒无输入计时，而 `session.created`、欢迎语生成和播放继续消耗同一窗口，最终在播报中触发 `voice.end()`。

生产修正把无输入计时改为 phase-aware：connecting、thinking 和 speaking 期间取消计时，只有欢迎语完整停止并重新进入 listening 后才重新获得完整 10 秒窗口；计时回调也再次校验仍为 listening，避免同一时刻的状态竞争。Realtime ready 后 Main 先投影 thinking，再创建欢迎 response。官方 Realtime client events 明确 response 级 `instructions` 只覆盖当前 response 的 Session 默认值，因此欢迎语从重复完整 Agent/Tool/Skill/Memory/Chat Context instructions 改为仅发送用户配置的 Voice instructions 与极短欢迎约束；本次实测记录中的完整 Session instructions 为 8,757 字符，Voice 配置为 110 字符。简体中文输出固定为“我在，请说。”，用于减少连接后首句生成与播报长度，但不把本次单次真人体验外推成跨网络延迟结论。

2026-08-27 真人复测修正后的最终生产链执行 `npm run verify:phase0` 全部通过：contract 104/104、focused/component 382/382、integration 178/178、Electron E2E 23/23；production build、开发态 smoke、macOS arm64 package 与 packaged smoke 均通过。定向测试覆盖 out-of-band payload、正常播完、播报中插话、`response.created` 迟到、欢迎语期间不计静默窗口、播放结束后重新获得完整窗口、原连接恢复和冷重连，并验证欢迎语前后都没有 Chat Message 或 Run。两种 smoke 都确认 `visibleWindowCount=0`、`characterRendererReady=true`、`wakeAssetsReady=true`，因此后台桌宠、KWS 资产和连接欢迎语入口不依赖打开完整主界面。验收没有运行自动化 Live 套件；修正后的真实麦克风与当前 Azure Provider 延迟仍由用户复测。

最终打包哈希：

| 文件 | SHA-256 |
| --- | --- |
| `sherpa-onnx-kws.js` | `03b44e372795fd907e84eecd29419e1d052dc6704ac06935c9bf9fe19b3e3434` |
| `sherpa-onnx-wasm-kws-main.data` | `a2ac267c52f314c76cdf81663543abdbf4cc2bc5b84084c47c47aa6cd451c99e` |
| `sherpa-onnx-wasm-kws-main.js` | `9a9b404546bc877f41bc444f007442ba7514b5fbad9918f22d648731b3f4e16a` |
| `sherpa-onnx-wasm-kws-main.wasm` | `62a4e488c6f37d6747fb1df007cb54cb1f36a1ebd01d9481ae53d7d71d7ccbe6` |

仓库只保留这一组资产、Apache-2.0 文本、模型 README 和 provenance notice；没有候选开关、云端 wake fallback、第二个 Voice Runtime 或实验 runner。

### 不能声称什么

当前记录不能声称真实麦克风端到端、真人多说话人 FAR/FRR、嘈杂房间可靠性、全天候误唤醒率、跨硬件功耗或中文口音覆盖已经通过。合成语料已经揭示发音敏感性，因此用户真实环境反馈应优先用于后续重新训练或替换固定模型的独立 Decision；在那之前，产品保持默认关闭且不把“已实现”写成“已达到成熟智能音箱准确率”。
