# Memory 修订、归档与形成回执的一致性

更新：2026-09-16。修订真值合同已进入 Main v21，真实模型的最终同版独立连续验收仍待完成；下方历史版本的通过数量不作为本轮最终验收。Owner：root（共享契约与整合）、memory worker（领域实现）。

## 当前修订真值合同

过去真实但后来改变的安排，与原来就记错的陈述，不能仅靠 `current/history` 查询用途区分。新 Revision 在同一事务中记录实际 `predecessorRevisionId` 和针对本 Memory 已存在旧版本的 `priorDispositions`。前驱改变则重比较，不能提交建立在旧前驱上的结果。沿已存前驱链判定，不用同时间戳或行号猜顺序；更早已被纠正的版本不会因后续普通编辑重新成为真事实。

| 状态 | 普通读取和行动用途 |
| --- | --- |
| current | 最新活动且未撤回的版本。是否适用于当前时间，还要独立检查 `current` 与 validFrom/validTo；状态名不代表过去有效期自动延长。 |
| retained_history | 有来源确认当时成立、后来变化。可以解释真实过去，也可用于有明确历史用途的巩固和领地表达。 |
| corrected | 可以解释“当时说错了什么”，读取时标注纠正；不能证明那件事发生，也不能作为完成、巩固或领地生成依据。 |
| unresolved | 旧陈述是否曾成立尚不明确。仅供带标注回看，不能作为真实经历使用。 |

自然形成必须由实际新来源支持 disposition；普通编辑不自动证明旧值曾经真实。显式纠错必须来自当前用户原话，不能由观察或推断替用户改口。再次确认已纠正的旧内容时写新当前版本，不洗掉旧纠错记录。读取“某时曾知道什么”也不会隐藏如今已经知道的纠错。

Schema 只在既有 Revision 增加前驱与处置字段，复用同 Memory 的复合外键和事务；没有第二份历史表。既有 v25 升级到本轮未发布 v26 时旧版本保持未知，不补造历史判断。共享 Schema、DDL 和升级由 root 唯一整合。依据为产品 §6.3、SQLite 3.53.3 的[递归 CTE](https://www.sqlite.org/lang_with.html)、[事务](https://www.sqlite.org/lang_transaction.html)与[外键](https://www.sqlite.org/foreignkeys.html)，读取日 2026-09-16；四种真值语义是产品合同，不是 SQLite 或脑科学定义。

当前真实 SQLite 领域验证覆盖多次修订、更早版本纠错、同时间戳顺序、原文释放、过期最新版本及派生依赖；DDL 12 例、历史说明 UI 13 例已分别通过。组合验证使用实际 Memory、Territory、PNG 文件和 Voice Run：真历史可继续表达；纠错、删除或父源失效在生成前、生成中和应用前均阻止旧内容落地；45 日重启仍保护待交接、在途形成和当前视觉来源。测试中的 semantic disposition 是明确的边界输入，不能代替自然语言模型理解。

首次组合回归 358/359：旧领地夹具把一次 manual edit 当成“旧值曾真实”，因此正确性检查拒绝后夹具等待了不会开始的图像任务。保留原失败；将正例改为明确 retained_history，并另测 unresolved 拒绝，没有放宽资格。新增 Voice 实际来源测试最初 5/5 失败，原因是对应适配器尚未整合；补齐后通过。长语音历史的固定“一次摘要”旧断言也在指令变长后失败，改查会话开启前已整理且原消息完整保留；摘要批次数由完整请求容量决定。后续单独 Voice 与来源回归 53/53、组合 typecheck 通过，最终同版全量仍以 STATUS 为准。

本轮冻结：History 18 领域文件 `f0e73ba18d1ba5437c2e510907d1285361b16baf371d6f9a37fe4d7ae546fa22`；共享契约 `4d7547cf9707bcea8301fa20f8b2f0608ce9859a1ef6ec6368661e48b4cd614b`；Voice 与宿主来源 10 文件 `b7739c5544baf980e34b7f7a848fa3985328e7973c54678f5f3bbbc1dd352ce6`。原始结果与可执行实验在仓外。独立 History、speech-act 与复杂形成/冷检索尚待真实 gpt-6-astra 运行，不宣称商业质量已完成。

历史链实际读取和修订成本的独立配对、获选 SQL 及短链代价见[历史查询决策](MEMORY-REVISION-HISTORY-QUERY.md)。该优化保持本页真实性合同，不新增持久历史副本。

### 认知行动使用读取时的历史资格

后续跨领域复核发现，Memory 返回的历史状态在 Cognition recollection 投影时被丢弃；而历史读取原版本仍存在，不足以证明此前决定的依据仍成立。新增路径把 `historyStatus/historyStatusRevisionId` 保存在既有不可变 Evidence 中，行动只从其选中 Evidence ID 取得实际读过的状态。宿主通过原批量引用校验同时比对读取资格，不增加第二份状态表、工具参数或相似检索。分发、Run 准备及发布继续检查同一依据；永久删除、归档、版本更替和历史状态变更各自维持原含义。

例如先根据“当时确实有此约定”作出决定，随后用户指出那是误记，旧 Run 不再投影；新请求仍可以读取并解释“当时记成了什么、现在为何被纠正”。已经纠错或尚未确认的直接观察回忆不能投影成 observed 事实；实际发生的用户原话可以保留其归因。状态原因修订变化也使此前读取资格失效，不能只比较四态名称。

实际 SQLite 的新增校验先失败后修复；认知/记忆 181 项 focused 和 Runtime 29 项通过。原 Runtime 允许“历史引用仍存在即可沿用在途决定”的正例在新合同下失败，已保留原记录，改为检查旧决策撤销，并另加新读取已纠正原话仍可正常完成的正例。这里验证宿主资格、真实数据库及发布边界；模型是否自然解释纠错仍由独立语义验收负责。源码与各次结果以仓外 `integration/history-cognition-stamp-*` 保存，最终整合验证另计。

## 2026-09-15 的已实现修复

以下记录对应当日范围。Owner：root（领域整合），explain_memory（手动修订），memory_research（归档候选资格）。当日修复没有新增模型、表、后台作业、迁移或用户设置。

## 问题与决定

发现三个可复现的生命周期缺口：手动编辑创建的新 Revision 没有保留已知角色归属；需要历史版本的关系扩展把 archived 记忆重新纳入候选；形成任务已经完成后，即使结果被用户永久删除，重复调用仍返回旧成功回执，Tool 继续报告“已根据原始证据更新记忆”。这三种行为分别违反角色范围、用户归档和实际保存结果的产品语义。

1. 手动编辑保留已知 owner，以及 character 的 personaId。新正文作为用户纠正，kind=claim、basis=explicit_user_statement；不复制旧实体、主谓关系、完成结论、约定状态或自动推断时间。用户设置的日历字段仍由普通 Revision metadata 管理，本次明确填写的有效时间按请求写入。原记录归属未知时不猜一个角色。创建 Revision 和其语义归属处于同一事务，失败全部回滚。
2. `includeSuperseded` 只让历史 Revision 有机会成为证据，不能解除 Memory 的 archived 状态。词法、向量、实体、来源和关系候选继续共用资格条件，恢复来自用户明确操作。
3. 持久形成回执描述当时提交过哪些 Revision，保留它用于幂等。每次返回时，以已有 Revision 主键批量核对当前活动版本；只有仍存在、未删除、未归档且仍为当前版本的条目进入 `changes`。其余只返回无正文的 `unavailableChanges` 引用。同一已完成任务标为 replayed，不重新调用模型或重新写入，Tool 不把旧结果说成当前已保存的事实。多段形成中被后续段修订的中间版本也不能再参与当前结果投影。

这不是“永远不能再次学到某事实”的实现。删除 Memory 不连带删除仍归 Chat 所有的原消息；一个不同的未来形成任务仍可能重新处理该原文。如何阻止后台重提已经明确删除的同一事实，同时不丢掉同来源中的其他事实，仍需与待处理合并及来源生命周期一并确定。此处不添加整条来源禁用或无证据的长期 tombstone 策略。

## 源码和主源

读取与验证日：2026-09-15。实际 better-sqlite3 13.0.1、SQLite 3.53.3、Node 24.18.0，M4 Pro / 24 GiB。依据是当前 `MemoryRepository.revise/archive/softDelete/purge`、Formation 工作回执、Memory Tool 及产品设计 6.3–6.7，而非外部库规定的记忆语义。

- [SQLite transactions](https://www.sqlite.org/lang_transaction.html)：同步领域事务中完成修订和归属；模型调用不进入事务。
- [SQLite foreign keys](https://www.sqlite.org/foreignkeys.html)：既有 Revision/来源关系通过已开启的外键维护，删除不靠吞掉 FK 错误。
- [SQLite query planner](https://www.sqlite.org/queryplanner.html)：回执核对按实际 Revision ID 和 Memory 主键定位，仅读取资格列；未加载全库或该记忆所有历史正文，也没有为这个短查询增设索引。

这些来源不定义“手动编辑该相信谁”或永久遗忘策略；后者是 CharaMate 产品决定。没有任意 TTL、记忆强度阈值或新的安全框架。

## 验证

手动修订的六个真实 SQLite 用例在修复前四个失败，修复后全部通过；独立树 Memory unit 107/107，限定入口使用同 strict tsconfig 的 531 个依赖文件无诊断。整合主树的手动修订与 Memory integration 22/22 通过。

加入回执修复后，当前主树 Memory formation、Memory Tool、手动修订、Memory integration、Agent Runtime 和 Voice Runtime 共 **150/150** 通过（2026-09-15 18:56，Vitest 1.84 秒）；主树 typecheck 通过。回归覆盖可恢复删除、永久删除、编辑后旧回执、归档后显式恢复、混合结果、持久回执不改写且模型只调用一次、Tool 不误报重新保存，以及跨角色候选和事务回滚。

首次整合验证两项旧断言失败：重复调用不再与首次调用的 replayed 标记相同；分段形成返回的中间旧版本转入 unavailableChanges。保留失败并把断言改为检查新合同和历史工作结果，没有改模型输出来掩盖失败。离线 SQLite 测试证明工程状态，不证明真实模型理解用户删除意图或最终回答质量；新的完整离线、桌面和打包边界以 STATUS 为准。

手动修订交接清单为仓外 `evidence/memory-manual-edit/handoff.json`；原始缺口记录为 `evidence/memory-lifecycle-review/MEMORY-LIFECYCLE-REVIEW.md`。后者写于修复前，不能当当前未修复列表。该只读审查中的删除诊断完成用户分支后，在另一个未准备 Persona 的合成分支遇到 FK 失败；未声称整份诊断通过，也没有关闭外键重跑掩盖错误。生产仅保留上述单一领域行为及回归，不保留诊断脚本。

## 新直接证据与旧用户报告

冻结 v6 的 s24:c08 又暴露一个依据建模错误：用户先报告刚收到拒信、正文未知，后来实际 Activity 呈现拒信正文。真实 Astra 输出保留了“收信来自用户报告；正文来自当前观察；来源未知；不代表情绪恢复”的范围，并引用两个真实来源，却被宿主把所有非 explicit_user_statement 都当成 interpretation 拒绝。这是主机分类过严，不是该输出没有依据，也不是 embedding 问题。

v7 修正：inference 不能覆盖 explicit_user_statement 或 direct_observation；实际观察可补充事件或更新实际结果。手动纠正 authoring=user_edit 仍只能由新用户明确陈述修订。形成指令要求保留复合来源范围，真实冲突另建关联观察而非伪造用户改口；视觉观察仍不能建立用户偏好/画像，角色完成经历仍要求实际 primary Tool 来源。这没有新增多依据评分或自动信任层级。

新增真实 SQLite 回归覆盖用户报告加观察正文、原 Revision/原来源保留、推断不能覆盖观察、观察不能覆盖手动纠正。形成 focused 47/47 通过（19:01，1.45 秒）。首次手动纠正用例试图给旧不可变语义重复 INSERT，触发 UNIQUE；改成实际创建新 Revision 再写新语义，未放松生产唯一约束。原冻结 v6 失败继续计入分母；保存输出的离线重放与真实 v7 模型重跑分开记录，不能将 host 接受旧输出说成模型已经通过新协议。

随后在 c08 检查点后的独立 SQLite 副本上，使用原实际 v6 batch 和完整已提供 EvidenceItem，零网络运行最新 v7 host：原目标 ID/正文相同，保存输出注入一次，提交一个修订和两条精确来源区间。原用户报告保留，新正文依据来自当前 Activity；相关 durable 工作原文与原库字节一致，冻结库及原失败 ledger 未改。这不是拒绝瞬间的精确全库前态，也不是 v7 模型生成质量测试。

该离线重放前三次脚本准备失败分别来自把 segment 重排来源当作 intake，以及使用缺少 sourceRefs 的诊断摘录；最终改用真实持久 Episode 和完整模型输入，没有放松宿主校验。结果为仓外 `evidence/memory-host-v7/result-4.json`，SHA-256 `ccc75c15cac10275adfa0243864c6c1e15622bdcb4fdda6fcf642cdb8a9ec7f5`；源、清单和完整限制见同目录 REPORT/final-manifest/canonical-audit。

当前整合源码完整离线 **1,255/1,255** 通过（19:02，134 contract / 842 unit+component / 279 integration），typecheck/lint/format通过，保留两个既有 TanStack 警告。后续新改动的验收仍以 STATUS 为准。
