# MULTI-AGENT 决策记录

> Decision ID：`MULTI-AGENT`
> 实验 ID：`CHM-MULTI-AGENT-20260813-W1`
> 日期：2026-08-13
> 状态：完成；机械 Execution Gate 为 no-winner，仓库所有者随后透明修订为 Agent 按需调用的 `D2 + M2R` 受限能力

## 当前产品决定

CharaMate 在 Agent 模式始终提供一个内部 `collaboration.dispatch` 能力，由父 Agent 自己判断是否调用。Composer 与 Settings 不增加 Multi-agent 开关、并发档位或实验选项；Chat 模式保持单 Agent。

一次调用固定为两个 child。父 Agent 必须预声明两个具体目标、互斥资源以及各自确切的读取动作；宿主只校验结构、当前 Run Tool scope、`read + idempotent`、资源不重叠、无 Browser/Computer 可变会话，不替模型做语义拆分。校验通过后，两个 child 并发读取各自资源并独立生成证据摘要；父 Run 等待两者终局后继续，由父 Agent 合并、处理限制并回答用户。过程保存为一个可折叠 `subtask` Item，取消、重启恢复和 Tool Result continuation 复用既有 Run/Tool 生命周期。

这是一项**结果后的产品取舍修订**，不是把实验 no-go 改写成统计胜出：预注册 Execution Gate 没有证明 M2R 对固定双资源任务带来平均质量或时延收益，机械结论仍是 no-winner/M0。仓库所有者在看到完整结果后指出，Multi-agent 更适合作为 Agent 自己按任务选择的能力；Dispatch selection 与 untouched holdout 共 72/72 次正确判断是否拆分，支持这种受限入口。最终接受该取舍，同时用两个只读 child、宿主资源门和无 UI 开关控制复杂度与误用面。

## 问题与单一变量

研究问题分成两道 Gate，避免把“何时拆分”和“拆分后是否更好”混在一起：

1. **Dispatch**：面对简单、顺序、共享资源或真正可并行的任务，谁决定是否派生？
2. **Execution**：对已经确定可拆的两个只读资源，并发 child 是否比单 Agent 更快或更完整？

Dispatch 使用同一份模型结构化提议，只改变宿主是否校验：

| Arm | 决策方式 | 产品含义 |
| --- | --- | --- |
| `D0` | 永不派生 | 单 Agent 基线 |
| `D2` | 父 Agent 提议；宿主校验独立、只读、资源互斥、无依赖和无共享可变 Browser Profile | 语义选择归 Agent，明显无效计划由宿主拒绝 |
| `D3` | 完全采用父 Agent 提议 | 测量模型自主判断上界 |

Execution 使用完全相同的任务、child prompt、读取 wire、父 Join 与评分，只改变执行形状：

| Arm | 形状 | 角色 |
| --- | --- | --- |
| `M0` | 一个 Agent 顺序读取两份资源并提交 | 简单基线 |
| `M2S-DIAGNOSTIC` | 两个相同 child 串行执行后 Join | 拆分成本诊断，不是产品候选 |
| `M2R` | 两个相同 child 真实并发后 Join | 候选能力 |

`M4R` 与 `M2W` 只有 M2R 先通过时才运行。本轮 M2R 没有通过，因此二者按预注册记为 `not-run-by-preregistered-gate`，不是遗漏数据。

## 一手来源与边界

2026-08-13 查阅 [Codex subagents 官方手册](https://learn.chatgpt.com/docs/agent-configuration/subagents.md)。手册把探索、测试、分诊、摘要等边界清楚且读多写少的工作列为推荐起点，同时指出每个 child 都增加模型/Tool Token，并发写会带来冲突；它没有给出 CharaMate 的协议并发硬上限或产品默认值。

同日复核 OpenAI Codex 公开源码 commit [`95aada11c4150e4ba28d6279c50f0995c1d93e5a`](https://github.com/openai/codex/tree/95aada11c4150e4ba28d6279c50f0995c1d93e5a)，提交时间 `2026-08-12T15:31:47Z`。该版本的 v2 spawn 共享 session registry，wait 订阅 mailbox/steering 事件，父线程负责整合 child 结果；源码中的默认 session slot 数只是当时实现行为，不是公开协议限制，也没有复制到 CharaMate。

同日复核 [OpenAI Responses API reference](https://platform.openai.com/docs/api-reference/responses/create) 与仓库锁定的 `openai@6.49.0`。官方 `allowed_tools` 示例使用顶层 Function 的 `{ type, name }` 引用，没有给出 namespace member 的可移植引用形状；SDK 的 `ToolChoiceAllowed.tools` 也只是开放对象数组，不能据此把 `namespace` 当成已确认协议字段。以下目标端点行为是权威代码之外的实测兼容边界，不外推为通用协议硬限制。

真实 Provider 验收依次暴露了三层 wire/runtime 边界：

1. 目标 Responses 端点以 `Invalid Value: 'tools'` 拒绝 `collaboration`，并明确说明它是保留 namespace。生产边界因此不枚举保留词，而把每个 client-defined namespace `x` 统一编码为 `charamate_x`；Provider 返回时只去掉一层前缀。`web_search` 等 Provider-native Tool 使用独立 wire 类型，不参与转换。
2. namespace 前缀修复后，Tool Search continuation 仍失败。直接最小复现取得原始 400：`Unknown parameter: 'tool_choice.tools[0].namespace'`。去掉 namespace 只写 `read`，或写 `charamate_file.read`，端点均返回 Tool choice 不在 `tools`；同一请求改为 `tool_choice: "auto"` 则 HTTP 200，并正确返回 `namespace=charamate_file, name=read` 的调用。此前根据归一化应用错误把这次失败归因于 bare `file` 是未经原始响应验证的中间假设，已被该复现推翻。
3. 首次 `auto` 实机运行越过 Provider 400 后，模型在 `collaboration.dispatch` 的结构化参数中引用了 wire 名 `charamate_file.read`，宿主只认识 `file.read`。生产 Adapter 现在对所有已知 client namespace 与 Tool 建立同一份双向引用表：Function Call 的 namespace 反向映射，解析后的结构化参数中只有与已知 wire Tool/namespace **完全相等**的字符串才转换为运行时名；不为 collaboration、file 或字段名添加特例。Provider continuation 仍保留它需要的输出 Item，运行时校验、执行参数、Run Item 与 UI 使用稳定内部名。

namespace member 不再发送未获目标端点支持的 `allowed_tools`。Tool Search 选中范围不是被删除：Harness 从持久化的 `tool_search_output` 与一次性 `allowedTools` 恢复已加载集合，执行前拒绝未加载的 deferred Tool；`plan.update`、`memory.record`、`collaboration.dispatch` 等 always-loaded 能力仍按 Run scope 与 execution mode 校验。这样把 Provider 兼容差异留在 Adapter，把最终执行权限留在 CharaMate Harness。

因此本实验的两个 child、样本数、误差门、bootstrap 次数、时延与 Token ratio 都是 CharaMate 启发式。只有正式结果和后续产品修订决定生产行为。

## 预注册、环境与证据标识

预注册在首个计分模型请求前写入 `refactor-architecture-decisions-2026-07-31.md` §4.6；两轮 wire smoke 均不计分，第二轮通过后才开始正式 selection。

| 项目 | 冻结值 |
| --- | --- |
| 基线 commit | `aefbe7c09c398dd3585c796b8492e5ce149399f3` |
| `package-lock.json` Git blob | `473b36b8763d99b27bf1563fc8d32ecaca47321c` |
| Manifest SHA-256 | `61c88449e90055ff7ada881ef1bb0b294e848aed1bb57211455f12009528470b` |
| task bank SHA-256 | `c51bea9be30279a810759fbe340ea125c6b9c56f512d22c9008e203013c4b1ef` |
| generator/runner/analyzer source-set SHA-256 | `b084a4059f6cf734afe6bb7f14e97b3ae86d1d53b585128043e6a8858d9cd29d` |
| 独立复评分器 SHA-256 | `cbfaea1b852e36401addde94878ce6344872fca0a6a5cbf4504aec83ced5ef10` |
| 模型 metadata SHA-256 | `9d44301bc2611c15d6c0395813d50e4d2df26e1c76d025b2c1dc5fa9917e25e8` |
| 设备 | Apple `Mac16,7`，arm64，24 GiB |
| 系统 | macOS `26.6.1 (25G76)` |
| 运行时 | Node `24.18.0`，npm `11.16.0`，`openai@6.49.0` |
| 模型路径 | 本机 Responses-compatible `http://127.0.0.1:4141/v1`，`gpt-5.6-sol`，`reasoning=medium` |
| 请求语义 | streaming，`store=false`，`parallel_tool_calls=false`，implicit prompt cache `30m` |

Dispatch selection 有 48 题（24 应派发、24 不应派发），untouched holdout 有 24 题（12/12）。正例覆盖双文档、双模块、双数据源只读综合；负例覆盖简单回答、顺序依赖、共享写资源、同一可变 Browser Profile、单资源和审批后动作。

Execution selection 有 18 个 paired tasks，文档对比、跨模块审计、双来源研究各 6；每题包含两个不可变独立资源、12 个稳定 evidence ID 与 7 个确定性结论。每个 block 内六种 Arm 顺序等频轮换，block 间 `concurrency=1`；child input 完全相同。预注册的 9 题 Execution holdout 只有 selection finalist 才运行。

## 预注册门槛

Dispatch selection 要求误派发和漏派发点估计各 `<=5%`，接受的无效资源计划为 0；平手优先 `D2`。holdout 必须 0/12 误派发、0/12 漏派发；selection+holdout 合并后两类 Wilson 95% 上界各 `<=10%`。

Execution 使用固定 seed 的 10,000 次 paired bootstrap：

- M2R 相对 M0 的 task success 95% 下界 `>=-5pp`、evidence coverage 下界 `>=-2pp`；merge 冲突、意外 evidence、资源越界和无效 Tool Call 为 0；
- 至少证明一项净收益：success 下界 `>0`，或结论正确率下界 `>=+3pp`，或 M2R/M0 端到端 p95 ratio 上界 `<=0.80`；
- 并发归因还要求 M2R/M2S p95 ratio 上界 `<=0.80`，且 M2R/M0 平均总 Token ratio 上界 `<=2.5`。

任何一项未满足，机械结果均为 no-winner/M0；不能只因 child 能完成就宣布晋级。

## Dispatch 结果

| 阶段 | Arm | 正确分类 | 简单/不合格误派发 | 合格任务漏派发 | 接受无效计划 |
| --- | --- | ---: | ---: | ---: | ---: |
| Selection | `D2` | 48/48 | 0/24 | 0/24 | 0 |
| Selection | `D3` | 48/48 | 0/24 | 0/24 | 0 |
| Selection | `D0` | 24/48 | 0/24 | 24/24 | 0 |
| Holdout | `D2` | 24/24 | 0/12 | 0/12 | 0 |

`D2` 与 `D3` selection 完全相同，按预注册复杂度/正确性 tie-break 选择 `D2`。Selection+holdout 合并后，正例漏派发和负例误派发均为 `0/36`；双侧 Wilson 95% 上界均为 `9.642%`，通过 `<=10%` 门。

Dispatch selection 时延 mean/p50/p95/max 为 `3.646/3.332/5.869/7.194s`，input/output Token 为 `18,072/5,472`；holdout 为 `3.525/3.295/6.038/6.885s`，input/output Token 为 `9,036/2,703`。这些只是 Dispatch 分类请求的描述性成本，不是生产 child 执行时延。

## Execution 结果

18/18 paired blocks 完整，全部首次尝试成功，无 block 重跑。三 Arm 的任务成功、结论正确、evidence coverage 均为 100%，merge 冲突、意外 evidence、资源越界、无效 Tool Call 和重复读取均为 0。M2S/M2R 共 72 个 child 输出都精确返回各自 6 个 evidence ID。

| Arm | 成功 | mean / p50 / p95 / max | input / output / reasoning Token | 每题 input+output |
| --- | ---: | --- | ---: | ---: |
| `M0` | 18/18 | `10.586 / 9.588 / 16.757 / 17.503s` | `32,696 / 6,344 / 1,040` | `2,168.89` |
| `M2S` | 18/18 | `20.948 / 21.234 / 29.283 / 29.646s` | `42,379 / 12,064 / 1,478` | `3,024.61` |
| `M2R` | 18/18 | `17.493 / 13.689 / 42.217 / 53.725s` | `42,385 / 12,182 / 1,483` | `3,031.50` |

关键 paired interval：

| 比较 | 点估计 | paired bootstrap 95% CI | 门槛结果 |
| --- | ---: | ---: | --- |
| M2R − M0 success | `0pp` | `[0pp, 0pp]` | 质量非劣 |
| M2R − M0 evidence/结论 | `0pp` | `[0pp, 0pp]` | 质量相同，无净收益 |
| M2R/M0 p95 | `2.5193` | `[1.1413, 4.3943]` | 未达到 `<=0.80` |
| M2R/M2S p95 | `1.4417` | `[0.7658, 1.8122]` | 未达到 `<=0.80`，不能归因并发收益 |
| M2R/M0 平均总 Token | `1.39772` | `[1.39241, 1.40322]` | 通过 `<=2.5` 成本上限，但增加约 39.77% |

M2R 首个有效 child 的 mean/p50/p95/max 为 `7.326/5.550/13.626/28.850s`，说明 child 可以较早返回，但父 Run 必须等待两者后才能 Join，未形成端到端收益。

因此机械 Gate 为：正确性通过、成本上限通过、净收益失败、并发归因失败，`winner=null`。按依赖停止 Execution holdout、M4R 与 M2W。

## 独立复评分与非计分失败

独立评分器在不复用主 analyzer 判定代码的情况下完全复现：Dispatch selection `48/48`、holdout `24/24`；M0/M2S/M2R 各 `18/18`，invalid 均为 0。独立复评分结果 SHA-256 为 `0b9f35ddb83393276dff9d780d2df0baa64e5cc626a9d487176369f79cfb3924`。

第一轮非计分 smoke 暴露两个 wire 定义问题：模型把父 Join 误列为第三个 child，且两个相似目标文字被旧校验器错误视为重复。计分前把契约修正为“只列 child work、父 Join 隐含；目标可以同类，但实际 resource claim 必须不同”。第二轮 smoke 的 D2/D3、M0/M2S/M2R 全部完成且零资源违规。两轮 smoke SHA-256 分别为 `00feacdb4991b34f1b7e7e778350ef8388a9dde1d7375885b45470c7ed97830a` 与 `e7a3054e76f53f7f609adb2ed2d950eb709d32165145021dd257f7c122a3f7c3`；它们不进入任何分母。

正式原始结果 SHA-256：Dispatch selection `faf09abbe1c47392bd98a36d5bfbbb22ccafe251dbe9d89bc674306cb24b7c99`，Dispatch holdout `06815d9dfe84a7475ded3c4e5651b5264de6bda3d56bff413e173cd97402d1e4`，Execution selection `bf1835f829d143ca96b110586121f242f8cc19d0c43f7b45a5ff84fd5fb9e3d1`，最终 analysis `dc1588567135ea0c8606af8d54056012706d0b8eee27377205b2e3346af0769d`。

## 结果后仓库所有者修订

机械 no-go 回答的是“把已知双资源任务强制改成两个 child，是否平均优于 M0”；它没有回答“让 Agent 只在自己判断值得时拥有一个受限协作能力，是否比永远不具备更合适”。完整 Dispatch 证据显示模型在 selection 与未触碰 holdout 的 72/72 个任务上都正确判断了该不该拆分。

2026-08-13，仓库所有者在看到结果后明确选择后一种产品语义：

- Multi-agent 是 Agent 能力，不是用户模式；Agent 认为需要时调用，不需要时不调用；
- 不增加 Composer 开关，避免把内部调度判断转嫁给用户；
- 保留 D2 的宿主门，避免 D3 仅靠声明绕过资源/副作用边界；
- 生产只实现证据覆盖到的两个只读 child，不运行或预留 M4R/M2W；
- M0 不是一个 runtime Arm 或 fallback flag：父 Agent 不调用能力时，自然就是现有单 Agent 路径。

这是在机械 Gate 之后基于产品价值作出的透明 amendment。它不能被引用为“实验已证明 Multi-agent 更快”。如果真实使用数据显示选择质量或净体验不足，应重新开 Decision 并替换唯一实现，而不是加开关或并行档位。

## 生产重写与复杂度成本

候选 runner 没有复制进生产。最终实现复用已有 Agent Runtime、Tool Registry、Provider、RunItem、checkpoint、AbortSignal、Renderer RunProcess 和本地观测：

1. `collaboration.dispatch` 仅在 Agent execution 中可见并 always-loaded；共享 Agent instructions 明确由父 Agent自主选择。
2. TypeBox/Ajv 输入固定两个 child；每个 child 包含目标、稳定资源声明和一个以上确切 read Tool input。
3. 宿主拒绝重复 child ID、重复/跨 child 资源声明、未被 read 使用的声明、跨 child 相同 Tool+input、Run scope 外 Tool、非 `read + idempotent` Tool、非普通 Tool Item 以及 Browser/Computer namespace。
4. 每个 child 内按声明顺序执行读取；两个 child 用同一父取消信号并发。读取结果经过现有 Tool Registry 校验与脱敏。
5. child 使用同一 Provider/model，只接收自己的目标和有界观察，不继承父对话，不开放 Tool 或原生网页搜索；返回带 evidence hash/artifact/status 的简短摘要。
6. `Promise.allSettled` 等待两个终局；部分失败保留已完成证据并返回结构化错误，父 Agent 可以换策略。父 Tool Result 带 `joinRequired=true`，同一 Harness 下一轮继续 Join。
7. 每次 execution attempt 使用一个 `subtask` Item；运行中、成功、受限、失败和取消沿现有 Tool 边界。应用中断时原 Item 记为 `interrupted`，恢复后以新的幂等 attempt 重新读取并继续父 Join，既不掩盖重试也不复用未知中间状态。开发观测把两个 child 的 usage 纳入 Run Token 汇总。

新增一个 Agent-owned 模块、一个 RunItem 枚举值与现有组件分支；没有新进程、表、持久化状态、依赖、IPC、Preload、Composer 状态、Settings 或新的 Provider Adapter。既有 OpenAI Responses Adapter 在单一边界统一编码所有 client namespace 与已知 Tool 引用，不维护 Provider 保留词枚举；Harness 负责 Tool Search 已加载范围的最终执行校验。数据库只更新 greenfield 当前 Schema 的 `run_items.kind` CHECK；没有为未发布数据新增迁移或兼容路径。

## 被拒绝的替代方案与删除证明

- `D0` 不作为产品配置：简单/不适合任务由 Agent 不调用能力自然覆盖。
- `D3` 被 D2 tie-break 淘汰：没有理由放弃可验证的只读/资源门。
- `D1` 没有替代语义判断：确定性规则只能验证结构，不能可靠判断复杂目标是否值得拆分。
- `M2S` 只是诊断；生产没有串行 child 模式。
- `M4R`、`M2W` 未运行也未实现；生产没有四 child、写 child、并发滑杆或隐藏常量档位。
- 没有 Composer toggle、fallback chain、候选 schema、临时表或第二套 Harness。

仓库内一次性 `experiments/multi-agent/`、runner、analyzer、候选 Arm 和临时资产已全部删除。非敏感原始证据与复现源码打包在仓库外：

- archive SHA-256：`f5473c2d92594f19fc0d4609f1c85b88811e6ba17c1b6ffe78e09ccfad999d68`
- 归档相对标识：`multi-agent/f5473c2d92594f19fc0d4609f1c85b88811e6ba17c1b6ffe78e09ccfad999d68.tgz`

原临时执行目录已移入系统废纸篓，可恢复；仓库只保留本中文聚合记录和获胜生产行为回归。

## 不能声称的范围

- Execution selection 是 18 个合成双资源任务、单一模型/本机 endpoint；不能外推为所有真实项目、Provider、设备或长任务的平均收益。
- 未运行 Execution holdout、M4R、M2W；不能声称四 child、child 写入或动态团队规模安全有效。
- Dispatch 的 72/72 支持当前冻结分布上的选择能力，不保证真实开放目标永远零误派发；宿主门只校验声明与 Tool descriptor，不能证明两个自然语言目标在语义上绝对独立。
- 生产 child 是“确切有界读取 + 一次独立分析”，不是递归自治 Agent；它不请求用户、不审批、不写入、不操作 Browser/Computer，也不再派生。
- 当前 amendment 选择了能力存在，不推翻 M2R 在 selection 上更慢、Token 更多且无平均质量提升的事实。
- 没有真实用户可用性研究；无 Composer 开关是仓库所有者的明确产品判断，而非实验中的 UI 偏好结论。

## 验证

生产实现的确定性回归覆盖：D2 资源门、两个 child 真实并发、父 Join、文本/Voice 当前 Tool scope、写/可变会话拒绝、父取消传播、应用中断后的幂等恢复、部分失败语义、Agent/Chat 隔离、Subtask SQLite 持久化、Renderer 折叠/终态标题、child Token 观测、所有 client namespace 的统一 wire 前缀、已知 Tool 引用的通用反向映射，以及“未加载 deferred Tool 在宿主执行前被拒绝”。Adapter 回归明确断言 namespace Tool continuation 使用 `tool_choice: "auto"`，不生成目标端点不支持的 namespaced `allowed_tools`。桌面 E2E 使用两个真实本地文件和本地假 Provider，先执行 Tool Search 并校验 `file.read → charamate_file.read` wire，再确认 Agent 自主调用、两个 child 请求、父回答与正常路径唯一 Subtask Item；没有 Composer 控件。

最终完整命令、日期、耗时和测试分母记录在 `docs/progress/STATUS.md`。通用 `npm run test:live` 没有混入离线回归；修复后使用当前真实 Provider/profile 在应用内提交原验收 Prompt，Run `a57c8778-c1ab-4ab5-8708-9dd06181db22` 于 59 秒、10 个 Item 后正常完成。第一次 `collaboration.dispatch` 即成功，两个 child 各自只读一个指定文件，父 Agent 完成中文对照表；没有 Provider 400、失败 Subtask、Browser/Computer 或文件修改。
