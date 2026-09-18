# Cognition 来源用途与输入引用：明确合同与一次条件纠正

2026-09-16。采用两项有界修订：模型指令明确来源的真实类型资格；Driver 与提交 Projection 复用同一纯校验，仅对已供应来源的精确用途类型错误，携带完整原 proposal 和具体错误请求一次完整重提。Root 先将唯一实现合入隔离共同 v15，现已随共同 v21 集成 Main；该次 v21 完整离线验证通过；最终组合语义与桌面验收仍待完成。

原 Life3 light-notebook/Common 真实失败把 `territory.observe` 的 **effect** 回执用作 `current_object`，但它没有顶层 `object`。宿主正确拒绝，不能因为 Tool 名叫 observe、结果很新或内含 World revision 就改成 observation。原提示已有“真实 observation 带 object”的自然语言要求；本次新增的是精确字段资格与条件反馈，不能把原失败描述为完全没有合同提示。

`current_object/current_foreground` 要求 `kind=observation && object present`；`current_recollection` 要求 `kind=recollection && current=true`。真实 Tool 读取可作为 `history`，由明确引用该读取的当前 Claim 和所绑定 Intent 继续表达行动条件。未供给的 ID 不直接提交；当前输入可判定的引用错误沿同一次条件纠正反馈，仍无合法引用时拒绝。其他 JSON、语义、网络错误不触发本纠正。第二次失败直接返回，取消、Persona 变化及完整请求预算均照常检查。没有自动重标来源、删 Claim、放宽完成依据、绕过 canonical revision 或实际 World/能力执行校验，也没有增加表、配置或第二调度路径。

OpenAI 官方文档说明 Structured Outputs 仍会产生内容错误，可改进指令或拆分任务；它没有规定“一次纠正”。本包的一次机会沿用已选 Memory R1 的有限语义纠正原则，是 CharaMate 的工程选择。[官方 Handling mistakes，2026-09-16 查阅](https://developers.openai.com/api/docs/guides/structured-outputs#handling-mistakes)。实际源为 common-v13；v14 的两个 Memory 变更未混入本比较。

| 固定分母 | 实际结果与能证明的范围 |
| --- | --- |
| 原历史真实失败 1 次 | 原 effect→current_object 被正确拒绝，原输出和闭库保留。离线重放拒绝后全部 Cognition 表不变。 |
| 已知条件 A/B 各 1 次真实生成 | A、B 使用同一新增 typed 提示。A 无反馈；B 先机械重放原坏 proposal 触发实际 Driver，再发一次真实纠正。两者均选 history + 当前 Claim + 原 Intent，并真实提交 ready；Intent 都为 active/rev19，新读取 Claim 已保存。**两者都过，不能称反馈优于无反馈**。B 只证明已知条件下纠正可执行，不估计自然触发率。 |
| 新 synthetic 类型对照 3 例 | 模型实际分别引用 current_object、current_recollection、history，3/3 宿主接受，无一触发纠正。没有把未用该类型的输出算正例。 |

A/B 的实际 SDK wire 除 B 多一个完整反馈消息外深等；原输入前缀也深等。两者没有宣称已坐下、读懂书页或休息了一段时间，均要求后续动作以真实回执确认。B 保留了旧的 1 月 13 日再考虑时间，并说明已过期；未来唤醒行为未在本包执行。三个普通对照分别保留了预览用途/字体未知、Memory 阅读不等于用户今天再次确认、历史画面不等于当前画面。recollection 例提出 RecallPlan，**只接受 prepare，未执行真实检索、complete 或 Agent 回答**。history 夹具的 23:59 文本与 15:59Z 意在表达 UTC+8，但模型时区为 UTC、映射没有显式供应，因此不能用此例证明精确跨时区理解。

真实执行区间为 11:18:24.370–11:21:00.363 UTC。5 次 gpt-6-astra generation 全部 completed，5 次 HTTP generation 均 200，进程 exit 0；合计输入 105,744、输出 8,387、缓存输入 0 tokens。B 比 A 增加 2,398 实际输入 tokens、7,979 wire bytes；此次共享机器/Provider环境的耗时只作描述。另有 5 次模型目录请求和 1 次 input_tokens 请求（404），没有 SDK 自动重试。

最大实际输入为 40,210 tokens，完整 SDK 输入估计最大 167,353，均低于完整输入 258k 合同。实际五份 generation wire 均未显式设置 `max_output_tokens`；不把它写成输入加输出总限额。部署不支持精确 count 的边界继续保留，本组不是近界计数验收。

离线验证为 33 focused（含 19 项新增）、348 Cognition 本域、54 integration，完整 TypeScript、受影响 lint/format 通过。唯一交付是 Driver、Projection 和两个 focused test，精确前后 hash 见 `HANDOFF.json`；源冻结 `23bd87a6…`，补丁 `ff612b42…`。实际调用冻结 `879e638b…`，完整 raw HTTP/SSE、解码结果、五份 SQLite/持久快照、费用和逐内容审阅留在 `live-validation/live-2026-09-16T11-18-24.305Z/`。

这不是独立 holdout，也不是五个独立真实故事。全包没有 Agent/territory.act 执行、native 或 encoder；不声称角色坐下、长期自主活动、三来源调度或冷记忆已通过。Root 集成后删除本包可执行候选及 A/B runner，保留原失败、输入输出、SQLite、补丁、报告与 hash；本次未删除仍待复核的源。

Root 共同 v15 集成：4 文件与 v14 逐项核对无冲突；417 项/20 文件通过（5.27 秒），完整类型检查与受影响 lint/format 通过。集成冻结 SHA `dd3213e816af03c7eca5ea74dc76836f97fb59cfa0f403a01e2e408cd01b1b7a`，765 文件共同源冻结 SHA `117303e4275604d6e7ba1921c478acb0b9fa856256239471cd75bbdbfbc1f643`。这不增加真实模型分母，也不替代到期恢复与实际 Agent/世界验收。


## 2026-09-17：同次纠正覆盖实体关系引用

独立 Final48 的 ia05 第三次 PFC 将当前情境保留的一个 closed 历史 ID 复制到新情境关联。ID 已在旧关联及历史 Attempt 中曝光，但当次 `snapshot.situations` 没有其实体视图；原提交因此正确拒绝。此前 Driver 的来源引用检查没有覆盖这种实体关系，直到下一条用户输入才重新分析成功。原四个对话检查点通过与这次 PFC 失败分别保留，不称整链无失败。

本次是原合同的正确性补全：Situation 与 Intent 各自以当次实体视图及本提案的同类型 `new:` 声明形成有效目标集合。未展示的历史关系仅能在原 owner、原字段保留；不能复制到新关联、另一关系字段、Choice、当前 Claim 的父项或注意选择。已供给的 partial 实体可以被引用，Situation 分配声明不可写的关系字段继续由 Repository 保留，前置检查不反向拒绝提交本来会忽略的占位值。child 资格、领域语义、版本及事务仍由原 Repository 负责。

不正确的引用只触发现有的一次完整提案纠正：原请求前缀不变，准确列出引用类型、字段和可用路径，保留完整原 proposal；纠正请求经过同一完整输入预算和取消检查，再次非法即结束。普通有效提案的指令、输入和调用次数不变，不自动删历史、不扩大快照、不增加重试或表。依据为当日实际 Projection/Reader/Repository，以及重新核对的 [OpenAI Structured Outputs 文档](https://developers.openai.com/api/docs/guides/structured-outputs#handling-mistakes)；官方仍未规定纠正次数，本次沿用原已选的一次机制。

临时真实 SQLite 前态经 Reader→selection→Attempt 生成：closed 目标确实省略，完整及 partial 两例原 commit 均无写拒绝，旧 Driver 只生成一次而在期望纠正处失败。候选在同一 Attempt 得到修正版后提交 ready，并保留原历史关联。新增 16 项与原引用 10 项覆盖 typed 新 ID、前向引用、可写及受保护字段、取消、持续非法和实际用户代次变化；本域与依赖集成 **530/530**，25 文件，08:01:45.562–08:02:12.788 UTC、27.223 秒，TypeScript/lint/format 通过。初始夹具错误、首次类型错误和两条旧 Driver 断言失败均保留；后两条改为当前 Driver 拒绝语义及既有 decoder 的纯映射测试，没有构造虚假供给。

Root 与独立 Cognition reviewer 均审完 2 生产及 2 既有测试文件，冻结清单 70/70 一致，已精确合入 Main。冻结 `adabb549844037daba9a4f5d55e579f4da02e251ec2464ed25d32bd5e499aabd`，补丁 `3f1fe3a4a2c32ecf87b71f5f428f55fa1621fb003504b2480161403b80ceb09e`，仓外记录 `integration/cognition-state-reference-correction-v1`。这些都是确定性与实际临时 SQLite 的机制证据；当前 Main 2512 项完整离线及生产构建已通过，真实模型的当次纠正效果及新版 App 尚未验收，不能覆盖 ia05 原成绩。生产没有候选开关或第二条路径。

2026-09-18定向真实复测：原ia05完整PFC输入、Persona/时钟及2,030个历史ModelEvent交给实际已修Driver，产生原关系诊断；一次新gpt-6-astra输出仅删除新Situation上不合资格的关联，原owner的历史链和其余完整提案逐JSON值保持。Driver接受，有限的原引用续修检查通过；原48结果不改。此执行固定aff6源，没有数据库提交、CAS、Agent派发或用户送达，后续Main组合与最终桌面仍按既定流程验收。

实际PID33686于09-17 16:03:16.081–16:03:48.023 UTC自然关闭，observer收口、无取消或finalization error。新增1 generation为22,526 input/2,045 output/cached0，历史20,106/2,161明确排除；另1 metadata200、1 count404。纠正请求本地完整估计105,123，不能称精确远程计数；真实用量已完整返回，金额未定价。Root全读独立报告并复核冻结 `248052f7f31a841996836a5c0f2133855dcbdca19865e699fc99d598b55861a0`，入口 `cognition-state-reference-live-continuation-v1/execution-01-review`。
