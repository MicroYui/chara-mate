# 明确条件约定的原对话续接

2026-09-16。集成 owner：root。状态：选中实现已随共同 v21 集成 Main；该次 v21 完整离线验证通过；最终同版连续语义和桌面验收仍待完成。对应 Product §9.2；不改变未经请求的主动开场策略。

## 问题与产品行为

真实 A2 的 sketch-play 中，用户已经邀请角色在后续具体条件满足时接话，两臂 PFC 都理解了邀请并选择继续共同活动，却被普通主动开场的冷却期拦住。用户明确约定的有限续接应回到原 Chat 履行一次，不能按所有 `continue_shared` 一律豁免，也不能把共同话题、助手自作的承诺或模糊偏好当作用户请求。

唯一新增的选择绑定为 `selectedBasis.requestedContinuation`：引用实际请求证据和本次已经满足的条件 Claim。条件须属于本选择的当前事实依赖，有请求后收到的直接观察或用户报告支持，且无当前反证。请求要落到真实 completed user_message RunItem、对应用户 ChatMessage、同 Persona 和原 Chat；本次模型确实收到完整请求正文。语义判断由 PFC 完成，结构检查只保证判断所用材料和执行范围真实。

## 实现与生命周期

Projection 校验实际来源、Intent、条件和 Chat；Service 把本次实际供应的 evidence 传给提交，不把 metadata 冒充原文；Repository 对原文等值核对，并在现有 Run 分配事务中按请求的真实 source kind/id/fragment 判重。跨 Intent、并发分配和应用恢复仍指向同一贡献。

该贡献可以不受普通未经请求开场的 cooldown、关闭/静默时段与忽略退避影响，仍受用户正在操作、Voice、睡眠、已有气泡、当前对象、用户改口、Intent 和记忆依据变化约束。用户取消、改口或条件失效后不发送旧内容；暂时忙碌不会清空约定的恢复条件。

生成和投递分开：completed Run 中已生成但未能展示的同一条 Message 保持待投递，重启只恢复它，不重新生成。实际 `surface:offered` 才消耗一次贡献。失败或中断且未投递的 Run 可以在下一次真实事件重判后尝试，不新增定时付费重试。失败 Run 中曾成功执行 `memory.search`，或者存在 completed 的中间助手句子，都不能把整个贡献误算完成；真实 Tool 回执和历史句子继续保留。

没有新表、后台任务、运行模式或产品 Settings。状态由既有 Attempt、Run、Message 和观察回执拥有。源码为 `cognitionProjection/Repository/Service/Driver/Types` 与 `app/cognitionRuntime`；普通 Chat、主动交流和角色日常继续使用同一 Agent Runtime。

## 来源、验证和限制

依据已冻结 Product 合同、当前主源的 Run/Item/Chat/Surface 生命周期，以及旧 `proactive-policy.md` 对未经请求开场的适用范围。实现没有把旧 5/15/60/240 分钟启发式重新解释成协议限制，也没有复制一个外部 Agent 框架。SQLite 事务仍使用本项目已有同步分配事务，没有跨 await 的持久化事务。

V3 不可变候选冻结 `CONTINUATION-V3-FIXED-SOURCE-FREEZE.json`，SHA `b1e1340469119dd8f08b2051ae52644dadba2d2184e73fc362f2e3639646d80f`；7 文件由 root 与 History 当前资格、quiet completion 三方合并。共同源 `COMMON-V9-SOURCE-FREEZE.json` SHA `f0fcff0e78e581500a5101bc6ec3251c194ff9251dab37fddb5004df7f5340fc`，仓外保留完整 before/incoming/merged 对照。

候选 360 项认知/实际 Runtime 测试通过；Root 同版受影响的 445 项通过，typecheck 和 affected lint 通过。覆盖原 Chat 实际 Surface 投递、同请求并发与跨 Intent 判重、真实磁盘 close/reopen 后恢复同消息、Voice 忙碌、用户撤回、页面变化、实际正文供给、无效或旧条件，以及成功读取后 Provider 失败的重判。后一个场景先复现了 `performed` 误结算，修复后成功读取回执不丢、下一次真实重判可履行。

这些检查不判断自然语言是否确实提出条件请求。真实 gpt-6-astra 正负故事、与 Life/持续注意组合及最终 E2E 仍须另验；原冻结 A2 的失败保持原分母，不能回写为修复后的成功。
