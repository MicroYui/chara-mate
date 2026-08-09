# VOICE-TOOL-JOIN 决策记录

> Decision ID：`VOICE-TOOL-JOIN`
> 状态：完成；选择最小串行 continuation（J0）
> 原始实验日期：2026-08-08；生产恢复日期：2026-08-09

## 当前决策

Realtime 获得与入口权限一致的客户端 Tool Registry 快照，但生产设置 `parallel_tool_calls=false`，同一 Voice Turn 一次只处理一个 Function Call。Main 使用现有 Tool Schema、executor、Approval 和 Run Item 执行；结果以 `function_call_output` 回注，随后只创建一次 continuation response。

这不是 Voice 专用 Tool Harness：没有 Tool 副本、Join 类型、依赖图、并发池、Join 表或用户设置。文字 Agent 和 Voice Realtime 的模型循环不同，但客户端 ToolDefinition 和执行边界相同。

## 问题与 Arms

| Arm | 调度 | 新增机制 |
| --- | --- | --- |
| `J0` | 单调用串行，结果后继续 | 无专用 Join |
| `J1` | 判定独立调用后并行，allSettled 后继续 | 资源冲突/依赖判定与 Join 生命周期 |
| `J2` | 显式依赖图后分层并行 | Planner、图状态和多层 Join |

不能用任意 sleep 制造并发收益；晋级并行路径需要代表性的独立慢 Tool、可验证的资源合同和端到端体验改善。

## 来源、输入与原始结果

- [Azure Realtime 协议参考](https://learn.microsoft.com/en-us/rest/api/aifoundry/azureopenai/realtime)与[OpenAI Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations)定义 Function Call、`call_id`、`function_call_output` 和后续 `response.create`。
- `openai@6.49.0` commit `04671d278ef1531692ae31a870251eec90f3c2d2` 的 Session 类型包含 `parallel_tool_calls`；这是协议能力，不是并发 Scheduler 的产品要求。
- 环境与 deployment 同 `VOICE-ARCHITECTURE`。
- 输入清单 SHA-256：`82bca2b57fc654bb8a6008118a53b8c511a6f36cf8ab485d1484a2433a5f9338`。
- 四条中英文强指令 prompt 均要求同一 response 调用互不依赖的 `lookup_weather` 与 `lookup_calendar`。

`4/4` responses 返回两个完整 Function Calls，名称和参数正确；应用为两个 call ID 写回结果后，每条只发送一次 continuation，`4/4` 最终 `response.done=completed`。回合耗时为 `944 / 1298 / 1388 / 1576 ms`，只描述目标 endpoint。

2026-08-09 的生产 issuer Live 另覆盖 J0 完整边界：Realtime 恰好产生 `1` 次 Function Call，应用写入匹配的 `function_call_output`，续答 response 完成、收到远端音轨和包含 Tool 结果的输出转写。它验证当前实现可用，不构成 J1/J2 的性能比较。

该结果证明模型可能产生多个调用，不能声称“模型不会并行调用”；但样本是强制 prompt，没有测量自然对话多调用率，也没有 J1/J2 的代表性端到端收益。按照“质量等价选择最简单基线”，生产选择 J0，并通过 Session 配置阻止模型一次产生并行待处理调用。

## 生产语义

- 每个调用独立验证 JSON Schema，并创建现有 descriptor 指定的 Run Item。
- Chat 入口只暴露幂等只读 Tool 和内部 `memory.record` 例外；Agent 入口暴露全部 Tool 并应用三档 Approval。
- Approval 等待期间停麦，决定后恢复；拒绝也作为结构化 Tool Result 回注，不能伪装成功。
- 打断会中止当前 Tool signal、取消未决 Approval、收口 Item 和旧 Run；迟到结果不触发新 response。
- Tool alias 只把 `.` 和 `-` 映射为 `_`，冲突直接阻止 Session 创建，不维护两套名称或模糊匹配。

## 限制与删除证明

- 没有运行 J1/J2 的虚构延迟对照，不声称串行永远更快。
- 未来若真实产品负载证明并发收益，应新建 Decision 并在隔离 worktree 比较；不能在生产悄悄加入 Scheduler。
- 生产没有 `ToolJoinGroup`、依赖图、并发数设置、Join 表、Voice Tool executor 或候选开关；一次性 runner 和原始 trace 位于仓库外。
