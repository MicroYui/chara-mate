# PROVIDER-PROMPT-CACHE 决策记录

> Decision ID：`PROVIDER-PROMPT-CACHE`
> 状态：完成；选择 Cache On（无 key、无显式 breakpoint、implicit、TTL 30m）
> 初始决策日期：2026-08-03
> 后继定案日期：2026-08-07

## 当前决策

生产 OpenAI Adapter 选择一条 Cache On 路径：不发送自定义 `prompt_cache_key`，不增加显式 breakpoint，使用 implicit 模式与 Provider 当前最小 `30m` TTL。它不是 Settings、运行模式、fallback 或动态策略；其他 Provider 只在各自协议支持时实现同一 Adapter 合同。

source-derived `PC0-ENABLE` 在 96 个 paired traces 上两 Arm 均 96/96 成功。Cache On/Off 的 advertised input-cost ratio 为 0.3419，单侧 95% bootstrap 区间 `[0.3283, 0.3564]`；latency ratio 为 0.9982，区间 `[0.9708, 1.0256]`，因此选择 Cache On。后续单变量阶段选择省略 key、无 breakpoint 与 implicit，组合 Arm 为 `PM0`。

最终 paired confirmation 的 Quality 有 298 个有效 pair（2 个整对 HTTP 408 基础设施排除）。Cache On 的总输入成本比为 0.2990，90% bootstrap `[0.2711, 0.3356]`，每成功任务成本比为 0.2951；约节省 70.1%。strict success 差为 +1.01pp，区间 `[-1.01pp, +3.02pp]`，质量非劣、安全与限流检查通过。固定 100-task Timing 中 TTFT p95 ratio 为 1.2465，90% bootstrap `[1.0322, 1.3404]`，超过预注册 1.05 启发式，因此机械结论仍选择 Cache Off。

仓库 owner 明确要求综合业务完成、成本、副作用与复杂度，而不让 TTFT 1.05 单项启发式自动 veto。最终产品 amendment 选择 Cache On；原机械结论、阈值与 paired observations 均保留。mechanical decision SHA-256 为 `ef4a75f4…a2c59`，产品 decision 记录了其完整 hash 链；H7 W2 继续使用相同 Cache On 策略，300/300 Quality blocks 无 Cache contamination invalid。

## 初始决策（2026-08-03）

本轮不在生产 Provider Adapter 中增加 Prompt Cache 专用代码。PC1 选择省略 `prompt_cache_key`，PC2 选择不设显式 breakpoint，PC3 因没有 breakpoint 而跳过；但最终 PC4 quality paired comparison 在第 3/300 个 task 发现两 Arm 的首个语义请求不相同，按预注册协议错误门在 28 个 Provider requests 后立即停止。

因此没有足够、公平的 PC4 分母，任何早期费用或 TTFT 点估计都不能用于晋级。`PC0-OFF` 只是在后续 AR2 中隔离缓存变量的实验 control，不是“Off 获胜”，也不是产品默认。

## 研究问题与 Arms

问题是：对固定 `copilot_api/gpt-5.6-sol` Responses-compatible 路径，是否存在一个固定 key/breakpoint/mode 策略，能降低 Provider 报告的 token-equivalent input cost 与 TTFT，同时不损害任务质量、安全、配额和维护复杂度？

实验按单一变量串行选择：

| Phase | Arm A | Arm B | 唯一变量 |
| --- | --- | --- | --- |
| PC1-KEY | `PK0` 省略 key | `PK1` stable-derived key | 是否发送 `prompt_cache_key` |
| PC2-BREAKPOINT | `PB0` 无断点 | `PB1` 一个稳定前缀断点 | 是否标记 breakpoint |
| PC3-MODE | `PM0` implicit | `PM1` explicit | 是否禁用额外 implicit breakpoint |
| PC4-QUALITY | `PC0-OFF` | PC1–PC3 选出的策略 | 只改变缓存策略，其他语义请求相同 |

Prompt Cache 是请求优化，不改变 Run、Context、Tool、Approval 或最终回答语义。候选不得成为 Settings、feature flag、Schema/IPC 字段或 fallback 链。

## 一手来源边界

执行日 2026-08-03 复核了 OpenAI OpenAPI `2.3.0`、[Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)、[GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol) 与 [Pricing](https://developers.openai.com/api/docs/pricing)，以及 `openai@6.49.0` commit [`04671d2`](https://github.com/openai/openai-node/tree/04671d278ef1531692ae31a870251eec90f3c2d2)。执行日 openai-node main 为 `aeab0549…`，但 npm latest 与锁定 tag 仍为 `6.49.0`。

官方协议事实包括：完全相同前缀才可命中；`gpt-5.6` 及之后模型的最小可缓存前缀为 1,024 tokens；`explicit`、breakpoint、`cached_tokens` 与 `cache_write_tokens` 有定义；cache write 为未缓存输入价的 `1.25×`；缓存不减少 logical input、上下文占用或 TPM，也不复用最终回答。SDK 的字段形状和 600 秒 timeout 是 `6.49.0` 当前行为。10% 最小费用收益、5% TTFT 上界、复杂度顺序与 concurrency=1 是 CharaMate 预注册启发式，不是协议硬限制。

本结论只覆盖该 pinned gateway/model。不能外推至 OpenAI 直连、Azure 或其他 OpenAI-compatible Provider；真正实现前还需各自 Contract Test。

## 工件、环境与数据

- 主 Cache Manifest：`PROVIDER-PROMPT-CACHE-PREREG-v7`，SHA `48002002…6bc`；V8 artifact index `ee1250de…f2d0`。
- 执行补充：`CHM-P2-CACHE-PREREG-20260802-V10`，index `12cde984…1578`，supplement `70b76473…f64d`，runner source set `c0362ec6…2916`。
- Cache trace bank：96 条，SHA `c4cb5bb4…08b3`；PC4 quality subset：300 个 AR2-S tasks，SHA `f043bedc…298f`；四个稳定 prefix records SHA `ccd33a4d…ca28`。
- Provider/硬件与其他 Agent 实验相同：`@jeffreycao/copilot-api@1.14.14`、`gpt-5.6-sol`、`reasoning=max`、M4 Pro、macOS `26.5.2`、Node `24.18.0`。
- 所有 Cache phase、paired blocks、Arms 和 Provider requests 固定 `concurrency=1`；namespace 按 Arm 隔离，运行时不得动态升降。

这些是 CharaMate 合成 trace 和 task，不是 OpenAI 官方费用校验数据集。原始 JSON/JSONL 在仓库外按 SHA 保存，不含真实密钥、用户数据或不可公开内容。

## 预注册门槛

1. Capability gate 必须证明 explicit-off 的 read/write 为 0，断点前 mutation miss，断点后 mutation 仍复用稳定前缀，usage 可与 request ledger 对账。
2. 相对 PC0-OFF，每请求与每成功任务的 token-equivalent input-cost ratio 95% 上界都 `<=0.90`。
3. TTFT p95 ratio 95% 上界 `<=1.05`，且没有 cache-policy-attributable 429。
4. success、Tool 选择和参数正确率差的 95% 下界都 `>=-2pp`；所有 Harness safety count 为 0。
5. 费用差 `<5pp` 且延迟不可分辨时，按 `Off < key < breakpoint < explicit-only` 选择更简单策略；不可对账或语义 payload 不同则无胜者。

## 结果

### Capability、PC1–PC3

- Capability gate 通过：evidence `80ccb582…b349`，analysis `08700cf6…1667`。
- PC1 完成 96 paired traces/Arm、480 requests/Arm，raw `7b1501d7…db07`，analysis `29b0dce1…1869`。PK1/PK0 advertised input-cost ratio 点估计 `0.9706`，95% 区间 `[0.7688, 1.2185]`；TTFT p95 ratio `0.9815`，区间 `[0.8004, 1.2370]`。费用差不足 5pp且延迟不可分辨，选择更简单的 PK0（省略 key）。
- PC2 完成 96 paired traces/Arm、480 requests/Arm，raw `4fe3b8d9…76ab`，analysis `f4248ab4…cd6`。PB1/PB0 cost ratio `1.0501`，区间 `[0.8496, 1.2926]`；TTFT p95 ratio `1.0826`，区间 `[0.8819, 1.2560]`。选择更简单、风险更低的 PB0（无 breakpoint）。
- PC3 因 PC2 没有 breakpoint 而预注册地跳过，skip evidence `b9761b83…b1f6`，analysis `966129a3…38d`。

这些是阶段选择，不证明最终 quality/cost gate 已通过。

### PC4 公平性停止

PC4 计划 300 paired tasks，实际写入 3 blocks、启动 28 requests。前两块语义 payload 匹配；第三块 `AR2SV8-EF7691AF23FB` 的首个 semantic request SHA 为：

- PC0-OFF：`f65d1196…3769`
- selected candidate：`72a89eb0…a77d`

原因是 Browser fixture 的两个独立 runtime 把随机 OS loopback port 暴露给了模型，使 Arm/runtime 实例产生不同语义输入。按冻结规则这属于 protocol-invalid paired evidence，不能比较 Cache 效果。raw `fe6884c0…1bf5`、stop `9fac4480…b9dc`、analysis `7ece6227…95c0`。冻结的 quality 分母是 success `300`、Tool selection `260`、arguments `1,875`；实际有效证据分别只有 `2/300`、`2/260`、`2/1,875`，远不足以评估对应门槛。独立复评分差异为 0，所有已尝试 safety count 为 0，但分母不足且语义公平性失败。

在任何 AR2 live sample 前，实验 fixture 把模型可见值更正为稳定的 managed-loopback resource ID，内部仍使用真实随机端口；该修正 source SHA `84366ab1…c3c7`。它只保证后续实验公平，不追溯修复、补样或重跑 PC4，所以本 Cache Decision 仍是无胜者。

## 初始复杂度、处置与限制

- 没有生产 Cache 代码、依赖、配置、key namespace、TTL、breakpoint、Settings 或兼容分支；PC0-OFF 也没有被实现为一个可切换模式。
- 外部一次性 runner 和原始证据不会合并；后续 AR2 使用 PC0-OFF 只是隔离缓存变量。
- 不能声称 Prompt Cache 无效。实验只能声称：在本次公平性停止后，没有足够证据选择任何策略。
- 如需重试，必须新建 Provider-specific Decision，先冻结已修正的模型可见 fixture 和全新 PC4 namespace；不得复用这 3 个 blocks、循环 capability probe 直到成功，或把早期 cost/TTFT 点估计当结果。

## Source-derived 后继实验的完整晋升与淘汰链

初始 PC4 因语义 payload 不同而公平性停止，不能据此选择 On 或 Off。修复 Browser fixture 后没有追溯补完旧 PC4，而是新建独立 source-derived Decision，冻结最终 Harness compiler 的真实请求形状，并先回答“缓存本身是否值得启用”，再逐项判断 key、breakpoint 和 mode：

后继实验于 2026-08-05 复核 OpenAI Prompt Caching、Pricing、Responses 与模型文档，并锁定 `openai@6.49.0` tag commit `04671d278ef1531692ae31a870251eec90f3c2d2`、当日 main `f58d060deaa9149edfe2328ddbb6653dc4abf7f9`。当前 cache 字段、usage 和 TTL 是本次 endpoint 行为；10% 成本收益、1.05 TTFT 与复杂度顺序仍是 CharaMate 启发式。

### 每个 Cache Arm 实际怎样编译请求

所有 Arms 先生成同一个最终语义请求，再只修改以下 cache-only fields；分析器去除 `prompt_cache_key`、`prompt_cache_options` 和 breakpoint marker 后校验 matched-task request 相同：

| Arm | 实际请求编译 |
| --- | --- |
| `PC0` | `prompt_cache_options={mode:"explicit", ttl:"30m"}`，但不放任何 breakpoint；该 endpoint 实测 read/write 均为 0，用作 Cache Off |
| `PK0` | `mode:"implicit", ttl:"30m"`，无 key、无显式 breakpoint；让 Provider 按完整相同前缀自动命中 |
| `PK1` | 在 PK0 上增加稳定 `prompt_cache_key`；key 由 model、Registry hash、Discovery envelope hash 与 stable-prefix hash 派生，不含明文用户内容 |
| `PB0` | 沿用 PC1 胜者，不加 breakpoint |
| `PB1` | 只在稳定 developer prefix 最后一个 content block 加 `prompt_cache_breakpoint={mode:"explicit"}`，动态用户/Tool 尾部仍位于其后 |
| `PM0` | 沿用 PC1/PC2 胜者，`mode:"implicit"` |
| `PM1` | 同一 key/breakpoint 形状，只改成 `mode:"explicit"` |

阶段顺序是因果的：PC0 若选 Off，PC1–PC3 直接 `not-applicable`；PC1 只比较 key；它的胜者固定后 PC2 才比较 breakpoint；PC1/PC2 胜者再固定后 PC3 才比较 mode。不能拿 PM1 的结果反向重选 PC1。

### 96-trace 和最终 confirmation 怎样设置

- 96 traces 来自 12 个真实请求族 × 每族 8 条：Approval、Steering、Browser/File observation 增长、MCP pagination、compaction follow-up、稳定 chat continuation、断点前/后 mutation，以及 native Tool Search 尾部单次/多次加载和 recovery candidate 加载。每条 trace 有 first-write、至少两次 warm continuation 和对应动态事件。
- traces 交叉覆盖 short、约 272K、resolved 922K input budget 的 85%–98%，以及 256/512 Tool；每族语言为 `3 en / 3 zh-CN / 2 zh-en`，难度轮换。所有长度用真实最终 compiler 序列化后由 Provider `usage.input_tokens` 校准，不靠字符数或 padding。
- `prompt_cache_key` 不是官方承诺的独占 cache partition，所以每个 block 给两 Arm 各一个全新 opaque prefix cohort，首个 cache-enabled request 必须 `cached_tokens=0`；cohort 按交叉顺序平衡。若首请求已命中，整对记 cache-contamination invalid，而不是假装 cold。
- PC0–PC3 各 96 blocks、12 lanes；同一 block 两 Arm 串行，四个阶段彼此串行，E12 只审计证据。最终确认另用 300 个完整产品 workflows（Quality 8 lanes）和固定 100-task subset（Timing 4 lanes）；warm-up writes 标记后不进入 paired latency。
- 每请求保存 input/cached/write/uncached tokens、stable-prefix bytes/hash、语义/序列化 request hash、TTFT、duration、HTTP/stream 状态和任务输出。成本统一按执行日短/长上下文 input、cache-read、cache-write 价格逐请求重算；先要求任务点估计非劣，再比较 paired input cost，不用“未缓存 Token 少”代替真实费用。

### 计分前的无效批次与设置修正

正式 96-pair PC0 不是第一次尝试的残余样本；此前三次受影响批次都整批归档、不计分，并从 Cache load calibration + PC0 完整重跑：

| 批次 | 暴露的问题 | 为什么不能计分 / 怎样修正 |
| --- | --- | --- |
| Tool Search round-trip pre-fix | 跑到 17 个 PC0 blocks 后出现 HTTP 400：runner 在上一请求伪造 `tool_search_call`，下一请求才补 output | 两 Cache Arms 同点失败，属协议设置错误；改为模型原始 call 与匹配 `tool_search_output` 原子回放，并在发请求前断言无悬空 call ID |
| sequence endpoint calibration pre-fix | 跑到 50 blocks 时发现长上下文校准只量最后请求；同一多 Turn sequence 的早期请求低于注册 band | 属 load setup-invalid；改为同时测首/末请求，两端都必须在 band 内，再用中点调记录数 |
| output-budget/bootstrap pre-fix | runner 把每个 checkpoint 的 `max_output_tokens` 覆盖成 128；1,112 个 samples 中 920 个因此停在 max output，完整 trace 只有 PC0 1/94、PK0 0/94；同时 checkpoint schema 每步变化破坏稳定前缀，过细分层产生 singleton CI | 这就是曾看到的“输出到上限”问题，但它不是候选失败或 Provider output-too-large；质量门已不可用，整批作废。改回最终 compiler 的 16,000 output budget、稳定 checkpoint schema + 动态 expected value，并按 task family + context layer 分层 |

修正后、正式 PC0 计分前，owner 在 H4 已证明 12 条长上下文 lanes 无 429/invalid、且 Cache C8 的首 12 条未计分校准也无错误后，把 policy selection 从 C8/E8 固定提高到 C12/E12；paired Arms 仍串行。那 12 条 C8 calibration 只作并发准入，不进入任何选择分母。最终 PC0–PC3 均为 96/96 valid、0 protocol/load/infrastructure/cache-contamination invalid。

| 阶段 | 唯一变量 | 有效 pairs | 主要结果 | 选择与淘汰 |
| --- | --- | ---: | --- | --- |
| `PC0-ENABLE` | Off `PC0` 对 On `PK0` | 96 | 两者 96/96；On/Off cost `0.3419 [0.3283, 0.3564]`，latency `0.9982 [0.9708, 1.0256]` | 选择 On；Off 留作最终配对 control，不作 fallback |
| `PC1-KEY` | 无 key `PK0` 对 stable-derived key `PK1` | 96 | 两者 96/96；PK1/PK0 cost `0.9966 [0.9273, 1.0699]` | 收益不可分，按复杂度淘汰 PK1，选择无 key |
| `PC2-BREAKPOINT` | 无 breakpoint `PB0` 对一个显式 breakpoint `PB1` | 96 | 两者 96/96；PB1/PB0 cost `1.0318 [0.9775, 1.0877]`，latency 上界 `1.0568` | 无收益且略差，淘汰 PB1，选择 PB0 |
| `PC3-MODE` | implicit `PM0` 对 explicit `PM1` | 96 | 两者 96/96；PM1/PM0 cost `2.9148 [2.7966, 3.0364]`，PM1 本轮 cached tokens 为 0 | 淘汰 PM1，选择 PM0 |

`PC0-ENABLE` 的第一请求 cold 检查两 Arm 均 96/96，On 的 cache read share 为 78.88%；raw/analysis/decision SHA-256 为 `fcfd8d79…c2b9` / `54e67aad…01f` / `a295da57…1021`。PC1–PC3 每阶段都重新冻结 96 paired blocks、0 invalid，只把前一阶段胜者带入下一阶段，不能从后面的结果反向改前面的 Arm。

最终 composed policy 为：`enabled=true`、不发 key、无显式 breakpoint、`mode=implicit`、`ttl=30m`，组合 Arm `PM0`。stage selections 为 `PK0/PB0/PM0`，composed Decision SHA-256 为 `98c35d79…eee5`。TTL 是本次 pinned Provider 的当前可用值，不是跨 Provider 常量。

### 最终 paired confirmation

组合策略随后与 Cache Off 在最终产品请求形状上重新配对，而不是用 PC0–PC3 的短 trace 直接宣称生产胜者：

- Quality 计划 300 pairs；2 个任务因整对 HTTP 408 基础设施失败排除，最终 298 个有效 pairs。排除规则在 Arm outcome 之外应用，不把单边成功拼回分母。
- Cache On/Off 总 advertised input-cost ratio 为 `0.2990`，90% bootstrap `[0.2711, 0.3356]`；每成功任务为 `0.2951`，即约 70.1% 成本下降。
- strict success 差为 `+1.01pp`，90% 区间 `[-1.01pp, +3.02pp]`；Tool/参数、业务终局、安全和 429 检查满足非劣要求。
- 固定 100-task Timing 的 TTFT p95 ratio 为 `1.2465`，90% bootstrap `[1.0322, 1.3404]`；这是实测退化，不是输出过大错误或可跳过样本。

按原预注册机械规则，TTFT 上界超过 `1.05` 会选择 `FC0-CACHE-OFF`；mechanical Decision SHA-256 `ef4a75f4…a2c59`，没有被删改。用户随后明确把 1.05 视为决策证据而非自动 veto：它是 CharaMate 启发式，不是协议、正确性或不可逆副作用红线；在质量非劣、零安全回归、零限流回归且成本约下降 70.1% 的前提下，综合产品价值选择 `FC1-CACHE-SELECTED`。产品 amendment 只改最终选择，不改观察值、区间或机械阈值；产品 Decision SHA-256 `67d8d519…6114`。

### 联合确认、处置与限制

H7 W2 固定使用同一 Cache On policy，300/300 Quality blocks 有效且无 cache-contamination invalid。这证明它能进入最终 Quality 组合，但不消除 TTFT p95 退化，也不等于 H7 Timing 已通过。未来实现只在该 OpenAI Adapter 中编译一条固定 Cache On 请求路径；不保留 Off fallback、动态 key、breakpoint、explicit mode、用户设置或实验 Arm。

本结论只覆盖当前 pinned OpenAI-compatible gateway/model。Cache 不减少 logical context、TPM 或回答生成；其他 Provider 需要各自协议 Contract Test，不能照抄 30m TTL 或 usage 字段。本轮 H7 `$8.29`/task 来自近 context-budget 压力任务，不是普通会话成本均值。产品实现应观测实际 TTFT 与成本分布，但不能为此恢复双路径。
