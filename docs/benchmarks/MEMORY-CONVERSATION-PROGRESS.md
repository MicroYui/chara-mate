# 已有承诺的实际对话进展

2026-09-17。已知本地连续场景的形成缺口修复，非新增研究题；Root 为产品与集成 owner。已随最终28文件Memory组合合入Main，实际946关联检查及静态通过；原自然模型定向复测与最终桌面仍待完成。

原 im02 的两个形成请求均已收到实际审阅回复全文及同一 active 承诺，但直接返回空 units，没有校验拒绝或材料遗漏。当时 current Revision 为 ad06dd47-ed18-4ae0-a167-0e2332adb2bc；最终 1d350b85-d39d-437c-a946-24af9f5d2871 是后续修订，不能倒放作前态。当前指令将实际言语交付与助手自称外部工作完成混在同一限制中；完整上下文分配的 F 候选没有改这条指令。

## 2026-09-17 无旧承诺的已交付材料

已随v24组合合Main，真实复测仍待执行。原if01已经给出长短两版风筝标签，但L37以完整139字实际assistant稿件为唯一primary、用户请求和session为context、existing为空时生成empty。后续只形成“用户正在征求写法”，PFC已保存两版不能替代Memory形成。原两点局部通过、第一次没有历史反馈供给、第二次暖采用的边界均保留，冻结 `407f19cb15b3b63b39959f4979c1868bfc0d4eb18cf25d3a65e78513842c9b20` 不改写。

这超出下文M的同一active承诺修订范围。2026-09-17重新检查当前FormationService，普通assistant文本的direct_observation只有当前角色承诺例外；因此仅修改指令仍会被实际依据核验拒绝。补充合同沿用既有event/episode、character/current persona、direct_observation，以既有predicate字段的 `delivered_conversation` 限定为已交付具体内容的言语事件。只允许实际primary assistant Chat/Voice引文；不能转换成用户已采纳、方法有效、稿件内行为真实发生或另一个承诺。一般闲聊、安慰与重复复述仍可不形成，不把所有助手文本存为事实。

该修改不新增kind/表/字段，仍由模型判断材料是否有持续用途、实际交付范围和语义主体；谓词及原引文检查是必要结构约束，不宣称宿主理解了所有稿件语义。Root所有的隔离包 `memory-delivered-conversation-v1` 只修改现Models/FormationService和相关回归。新助手依据例外仅限 create：若已供记忆保存同一原回复，省略重复；新回复不能因此确认或改写旧事件。原空输出、旧Service对限定提案的拒绝、受控持久化和之后的真实模型复测分开报告；最终具体结果待补，不增加研究Arm或重跑整个if01。

## 选择与范围

澄清现有形成指令：实际已保存回复中的具体审阅、解释或改写，可修订同一 active 承诺的局部进展。保留原角色、主体、对象、承诺发生时间及精确旧引文，新增真实回复来源和交付时间，并保留全文审完、文稿修改、用户采用未知。不得把再次答应、草稿台词或“我已经办好了”当作所称外部行为发生的证据。此路径不增加语义种类、字段、表、来源或自动完成规则。

现 Service 已允许有实际 primary assistant 依据的同角色 active commitment 修订；不伪造一项 Service RED。真正原失败是两次模型空提案。版本化当前指令、持久化回归和原材料定向真实生成分别回答合同、机制及实际形成效果。

## 当前来源

采用当前项目实际来源，非外部协议约束或论文性能结论。Main memoryModels.ts v18 SHA 15d272b70b3ee3c17c907040812625e6a18a7e9b80ebc6830f35348b0e920d9e；冻结 F v19 对应 SHA daaa0edbe6a4fec0b3482044167e6a496b1344a8de4e6a69a03d7f97c8605b4d，相关限制原文相同。Main memoryFormationService.ts SHA f8c608c0ca025da534b33ad9fc3329de9441e42c4ed3ec6c3bc498ca7853ec38。实际 Run/Item/Message 来源沿 memoryFormationSources.ts、runMemoryIntake.ts 和 cognitionMemoryIntake.ts 原路径，不让 Memory 跨域读取 Run 表。

仓外只读记录 memory-conversation-progress-source-review-v1.md SHA 9adff3c3d2f0ff6090e95879b185d815a5a4e2d4616eb48033151cb98f970deb。原 formation.jsonl SHA c12b7d8346557c3d64219280b9c2030507b13b08145f2dd0c1417e249378b8fe；assistant 来源 480b2304-c618-4e9e-aeb2-9483b76fec82 的 132 字全文已供给。

## 待完成验收

同一实际前态的合法局部进展提案通过真实 Service/SQLite 修订、再读，旧/新引文与两种时间不丢；外部完成、失败行动、其他角色、代写台词、completed/experience 来源限制及 CAS 回归仍有效。原材料定向生成必须实际产生新 Revision，并检查进入整合及重开后供给的内容，不能以强制 batch 回放替代模型效果。原评分点保持；不新增故事、研究 Arm 或预算参数。最终仅保留获验收的一个形成指令，实验副本不进入产品。


## 实现与已验事实

三文件于 11:57:02Z 按精确前像合入 Main：唯一生产文件 memoryModels.ts 将处理器升级为 source-evidence-formation-v20-active-conversation-progress，增加上述局部进展说明；原 Service、外部完成、experience 和 primary 来源限制均未改变。一个 Provider request 合同用例确认实际发送的正向说明与原限制共存，两个真实 Service/SQLite 回归保存同一 active 承诺的局部进展、原发生时间及新交付时间、全部旧引文和实际新引文，再 close/open 核对持久状态。

回归采用原 im02 L11/L13 的必要目标投影：五个 existing 中只保留 ad06 目标，其余记忆、未提供别名和写入历史未重建，不声称完整自然流水线重放。旧 Service 本来能提交合法 active revise，因此无伪造的 Service RED；原真实失败仍是两个模型空提案。隔离 Memory/来源 23 文件 476/476（含 focused171，不相加），11:42:49.827–54.171Z；tsc/lint/format 均通过，所有九个子 PID 退出。独立审查逐字段核原 episode/sourceWindows/sourceCoverage、实体、前态及132字交付原文和精确 spans，无合入阻塞。

原 im04 也出现完整建议输入后两次空提案，后续巩固收到的材料因此仍缺进展；PFC 已记录建议并未重复，原五点通过保留。这归同一已知缺口，不另开 Arm。新版自然形成、进入 Conso 和重开后供给仍待原 im02 一次完整针对复测；离线受控 batch 不代替它。

仓外 `integration/memory-conversation-progress-fix-v1` 冻结 SHA `c00d8427a0723cbca01e6ead03b328c85c0ff29969dddfc10a8ff39f5f093106`，补丁 SHA `8199a22829c86126c4275c52e0bcdf76033fc954dae9df63a81a138aa68b9509`。F 的完整比较接口适配目前只有静态可应用检查；最终组合须保留 F 的 bind/prepare/完整预算与本语义说明，不能将隔离验证转算为 F 同版结果。

精确 Main 集成回执 SHA `818144e600215a6df335a61727d5ddc3274522e9245ba988534430d9d90005d9`。后续若接受 F，组合处理器须改用独立版本身份，不复用 M 的 v20；原冻结比较源及其身份不变。

整合后实际 Main 验证：11:57:53–11:59:02Z，完整 offline 2553/2553（54.027秒）与生产 build（15.281秒）通过，628个src/tests前后相同，两PID退出。记录 `integration/waiting-and-progress-main-integration-v1`。原场景自然复测与最终桌面仍待执行，F候选不包含在此组合。


## im05 同一缺口的原目标供给修复

原五月 Formation L9 收到已交付清单比较与旧摘要45e2e705，但缺原active承诺7d0092fa；两者没有相同原始source ID，摘要却已明确携带指向该承诺的 current dependency。F1前只按同源取材，空units后又不触发Recall，因此 M指令与F完整预算均不能单独证明修好这条路径。八月一般邀请示例不自动成为必须入库的新记忆。

选择在 Formation 比较装配中补齐已采用摘要的精确原始依赖，复用同Persona/owner/current-history资格和完整证据读取。当前 grounded-consolidation-v1 的 LIVE_DERIVATION_SQL 明确禁止派生父项，所以一跳是实际数据合同，不是任意图深度。原件与摘要及其它必要材料一起计入现16MiB raw和完整Provider请求；不能重新截成小包，history不变成current，异步变化仍核原对象。只在实际形成请求前补比较原件，不新开模型、空输出循环或全历史检索。

实现前已读 2026-09-17 当前 Main memoryFormationService、memoryRecallPipeline/Repository、memoryLearningRepository 和冻结F对应实现。仓外因果记录 `integration/im05-formation-target-discovery-review-v1.md` SHA `5ac724c8f8df32ac1c549e1d288683ab6eab371728edfaf400159270b37cec35` 保留原L9/HTTP/空输出与哈希。原F公平比较与原48不改。

隔离候选已完成：仅Service补齐实际采用摘要的明确一跳依赖，Models与既有版本期待改用独立v22身份。补读不再次发现同源新摘要；完整组共享原raw和模型输入额度，current/history及每次await后的身份与引文检查沿原路径，不能容纳则保留未提交工作。没有新SQL、表、队列或检索器。原im05必要投影的旧路径先真实空完成；修复后受控提案实际修订同一active承诺并close/open一致，只证明供给和提交机制。

受影响领域首轮504/505，唯一失败为既有v21期待；修正后Service+Models195/195，最后Pack字段补型后对应F2例1/1，最终tsc/lint/format通过。结果不相加，也不声称一次最终505全绿。18个记录子PID全部退出。Root检查627个源文件中仅四个声明文件变化，其余623与父组合相同，并审查实际生产差异。仓外 `integration/formation-derived-comparison-completion-v1` FREEZE `83b434ed917b348edf08f969e3f2e4c8b854149029e27a5d0f3a833c9fac52cb`，patch `6b9a8eed4824b24728ca42636bd57627b60d87cb8da882884cff9c2f17799746`。Main尚未合F或本包；公平比较、最终整合和原im05自然模型复测仍待完成。


2026-09-18（UTC09-17）组合接管：Root按28项精确前像合入完整必要比较、v22派生原件、v23纠正情境、Selector引用、v24实际稿件及巩固来源支持，保留Activity与Cognition新实现。当前唯一Formation身份为 `source-evidence-formation-v24-delivered-conversation`，此前v20/v21/v22是历史包身份，不保留运行时分支。Main 946关联检查（35文件）与类型/lint/format通过，16:29:56–16:30:12 UTC；原im02/im05/if01实际模型与最终App尚待同源复测，不能以集成通过替代语义结果。选择依据见[完整必要比较](MEMORY-FORMATION-COMPARISON-CONTEXT.md)。

## 2026-09-18 整合源 v3 的既定定向复测

原139字assistant稿为唯一primary、另两source仅context、existing/entities为空的单形成复测，在最终v3自然生成并提交一个 `event/episode/character/direct_observation/delivered_conversation`。两版“牵着风”标签及精确assistant `[22,109)` 引文真实保存，明确稿内往事未知、无用户选择/采纳或制作证据；新PID重开全部事实相等。episode、来源次序/窗口/用途/coverage/entities/time与原一致，但原后台gap字符串“部分经历尚未形成可检索记忆”在单episode新库为 `[]`；instructions也改变，schema相等。因此这是同原材料针对形成，不是完整原F1字节重放或原后台负载复现。原empty保留；本次一生成，不证明if03同类材料、索引、Conso或后续普通答案已通过。

证据：`integration/if01-delivered-conversation-live-retest-v1/live-integrated-01/{form/INPUT-COMPARISON.json,form/formation.jsonl,form/final.json,reopen/reopened.json,form/HTTP-SUMMARY.json,RESULT.json}`；`ROOT-LIVE-REVIEW.json` 与独立 `independent-review-integrated-01/REPORT.md`（SHA `b898f75517969bb0f55d9a3188e00160c4497cf87e8b2bcad0ebb6c1e9a25d77`），以及`integration/final-local-completion-queue-v2/NODE-INDEPENDENT-ROOT-REVIEW.json`。原SSE的服务降级提示与count404保留，唯一生成仍真实completed。

本结果固定于 SOURCE-FREEZE `0cbc46b68b3eb62f10f1e72f8a3acc97b533ee1a171473940955845a5c28f3b0`。后续共享表达改动与最终安装另行绑定；不回写原48成绩，不以内部调用替代最终桌面/冷检索。
