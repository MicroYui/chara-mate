# 记忆支持操作只附加新证据

2026-09-16。root 选择的唯一窄 support 合同已从隔离共同源进入 Main v21；原 wire→形成→SQLite 及模型比较结果保留，最终同版独立验收仍待完成。形成、检索和运行时仍属于同一个 Memory 服务，没有旧 schema 兼容分支。

实际连续 L 出现四次 support 因重写正文而失败；另一个实际 PFC→Run→memory.record 的 Budget 材料也出现同类错误。旧规则要求 support 的正文、语义及实体与已有版本完全相同，这保护了不可变字段，却又让模型重抄这些字段成为成功前提。L 的部分新来源确实含有新限定，不能一概放行旧 support 提案；操作的正确选择仍需要单独验证。

所选变更把模型 wire 与私有 batch 的 support 限定为 operation、targetRevisionId、新 citations 和 links。宿主读取这次实际供给的目标，保留其 content/type/semantics/canonical entity IDs；不要求模型重新声明已有实体，不给手工无语义的记录补造语义。当前版本 CAS、primary 原文引文、主体/依据类型和来源有效性仍重验。一般 assistant 的重述不能支持 user 事实。新条件/时间/主体/角色范围、撤回状态必须 revise，不能在 support 偷改。

来源沿用 v15 是两臂共同基底。本组四个全新开发家族、4 次共同初始形成、8 次更新、8 个普通 Agent 冷问；两个重申正例与两个变化反例，AB/BA/AB/BA。实际 gpt-6-astra、Qwen3-Embedding-4B-Q4_K_M.gguf、512维、SQLite/Vector Worker。协议中“Q8”为文字误标，原冻结保留；`EMBEDDING-RESOURCE-REPORT-CORRECTION.md` 已记录更正，两个实际资源文件始终是 Q4_K_M，从未换 Arm。

|结果|旧完整 support|窄 support|
|---|---:|---:|
|新来源形成成功|4/4|4/4|
|两重申：原正文/语义/实体/版本保持，source从1增2|2/2|2/2|
|新增家庭场景/会议例外/信号/仅当前伙伴范围准确修订|1/1|1/1|
|未履行承诺撤回为cancelled，未当作完成或待办|1/1|1/1|
|普通冷问关键语义正确|4/4|4/4|
|形成侧模型调用|12|12|
|形成侧输入/输出 Token|53,385 / 5,276|48,074 / 4,672|
|普通回答侧模型调用|14|14|
|普通回答侧输入/输出 Token|98,625 / 2,228|98,866 / 2,242|

这四组没有重现旧版异常，因此不能说此组证明异常率下降。两反例在两臂均做了实际 revise，说明窄 support 没有在本组把条件和撤回悄悄丢掉。正例两边完整不可变字段相等、无重复 Memory，区别是新操作不再让模型 author 那些字段。窄 support 形成阶段输入/输出合计少 5,915 Token（约10.1%）；整条链有采样与检索步差异，不外推收益比例或金额，cached 也受先后复用影响。

共同初始4调用另 **22,913 输入、1,849 输出，cached 21,220**，只计一次。全组56真实模型调用、usage全齐；完整单请求估算含声明输出最大160,861≤258k。实际运行与其它语义链共享资源，时间不作性能比较。完整逐阶段 usage 和人工判读结果在仓外 `SUPPORT-OPERATION-LIVE-RESULT.json`。

选择理由是操作建模更直接、消除了已经观察到的无效重抄前提，并在新限定反例/实际消费者下未看到质量退化；不把 schema 约束当作语义正确性的自动证明。用户谈到了新的限定但模型误选 support，仍可能遗漏，因此原 L 和 Budget 的失败不改写，最终独立材料继续覆盖该边界。

309 Memory/context 回归、5文件 lint通过。新增 actual wire→SQLite 覆盖 canonical entity ID、无语义手工记录、assistant不能背书user事实、形成期间版本变化，旧来源区间/删除/预算边界回归保留。独立副本自身仍有12条旧跨域快照的tsc缺口，Memory域无新错误；完整共同源 tsc 与跨域回归由Root集成验证，不将单元数量当成熟度结论。

交付5文件：MemoryModels、MemoryFormationService及两者单元测试，另 MemoryLearning 的一个 fixture 只删除已禁止的 support 复抄字段。唯一源码冻结 `3be4b4f5c82d40aa515a1177b66383b677695f3dfd8f7f4eb689ba3d6a4902e2`，父为 carry 冻结，exact before/after 与单一 patch 已提供。真实协议冻结 `ca48930ecea43968d3006e7ecb16f8030e0e1152d672ae745c8ef39ec2db6ea5`，结果 SHA `8b37516d66a2c1f4d810c552bc3025519ac21e27dd1581b96464dda3fb7a4743`。删除旧 support 输出要求；无新表、依赖、Settings、模型备用路径或额外模型步骤。

Root 共同源验证：Memory 与上下文单元 310/310（17 文件，3.05 秒），完整 TypeScript 通过；Memory/来源删除回收/Run intake/Cognition bridge/Territory生成/Voice 边界 106/106（7 文件，12.14 秒）。这些结果证明此次组合边界，最终独立与 packaged 同版验收仍未完成。
