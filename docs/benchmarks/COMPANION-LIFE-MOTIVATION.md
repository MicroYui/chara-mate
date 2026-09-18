# 角色动机与阶段连续性：选择既有 Persona/Intent 单一路径

2026-09-16，四家族 × 两臂的原冻结执行全部结束；不是最终产品验收。选择简单 Common，不引入 Life 的 motivation/parentIntent 与显式 stage Tool 扩展。新增结构在一例保留完成阶段历史有清楚表现，但没有稳定改善实际日常效果，且在本轮引入额外来源闭包耦合。共同故障继续修复，不因选择 Common 就宣称自主生活成熟。

## 问题、来源与冻结

问题是：持久 Persona 价值/兴趣与实际经历的结构化引用、直接父阶段、原子 begin_stage/continue_current，是否比既有 Persona + Claim/Situation/Intent/Choice 更能保持真实活动、用户接管、失败恢复和跨月连续性。仅字段齐全、故事更长或新阶段 ID 不计收益。

脑认知/主动 Agent 的一手研究与模型边界已记录在原 DESIGN.md、PROTOCOL.md、LIFE-CONTRACT-FREEZE.json；其认知类比不是效果证据。本轮工程源以 common-v12、真实 Memory v18、完整 request 动态材料预算为共同底座；来源提示 C0/C1 先前配对等效，保留原 C0，不把任何预算或来源共同修复计入 Life。源 delta 为 life2-delta-before-material/FREEZE.json（88d08157…），22 文件。执行冻结 LIFE3-EXECUTION-FREEZE.json：d91d83f21e8892495564b83567a6ec7f1292b47124cd634cb12aaddccc1865d7。

四家族及原检查点标签在 LIFE-DATASET-FREEZE.json；输入 SHA6171be18e53ced9bba4d04364c3a4d98793fc2e0f41646f6e13b8d774caa7111，标签 SHA531490ee813576baae6ff79d717d540f2790b37b8c06b46eac493208a26462e0。每家族各4点，共16点/臂；每臂20个实际步骤。light、map Common→Life；quiet、lamp Life→Common，两个独立进程链。真实 gpt-6-astra、4B/Worker、PFC→Run→Tool→World、Formation、SQLite/AssetStore，日/月由受控时钟推进。各故事正常关闭，8/8 closeErrors 为空。

## 结果

| 家族 | Common 请求 / 输入 / 输出 | Life 请求 / 输入 / 输出 | 可见结果与失败 |
| --- | --- | --- | --- |
| light-notebook | 61 / 731,553 / 28,561 | 33 / 339,200 / 14,160 | Common 重开后成功近前观察书与地图1次；Life 的过期revision动作失败后重新读取，但1月7日PFC失败后停摆。Common2月也有1次PFC类型失败。 |
| quiet-craft | 55 / 512,673 / 26,664 | 42 / 444,471 / 26,963 | 两臂实际暂停/恢复用户接管，并保留未制作设想；只有整区观察和安排，没有制作/放置动作。Life2次新增Claim闭包失败。 |
| map-reading | 22 / 205,775 / 12,077 | 8 / 74,438 / 3,297 | 两臂均未在地图删除/跨月后恢复活动。Common 把自己一次不移动方法当成长期限制；Life 首轮类型失败后不再考虑。 |
| lamp-study | 41 / 482,568 / 22,101 | 64 / 894,010 / 49,604 | 两臂均成功坐椅1次；Life先有1次过期revision失败，随后保留旧完成阶段与新修正阶段，但另有7次PFC错误。Common普通精确工具名查找未得到observe，之后等待“能力恢复”。 |

| 全量指标 | Common | Life |
| --- | ---: | ---: |
| 请求 / 输入 / 输出 Token | 179 / 1,932,569 / 89,403 | 147 / 1,752,119 / 94,024 |
| 缓存输入 Token | 638,120 | 661,376 |
| 最大单次真实 usage.inputTokens | 37,700 | 37,373 |
| 缺 usage 请求 | 0 | 0 |
| 自主 Run / 普通消息 Run | 11 / 3 | 10 / 3 |
| 成功 territory.act / 失败 territory.act | 2 / 0 | 1 / 2 |
| 整区 territory.observe | 10 | 9 |
| PFC拒绝 | 1 | 11 |
| 自主向用户输出气泡 | 0 | 0 |
| 四库总大小 | 8,327,168 B | 8,261,632 B |
| Cognition来源 / Attempt payload | 167,318 / 93,045 B | 155,807 / 70,703 B |

所有已有 Run 均 completed 不意味着连续活动完成；错误多出现在反馈/下一步 PFC，导致之后没有 Run。Life 少32次请求、输入少约9.3%，同时更早失去工作，不能作为效率提升。输出反而多约5.2%。共享硬件阶段墙钟只描述，未作性能结论。存储规模很小且失败停摆影响后续写入，不据此比较容量效率。

按原16条标签逐项审阅（LIFE3-QUALITY-REVIEW.json）：Common 完整满足10、部分满足4、未满足2；Life完整10、部分2、未满足4。这里的“部分”明确区分仅持久文本存在与实际恢复消费者、仅观察与真实行动，不是把部分折成某个任意分数。每点理由保留，原标签允许观察/休息的点不事后改成必须制作。map第二天Common、lamp跨月Life等较窄标签达标，也不能抵消其后续停摆。16点相关联于4条故事，样本不是16个独立用户，不能推断普遍成功率或SOTA。

## 失败原因与产品后续

1. 共同 wake 生命周期缺陷：开始 drain 就清除到期事项，来源用途或提交失败后再无安排。独立 Wake 包修复事务确认、未供给保留、失败可恢复和同失败上下文抑制；原本轮两臂不回改。来源类型纠正与 Wake 恢复已分别随共同 v21 集成 Main，见[来源用途](COGNITION-SOURCE-USE-CORRECTION.md)与[到期恢复](COGNITION-DUE-RECOVERY.md)。不能把共同修复算成 Life 建模胜出。
2. Life6次 `Selected current claim requires all support and contradiction sources to be declared` 来自 motivation.experienceClaimRefs 被宿主加进 selected currentClaimRefs 后，又要求模型重复枚举额外来源。quiet两例明确所选原Claim已经完整，新增历史来自宿主扩充，实际材料也已供给；这是新增协议耦合，不是Memory漏召回。CLAIM-SOURCE-CLOSURE-REVIEW.md 保存来源、字节和原错误。拒绝Life后该新增扩充路径不进入生产；既有真正被选Claim的支持/反证规则不删除。
3. Common map 自限不是用户权限：当次PFC自己说只读、不移动，实际 territory.act 可逆动作允许。随后计划自述变成长期 blocker。后续[当前真实能力 C1](COGNITION-CURRENT-CAPABILITY.md)已在既有 Claim/Intent 中明确这些区别，并取得两个历史家族的有界恢复结果；没有增加另一份人格/权限状态，也不回写本轮停摆。
4. Common lamp 不是单纯模型不愿找：原两次 discovery（`+territory.observe`、`territory.observe 读取当前住处布局 revisionId targets`，limit1）实际均只返回 description 提及observe的 territory.act。[工具身份与范围修复](TOOL-DISCOVERY-IDENTITY-SCOPE.md)及 C1 当前能力供给已随共同 v21 进入 Main。PFC 仍不能将 Agent 一次“没找到”自述变成永久能力缺失；后续有界恢复与这里的原失败分别计数，完整长期自主活动仍待验收。
5. 真实缺失的能力仍缺失：当前回执没有修补抱枕、直接量出照明舒适度或读完整书页的能力，不造成功。允许换成确实可行的活动或明确休息，不能要求不存在的执行接口。

## 边界与删除

本轮只装配 cognition 自主调度；Opportunity/Automations/Settings和ModelConsolidation未进入原冻结运行器。先前记录在 LIFE3-ASSEMBLY-COVERAGE-NOTE-V2.md。两臂同一装配，能比较该own-life模型，不能证明完整三来源竞争或后台巩固下的产品体验。原旧 rawHTTP 观察器在SDK构造后安装，HTTP原始截获可能缺失；归一化实际请求、事件和usage仍在，不追补伪原始传输。新的完整独立运行器已修SDK装配时点，另行验收。服务重开不是新Node进程；本轮不声称真实应用重启。生成图片使用受控PNG，本轮没有实际物件生成，不给审美信用。

所有候选代码、runner、DB、原始输出在仓外。Life新增22文件增量、Appraisal扩展以及对应字段/候选schema不送Main；Root共同v15沿用Common，当前Main共同v21仍保留这一基础，没有引入Life的motivation/parentIntent/begin_stage扩展；仓外候选最终清理与最终组合验收仍单列。保留最少生产正确性回归，中文记录可进入docs/benchmarks。原失败不能删；仓外freeze与简洁聚合提供可复查定位，生产不保留算法切换。

Common 上的到期恢复、来源用途、工具身份检索与当前能力供给已分别完成有界验证并集成 Main；下一步仍是最终同版完整管线、连续事件与跨月独立验收。本记录选择了领域模型的单一路径，尚未证明用户要求的商业成熟自主陪伴已完成。

## 2026-09-18：后继连续性结果与边界

上文“仍待验收”是原Life3比较时的状态，原两臂16点及停摆不回填。后继原e05的il02/il04各4点已实际验证用户暂停、跨PID保留、明确许可后恢复，以及重开后才观察、创作一件小景并休息；没有编造停机期间经历。创作使用受控PNG，证明真实World创建/放置，不证明图片生成品质。当前继续选Common，用户不需维护另一套阶段表。

v6既定自主接续进一步取得原缺失的实际链：继承已闭v2的opening与01:25到期，目标在act开始后删除，真实REVISION_CONFLICT之后重新观察、改选墙上地图并行动；保存01:50后，经真实PFC提交确认再推进该due，同一Intent继续看吊饰并保存02:20。两新Run、18次实际生成均正常结束，新PID保留状态；02:20没有继续推进，不能把安排写成已发生的休息。报告为`local-autonomy-initial-due-observer-fix-v1/V6-LIVE-REVIEW.md`及`V6-LIVE-RESULT.json`。

这仍不是自治全环节无失败：两新Run自然quiet，公开正文Stop和取消Run后重开未曝光；已有工程取消/恢复和原暂停场景分别保留，不代填本次Stop。外部Formation旧wrapper产生4条`this.model.bind is not a function`错误，Memory仍0；外部接口已另修，但未重跑该故事，不能声称该链形成通过。当前v8（冻结`348d74ee…7ee14`）与v6（`e38d5d72…f5ac8`）的15个相关Cognition/Agent/Life及预算生产文件逐字相同，允许在该范围复用结果，不能把旧opening、原48与v6接续拼成v8整套重跑或真人长期收益。版本及场景映射见`COGNITION-COMPLETION-MAP-V8.md`（`85d7ba3f…2467e12a`）；整体剩余范围见[本地验收](../progress/LOCAL_MATURITY_ACCEPTANCE.md)。
