# TOOL-DISCOVERY 决策记录

> Decision ID：`TOOL-DISCOVERY`
> 状态：完成；source-derived `T2-CLIENT-BM25` 已随 H7 Quality 接受，专用 H7 Timing 100 已 waived
> 初始决策日期：2026-08-03
> 后继定案日期：2026-08-07

## 当前决策

选择 `T2-CLIENT-BM25` 作为未来生产单路径中的发现协议：模型首屏只见 source/namespace 元数据与 native Tool Search 接口，CharaMate 用固定 metadata BM25（limit 8）返回 `tool_search_output`，命中后才让完整 Schema 进入上下文。它随单一 `HC-FINAL` 组合通过 H7 W2 Quality；不得保留 `T0-FULL` fallback、hosted search 分支、双语 ranker 开关、旧 meta functions 或用户可调 topK。

原 D1C 机械门会选择 `T0-FULL`，原因只有 256-Tool timing 的 end-to-end p95 ratio 单侧 95% 上界 `1.1190` 窄幅超过 CharaMate 启发式 `1.10`。完整证据同时显示：T2 在 256/512 两层业务质量非劣，512 层完整合格，input token 显著下降，且 512 的 TTFT/end-to-end 在 C16 与 C1 下方向一致。仓库 owner 因此在保留机械结论后，以带时间戳 amendment 选择 T2。当前 Decision SHA-256 为 `70a41569…e052`，selection amendment 为 `df73b622…d044`。

H7 W2 使用 T2、512 Tool 极限层和最终 Harness/Cache 组合，300/300 Quality blocks 有效，产品语义终局 300/300、No-op discovery/product calls 为 0。H7 是联合单 Arm 确认，不能反推 T2 的独立因果收益。2026-08-07 owner 决定不再运行专用 H7 Timing 100；Quality raw 的 C12 延迟只作描述性遥测，不把范围关闭写成 timing Gate 通过。

## 初始决策（2026-08-03）

更早的 V7 AR1 也没有胜者：`T0/T1/T2/T3` exact selection 为 `88/79/84/89`，但在 16 个 Direct/No-op trials 中分别产生 `3/8/10/16` 次不应发生的 capability call，全部触发 no-tool 零容忍门。后续 V8 使用新 Manifest 和未曝光任务重新定义候选；它不是给 V7 补样。以下为 V8/V10 的初始阶段选择。

在相同模型、任务和 48 个 Tool Schema 下，只有基线 `T0-Full` 保持 eligible；`T1-Catalog`、`T2-Domain`、`T3-Search` 无一同时通过质量与冻结效率门。T1 的 Tool 质量略好，但没有减少一个完整 Schema-bearing request，反而增加约 5.4% logical input tokens；T2 明显退化；T3 也增加 Token 和 Schema-bearing requests。

因此 `T0-Full` 是本轮唯一 AR2-S 阶段选择，但不是 CharaMate 产品默认。预注册要求 Discovery 与完整 Harness 组合共同通过 H7；`HARNESS-LOOP` 在 H2 无胜者，H7/AR2-H 未运行。最终 Decision 结论是“没有经 holdout 确认的生产发现协议”，生产 Tool Registry/Discovery 仍不得实现。

## 初始问题、Arms 与单一变量

问题是：Skills、MCP、App Actions 与 built-in Tools 共用一个 Registry 和调用 envelope 时，模型应如何获得可执行 Schema，才能在不损害正确性的前提下降低 Prompt Token 与额外往返？四个 Arms 只改变发现方式：

| Arm | 初始披露 | 完整 Schema 的获得方式 |
| --- | --- | --- |
| `T0-Full` | 48 个完整可执行 Schema | 直接调用目标 Capability |
| `T1-Catalog` | 48 个统一 descriptor | `capability.load(ids)` |
| `T2-Domain` | 8 个 domain descriptor | `capability.expand_domain(domain)` |
| `T3-Search` | 一个搜索 Tool | `capability.search(query)` 返回全部正分匹配及 Schema |

模型、Provider、reasoning、任务、Capability 集、JSON Schema、fixture、scorer 与 Harness 组件全部相同。meta capability 只存在于实验；没有为 Skill、MCP 和 App Action 分别发明机制。

这里的 T0–T3 只比较“可执行 Capability Schema 怎样被模型发现”。即使 T0 作为阶段基线，它也不代表把全部 `SKILL.md` 正文、references 或资源常驻 Prompt；产品设计 §5.6 的 Skill 内容仍只在命中后按需加载。

## 初始一手来源与数据边界

执行日 2026-08-03 复核：OpenAI OpenAPI `2.3.0` 的 [Function calling](https://developers.openai.com/api/docs/guides/function-calling) 与 [Streaming Responses](https://developers.openai.com/api/docs/guides/streaming-responses)；`openai@6.49.0` commit [`04671d2`](https://github.com/openai/openai-node/tree/04671d278ef1531692ae31a870251eec90f3c2d2)；MCP 规范 `2026-07-28` 的 [Discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover) 与 [Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)，规范 commit [`7376311`](https://github.com/modelcontextprotocol/modelcontextprotocol/tree/73763114e511106fc07543f6096b3a814b1a3583)；MCP TypeScript SDK commit [`cc4b416`](https://github.com/modelcontextprotocol/typescript-sdk/tree/cc4b41617ce3601b1290d67216ea0b194a3cd9ac)。

OpenAI Function Calling 和 MCP `server/discover/tools/list/tools/call` 定义协议边界，但没有规定 T0–T3 哪一种是 CharaMate 默认，也没有提供覆盖 CharaMate Approval、Steering、Recovery、Computer Use 与统一 App Action 的官方选择数据集。这里使用 996-family 自有合成 bank；一手来源不是校验答案集。

- 预注册：`CHM-P2-AGENT-PREREG-20260802-V8`，index `ee1250de…f2d0`，Discovery Manifest `0f39d2ef…5e98`。
- AR2-S task/fixture/scorer 各 600，SHA 分别为 `d9ea022e…7f36`、`de605d1d…08f5a`、`fd0e1dbb…bd7a`；稳定 opaque task ID 记录类别、语言、难度、预期证据与成功判据。
- Capability Registry `CR2` 包含 48 个 built-in/Skill/MCP/App Action capabilities，SHA `93757a83…78a`。
- 执行补充 `70616252…8808`；runner source set `63710a4b…e899`；D1 freeze `d87e58f8…2dae`。
- 环境与 Harness 记录相同：M4 Pro、macOS `26.5.2`、Node `24.18.0`、`copilot_api@1.14.14`、`gpt-5.6-sol`、`reasoning=max`。

原始 JSON/JSONL 与 runner 在仓库外保存；无真实密钥、用户隐私或不可公开数据。

## 初始执行与门槛

- AR2-S quality：600 paired families，16 lanes，paired block 内 Arms 串行；E16 在每 lane 首块后只查证据完整性和独立评分差异。
- LS2：固定 100-task 子集，`concurrency=1`；并行 quality timing 不进入 TTFT/p95。
- 正确性：safety 与 Direct/No-op product false call 必须为 0；success、精确选择和精确参数相对 T0 的单侧 95% 下界必须 `>=-2pp`。
- 效率：logical input token ratio 的单侧 95% 上界 `<=0.80`，或至少少一个 Schema-bearing request 且总延迟 p95 ratio 上界 `<=1.10`。
- 统计：10,000 次分层 paired bootstrap，并报告 exact McNemar/Holm；多个候选合格时选最简单者。

## 初始结果

quality raw `6adc7839…a963`，E16 `db33512f…d7d`，LS2 `5b442b39…321b`，analysis `bd33bf76…7cd9`。600/600 quality blocks 和 100/100 LS2 blocks 完整；safety、protocol/infrastructure invalid、E16 缺证据及 quality/latency 独立评分差异全部为 0。

| Arm | 成功 | 精确选择 | 精确参数 | wrong calls | logical input tokens（相对 T0） | model round trips（每 family 相对 T0） | Schema-bearing request 差 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| T0-Full | 586/600 | 511/520 | 3695/3709 | 20 | 27,931,508 (`1.000`) | 4,444 (`0`) | `0` |
| T1-Catalog | 589/600 | 520/520 | 3698/3709 | 11 | 29,443,432 (`1.054`) | 4,978 (`+0.890`) | `-0.110` |
| T2-Domain | 505/600 | 450/520 | 3598/3709 | 143 | 37,901,853 (`1.357`) | 5,460 (`+1.693`) | `+0.693` |
| T3-Search | 588/600 | 513/520 | 3697/3709 | 17 | 29,654,918 (`1.062`) | 5,108 (`+1.107`) | `+0.107` |

- T1 的 quality 非劣且串行总延迟 p95 ratio 上界 `1.0376`，但 token ratio 上界 `1.0567`，Schema request 差上界仅 `-0.090`，两条效率路径都失败。
- T2 的 success/选择/参数下界分别低于非劣门，且 Token 与往返都更差。
- T3 的 quality 非劣，但 token ratio 上界 `1.0788`、Schema request 差上界 `+0.1467`，效率失败。
- T0 是唯一 `eligibleArmId`，其自身 component latency gate 为 1.0；这只支持 AR2-S 阶段选择。

`wrong calls` 与精确选择共同承载误调/漏调；`model round trips` 记录完整 600-family 质量运行的模型请求总数。串行 p95/TTFT 只由独立 LS2 计算，不能从这张并行表推断。

## 初始复杂度、处置与限制

- T0 不需要 meta Tool、catalog/search index、额外模型往返或候选专用生产模块；T1–T3 都会增加发现协议状态和维护面，却没有通过冻结效率门。
- 主仓库没有发现候选实现、依赖、Schema、IPC、Settings 或 feature flag；外部 runner/原始结果不会合并。没有为了“备用”保留 T1–T3。
- 未运行 H7，所以不能声称 T0 已通过完整 Harness、长程、Approval、Steering、Recovery 或 untouched holdout；也不能把 Codex 或 MCP 当前实现行为写成 T0 的产品依据。
- 若仓库所有者授权新的 HARNESS Decision，只有新 Manifest 明确绑定未漂移的模型、来源、Registry、task hash 与本分析，才能决定是否复用 D1 阶段证据；最终仍须新的联合 holdout 通过后才能实现一个生产发现协议。

## Source-derived 后继实验的完整晋升与淘汰链

旧 48-Tool `T0-Full/T1-Catalog/T2-Domain/T3-Search` 只属于初始自定义 meta-function 协议。2026-08-05 刷新 OpenAI Tool Search、OpenAI SDK、MCP 规范/SDK 和 Codex 当前源码后，后继实验改用 native Tool Search wire，并把“发现协议”和“ranker”拆开：

本轮锁定 `openai@6.49.0` tag commit `04671d278ef1531692ae31a870251eec90f3c2d2`（当日 main `f58d060deaa9149edfe2328ddbb6653dc4abf7f9`）、Codex commit `30d99232f485bd64eda9f6e0d9433bceebb2cb2b`、MCP 规范 `2026-07-28` commit `5c4f1768b97198a149d7db05f5026b30c6a3cb12` 与 TypeScript SDK commit `cc4b41617ce3601b1290d67216ea0b194a3cd9ac`。实际 MCP Client/Server 协商版本为 `2025-11-25`；它是本次 SDK/endpoint 行为，不能与所查规范版本混写。

| Arm | 模型首屏可见内容 | Schema 加载方式 | 角色 |
| --- | --- | --- | --- |
| `T0-FULL` | 全部 256/512 个完整 Schema | 无发现往返 | 直接基线 |
| `T1-HOSTED-REF` | source/namespace 名称、说明与 native server `tool_search` | Provider hosted search 加载 deferred Tool | reference，不让 Provider 拥有 Registry |
| `T2-CLIENT-BM25` | 相同 source/namespace 元数据与 `execution:"client"` | CharaMate BM25、limit 8，返回 native `tool_search_output` | client baseline |
| `T3-CLIENT-BILINGUAL` | 与 T2 相同 | 只把 ranker 改为中英 normalization/BM25 | ranker 增量 |

256 与 512 是 CharaMate 的常见/极限产品负载假设，不是 OpenAI 总 Tool 上限。1024 只完成 compatibility/task-bank 准备，在首个 scored request 前按产品代表性判断退休；它不计分，也不移入 H7。

### T0–T3 实际怎样运行

四个 Arms 面对同一份 Registry snapshot；Built-in、Skill、MCP 与 App Action 在模型侧都编译成同一个 native Tool Search/Function Tool 协议。MCP `server/discover/tools/list` 只负责 Adapter 在请求前取得 inventory，不是模型要再学的一套发现路径。

`T0-FULL` 的每次首请求直接把全部 256 或 512 个完整 function Schema 放进 `tools`；模型不需要 search，目标 Tool 从第一步就可调用。它的优点是没有发现漏召回或 search 往返，代价是每个请求都携带大 catalog。

`T1-HOSTED-REF` 把相同 Tool 按 namespace 组织为 deferred definitions，首屏只暴露 namespace 名称/说明和 `{type:"tool_search"}`。模型产生 server `tool_search_call` 后，由 Provider hosted search 返回 native `tool_search_output`，命中的完整 Schema 被追加到上下文尾部，再继续同一个 Response 链。CharaMate 仍持有 Registry、记录实际 loaded IDs，并只把 T1 当 hosted reference；Provider 不拥有 Run state。

`T2-CLIENT-BM25` 首屏同样只含 namespace/source 元数据，但 Tool Search 声明为 `execution:"client"`。实际流程是：

1. 模型输出带 `query` 和可选 `limit` 的 native `tool_search_call`；limit 上限固定为 8。
2. CharaMate 对 Registry metadata 做 BM25：文档字段包括 Capability ID/name/summary、domain/namespace/source kind、namespace description，以及 input Schema 的属性名、类型和说明；`k1=1.2`、`b=0.75`，英文按 NFKC、小写和简单词干化。
3. 取正分 top-8，按 score 后 Capability ID 确定性排序；把这些原始完整 Schema 编译成匹配同一 call ID 的 native `tool_search_output`。
4. call 与 output 原样加入下一请求尾部，只有被加载的 Capability 才可调用；若任务需要，模型可以再次 search，所有 search 与 product call 都进入 ledger。

`T3-CLIENT-BILINGUAL` 与 T2 的 request wire、limit、Schema、排序 tie-break 和四步流程完全相同，只替换 tokenizer/ranker：在英文 token 外加入中文单字、双字 token，并对冻结短语做英文扩展。因此 D1B 的差异能归因于 bilingual normalization，而不是“一个有 Tool Search、另一个没有”。

### 公平实验设置怎样做

- D1A 的 256-Tool catalog 由 48 个可评分核心 Capability 和 208 个 product-shaped distractors 组成，按 32 namespaces × 8 Tools 组织。Schema 覆盖 read/search/list、create/send、update/write、destructive、transfer/export、queued/action 等形态，并使用 path/range/query/revision、session/window、server/job/cursor、account/idempotency/approval 等真实字段；不能用一个通用模板复制 256 次。
- 同一个 task ID 在 T0/T1/T2（或 D1B 的 T2/T3）使用完全相同的用户目标、Registry bytes、Tool 实现、fixture 状态、Harness、Cache 状态和 oracle。唯一允许变化的是上表的 Schema 披露/搜索方式；paired block 内 Arms 串行，顺序按冻结 seed 平衡。
- Quality 的不同 blocks 可用 16 lanes 并行，但 lane 内不交叉 Arms；固定 100-task timing 使用相同 task subset，早期 D1A/D1B 为 `concurrency=1` 以隔离 Provider 排队。D1C 又用同一 512 tasks 对照 C16/C1 方向，确认结论不只来自串行条件。
- 每个 run 同时报业务终局、strict execution、exact Capability、exact first arguments、wrong/missed call、Direct/No-op 零调用、search 次数、首请求/全 Run logical input tokens、Provider usage、TTFT 与 end-to-end。业务终局不会因一次被拒绝但最终恢复的误调而重复扣分；strict 指标会如实扣分。
- 只有整对 408/409/429/5xx、掉流或 SDK timeout 可按冻结规则完整重试一次；Schema 400、模型/Manifest/hash 漂移立即标 setup/protocol invalid。不能只重跑输掉的 Arm，也不能把 smoke/calibration 拼进正式分母。

### 设置校准：R1、R2 为什么不算淘汰结果

| 轮次 | 实际情况 | 处置 |
| --- | --- | --- |
| source-first 前的早期 D1 | 已跑 600 quality、27 timing，之后发现候选未按最新一手协议定义 | 整轮不用于当前选择；raw 保留 |
| R1 | 16 blocks 中 42/48 runs 返回 HTTP 400；原因是嵌套 strict object 漏写 `required` | setup-invalid，完全不计分；raw `e3fd64a9…0d0d` |
| R2 | 96/96 calibration blocks、0 invalid，但 208 个 distractors 共用一个通用 Schema 模板 | 只证明 wire 可跑；现实负载准入失败，三 Arm 均不晋级，不启动 AR2 |
| R3 | 256 Tool catalog 改为 32×8、7 类产品形态 Schema，strict issues=0；live smoke 与证据屏障通过 | 才允许进入正式 D1A |

R1/R2 是实验设置或负载代表性问题，不是“某个候选质量差”。它们不能与正式分母拼接，也没有通过简单重跑个别错误样本改成有效结果。

### D1A：协议筛选 `T0/T1/T2`

D1A AR1 有 96 paired blocks，三个 Arms 都暂时存活；它只用于发现明显错误和验证现实 request shape。正式 selection 为 600 个 256-Tool paired blocks，另有固定 100-task timing，并以 200 quality/100 timing 的 512-Tool cohort作规模压力。

2,700 个已有 runs 在不覆盖 raw、不调用 Provider 的前提下确定性重评分，把“业务终局”和“严格 Tool 执行”拆开；旧字段与新主 scorer、独立 scorer 的差异均为 0。256 quality 结果为：

| Arm | 业务终局 | strict | exact Capability | 中文 exact Capability | wrong calls | 总 input token ratio（对 T0） |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| T0 | 599/600 | 588/600 | 589/600 | 230/240 | 20 | 1.000 |
| T1 | 599/600 | 533/600 | 557/600 | 218/240 | 94 | 0.208 |
| T2 | 600/600 | 571/600 | 586/600 | 230/240 | 50 | 0.135 |

T1 虽省 Token，但 strict、Capability、中文选择和 wrong calls 明显落后，淘汰。T0 的唯一 safety 计数是最终 evidence ID 拼写错误造成的 false completion，三项外部副作用仍为 0；T2 的四项副作用均为 0。T2 相对 T0 的业务、Capability、参数通过原 `-2pp` 非劣界，但 wrong-call-free 下界为 `-4.167pp`，所以 D1A 原机械结果仍是 no-winner，而不是把 T2 直接宣布胜者。

512 规模补充中 T0/T2 业务终局均 200/200，strict 为 200/200 与 199/200；串行 TTFT p95 为 `25.555s/7.204s`，总延迟 p95 为 `57.050s/41.671s`。结合 256 证据，只让 T2 作为 client candidate 进入 D1B/D1C；T0 继续作为直接基线，不是生产 fallback。

### D1B：只比较 ranker `T2/T3`

D1B 保持 native client wire、catalog、limit 8、任务和 scorer 完全相同，只改变中英 normalization/BM25。600 quality 与 100 timing paired blocks 均 0 invalid：

- T2/T3 业务终局为 600/600 与 599/600；strict 为 562/600 与 566/600。
- 中文 exact Capability 完全相同，均为 226/240；没有证明 T3 的中文收益。
- T3 的 timing TTFT p95 ratio 单侧 95% 上界为 `1.2467`；实现还多一层 normalization。

因此按预写门槛和复杂度选择 T2 进入 D1C，淘汰 T3。Decision SHA-256 为 `4a29867e…ebca`。这个阶段只选择 ranker，仍不等于生产 Discovery 获胜。

### D1C：现实多步工作流与机械/产品分叉

D1C 用 12 类现实多步 workflow，分别在 256 与 512 Tool 层运行 300 quality + 100 timing paired blocks；两层分别计分，不把规模当 Arm。任务覆盖 Direct/No-op、File、Command Long Run、Browser/App Action、MCP、Skills、Cross-source、外部等待、Steering、Recovery、Approval/Cancel，Schema 使用各 domain 的真实字段而非统一 `fixtureId + target`。

| 层 | T0 / T2 业务终局 | Tool/参数/wrong-call-free | T2 input token | T2 timing | 机械处置 |
| --- | --- | --- | --- | --- | --- |
| 256 | 299/300 / 300/300 | 两 Arm 三项均 300/300 | input upper ratio `0.5784` | end-to-end p95 point `0.9463`，但上界 `1.1190` | T2 因 `>1.10` 不合格 |
| 512 | 300/300 / 300/300 | T0 为 299/300、299/300、298/300；T2 均 300/300 | input upper ratio `0.3023` | C1 end-to-end `0.5805`（上界 `0.6136`），TTFT `0.2447`（上界 `0.2943`） | T2 合格 |

512 的相同 100 tasks 在 quality C16 与 timing C1 下，T2/T0 的 end-to-end、TTFT 方向一致，且两种并发均无 429、protocol-invalid 或 infrastructure-invalid。这证明收益不是只由串行排队偶然造成，但不能外推成任意并发的协议保证。

原 Manifest 机械执行会因为 256 单项区间上界选择 T0，该结论完整保留。结果全部可见后，仓库 owner 判断 `1.10` 是决策启发式而非协议/正确性红线；T2 在 512 完整通过、两层业务质量非劣、Token 大幅下降，并在高压层显示稳定时延收益，因此用 post-result product-tradeoff amendment 选择 T2。1024 未运行的 scored 分母明确退休，没有挪到 H7 或用 smoke 代替。

### 联合确认与生产处置

T2 随 H3–H6 与 Cache On 进入 H7 W2，而不是单独再造一个“Discovery holdout”。H7 Quality 的 300/300 blocks 有效，No-op discovery/product calls 均为 0，产品语义终局 300/300，因此 T2 作为 `HC-FINAL` 的内部组件被接受。生产重写只保留一条 client native Tool Search 路径；T0/T1/T3、旧 48-Tool meta functions、候选 catalog、runner 和 Arm IDs 全部留在仓库外归档或删除。

本记录不能声称：T2 在所有 Tool 数量、Provider 或语言上总是更优；512 是产品压力假设而非协议上限；H7 联合结果也不能拆成 T2 的独立因果效应。专用 H7 Timing 100 已由 owner waive 而不是通过；后续只在生产单路径的集成/E2E 和实际遥测中继续验证时延。
