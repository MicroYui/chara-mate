# HARNESS-LOOP 决策记录

> Decision ID：`HARNESS-LOOP`
> 状态：完成；H7 Quality 接受单一 `HC-FINAL` 组合，专用 H7 Timing 100 经 owner 决定不再运行
> 初始决策日期：2026-08-03
> 后继定案日期：2026-08-07

## 当前决策

接受 `HC-FINAL` 作为生产单路径重写的 Quality 选择：`HS0`、`T2-CLIENT-BM25`、source-derived semantic-cycle detector、H3 条件恢复动作、`CT1-CODEX-TOTAL90`、`CS1-CODEX-HANDOFF`、`CO0-CODEX-USERS` 与已选 Cache On 策略组成一个事件驱动 Harness。不得把候选 Arm、阈值、fallback 或调参入口带入生产。

H7 W2 Quality 为 300/300 valid blocks、0 infrastructure/load/protocol/cache-contamination invalid。预注册机械 Gate 仍判失败：strict task success 236/300（78.67%）、exact Capability 236/280（84.29%），Long Run、Recovery、Steering 的 strict point estimate 为 48%/52%/55%。这些轨迹 exactness 指标保留作诊断，但不单独否决产品选择。

产品语义终局为 300/300：全部任务最终状态正确、全部有效边界完成、结果 token 与终止原因正确、预期证据完整度 100%，且审批前执行、取消后执行和非幂等完成重放均为 0。注册 `businessOutcomeSuccess` 仍是 292/300（97.33%）；差异只来自 8 个 Recovery 任务额外附带 72 条内部 compaction evidence，scorer 的 evidence set equality 把“多了有效证据”记为 `falseCompletion`。原分数不改；产品分析允许附加有效证据，但仍要求所有预期证据和正确性红线。生产输出应只暴露 task evidence，内部 ledger 可继续保留 compaction evidence。

exact arguments 为 1879/1903（98.74%，Wilson 95% 下界 98.13%），evidence retention 为 2435/2435（Wilson 95% 下界 99.84%），Approval 52/52、Steering 33/33，No-op discovery/product calls 均为 0。50 个 Guard 正例触发 27 个、27/27 达到产品语义终局；23 个未触发正例同样完成。50 个负例误触发为 0。H7 是单 Arm 联合确认，不能据此宣称 Guard 的独立因果收益，也没有证据支持只为提高 detector 召回或 strict Tool path 而继续增加 Harness 复杂度。

W2 事前只定案 Quality。2026-08-07，owner 在结果完整可见后决定不再运行专用 H7 Timing 100：现有 Quality raw 的延迟字段只作为 C12 混合负载下的描述性遥测，不伪装成隔离 timing cohort，也不声称通过原 timing Gate。该范围取舍关闭实施前阻塞；生产性能由单路径集成/E2E 与后续实际产品遥测继续验证，不恢复实验 Arms。

## 初始决策（2026-08-03）

本轮不实现 Agent Runtime。`H1-STRUCTURE` 在 AR2-S 选择了最简单的 `HS0`，但下一阶段 `H2-GUARD-DETECT` 的 `GD2/GD3/GD4` specificity 均未达到预注册的 `0.90`，因此 H2 无合格 Arm。按冻结依赖，H3–H7 与 AR2-H 不得运行，`HS0` 也不能被单独写成 CharaMate 的 Harness 默认值。

这是一项有证据的“无胜者”决策，不是实验未完成。若要继续，需要新的 Decision 版本、经失败 trace 审计后提出的新 detector 候选，以及未被当前结果用于调参的新任务；不得在本 Manifest 内补样、降低门槛或保留 fallback Arm。

## 问题与边界

研究问题是：在不改变产品已经冻结的 Run/Item、无静默全局步数/墙钟/Token/成本终止、统一 Tool/Approval 语义的前提下，怎样选择 Harness 结构、Loop Guard detector/action 与压缩策略？

实验把变量拆为 `H1 Structure → H2 Guard Detect → H3 Guard Action → H4 Trigger → H5 Summary → H6 Output → H7 untouched holdout`。一个阶段只改变一个变量；后续阶段只能消费前序晋级 Arm。候选只存在于仓库外的一次性 worktree，不是 Settings、feature flag 或生产运行模式。

## 候选具体怎样实现

### H1 Structure

三者使用同一个自适应 Run loop、Tool/Approval、Guard、Context 和终止语义，只改变“Plan Item 在何时产生”：

| Arm | 实际做法 | 相对前一 Arm 多出的机制 |
| --- | --- | --- |
| `HS0` | 模型在普通响应中自行决定是否创建或更新 Plan Item；Direct/No-op 和 multi-step 都走同一入口 | 最简单基线，无额外往返 |
| `HS1` | 对预标注 multi-step 任务，要求第一个普通响应必须产生 Plan Item；Direct/No-op 不要求 | 一条首响应 planning directive，不增加独立请求 |
| `HS2` | 对 multi-step 任务先单独请求一次“只输出 Plan Item”的 planning response，再进入与 HS0 相同的执行 loop | 固定多一次 planning 模型往返 |

这里没有独立 Planner service、固定步数或第二套 Runtime。任务、Prompt 主体、模型、Tool Registry、采样、证据 oracle 与后续执行完全相同；HS2 固有的额外 planning 请求作为其真实成本计入。

### 初始 H2 `GD2/GD3/GD4`

三个 detector 都把一次失败调用规范化为 `capabilityId + RFC 8785 canonical arguments + errorClass`，忽略 request ID、timestamp 和非语义日志。若 evidence、目标/Steering、Approval 或外部状态 revision 更新，则视为有新观察并清零；否则连续看到 2/3/4 次相同失败就触发同一条冻结 GA1 换策略文本：

| Arm | 触发条件 | 唯一差异 |
| --- | --- | --- |
| `GD2` | 连续 2 次同签名失败且无新观察 | 最激进阈值 |
| `GD3` | 连续 3 次 | 中间阈值 |
| `GD4` | 连续 4 次 | 最保守阈值 |

H2 只在同一批冻结 shadow traces 上离线重放 detector，不重新调用模型；因此比较的是分类规则，不混入不同模型回答。正例/负例由环境 revision、evidence 和合法 continuation oracle 决定，不由模型自评。

## 一手来源边界

执行日 2026-08-03 复核了以下冻结来源：

| 类型 | 版本与直接来源 | 对本决策的约束 |
| --- | --- | --- |
| OpenAI API | OpenAPI `2.3.0`；[Streaming Responses](https://developers.openai.com/api/docs/guides/streaming-responses)、[Function calling](https://developers.openai.com/api/docs/guides/function-calling)、[Errors](https://developers.openai.com/api/docs/guides/error-codes)、[Cancel](https://developers.openai.com/api/reference/resources/responses/methods/cancel) | SSE terminal、Tool Call/Result、错误与 background cancel 是协议事实。 |
| OpenAI JavaScript SDK | `openai@6.49.0`，commit [`04671d2`](https://github.com/openai/openai-node/tree/04671d278ef1531692ae31a870251eec90f3c2d2)；执行日 main 为 `aeab0549…`，npm latest 仍为 `6.49.0` | 600 秒单请求 timeout、流式中断与错误归一化是该版本源码行为，不是产品 Run 上限。 |
| Codex | commit [`2b5bdcf`](https://github.com/openai/codex/tree/2b5bdcf67547860f2e5c5a605009a70026796b2b)；[`turn.rs`](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/core/src/session/turn.rs)、[`compact.rs`](https://github.com/openai/codex/blob/2b5bdcf67547860f2e5c5a605009a70026796b2b/codex-rs/core/src/compact.rs)、[App Server](https://learn.chatgpt.com/docs/app-server) | turn continuation、compaction、steering、resume 是权威源码当前行为，只用于形成候选，不是 CharaMate 默认。 |
| MCP | 规范 `2026-07-28` commit [`7376311`](https://github.com/modelcontextprotocol/modelcontextprotocol/tree/73763114e511106fc07543f6096b3a814b1a3583)；TS SDK commit [`cc4b416`](https://github.com/modelcontextprotocol/typescript-sdk/tree/cc4b41617ce3601b1290d67216ea0b194a3cd9ac) | `server/discover`、`tools/list`、`tools/call`、JSON Schema/structuredContent 是协议边界，不决定 Loop Guard。 |

生产重写前于 2026-08-08 再次核对 Codex 当前公开源码 commit [`3aae5d8`](https://github.com/openai/codex/tree/3aae5d885bac39c1262491aa3fd100dfd8b3919f)（提交时间 `2026-08-08T04:57:06Z`）中的 turn continuation、compaction、steering 与恢复边界，并以项目实际锁定的 MCP Client/Server `2.0.0` 复核 Adapter。该复核没有改变历史实验分母或 Decision：Codex 行为仍只是实现参考，CharaMate 仍由自己的 Run/Item/checkpoint 状态机实现已接受单一路径。

协议硬限制、上述源码行为和 CharaMate 实验启发式在研究设计 §1.8 分开记录。固定的 detector 阈值、压缩水位、lane 数、非劣界和 p95 门槛都是预注册选择，不能外推为协议常量。

## 工件、环境与任务集

- 基线 commit：`b7c68fe918c0e85300c4f2ab5e3620ebaf9d843b`；`package-lock.json` SHA-256 `07de250a…fd206`。
- Provider：用户授权的 `@jeffreycao/copilot-api@1.14.14`、`gpt-5.6-sol`、`reasoning=max`；gateway tag commit `4959ba0…`。这只是本次实测路径。
- 宿主：Apple M4 Pro/arm64/24 GiB，macOS `26.5.2` build `25F84`，Node `24.18.0`，npm `11.16.0`。
- 主预注册：`CHM-P2-AGENT-PREREG-20260802-V8`，index `ee1250de…f2d0`；Harness Manifest `b013ef1d…c99f`。
- AR2 执行补充：`CHM-P2-AR2-EXECUTION-PREREG-20260803-V10`，index `04e71875…7ec`，supplement `70616252…8808`，12-file runner source set `63710a4b…e899`。
- 共享 task bank：AR1 `96`、AR2-S `600`、AR2-H `300`，task SHA 分别为 `0a00356f…d93d`、`d9ea022e…7f36`、`9f89d496…b83c`；fixture/scorer 另有独立 SHA。三个 bank 共 996 个不重叠 opaque ID。
- 任务覆盖 Direct、File、Command、Long Run、Steering、Recovery、Approval、No-op，以及 Browser、Computer Use、MCP；每条记录冻结语言、难度、预期证据和成功判据。没有真实密钥、用户隐私或不可公开数据。

没有可直接替代该产品契约的 OpenAI、Codex 或 MCP 官方校验数据集。一手来源用于协议校准，质量证据来自 CharaMate 自有合成任务。原始 JSON/JSONL、runner 与结果只在仓库外按 SHA 保存；仓库仅保存复现标识与聚合结论。

## 执行设计

- AR1 先筛除明显错误方案；H1 最终有效筛选使用 V11，H2/H3 使用 8 lanes，H4–H6 使用 4 lanes。
- AR2-S/AR2-H quality 固定 16 lanes；paired block 内 Arms 串行，每 lane 的类别、语言、难度 maximum spread `<=1`。
- 首轮屏障为每 lane 首个 block 后的 E16，只检查证据完整性与独立评分差异，不查看 Arm outcome。
- TTFT/p95 使用独立 LS2、100 个固定 task、`concurrency=1`；不与并行 quality timing 合并。
- 10,000 次按类别分层 paired bootstrap；二元指标同时报告 exact McNemar/Holm。安全事件、protocol invalid 和 reference-score mismatch 为硬门。

实际后继样本与并发如下；“lanes”只允许不同 paired blocks 并行，同一 block 内的 Arms 始终串行并做顺序平衡：

| 阶段 | AR1 / selection | 正式 Quality | 独立 Timing / control | 实际并发设置 |
| --- | --- | --- | --- | --- |
| H1 | 96 paired tasks | 600 | 100 timing | AR1 4 lanes；Quality 16；Timing 串行 |
| 初始 H2 | — | 280 shadow traces | 无 Provider timing | 16 lanes 离线重放 |
| 重设计 H2 | development 后 1,200 selection | 1,200 report-only holdout | 无 Provider timing | 16 lanes 离线重放 |
| H3A/H3B | 24 / 8 paired tasks | 300 planned（H3A 299 valid）/100 | Direct controls 100 | 8–16 lanes，block 内串行 |
| H3C | — | 300 | timing 100 | Quality 16；Timing 固定子集 |
| H4/H5/H6 | 各 16 pressure tasks | 各 200 | 各 100 timing | screen 4；Quality 8；Timing 4 |
| H7 W2 | 无候选筛选 | 300 单 Arm holdout | 专用 Timing 100 waived；Quality raw 延迟仅描述 | Quality 12 lanes |

H4–H6 的 200 workflows 固定为 10 个产品任务族，每项 24 个有效边界；语言 `80 en / 80 zh-CN / 40 zh-en`，难度 `60/80/60`。100 个任务落在约 272K input，另 100 个落在当前 endpoint resolved 922K input budget 的 85%–98%；实际 Provider `usage.input_tokens` 不在注册 band 的整对记 load-invalid。六类 observation 为 artifact ledger、Browser snapshot、command output、file chunk、增长日志和 MCP records，早/中/晚各放 evidence，并含两次 Steering revision 与一次 Approval outcome；不靠无意义 filler 造长上下文。

## 结果

### H1 Structure

有效 AR1 先比较 `HS0/HS1/HS2`：`HS0`、`HS1` 分别完成 `81/96`、`79/96`，进入 AR2-S；`HS2` 只有 `9/96`，并产生 73 次 false completion，触发正确性硬门后淘汰。更早的 V5 因未持久化完整 `finalOutput` 与 `effectiveBoundaryCount` 而不可独立复评分，整版只作 diagnostic，不能参与晋级。以下 600-family 结果只比较 AR1 survivors。

AR2-S quality 为 600 paired families；E16 通过，quality raw `9400560c…1dc5`。首次 LS2 尝试在 ordinal 70–99 出现 30/100 个 `500 fetch failed` blocks，整份 `68e1ed0d…5948` 仅作 diagnostic，包括前 70 个有效块也不进入分析。

恢复补充在任何新调用前冻结：index `7c4d1362…c3fc`、Manifest `7f6ca6e5…3a28`。一次 `/models` 与连续 3 个固定 capability probes 全过，evidence `2d606a69…0b66`；随后从 ordinal 0 完整重跑相同 100-task LS2，结果 `d180f8a6…3cf6`。原 600-family quality 被逐字节复用，没有重采样。

| 指标 | HS0 | HS1 |
| --- | ---: | ---: |
| 成功 | 585/600 | 586/600 |
| 精确 Tool 选择 | 512/520 | 509/520 |
| 精确参数 | 3694/3709 | 3695/3709 |
| safety / protocol / infrastructure invalid | 0 | 0 |
| logical input tokens | 27,914,663 | 28,549,112 |
| 串行 TTFT p95 | 5,538.1 ms | 7,134.2 ms |

HS1 相对 HS0 的 success、选择与参数单侧 95% 下界分别为 `-0.50pp`、`-1.346pp`、`-0.080pp`，通过 `>=-2pp` 质量门；但 TTFT p95 ratio 点估计 `1.2882`、单侧 95% 上界 `1.5705`，超过 `1.10`。因此只有 HS0 合格。分析文件 SHA-256 为 `ce4f5f19…280b`，quality/latency 独立复评分差异均为 0。

### H2 Guard detector

在下表所列 V10 shadow-trace 结果之前，V7 AR1 曾先比较同名 `GD2/GD3/GD4`：32 blocks 中业务成功分别为 `10/32`、`12/32`、`11/32`，但 false completion 为 `12/13/16`，三者都触发零容忍正确性门而淘汰。V10 用全新 Manifest 与未曝光 traces 重做 detector 评估，安全计数归零，但又暴露出以下 specificity 缺陷；两次无胜者各自保留，不能把 V10 写成对 V7 的补样。

H2 使用冻结 shadow traces，不发 Provider 请求，因此无 LS2。16 lanes 完成 280 paired families，raw `8bcbd3c2…be98`，E16 `aba8fa93…f594`；E16 的缺证据和评分差异均为 0。

| Arm | sensitivity | specificity（Wilson 95%） | direct false interventions | detector 分类正确 |
| --- | ---: | ---: | ---: | ---: |
| GD2 | 140/140 = 1.000 | 36/140 = 0.257 `[0.192, 0.335]` | 15 | 176/280 |
| GD3 | 140/140 = 1.000 | 72/140 = 0.514 `[0.432, 0.596]` | 10 | 212/280 |
| GD4 | 140/140 = 1.000 | 106/140 = 0.757 `[0.680, 0.821]` | 5 | 246/280 |

三者 specificity 都低于预注册 `0.90`，所以 `eligibleArmIds=[]`、`selection=no-winner`。raw/analysis 中 safety、protocol invalid、infrastructure invalid 与独立评分差异均为 0；失败来自 detector 正确性，而非 Provider 或证据缺失。分析 SHA-256 为 `06fe9457…6dd4`。

## 初始复杂度与处置

- 没有修改生产 Schema、IPC、Settings、Provider、Tool、Approval 或模型采样；没有新增生产依赖、feature flag、兼容路径或实验运行模式。
- 主仓库没有候选实现。失败 Arms、runner 和原始结果只存在于仓库外一次性 worktree/归档，不会被合并；生产路径没有需要保留的 fallback。
- `HS0` 只是一项 Structure 阶段选择；H2 无胜者使完整 Harness 组合不存在。H3–H7 与 AR2-H 未运行，不能声称长程、steering、approval、recovery 或 holdout 已获生产确认。

## 初始后续决策

需要仓库所有者决定是否启动新的 `HARNESS-LOOP` Decision。若启动，先只读审计 H2 false-positive traces，预注册新的 detector 候选、复杂度预算和未曝光任务，再从受影响阶段开始；当前阈值、结果和未运行阶段不能被就地改写。

## 后继实验的完整晋升与淘汰链

后继实验没有把初始无胜者覆写成“其实通过”。每一轮先判断证据是否有效，再区分正确性硬门、CharaMate 预注册启发式和产品综合取舍。完整顺序为：

后继候选形成前于 2026-08-05 再次检查 OpenAI Streaming、Function Calling、Tool Search、Compaction、Conversation State、Errors、Cancel 与 Prompt Caching 文档；锁定 `openai@6.49.0` tag commit `04671d278ef1531692ae31a870251eec90f3c2d2`，并记录当日 main `f58d060deaa9149edfe2328ddbb6653dc4abf7f9`；Codex 使用 commit `30d99232f485bd64eda9f6e0d9433bceebb2cb2b`；MCP 规范使用 `2026-07-28` commit `5c4f1768b97198a149d7db05f5026b30c6a3cb12`，TypeScript SDK 使用 `cc4b41617ce3601b1290d67216ea0b194a3cd9ac`。这些源码行为只用于提出候选；阈值仍是 CharaMate 启发式。

| 阶段 | 进入比较的候选 | 本阶段处置 | 进入下一阶段 |
| --- | --- | --- | --- |
| H1 Structure | `HS0/HS1/HS2` | AR1 淘汰 `HS2`；AR2-S 因 `HS1` TTFT p95 退化选择 `HS0` | `HS0` |
| 初始 H2 detector | `GD2/GD3/GD4` | specificity 均低于 0.90，机械无胜者 | 无；H3–H7 当时停止 |
| 重设计 H2 detector | cycle/window/confirm/delay 组件 | selection 选 `S1+W0+C0+D1`，唯一组合通过独立 holdout | 固定 detector |
| H3 Guard action | `GA0`–`GA6` | 先按有无替代 Capability 分组，再选择 `GA3` 与 `GA5` | `H3C-CONDITIONAL` |
| H4 Trigger | `CT0`–`CT3` | AR1 淘汰等价或退化项，AR2 选择 `CT1` | `CT1` |
| H5 Summary | `CS1/CS2` | 复杂方案无已证明收益，选择简单基线 `CS1` | `CS1` |
| H6 Output | `CO0/CO1/CO2` | 复杂方案无可归因的处理暴露收益，选择简单基线 `CO0` | `CO0` |
| H7 joint holdout | 一条 `HC-FINAL` | W1 setup-invalid；W2 Quality 机械失败、产品语义接受 | Quality 已定案；专用 Timing waived |

### 重设计 H2：从旧无胜者到固定 detector

旧 `GD2/GD3/GD4` 的失败是真实 detector 缺陷，不用补样或降低门槛修复。新版本用未曝光 selection 与 report-only holdout，各包含 1,200 条 traces（480 positive、720 hard negative），只比较 detector 组件，不调用 Provider：

重设计先统一两类输入证据：净进展向量包含 goal/milestone/evidence/artifact/job/approval/cancel revisions；合法 continuation 包含仍可重试的 transient error、queued/running job 的下一次 poll、pending Approval、cancel drain 和已登记 external wait。只要合法 continuation 仍成立，detector 不得确认 no-progress。随后一次只替换一个组件：

| 组件 | 候选实际做法 |
| --- | --- |
| cycle signature | `S0` 使用完整 Capability/arguments/outcome；`S1` 只保留 semantic operation、stable target 与 effect/outcome，去掉 request ID、时间戳、retry 文案和无语义参数噪声 |
| candidate coverage | `W0` 只接受长度 1–5 且完整重复 5 次的 cycle；`W1` 还把任意 5-action“净进展不变”窗口列为候选 |
| confirmation | `C0` 用上述环境证据确定性确认；`C1` 计划增加一次模型 confirmer，只能对 W1 候选作过滤 |
| debounce | `D1` 首个完整候选窗口即确认；`D2` 要连续两个窗口一致才确认 |

selection 的 12 类每类 100 条，语言为 `480 en / 480 zh-CN / 240 zh-en`，难度 `300/480/420`。480 正例覆盖重复失败、A→B→A 振荡等无净进展；720 hard negatives 覆盖合法 retry/poll、Approval、Cancel、external wait 和有限探索。oracle 只读环境状态，不读取 detector 输出；主/独立 scorer 对 E16 首块证据逐项复核。

| 候选 | selection 结果 | 处置 |
| --- | --- | --- |
| `S0-FULL-CYCLE` | sensitivity 400/480，漏掉 80 条 semantic-noise 正例 | 淘汰 |
| `S1-SEMANTIC-CYCLE` | sensitivity 480/480、specificity 720/720 | 选择 |
| `W1-STAGNANT-COVERAGE` | sensitivity 160/480、specificity 600/720，另有 320 次过早触发和 20 次 safety false positive | 淘汰 |
| `D2-TWO-WINDOW` | 与 `D1-ONE-WINDOW` 同为 1,200/1,200，但多一个观察边界 | 按复杂度淘汰，选择 `D1` |
| `C1-MODEL-CONFIRMER` | `S1` 已零分类错误；confirmer 只能过滤同一候选集并增加调用、成本和延迟 | `not-run-dominated`，选择确定性 `C0` |

最终唯一组合为 `S1-SEMANTIC-CYCLE + W0-CYCLE-ONLY + C0-DETERMINISTIC + D1-ONE-WINDOW`。独立 holdout 为 1,200/1,200 分类正确：sensitivity 480/480、specificity 720/720，安全误触发和过早触发均为 0，p95 检测延迟为 0。selection raw/analysis 为 `45a0e2b1…e9d7` / `d69a7822…a248`，holdout 为 `025bcc3f…c087` / `0087dc32…02a1`。这只选择 detector；还不能单独成为生产 Harness。

### H3：`GA0`–`GA6` 的逐轮筛选与条件组合

H3 只处理已知 failed/no-progress；unknown outcome 与副作用 reconcile 不在本轮声明范围。候选分为“没有独立替代 Capability”和“已有独立替代 Capability”两组，避免同时改变提示、候选信息和 Tool 限制：

所有 Arm 固定 H2 detector、首次失败 Tool output、256-Tool T2 inventory、模型、任务与 scorer。candidate-present 分支先通过同一个独立 router 选出合法替代 Capability，再让 GA4/GA5/GA6 以完全相同的位置和额外往返加载同一个 Schema；三者只改变下一请求的 Tool choice。router 先在 400 个 base cases 上离线验证：320 个有候选（Built-in/Skill/MCP/App Action 各 80）top-1、valid set 与 recall 均为 320/320，80 个无候选全部 abstain；另做 1,200 个 ID 重命名、顺序打乱和无关 Tool 追加 view，输出零变化。这只验证候选映射，不当成 H3 action 胜者证据。

AR2 的 300 scenarios 固定为 100 candidate-present、100 no-candidate bounded-retry/failed-contract、100 detector-negative progressing controls；另有 100 clean Direct probes，不能并入 300。每个 case 至少包含失败前调用、确定性失败结果、干预后调用和一个后续业务步骤；Long Run 必须继续完成 24 个边界，不能把“调用到 recovery Tool”直接算业务成功。

| Arm | Guard 后给模型的信息或约束 |
| --- | --- |
| `GA0-CODEX-FREE` | 不增加恢复指导 |
| `GA1-PLAIN` | 简短说明 no-progress，要求重新评估；仅在元数据允许时有限重试 |
| `GA2-STRUCTURED` | 结构化给出参数 digest、Capability、循环长度、错误类和触发事件，不给候选 ID |
| `GA3-CANDIDATE-LIST` | 在 GA2 基础上给出独立 recovery candidate ID 列表 |
| `GA4-NAMED-FREE` | 明确命名替代 Capability，仍允许模型自由选择 Tool |
| `GA5-ALLOWED-AUTO` | 命名替代 Capability，并用 `allowed_tools`、`mode=auto` 限定集合 |
| `GA6-ALLOWED-REQUIRED` | 与 GA5 相同，但 `mode=required` 强制 Tool call |

H3B 早期诊断批曾出现 HTTP 400 `Missing namespace for function_call`：runner 回传动态加载的 function call 时丢失了 Provider output 上的 `namespace`，且一度存在 candidate 重复暴露、Arm 间已加载 Schema 集不一致。它们属于 native Tool Search continuation 的实验实现错误；失败批次原样归档但不计分。修复为完整 output item 原样 round-trip并断言三 Arm Schema 集一致后，正式 H3B/H3C 均为 0 protocol invalid。

无替代 Capability 的 H3A AR1 每 Arm 24 tasks，业务终局均为 24/24；GA0/GA1/GA2/GA3 的 strict 为 `13/12/15/16`，exact Capability 为 `14/12/15/16`，exact arguments 为 `16/15/18/19`，recovery 为 `8/7/10/11`，wrong calls 为 `76/55/77/20`。四者都进入 AR2；AR2 有 299 个有效 paired blocks：

| Arm | 业务终局 | strict | exact Capability | exact arguments | recovery | wrong calls | 处置 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| GA0 | 299/299 | 159/299 | 165/299 | 182/299 | 83/200 | 1,076 | 不选 |
| GA1 | 298/299 | 153/299 | 167/299 | 195/299 | 96/200 | 763 | 不选 |
| GA2 | 298/299 | 150/299 | 162/299 | 193/299 | 94/200 | 678 | safety=1，硬淘汰 |
| GA3 | 299/299 | 175/299 | 183/299 | 209/299 | 110/200 | 377 | 产品选择 |

四 Arm 都没有机械通过绝对质量启发式，原结论保持 `no-winner`；在硬门合格者中，GA3 的 strict、Capability、参数、recovery 和 wrong-call 总体最好，因此以 evidence-led amendment 选择。H3A Decision/analysis 为 `e73f4ef…f374` / `9e0d1cfa…77b7`。

有替代 Capability 的 H3B AR1 每 Arm 8 tasks，三者业务终局均为 8/8；GA4/GA5/GA6 的 strict 为 `5/5/4`，exact Capability 为 `8/8/7`，exact arguments 和 recovery 均为 `5/5/5`，wrong calls 为 `3/3/5`，所以全部进入 100-block AR2。AR2 三者业务终局均 100/100；strict 为 67/66/65，exact Capability 为 90/91/92，exact arguments 为 74/76/74，recovery 为 74/76/74，wrong calls 为 61/52/50。绝对质量门仍给出机械无胜者；GA5 在参数与 recovery 最好、Capability 接近最好，又不引入 required-mode 强制性，因此选择 GA5。100 个 Direct controls 的错误 Guard intervention 为 0。H3B Decision/analysis 为 `8d4d660f…8d59` / `536f9f13…20e`。

组合阶段比较：`H3C-CONDITIONAL` 在有候选时用 GA5；无候选且错误为已知 transient、调用为 read/idempotent 时用 GA3 有限重试；其他情况诚实终止为 failed。`H3C-GLOBAL` 则把同一全局动作应用到所有情况。300-block 结果如下：

| 组合 | 业务终局 | strict | exact Capability | exact arguments | recovery | wrong calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Conditional | 300/300 | 223/300 | 255/300 | 277/300 | 177/200 | 98 |
| Global | 268/300 | 197/300 | 234/300 | 242/300 | 142/200 | 106 |

两者仍未机械通过全部绝对门槛；Conditional 在全部核心点估计上更好且四项副作用为 0，因此产品选择 Conditional。固定 100-task timing 中 Conditional 的 TTFT p95 ratio 上界为 `0.7936`，end-to-end p95 ratio 上界为 `1.1641`，后者略过注册 `1.15`，所以机械 latency pass 仍为 false，不被改写。H3C quality/timing Decision 为 `03331ae2…ea3e` / `332652c2…0103`，最终 composition Decision 为 `57e00ca8…4395d`。

### H4–H6：压缩触发、摘要和完成输出

三个阶段固定相同的 512-Tool T2 inventory、24-boundary transcript、durable artifact/evidence ledger 和最终 oracle；H4 只改何时压缩，H5 固定 H4 后只改压缩摘要，H6 固定 H4/H5 后只改已完成 Tool output 对模型的可见表示。

H4 的方法为：

| Arm | 实际触发公式或 control 做法 |
| --- | --- |
| `CT0-BOUNDED` | 不压缩；把可重建的历史 raw Tool output 换成 immutable artifact references，保持相同任务终局、Evidence、Steering 与 Approval，仅作不可晋级伤害 control |
| `CT1-CODEX-TOTAL90` | 当 total active input 达 resolved input budget 的 90% 时，在下一次采样前压缩 |
| `CT2-CODEX-BODY90` | carried stable prefix 不计入 90% 分子，只对其后的增长 body 触发；完整 resolved window 仍是 hard cap |
| `CT3-CHARA-HEADROOM` | 若 `active input + next-observation reserve` 将越过 prompt cap，或再加 configured max output 将越过 context cap，则提前压缩 |

当前 endpoint metadata 为 context 1,050,000、prompt 922,000；实验固定 max output 16,000，resolved input budget 因而为 922,000。它是实测 endpoint 条件，不是协议常量。四 Arm 在 H4 都使用同一个 `CS2` summary 与 `CO1` output representation，避免同时改变压缩内容。

H5 的方法为：

| Arm | 压缩后写入新窗口的 summary |
| --- | --- |
| `CS0-OPENAI-OPAQUE` | 原计划调用官方 `responses.compact`，并把 canonical opaque output 原样传入下一窗口；pinned endpoint 返回 404，所以只记 compatibility exclusion，不伪造 Arm |
| `CS1-CODEX-HANDOFF` | CharaMate 本地生成 `currentProgress / decisions / constraints / nextSteps`；constraints 内带最新 Approval 与 Steering |
| `CS2-CHARA-STATE` | 本地固定字段 `goal / progress / evidence / pending / approval / steering`，更结构化也更产品专用 |

H6 的 durable ledger 在三 Arm 中完全相同，只改变模型下一窗口能看到的已完成 Tool output：

| Arm | 模型可见表示 |
| --- | --- |
| `CO0-CODEX-USERS` | H5 handoff + bounded recent user/task context；已完成 raw Tool outputs 不再重放 |
| `CO1-CHARA-LATEST+REFS` | 最新一条 raw observation + 所有已完成边界的 immutable artifact/evidence references |
| `CO2-CHARA-SCHEMA+REFS` | 每个已完成边界的 schema-key summary（kind、revision/control、evidence、semantic fact）+ immutable references |

H5/H6 的因果比较只用两 Arm 都实际发生压缩的共同 treatment-exposed pairs；否则 summary/output 变量根本没有生效。全部 200 valid blocks 仍作为 intent-to-treat 报告总体成功、Token 和延迟，并承担绝对质量门。这一分母规则在 H5 正式主实验前冻结。

H4 AR1 用 16 blocks 比较四个触发方案。`CT2-CODEX-BODY90` 与 `CT1-CODEX-TOTAL90` 的处理确定性等价但不更简单，淘汰；`CT3-CHARA-HEADROOM` 出现 control revision loss，淘汰；`CT0-BOUNDED` 与 CT1 晋级。200-block AR2 中 CT0/CT1 业务成功为 193/200 与 191/200；关键的 69 个实际压缩处理任务中，CT1 的成功、证据、语义事实、Steering、Approval 均为 69/69，压缩后 input ratio 约 `0.1030`。固定 timing 的 35 个处理任务同样全部保留正确性，因此选择 CT1，而不是把“未触发压缩”的 CT0 当成产品 fallback。Decision SHA-256 `5acb59a5…e8766`。

H5 只比较 `CS1-CODEX-HANDOFF` 与 `CS2-CHARA-STATE`；当前 pinned Provider 不可用的 `responses.compact` 路径没有伪造模拟 Arm。AR1 16 blocks 两者都晋级；200-block AR2 的整体成功为 186/200 与 185/200，共同暴露的 69 个压缩处理任务两者均 69/69。CS2 没有达到注册的成功或证据复杂度收益，input token 还略高，因此按“质量不可分时选最简单基线”选择 CS1。Decision SHA-256 `b1df9e1e…42e0`。

H6 AR1 的 `CO0-CODEX-USERS`、`CO1-CHARA-LATEST+REFS`、`CO2-CHARA-SCHEMA+REFS` 均晋级。正式 Quality 计划 200 blocks，有效 193、整对基础设施排除 7、protocol invalid 0；这些排除来自 408 request-body timeout、500 fetch failed 或流缺 terminal event，不是候选质量失败。整体成功为 177/193、185/193、185/193，但共同处理暴露的 66 blocks 中 CO0/CO1/CO2 为 66/66、65/66、66/66，复杂方案没有达到注册的可归因成功或证据收益，且 input token 不更低。因此不根据未暴露任务的 +4.15pp 点估计增加表示复杂度，选择 CO0。Decision SHA-256 `a36c30fd…fd16`。

H4 的第一版 finalizer 曾错误把全部候选运行当处理暴露分母；H5 timing 的第一版又把过细分层造成的 singleton strata 当成可比较区间。两处都只修复分析器、保留 raw、未重跑 Provider，并保存旧机械输出与修正后的 hash。它们属于分析设置修正，不是补样或按结果改 Arm。

### H7：无效 W1、有效 W2 与最终 Quality 取舍

H7 W1 在运行至 102 个 Quality、65 个 Timing blocks 时发现使用了旧 task bank，并且缺少正确的 recovery catalog/discovery 组合。整轮连同已完成样本都标为 setup-invalid；它不是“输出太大”错误，也不能重跑两条后拼入正式分母。归档目录保留原始证据，但不与 W2 混算。

W2 不是再比较 Arms，而是把前序唯一选择合成一条 compiler 后做交互确认。300 个未曝光 workflows 按 256/512 Tool inventory 各 150，并与 short、约 272K、当前 endpoint resolved input budget 的 85%–98% 三层各 100 条交叉。任务分层不是十二类均分：Long Run、Recovery 各 50，Approval、Browser Act、Browser Read、Command、Computer Use、Direct、File、MCP、No-op、Steering 各 20；语言为 `120 en / 120 zh-CN / 60 zh-en`，难度为 `60 easy / 120 medium / 120 hard`。同一 oracle 同时报业务终局、strict、Tool/参数、Evidence、Approval、Steering、Guard 触发和四类副作用；20 个 No-op task 另要求 discovery/product call 为 0。由于只有一个 Arm，H7 只能检验绝对门和组件交互，不能做组件间因果比较。

W2 重新冻结 fresh 300-task bank、12 lanes 与单一 `HC-FINAL`，事前只运行 Quality。300/300 blocks 有效，0 infrastructure/load/protocol/cache-contamination invalid。raw SHA-256 为 `9a0f7aa4…e11ac2`，analysis 为 `5d5a8ac2…ba2e`。机械 Decision `62f39d26…8f63` 保留 strict/exactness 门失败；产品 Decision `25a4bf1e…c103` 根据 300/300 产品语义终局、97.33% 注册业务完成、98.74% exact arguments、100% 证据/Approval/Steering 保留和零外部副作用接受 Quality。

不新增 Provider 请求，直接从同一 raw 重算描述性延迟：300 个 task 的端到端 mean/p50/p95 为 `111.1s / 51.1s / 351.6s`，首请求 TTFT 为 `13.0s / 10.3s / 25.3s`。三层端到端 mean/p50/p95 分别为：short `28.6s / 22.0s / 66.8s`、约 272K `48.8s / 41.9s / 95.3s`、近 resolved budget `256.1s / 226.1s / 431.5s`；后者显著拉高总体平均。描述性分析 SHA-256 为 `925ade18…be41a`。它来自 12 条并发 lane、混合任务长度和 Quality 采样，没有 timing 专用顺序、对照或置信区间，所以只回答“本次实际运行观察到什么”，不回答独立 timing Gate 是否通过。

## 当前复杂度与处置

- 选择的是一个生产实现方向，不是保留整个实验编译器。实现时删除 losing Arms、runner、候选 catalog、阈值开关与实验 schema，只重写一个 Harness/Discovery/Cache 路径。
- H7 Quality 的执行价格快照成本等价为 `$2486.07`（`$8.29`/task），包含近 context-budget 压力层，不代表普通会话均值。
- 本记录不能声称各组件的独立因果收益，也不能声称专用 H7 Timing 100 已通过。owner 已明确 waive 该额外 cohort；后续集成/E2E 或产品遥测若发现具体性能问题，应优化单一路径，不得为“保险”恢复多个 Harness 模式。
