# CONTEXT-RECIPE：长期记忆与当前 Run 的唯一装配方式

## 问题与边界

本 Decision 在 `MEMORY-RETRIEVAL` finalist 冻结后，选择近期原文、结构化 handoff、长期 Memory 与按需 `memory.search` 的唯一组合。当前用户目标、附件、最新 steering、审批结果、必要 Tool Result/Schema 是既有正确性约束，不作为某个 Arm 的隐藏得分；本实验只比较可裁剪的历史和长期信息。

协议硬限制、来源行为和 CharaMate 启发式分开。Provider 返回的有效输入预算是运行时约束；OpenAI Responses 的 compaction item 与 Codex 当前 handoff/近期用户消息行为只是候选来源。slot 顺序、近期窗口、topK 和预算是本实验选择，不从其他项目直接复制。

自定数值只作证据。最终同时报告长程回答/任务成功、来源一致性、工具调用、输入 Token、TTFT、成本、压缩后保留与实现复杂度；不因某个 CharaMate 门槛单项越线机械否决整体更优方案。机械结论与产品选择不一致时保留结果并写透明 amendment。

## 来源与环境

- 执行日：2026-08-08；基线 commit `d539dff367a5e8af544d6dcf28e1112e8311d63b`；Apple M4 Pro、24 GiB、macOS/Darwin `25.6.0`、Node `24.18.0`。
- OpenAI 官方 Responses Compaction 文档与 OpenAPI `2.3.0`；Codex 公开源码 commit `3aae5d885bac39c1262491aa3fd100dfd8b3919f` 的 compaction/turn context 行为，均已在研究设计与 `HARNESS-LOOP` 记录。它们不定义产品 Recipe。
- 目标 live profile：本机 `copilot_api 1.15.2`、`gpt-5.6-sol`；离线 screen 不依赖 Provider。若 live endpoint 漂移，保留 protocol invalid，不把它算成 Arm 失败。
- Memory 组合的离线/live 比较使用产品中文 Memory 68 问及 LongMemEval/LoCoMo 确认子集，查询与 evidence hash 复用 `MEMORY-RETRIEVAL`。当前目标、结构化回答、图片引用、steering、审批决定、最新 action Tool Result 和未完成 Plan 属于宿主正确性约束，不混进模型 Arm 得分；它们由 `runtimeMechanics.unit.test.ts` 与 `agentRuntime.test.ts` 的强制压缩/重启回归逐项验证。这样不会用一项可权衡平均分掩盖必要边界丢失，也不虚构一个实际未运行的长会话模型数据集。

## Arms 与分阶段设计

| Arm | 近期历史 | handoff | 预注入 Memory | `memory.search` |
| --- | --- | --- | --- | --- |
| `C0-FULL` | 尽量完整 | 无 | 无 | 无 |
| `C1-WINDOW` | 有界近期 | 结构化 | 无 | 无 |
| `C2-PRE8` | 同 C1 | 结构化 | top8 | 无 |
| `C3-TOOL` | 同 C1 | 结构化 | 无 | 有 |
| `C4-PRE2-TOOL` | 同 C1 | 结构化 | top2 | 有 |
| `C5-PRE8-TOOL` | 同 C1 | 结构化 | top8 | 有 |
| `C6-DYNAMIC` | 同 C1 | 结构化 | 按检索置信/问题复杂度动态 | 有 |

先用全部冻结样本做离线证据可达性、污染和 Token screen；明显被 C4/C5 支配的 Arm 不进入 live。live 只比较仍有竞争力的 finalist，避免为形式完整运行 7×全量模型网格。然后在胜者上做顺序消融：Persona/Memory 靠前、当前目标靠末尾；目标与未完成项相邻；Tool Result 与其调用相邻。

## 指标与综合选择

- 回答正确、知识更新、跨记忆组合、abstention、来源引用一致；
- 当前目标/steering/审批/必要 evidence 保留（正确性红线）；
- `memory.search` 调用率、漏调率、无效调用、预注入后仍重复调用；
- input/cached/output Token、TTFT、总延迟与 Provider 报告成本代理；
- 压缩率、旧事实污染、失效/被取代 Revision 误入；
- slot、持久状态、恢复和测试复杂度。

能力相当选择更短、更确定、对模型主动调用依赖更少的 Recipe；少量预注入是否值得由最终回答增益决定，topK 本身不是晋级目标。最终发布只有一个 Recipe，不按模型或用户设置分支。

## 结果

### 离线筛选与 runner 修正

R0 FTS 冻结后，2,191 个可评样本的确认段均值如下：

| Arm | 可达 evidence | 预注入 evidence | 平均注入字符 | 平均无关条目 | 额外状态 |
| --- | ---: | ---: | ---: | ---: | ---: |
| C0 FULL | 100% | 100% | 123,759 | 531.8 | 0 |
| C1 WINDOW | 2.5% | 2.5% | 0 | 0 | 1 |
| C2 PRE8 | 57.9% | 57.9% | 1,519 | 7.28 | 1 |
| C3 TOOL | 57.9% | 2.5% | 0 | 0 | 2 |
| C4 PRE2+TOOL | 57.9% | 42.0% | 386 | 1.53 | 2 |
| C5 PRE8+TOOL | 57.9% | 57.9% | 1,519 | 7.28 | 2 |
| C6 DYNAMIC | 乐观上界 57.9% | 2.5% | 0 | 0 | 3 |

C0 的全量上下文污染和输入规模不可接受；C1 证据不足；C5 与 C2 的 evidence 完全相同但多一个工具状态；C6 没有已冻结且可解释的动态规则。live 因此只比较 C2、C3、C4。

Tool runner 首次返回与生产不一致的 `{memories: "..."}`，随后又忽略模型实际提交的 query、总是返回原始 top8，导致模型重复调用。该协议缺陷在首个样本即发现，没有形成完整结果。修正版返回生产形状 `hits[]`，并在同一只读 R0 索引上执行模型实际 query；重复或无新增 evidence 只作为指标，不再让整个实验崩溃。

修正后的第一次完整 live 仍固定按 C2→C3→C4 执行，存在 Provider 顺序/缓存混杂。对应主实验和顺序实验分别保留为 `context-live-raw.order-confounded-v3.json`（SHA-256 `2081d867c5aabf17fbf0543a04a1196230d7729c40f29b639bdc4e87a706effa`）与 `context-order-live-raw.order-confounded-v3.json`（`31f93dc4c3aba6e0b2e3fd639a92a2bf955dc7a70b8a7d9ed9ef83fb4adb819f`），均排除。最终 method v4 按冻结样本索引循环轮换，三个 Arm 的首位次数为 6/6/5 的平衡排列。

### 平衡 live 结果

| Arm | 正确 | 全部主张有证据 | 工具样本 / 调用 | 无 final | input / cached / output Token | 总延迟 p50 / p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| C2 PRE8 | 14/17 | 17/17 | 0 / 0 | 0 | 13,998 / 6,033 / 1,760 | 2.41 / 6.02 s |
| C3 TOOL | 13/17 | 15/17 | 17 / 27 | 2 | 40,002 / 8,964 / 2,478 | 5.26 / 9.63 s |
| C4 PRE2+TOOL | 13/17 | 16/17 | 5 / 6 | 0 | 15,105 / 1,109 / 1,561 | 2.99 / 12.29 s |

C2 在正确数、supported、稳定完成、输入量和尾延迟上整体最好；C3 的模型主动调用没有换来质量优势，反而出现 2 个三步后无 final；C4 降低预注入字符，但 5/17 样本仍需工具，正确数少 1，p95 更高。最终有效 offline/live SHA-256 分别为 `9d3df1440f27615f0b220dee8fa09f7781ded26891a8f5c70d8347ca00fbc900` 与 `c788281785d4ee13bba7b8296d23f01a94e60d52bc2f5220fa44b74196470090`。

在 C2 上做平衡顺序消融时，两种顺序均为 12/17 正确、17/17 supported、无失败。`goal-last` 的 input/cached/output 为 `13,998/6,033/1,762`，总延迟 p50/p95 `2.60/6.00 s`；`goal-first` 为 `13,998/0/1,502` 和 `2.44/4.86 s`。后者在这 17 题的尾延迟较低，前者保留同等质量且命中 6,033 cached tokens，并让稳定 handoff/Memory 在当前动态目标之前，符合当前目标靠近末尾的宿主正确性。有效顺序 offline/live SHA-256 分别为 `a7bf72941fee4f0064d70e00b4db3402631ee99bc8c1469a4ef2442531b6f8ca` 与 `7d6c13d050f608076d0532f46b70d850526a8affcd865fe008e43db4ee06a4fa`。

## 综合定案

选择 **C2 PRE8 + goal-last**：有界活跃上下文与结构化 handoff 在前，每个新 Run 用已选 R0 对当前用户请求检索一次 top8，Memory evidence 随后进入 checkpoint，当前用户输入置于末尾。每条 evidence 带 Memory ID、Revision ID、创建/更新时间、来源和状态；模型续步、工具 continuation、重启恢复与 steering 不重复执行初始检索。压缩时保留当前/最新结构化用户输入、Memory evidence、当前 handoff、未完成 Plan/输入边界与最新必要 action Tool Result。

`memory.search` 仍是产品要求的 Agent 能力，但它不属于自动 Context Recipe：默认以 deferred Tool Search 形式存在，仅在用户明确要求检查或搜索预注入范围之外的 Memory 记录时加载；Chat 和普通 Agent 回答不把它常驻或重复调用。这样保留一个 Retrieval Pipeline 和一个自动 Recipe，也不把被 C2 离线支配的 C5 偷渡成常驻路径。

顺序选择是综合取舍：goal-first 的本次 p95 确实更低，记录不删除；两者质量相同，而 goal-last 提供实际 cache 命中和更清楚的“当前目标最后”结构。没有把 p95 当自动否决线，也没有按模型或用户设置保留第二种顺序。

候选 runner 已移入可恢复废纸篓；生产只有一个 checkpoint item 形状和一个 formatter，没有 C0–C6 分支、动态 topK、Recipe 设置或第二装配器。当前目标、图片引用、steering、结构化回答、审批、Plan 和 action evidence 的强制压缩/重启回归独立通过，避免用 17 题平均分掩盖正确性红线。

## 限制

- live 结果只支持记录的目标 Adapter/模型，不声称所有 Provider 都有相同 Tool 主动性；生产仍使用一套可恢复 Recipe。
- 产品集集中于个人桌面记忆，不能替代所有长文/代码上下文评测。
- Context compaction trigger 已由 `HARNESS-LOOP` 选定；本 Decision 不重新解释 trigger 效果，只选择压缩前后进入输入的内容。
- 顺序消融两次独立 live 的绝对正确数受模型随机性影响；定案只比较同一次平衡运行中的 paired Arm，不把主实验的 14/17 与顺序实验的 12/17 当作顺序造成的下降。
- 新 Run 的一次检索不会因 run 内 steering 重新查询；这是有界、可恢复语义，若真实 steering 数据显示明显缺口，应以新 Decision 修改 Recipe，而不是加隐藏重复检索。
