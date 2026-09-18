# 角色自主日常的安静结束

2026-09-16。Owner：root。状态：选中实现已随共同 v21 集成 Main；该次 v21 完整离线验证通过；最终同版自然语义与桌面验收仍待完成。依据 Product §4.6、§9.2；这是已有运行合同的矛盾修复，不是通过空回复提高实验分数。

## 实际问题

冻结 A2 的 ordinary-focus/Common 在一次自主日常中真实完成了 `territory.observe`、`territory.act` 坐下和 `companion.life` 安排后续。宿主输入明确允许安静结束；随后 gpt-6-astra 返回 completed 的 final_answer message，output_text 为空，没有新 Tool，也没有失败、取消或截断。Agent Runtime 却要求最后一步必须有非空文字，因而写入 `AGENT.EMPTY_RESPONSE`。已完成的行动仍然存在，但 Run 被错误标为失败。

原 Run 为 `93143110-5dc9-4b6d-a4fb-0c1101127e44`。仓外冻结 `mixed-a2-ordinary-focus-common/wire/model-00030` 至 `00033` 保存实际请求与事件；末轮为 12,368 input、4 output Token。原 A2 源、RunEvent 和失败分母不回写。此处修复不算 Appraisal 的收益。

## 主源与产品决定

当日读取已锁定的 OpenAI JavaScript SDK 6.49.0：`resources/responses/responses.d.ts` 的 Response 输出是生成 item 数组，不承诺首项为 assistant；完成状态与 output_text 分离。官方[Function calling 指南](https://developers.openai.com/api/docs/guides/function-calling)描述 Tool 往返，但没有为 CharaMate 定义何时应该安静。已读取本项目 `openaiModelProvider.eventError/stream`：failed 和 incomplete 仍抛出 ProviderError，completed 才投影为正常模型终结。直接依据还包括上述真实 gpt-6-astra 的完整末轮事件。

因此三者分别是：Provider 的正常/异常响应边界；当前适配器的实际事件行为；CharaMate 对自主生活无需每次发言的产品决定。不能从 SDK 的类型宽松推导“所有空回答都成功”，也不改 Provider 协议来掩盖真实失败。

## 单一路径

只有自主日常的 `continue_character` 分发由宿主传入 `quietCompletionAllowed`；普通消息、主动搭话和 Automation 没有这个许可。该字段属于既有 Run checkpoint 的执行语义，随中断恢复，不新增 Run 状态、表、调度器或 Settings。终局仍必须是正常完成且没有待处理 Tool、steering、审批或 continuation；取消和 Provider 失败沿原路径处理。

用户在同一 Run 接管后，合并实际消息时移除许可；应用重启时从原 RunItem 补入的用户消息也走这一个方法。正文中出现“可以安静结束”不会授予宿主许可。正常无文字结束不插入空 Chat 消息、不生成占位回复、不生成成功行动依据，也不触发桌面搭话。真实 Tool 回执和原角色 Intent 的完成资格继续独立校验：Run completed 只说明这次执行结束。

许可属于既有 Runtime；生命周期至该 Run 终局或用户接管。若将来自主日常产品不再允许安静，则同时删除该唯一宿主入口和 checkpoint 字段。没有保留另一个 Harness 或候选开关。

## 验证与限制

新增两项实际 Runtime/SQLite 边界先复现失败；修复后无动作的安静结束、实际文件行动后安静结束、三种无许可空响应、用户接管、取消、Provider 失败、持久 checkpoint 恢复及落盘未合入用户消息恢复共 10 项通过。文件正例检查真实文件内容和原 Tool 回执，所有安静正例无虚构助手消息。首次 runner 用了不存在的独立 Vitest config，第二次才得到有效红例；恢复夹具先误用方法名、后未完成真实 initialize，已保留两次夹具错误并修正，没有改生产恢复规则。

日志为仓外 `integration/quiet-life-{red-1,red-2,green-1,green-2,green-3}.txt`。这些是工程边界证据，不能证明角色已经学会自然生活；后续使用修复后的同一 Runtime 做独立生活/连续场景，原冻结 A2 不重写。完整静态、跨领域及桌面验证以 STATUS 的同版记录为准。
