# 显式 Appraisal 与现有 Claims/Intent/Choice：开发比较决策

2026-09-16。集成 owner：root。开发比较已完成，选择保留现有基础；最终组合语义验收尚未完成。

4 个混合事件家族 × 4 检查点、8 条完整实际流水线结束。选择保留较简单的共同基础，不将 Appraisal 新表示晋级。这里不是宣布两者数学等价，也不是宣布当前商业成熟；共同的真实执行与记忆形成失败仍须修复。Appraisal 在一处恢复自主活动上比 Common 更早发生了实际动作，但没有改善完整执行成功，新增表示及成本暂不足以支持保留。

## 冻结与因果范围

A2 源固定于 `APPRAISAL-A2-SOURCE-FREEZE.json`（SHA be4a3b96da1335bf830bbec1a5964c8fb87e09cbbf588fc758f20a258e0db45e）：共同接管 v2、unknown actor、冷入口 instruction、同 Memory、同 4B、同真实 Runner，只有 15 文件 Appraisal 变化不同。四族顺序 AB、BA、AB、BA。中途平台资源窗口在故事边界暂停，按事先记录的并行环境修订允许两独立家族并行；不把墙钟差异作为产品性能因果。每次调用及失败均保留，已完成故事没有重跑。

输入 SHA b58fe224f4d88872b6ccac6e1e75b1a981541eb5c8b89f950d2ca576e47ec3b1；标签 SHA 59a63ba36d40e972ceb335021a88062b5155627213edfbf7782daf47f39bc8b9。输入不含期待 Tool/动作/心理标签。评价采用事前独立标签、实际 PFC 选择、完整输入、Agent 输出、SQLite 与世界结果。评分由实现者复核，因此属于开发比较；Root 未見组尚未执行，不能冒称独立盲验。

原 a1 message-only 在普通 Agent 已回应后后台多数 quiet，并有原始接管流程失败；它不能证明 Appraisal 改变注意竞争。a1 的分母、失败和冻结源保留，未合进 A2 的 16 点。

## 结果

| 家族 | Common 行为准则 | Appraisal 行为准则 | 实际差异与未解决问题 |
| --- | --- | --- | --- |
| letter-listening | 4/4 | 4/4 | 都能先听、等真正文稿出现后支持、撤回后停止、跨日只讨论新许可范围。两边都 12 次 PFC：10 quiet+2 shared；6 Run 完成、2 Surface。 |
| sketch-play | 3/4 | 3/4 | 两边都识别玩耍邀请并选 continue_shared，但已有未经请求开场冷却阻止实际回应；不是分类未认出。停止与个人表达约束两边保持。 |
| ordinary-focus | 4/4 | 4/4 | 不把操作强度当焦虑，承认纠正，完成工作后转轻松交流。安静时各一次真实领地动作，未打扰，但 Runtime 将允许的空终结回答判失败。 |
| own-home-return | 3/4 | 4/4 | Common 恢复排程后当次后续活动被材料预算拦住，Appraisal 实际观察书堆，保留这一处局部优势。两边能暂停、重新安排并跨14日重启，不编离线活动；随后都遇到全源材料超配额。 |
| 合计 | 14/16 | 15/16 | Appraisal-only 1，Common-only 0；差异+6.25个百分点，只有一个家族中的一个点。 |

以上行为准则不是“完整产品成功率”。事后另外把实际必要 Run 终态、执行材料失败合并报告（不另造预注册 veto）：letter4、sketch3、ordinary3、home1，两边均 **11/16**。ordinary c3、home c1/c3/c4 的行为与真实终态/供给缺口逐项保留；例如已成功坐下是真实效果，同时该 Run failed 也是真的，不能让其中一个抹去另一个。

描述性 Wilson95：Common 行为14/16 [0.640,0.965]；Appraisal15/16 [0.717,0.989]；完整流水线11/16均 [0.444,0.858]。16 点来自4相关家族，不能把这个区间当独立用户总体置信结论；没有足够证据声称通用改善或严格等价。

| 实际代价与失败 | Common | Appraisal |
| --- | ---: | ---: |
| 模型请求（包括 PFC/Agent/Formation/Selector） | 258 | 265 |
| input tokens | 2,036,491 | 2,246,065 |
| output tokens | 143,377 | 159,032 |
| cached input tokens（输入子集，不重复加） | 647,070 | 604,317 |
| 最大真实单请求 input | 27,347 | 34,979 |
| 缺 usage 请求 | 0 | 0 |
| 已提交 Choice | 41（31 quiet、5 shared、5 character） | 42（31 quiet、5 shared、6 character） |
| 实际 Run | 17 completed、3 failed | 17 completed、4 failed |
| Formation 报错 | 8 | 9 |
| PFC/材料报错 | 2 | 4 |

Appraisal 总 input +10.29%、output +10.92%；没有可核定单价，不换算美元。最终单请求都远低于用户258000，但当前代理 input_tokens count 不支持，保守预检不能声称精确数学硬保证。所有正式调用 gpt-6-astra、同选中4B，无额度切换。

最终 Situation 存量 Common 41443 bytes、Appraisal 48133 bytes（两臂自行创建的对象数不同，不能把全部差额都归于新字段）；Appraisal 字段本身3856 bytes，另有15文件的状态/引用/投影/校验复杂度。这里只计逻辑 JSON，不称 RSS 或完整数据库占用。

## 实际消费与时点

13 个当前用户 prepareTurn 中，Appraisal 有9个带入先前已形成的解释，Common为0；实际 Agent 20个模型请求包含 appraisalContext。均可回到 `model-*-request.json` 查看真实投影，未只根据数据库存在字段就计消费。

这不意味着13条当前消息都在答复前进行了新 Appraisal。真实顺序是当前消息先进入 ordinary Agent（可收到已有解释），之后 PFC 再更新本条消息的解释。首次消息没有前置 Appraisal；9次是旧解释被继续使用，不是本条新解释导致本条回应。Activity/wake 的 PFC 则直接处在后台选择之前。本比较据此评价选择与最终表达，不把“字段齐全”当能力收益。

对倾听、协作、玩耍、安静的实际方式切换，两边多数都依靠既有用户原话、Claims、Intent状态/许可范围和Choice时机即可实现。观察到 Appraisal 存储与消费者工作，不等于观察到额外表示的稳定作用。

## 真实失败和后续共同修复

1. 17条 Formation 失败保留：多数把角色实际话语承诺当成 direct_observation，另有当前来源限定问题。Root 后续 History+角色speech-act修复不是 A2 Arm 的改动，不回写旧结果。
2. sketch c3 两边理解邀请但未投递。Root Requested Continuation V3 用实际用户 receipt、条件、原Chat与一次投递资格解决，未作为本比较收益。
3. 7个实际自主Run均发生真实工具结果，却在允许quiet完成时EMPTY_RESPONSE。Root 的 [quietCompletionAllowed 修复](AGENT-QUIET-LIFE-COMPLETION.md)已随共同 v21 集成 Main，不能让“改成发一句话”掩盖原产品意图。
4. 4次准备材料失败（每臂2次）源自选中整份约13.5KB世界观察而执行配额为8192保守估算。当时先核对计量，独立设计见 ACTION-CONTEXT-BUDGET-SOURCE-REVIEW.md；后续已选择[完整请求动态分配](COGNITION-DYNAMIC-ACTION-BUDGET.md)，不再把8192作为当前行动配额。Appraisal额外的两项PFC错误分别为 observed claim 来源不合格、meaningClaimIds 空数组；不为了零报错放宽来源语义。

## 选择、删除与边界

依据整体效果、成本和维护量，选现有 Claims/Intent/Choice 作为单一基础；这是透明工程选择：保留 Appraisal 一处局部行为优势的原证据，没有声称“完全无差异”。该优势尚未变成完整执行收益，需先关闭共同执行失败，再在Root独立组验证单一基础能否满足要求。不能因用户要求高级产品就保留一份没有明确净收益的解释状态。

Main 从未合入候选 Appraisal schema/消费者；后续从 Root `common-v9-frozen` 建立预算/Life候选，不从 Appraisal候选复制。现在仓外各冻结 Arm/runner 仅为复现与独立整合准备，尚未删除，不能写“删除证明已完成”。最终 Root 验收后归档非敏感证据并删除候选源码、Runner、开关与实验资产；生产只保留当前基础以及另被选中的真实修复。持久价值/阶段/经验连接后来经独立 Life3 比较，已选择 Common，见[角色动机决定](COMPANION-LIFE-MOTIVATION.md)；不是从本 Appraisal 未选推定其结果。共同修复已随 v21 集成 Main，最终组合语义验收仍单列。

聚合：`evidence/MIXED-A2-PAIRED-FINAL.json`，逐点行为与联合结果分开；8份`MIXED-A2-*-FULL-SUMMARY.json`对应真实来源目录；`MIXED-A2-STATE-SIZES.json`来自最终只读SQLite。完整故事结束不等于桌面实机、长期体验、吞吐或商业级可靠性已通过。

## 2026-09-18：后继有限验收收口

上文“最终组合尚未完成”是原开发比较结束时的边界；原两臂16点、实际失败、成本和不晋级Appraisal的选择均不变。后继原e05独立48中，ia01/ia02各4点实际区分了用户担心与能力判断、当日建议与倾听要求，回答和后续约定随真实新信息改变；并非仅保存了解释字段。v3原im01九步定向5/5，包含暂停后不因环境更新自行恢复，以及后续新材料进入同一waiting Run、正确核算700元的实际结果。这里分别有Cognition暖供给和真实按需取材，不统称冷检索，也不作为Appraisal比较的新分母。

当前仍保留原it02 c120瞬时遗漏：完整条款已进入PFC，但检查点时决策尚在途；之后被真实用户输入取消。请求目录去重不能证明已解决该时点失败，不由此增加抢占、调用或新阈值。上述受控结果支持既有Claims/Intent/Choice的有限本地收口，不证明普遍心理理解或全部场景零失败。

当前v8源码冻结为`348d74ee…7ee14`；与v6的15个Cognition/Agent/Life及完整预算相关生产文件逐字相同，版本清单见仓外`final-local-completion-queue-v2/COGNITION-COMPLETION-MAP-V8.md`（SHA256 `85d7ba3f…2467e12a`）。原48保持e05、im01定向保持v3，不改绑为最终v8全48通过。实际报告分别为原`ia01/ia02`独立REPORT、`im01-waiting-input-live-retest-v1/review-natural-integrated-01/REPORT.md`和`it02-attention-timing-cause-review-v1.md`；整体剩余范围以[本地验收](../progress/LOCAL_MATURITY_ACCEPTANCE.md)为准。
