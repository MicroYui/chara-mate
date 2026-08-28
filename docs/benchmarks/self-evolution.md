# SELF-EVOLUTION：触发式 Experience Review 与成长候选

## 定案

选择 **E4：触发式异步 Review + 用户确认 + Skill replay 后激活**。

只有用户明确纠正、明确教学、具有客观验证的成功或可证实的重复流程才进入 Review 队列；Review 只生成 `memory`、`persona_preference`、`skill_patch`、`new_skill` 四类草稿，不直接写入。所有候选由用户接受或拒绝；Skill 候选在接受后还要执行独立 replay，通过才成为 active。replay 失败时保留候选、结果和可编辑内容，不把失败静默改成通过。Skill 版本可恢复，归档不永久删除，pin 阻止后台改写。

生产不保留 E0–E3、每 Run 复盘、直接写入、Reviewer 自批、固定 Tool Call 次数、Hermes 的 16 iterations/7 天/30 天/90 天参数、Arm 开关或普通 UI 调参。Phase 3 的 `memory.record` 与普通 Memory 候选继续作为当前 Run 的基础形成路径，本 Decision 不复制或替代它。

## 问题与边界

问题是：Phase 3 已能形成普通 Memory 后，异步复盘是否还能提高未来同类任务成功率，并把错误迁移、候选膨胀、模型成本和用户打扰控制在可接受范围；若能，产品应只有哪一种触发和生效流程？

可变对象只限：关于用户的 Memory、用户可见的 Persona 偏好、可复用 Skill。源码、系统根指令、Provider/凭据、审批规则、数据库 Schema 自身和任意内部调参都不属于自进化对象。

## 一手来源、版本与约束分类

执行日为 2026-08-13；CharaMate 基线 `aefbe7c09c398dd3585c796b8492e5ce149399f3`，Apple M4 Pro、24 GiB、Darwin 25.6.0 arm64、Node `24.18.0`、npm `11.16.0`。

- Hermes Agent `main` 检查点 [`a871948`](https://github.com/NousResearch/hermes-agent/commit/a871948d8d4b0f774d4ec40467bab1078a9f28d5)，2026-08-12。`background_review.py` 使用其最近提交 [`35cbad5`](https://github.com/NousResearch/hermes-agent/blob/35cbad5854155de5541adbe4578008269d60c5af/agent/background_review.py)：当前实现派生后台 Agent，同模型路径复用完整历史与热缓存，限制 Memory/Skill 工具，最多 16 iterations，并可直接写入。Skill 提示强调优先 patch 已加载或 umbrella Skill，也排除临时环境失败、未解决尝试和一次性叙事。
- Hermes `curator.py` 使用其最近提交 [`bc3fa54`](https://github.com/NousResearch/hermes-agent/blob/bc3fa54f5748fd6c735ad6ced8bacebb752ce3e6/agent/curator.py)：当前默认 7 天周期、30 天 stale、90 天 archive；归档可恢复，LLM consolidation 默认关闭。
- Agent Skills `main` 检查点 [`69ef37e`](https://github.com/agentskills/agentskills/commit/69ef37e9424c0a7ea9dd2293b559e43ec8176379)，规范最近提交 [`217be54`](https://github.com/agentskills/agentskills/blob/217be548739f21d6008915c29aefe320ea1a90af/docs/specification.mdx)：`SKILL.md` 的 name/description、目录名和渐进披露属于外部格式约束。
- 2026-08-13 复核锁定的官方 `openai@6.49.0` Responses 类型：`text.format` 的 `json_schema` 是 Structured Outputs 入口，`strict: true` 要求响应遵循所给 Schema；生产 Reviewer 和 replay 因此在无 Tool 的同一次调用上提交各自 JSON Schema，应用侧仍以 TypeBox/Ajv 做持久化前校验。

Agent Skills 格式是协议约束；Hermes 的触发、直接写、迭代数和生命周期日期只是该提交下的当前源码行为；CharaMate 的触发信号、候选确认、replay、状态与无固定自动归档日期是本 Decision 的产品启发式。三者没有混写为同一种“硬限制”。

## 2026-08-27 Voice Review 与 Memory 布局正确性修订

本修订不重开 E0-E4 的触发式 Review 选型，只修正“来源 Run Provider/Model”在 Voice transport 上的错误外推，并收口其暴露出的 UI 生命周期问题。

- 一手来源读取于 2026-08-27：[OpenAI `gpt-realtime` 模型页](https://developers.openai.com/api/docs/models/gpt-realtime)把 Realtime 与 Responses endpoint 分开列出，并明确该模型不支持 Structured Outputs；[Microsoft Azure Structured Outputs](https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/structured-outputs)要求使用支持 JSON Schema 的合适 deployment，其当前支持列表不含 Realtime 模型。协议硬约束是 Reviewer 的严格 JSON Schema 必须交给支持 Structured Outputs 的 Chat Model；具体默认 Profile 选择和“无兼容模型则 skipped”是 CharaMate 的产品策略。
- 当前生产数据观察到两次已完成 Voice Run 使用 Azure Realtime deployment `gpt-realtime-2.1`，随后 Experience Review 把同一 deployment 传给 Chat/Responses Structured Outputs 路径并落为 `failed`；该 Azure Profile 没有配置 Chat Model。持久错误经过归一化只保留 `PROVIDER.REQUEST_FAILED`，不能从旧记录反推出具体 HTTP status，但运行快照、调用路径与能力边界已足以证明不应发送该请求。
- 修订后的唯一生产路径：Text Review 继续复用来源 Chat Provider/Model；Voice Review 复用来源证据，但通过现有默认选择取得一个已保存凭据和 Chat Model 的 Profile。找不到兼容 Chat Model 时完成为 `skipped`，不调用 Provider；找到后发生的真实网络、认证或 Provider 错误仍为可重试 `failed`。Voice 来源的 Skill replay 使用同一 Chat Model 选择边界。
- Memory 页保持搜索栏在首行、列表/详情占满剩余高度。Experience Review 的 Memory/Persona 草稿进入左侧有界区域；失败 Review 是紧凑状态，可重试或显式关闭。关闭把 `failed` 改为 `skipped` 并保留来源，不引入自动过期天数或第二套错误表。
- 回归必须同时覆盖：Voice + 无 Chat Model 不发模型请求且落为 skipped；Voice + 可用 Chat Model 使用该 Chat deployment；失败 Review 可关闭；Memory 中存在失败 Review 时工具栏仍在首行且工作区保持正高度。jsdom 的“元素存在”不能替代桌面几何断言。

## 预注册、数据与环境

- 主实验 ID：`SELF-EVOLUTION-20260813-E3-V1`。
- 模型：本机 OpenAI-compatible Responses 端点的 `gpt-5.6-sol`；真实模型层，不设置服务不支持的 seed。
- 冻结输入与 runner SHA-256：`985a4898bfa8e0b15503825bc83b7adf751a87ad573841d5b04b6c1da654fa7a`。
- 冻结 source hash 记录文件（内容为上一项 hash）的自身 SHA-256：`db8e6bdbf522177a49b37c6c88da9871935e211f37ad34b4bee687353eb172eb`。
- raw JSONL SHA-256：`806ab8fc09812abf214a94dc1c78000c52ec484ebe2ac7e0bbcecc3a976e6504`；汇总 SHA-256：`29f841210ae61a3fb7be894f4056d5430df82afa8ef7ce8ed4ed1b32e465e030`。
- 30 个配对场景：研究设计要求的十类各 2 个，另加 10 个无学习信号的普通 Run；16 个正例、14 个负例。正例含 7 个 patch、4 个 new Skill、3 个 Persona 偏好和 2 个 Memory。
- Reviewer 只见 source Run 和 Skill metadata，不见真值、replay 答案或 holdout；独立标签只决定是否模拟用户接受，错误候选不会被自动修正后激活。
- 每个正例有校准 replay 与未见 holdout，同类任务和旁路任务成对；比例使用 Wilson 95% 区间，配对差使用固定种子 `20260813` 的 case-level bootstrap。

两次请求因本机代理 socket 临时关闭返回 HTTP 500；预注册的同请求重试成功，原始失败和成功响应均纳入删除前的最终 hash 核对，222 个成功响应 ID 无重复。没有删掉失败样本或人工改写输出。

## Arms

| Arm | Review | 生效 |
| --- | --- | --- |
| E0 | 无 | 现有基础 Memory / 手动 Skill |
| E1 | 每个 Run，Hermes 风格主动提示 | 直接写入 |
| E2 | 每个 Run | 独立标签模拟用户确认，无 Skill replay |
| E3 | 每个 Run，严格边界提示 | 用户确认；Skill replay 后激活 |
| E4 | 仅纠正、教学、客观成功或重复模式；提示同 E3 | 用户确认；Skill replay 后激活 |

E4 相对 E3 的唯一实验差异是模型调用前的确定性触发筛选。E1–E4 使用相同模型、证据、输出结构与并发。

## 主实验结果

| Arm | Review 调用 | Review Token | 候选 precision | 正例 holdout | 全部 holdout | 增量错误迁移 | Skill replay | 激活 Skill / 成功复用 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| E0 | 0/30 | 0 | — | 12/16（75.0%） | 26/30 | 0/30 | — | 0 / 0 |
| E1 | 30/30 | 12,082 | 16/16 | 16/16 | 30/30 | 0/30 | — | 11 / 11 |
| E2 | 30/30 | 11,154 | 16/16 | 16/16 | 30/30 | 0/30 | — | 11 / 11 |
| E3 | 30/30 | 13,890 | 16/16 | 16/16 | 30/30 | 0/30 | 11/11 | 11 / 11 |
| E4 | 16/30 | 8,655 | 16/16 | 16/16 | 30/30 | 0/30 | 11/11 | 11 / 11 |

E4 正例成功率相对 E0 增加 25 个百分点；配对 bootstrap 95% 区间为 `+6.25pp…+50pp`。E4 的正例成功率和候选 precision 均为 16/16，Wilson 95% 区间 `80.6%…100%`。增量错误迁移为 0/30，但 Wilson 上界为 11.35%，跨过预注册 5% 启发式；因此只能说本样本未观察到迁移，不能声称真实上界低于 5%。

E4 与 E3 的正例结果相同，Review 调用减少 `14/30 = 46.7%`，Review Token 减少 37.7%，达到预注册的“成功损失不超过 5pp、调用减少至少 25%”。E4 Review p50/p95 为 6.04s/10.13s；它在 Run 完成后异步执行，不阻塞当前回答。5,000 次入队同步返回微基准 p50/p95 为 0.000291/0.000584ms，只证明入队代码很小，不代表下一 Run 没有资源竞争。

E1 在这组小而清晰的合成数据上没有暴露直接写错误，不能据此证明直接写安全。它与 E2/E3 的质量相同，却没有独立用户确认或 replay，且每 Run 都付费，因此没有保留理由。

## Replay 确认层与透明偏差

主实验的 11 个 Skill 候选全部写出了正确边界，11/11 replay 通过，没有给 replay 留下拦截机会。为避免把“没遇到坏候选”当作 replay 有效，结果产生后另行预注册确认层 `SELF-EVOLUTION-20260813-REPLAY-V1`：固定注入 10 个 action、target 和同类步骤都正确、但将规则扩大到旁路流程的有害 patch。

- 确认层 source SHA-256：`ebf254d84d9ad8d470788ce1f90dac66c87905756af8425752411190529ce8d2`。
- 冻结 source hash 记录文件（内容为上一项 hash）的自身 SHA-256：`aa5b6c8c8ec2ef684eb15e52392ab776c8c9d67b2da6246f0974cf426b66f385`。
- raw SHA-256：`5df367b8bcc63e6ff012daccd87280da860f0f0777fb0ec323dc39c474a4f9d0`；汇总 SHA-256：`f30d049c0e67a7f4a849d278117e726109f76ef0a790b36942cd90e36c9b9aee`。
- 同类任务 10/10 正确；replay 只拦截 5/10 有害 patch，Wilson 95% 区间 `23.7%…76.3%`，未达到预注册 7/10 证据线。

未达线结果原样保留。它表明模型 replay 能提供增量信号，但不能当唯一安全判据。因此生产采用“所有候选用户确认；Skill 再 replay”的串联，而不是 replay 通过即无人确认地自动生效。用户仍能看到 proposal、证据、来源、边界和 replay 结果；失败候选可编辑后重新 replay。

## 综合选择

1. E4 达到主要收益证据：正例 12/16 → 16/16，点估计 +25pp；全体 26/30 → 30/30，没有在 30 个旁路对上观察到新增错误。
2. E4 与 E3 的质量相同而少调用 46.7%，符合“质量相同选更简单、成本更低”的规则。
3. 每 Run Review 只增加成本；本数据中 E3 在 14 个无信号 Run 上没有产生候选，所以 E4 的调用前筛选删除了纯浪费而没有删掉收益。
4. 用户确认是实际生效门槛；replay 确认层只拦截一半有害 patch，故保留为 Skill 的第二道质量检查，不扩张成无人确认的自动审批器。
5. 不采用 Hermes 的 forked Agent runtime。生产 Review 是 CharaMate-owned 单次结构化模型调用，没有 Tool 权限，不直接写 Memory/Skill，也不成为第二套 Agent Harness。

## 生产重写

唯一流程为：

```text
terminal Run event
  → 持久化触发判断与异步 Review job
  → 四类 draft candidate（绑定 Run/Item evidence）
  → 用户接受 / 编辑 / 拒绝
  → Memory/Persona 写入既有 MemoryService
    或 Skill replay → 版本化 Skill 激活
  → active / stale / archived / restore
```

Review job 先持久化再异步执行，进程重启可恢复 queued/running 项；同一 Run 唯一，事件 replay 不重复生成候选。Review 只能读 Run/Item、Chat messages 和 Skill metadata/本 Run 已加载 Skill 内容。候选写入前经过 TypeBox/Ajv、redaction 和持久化边界；Reviewer 没有 Memory、Skill、Tool 或源码写权限。

Skill 只有用户目录可由成长候选修改；workspace Skill、pin Skill、已归档 Skill 不接受后台 patch。patch proposal 固定本 Run 已加载目标的 ID、revision 与内容 SHA-256，接受和 replay 后写入时都重新核对；期间发生的手动编辑不会被旧候选覆盖。新 revision 保留内容快照、来源 candidate、使用/成功/patch 统计；archive 可恢复，rollback 以旧内容创建新的 active revision，历史不改写。没有自动 stale/archive 天数；旧 revision 在后继版本激活时成为 stale，Settings 或 Agent 对 Skill 的显式编辑、归档、恢复、pin 会同步回关联候选状态。

## 删除证明

E0–E4 runner、Arm prompts、预注册临时文件和候选 fixture 已从工作树删除。仓库外原始产物完成最终 SHA-256 核对后也已删除，只保留本记录中的 hash、分母与汇总结果，不进入安装包；生产代码中不存在 `E0`–`E4` 名称、review mode、直接写 fallback、benchmark route 或参数 UI。小型回归 fixture 已按产品语义重写，只验证唯一触发、候选、replay、恢复和 IPC，不携带 Arm 身份。

## 不能声称什么

- 30 个合成场景、单模型、单次运行不能代表真实接受率、跨语言 recall、长期 Skill 增长或所有 Provider；候选 precision 的区间仍宽。
- 增量错误迁移 0/30 的区间上界 11.35%，不能宣称低于 5%；上线后应在本地 Dev metrics 观察接受、编辑、拒绝、replay 失败和真实复用，但普通 UI 不显示 benchmark 指标。
- 触发规则可能漏掉没有明确语言、没有可验证结果的隐含学习；不能用每 N 个 Tool Call 兜底，否则会重新引入被 E4 删除的无收益调用。
- replay 不是执行所有真实外部副作用的沙箱，也不是独立真理源；确认层只拦截 5/10 过宽 patch。它与用户确认、来源证据、版本恢复共同降低风险，不能证明错误为零。
- 本 Decision 不选择自动归档天数、聚类、Skill 自动合并、第二 Reviewer、参数自调或源码自改；这些没有收益证据，生产不实现。
