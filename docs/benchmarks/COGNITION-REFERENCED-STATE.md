# 已结束事项按实际引用续接

日期：2026-09-15；交付状态更新于2026-09-16。Decision ID：`COGNITION-REFERENCED-STATE`。近期实际引用恢复与普通直接关联投影已选入 Main，已随共同 v21 保留，且该次完整离线验证通过。下文原连续故事与普通 Agent 配对只证明其各自范围，不构成最终同版冷跨 Chat、连续语义或桌面验收。Root 是 Main、共享合同、DDL 与产品文档的唯一集成 owner。

## 产品问题与证据

本轮 p05 的实际案例不是模型完全没有理解。c3 已保存九月账本数值 1260 并结束 Situation/Intent；c4 理解了“仅本地保存，八月 1190 是另一个文件”，但先前实体已经离开默认 snapshot，模型没有当前 revision 和可写 allocation，新的限定只出现在 Attempt rationale。当前 prepare 没有焦点时为空本身是合理行为；错误在于必要更正无法落回已知旧事项，而不是所有历史内容都应常驻。

只读诊断及原始评分保存在 `local-perception-independent-memory-review/CLOSED-CORRECTION-DIAGNOSIS.md`。本包不回写原模型输出、失败分母或评分，不把本地可提交测试称作 p05 已重跑成功。原先针对两个“片段未显示”句子的额外错误归因已有独立勘误，见同目录 `SOURCE-EXCERPT-ERRATUM.md`；必要事实得分不变。

基线是 `BASE-FREEZE.json` 在 `2026-09-15T14:16:01.242457+00:00` 从 integration 复制并逐文件记录的源码。Git HEAD 为 `fc81239304c03648ee3f39ca178f3695ce474ffc`，但大量新功能尚未提交，故 **HEAD 不能替代该逐文件快照**。读取范围包含当时 Memory v11、Q4 和时间修复后的 Cognition。没有改正在执行的正式感知或 Q4 快照。

## 选中行为

保留现有 snapshot、allocation、revision fence 和 prepare，不建立第二个状态搜索服务。两种实际来源进入同一个受预算 `referencedState` 读取：

1. 最近一次 Attempt 实际 selectedChoice 的 Situation/Intent，以及 selectedBasis.currentClaimRefs。父 ID 还必须出现在该 Attempt 的实际 dependencies。全体已曝光 dependencies 不续驻留；未选用一次以后退出，连续实际使用可以继续。读取不会把 closed/fulfilled 改成活动状态。
2. 既有 Memory recall 完成时，宿主将 Memory 的真实 canonical source references 映射到 Cognition 来源别名，再从同 Persona 的 Episode/Claim 反向关联取得 parent 和具体 child。读取当前 revision，不要求历史 Memory source revision 等于当前 Cognition revision；这只赋予可读性，绝不自动赋予当前动作资格。

必要首条 source identity、当前情境/承诺、实际 cue 与当前前台来源保留后，引用父项的最小可更新视图进入同一预算，先于其余 journal 填充。命中具体 claim/episode 先于默认 children，返回仍维持其 canonical 数组顺序；目标 child 原支持来源也在其余 journal 之前分配。后续扩充继续优先同一组 child，不能把它们再次挤掉。过大 child/source 仍可省略或只返回 excerpt，必须保留 coverage 与 allocation 限制。

completion 的 reader 接收当次已选消息和 Memory recollection 的 identity。完成分析最终只保留这些来源及实际可见 state 依赖的来源；不把 recall 等待期间新增的一整页无关 journal 混入当前分析，也不再次覆盖掉刚读取的旧 support。原 Attempt throughSequence 保持不变，实际新的 user generation/Persona/revision 仍按原合同验证。

普通问候的 prepare 不因此注入全历史。模型可以更新旧限定而继续保持 closed/fulfilled，并保持安静；它是否应该对用户再次提起，仍是情境决策问题。

## 最终公开接口

`src/main/cognition/cognitionTypes.ts`：

```ts
interface CognitionStateReferences {
  situationIds: string[];
  intentIds: string[];
  situationChildren?: {
    situationId: string;
    claimIds: string[];
    episodeIds: string[];
  }[];
  missingReferenceCount: number;
  truncated: boolean;
}
```

`CognitionRepository.stateReferencesForSources(personaId, candidates, maxBytes)` 消费现有 `CognitionSourceRetentionCandidate[]`。每个 `candidateId` 表示一个 canonical source，`references[]` 是它的实际 `{kind,id,fragment}` 别名组。一个别名关联成功即可，不把未使用的另一合法别名算作缺口。找到了 Evidence 却找不到 Episode/Claim parent 时，仍记一个 state relation 缺口。未遍历的截断后缀不算已知缺失。

返回的 parent、Intent、child IDs 和 coverage 一起按 UTF-8 JSON 字节预算停止。使用 `iterate` 同步读取，不全量 `.all()` 历史 parent 正文；每次调用取入参与仓储 readBudgetBytes 的交集。`maxBytes` 是本机 materialization/请求工作集预算，不是协议 token 计数、长期存储上限或固定召回条数。

`CognitionServiceOptions.resolveMemoryStateReferences?(personaId, items, maxBytes)` 同步返回以上结构。Root 在 Main 注入真实 canonical→Cognition 适配，不根据 Memory.owner 猜 Persona，不把 canonical sourceId 当作 Cognition evidenceId。Memory 的 sourceRefs 不完整时，Main 应在该覆盖结构中记映射缺口。没有匹配也仍能使用普通 Memory facts，不能称所有旧 Cognition state 已可发现。

`CognitionRepository.readSnapshot(personaId, now, maxBytes?, referencedState?, retainedEvidenceIds?)`：第五参供既有 recall completion 保留已选输入，不新增运行时模式。reader 与 `selectAnalysisSnapshot` 都沿用现有分配。新增 `coverage.stateReferences` 包含实体缺失、预算省略、sourceMappingMissingCount 和 sourceMappingTruncated；它表达读取范围，不推断缺失事实的内容。

没有新的 LLM 输出 schema、用户配置、计时器、进程、模型调用或付费重试。

## 数据与生命周期

新增派生表 `cognition_claim_evidence`，主键 `(situation_id,claim_id,evidence_id)`，外键级联；保存 claim state 和 `current_basis`。Situation 全量提交删除并重建该 parent 的派生关联，partial merge 仅替换实际更新的 child，保留未读 child。与 canonical Situation 在同一同步事务里维护；异常整体回滚。没有另一份来源正文。

新增 source covering index `(evidence_id,current_basis,situation_id,claim_id,state)` 和 Intent parent index `(situation_id,persona_id,id)`。现有 Episode 反向关联继续独立维护，不能把只有 Claim 的真实来源漏掉。本次是未发布 v26 的当前 DDL 候选，不为此前实验库加迁移。Root 集成时需确保真实数据库创建路径与 DDL 同版。

GC 语义变化必须单列：基线原先把 `historyEvidenceIds` 也当成 claim 的原文保留 consumer；这不是本包新增的回归。Root 审阅后明确收紧为“实际当前 consumer 锁原文”。本候选保留 history 的反向关联供冷找回，但 GC 只认当前支持/反证、且未 superseded 的 claim。相同 source 同时在 history 和当前支持时 `current_basis=1`。其他 unanalysed、进行中的 decision、handoff、未闭合 Episode、未结束 Intent consumer 不变；本包不增加 TTL，不直接删除 Memory canonical 原文，也不删除精确引文/历史关联。

## 来源与查询计划

- [SQLite Query Planning](https://www.sqlite.org/queryplanner.html)，阅读日期 2026-09-15：复合/covering index 属于查询能力；具体列顺序与跨域映射是本项目候选。
- [SQLite JSON Functions](https://www.sqlite.org/json1.html)，阅读日期 2026-09-15：`json_each` 在现存 JSON payload 上读取数组。本包不称扫描一个大 parent JSON 是常数时间。
- [better-sqlite3 官方 API](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md)，阅读日期 2026-09-15；项目实际安装版本 `13.0.1`。事务是同步边界，statement iterator 不跨 await 持有。远端 master 会变化，复现以 exact lockfile 与本机版本为准。

实际环境 Node `v24.18.0`、SQLite `3.53.3`、better-sqlite3 `13.0.1`。`eqp-results.json` 由实际候选仓储所准备的 SQL 取得 EXPLAIN，不是手写近似查询。源 schema hash `caa431a42c1f785192e51be6dab01ab2f971f4ee0ef37b5176ca221e27fc1e49`。

| 查询                 | 实际计划关键点                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| source→Episode/Claim | `cognition_evidence_original_lookup` 的 source_kind/source_id/source_fragment/persona_id → 相应 source covering index → Situation 主键 |
| parent→Intent        | `cognition_intents_situation_lookup` covering，situation_id/persona_id 定位                                                            |
| claim 原文 consumer  | `cognition_claim_source_lookup` 通过 evidence_id/current_basis 定位，再检查 Situation Persona；不扫描全部 Situation JSON 的 claims     |

这是 fresh schema 和一个实际 ingest source 上的查询计划证据，不是大库吞吐、延迟分位数或内存峰值实验。其他既存 GC 分支仍有其自己的 active state/JSON 查询，本包没有宣称整个 GC 已无扫描。指定 child 的读取仍需解析已定位的单个 parent JSON；巨型 parent 的 CPU 成本需要后续独立测量，不能由字节边界推出耗时有界。

## 验证与失败记录

本候选新增 15 条确定性领域回归，覆盖：真正选用续驻留与曝光退出、已闭合更正提交、无焦点 prepare、不匹配/Persona/多别名/多 parent 截断、分配范围与 revision fence、大 parent 的具体 claim/episode、partial unseen 保留、投影删除/回滚/级联、history-only 回收资格及历史发现、同 source 的双重用途、实际 Service recall completion 的源依赖保留。

有/无 60 条等待中新 observation 两个实际 Service 用例都验证：旧 claim 的原文和新 correction 同时进入 completion dependencies，更新原 claim 并实际 selectedBasis 成功；无关新 journal 不进入完成分析，runtime 未派发动作。Memory pack 和模型分析是明确的 unit fixture；SQLite/仓储/Service 生命周期实际运行。它证明机制，不证明 Astra 语义质量。

最后验证：Cognition 8 套 `182/182`；受影响四套 integration `39/39`；contract `134/134`。typecheck、八个改动文件的 ESLint 与格式检查通过。已做 base→candidate diff/空白检查。没有运行全仓 offline、Electron E2E、构建、native、真实 Provider 或新的性能大跑；Main 全量验证由 Root 在统一集成后负责。

开发期间保留了正常失败定位：handoff ack fixture 最初没有同步事务；引入 child 字段后的旧精确期望未更新；selected current claim 的 fixture 最初没有声明全部支持来源；新增 SQL ordinal 字段的一处 TypeScript 类型漏写。均修复后重跑，未靠放松产品约束使其通过。这些是离线开发错误，不并入真实模型失败分母。

## 真实对照协议与未解决边界

预注册保存在仓外证据 `cognition-resumption-candidate/PROTOCOL.md`，原 p05 24 条来源行冻结于 `p05-input.jsonl`，哈希 `972a5b2341f6ffe8c301f943b2626755474657237544bcb8f24747d3e1c33848`。无 holdout 读取。两个 Arm 需在同一共同配置、相同实际前态、相同原文顺序下分别使用旧读取与本候选读取；不得给某臂人工注入 gold parent/claim 原文。真实模型调用已获用户授权，后续按共同 v5 输出合同完成的近期对照见下节；原预注册与数据不回写。

建议先保持 p05 原输入做近期续接，随后在独立已保存 checkpoint 上做冷跨 Chat 自然更正：当前 Cog 与近期用户原话不直接含答案，必须由实际 Memory 检索及 canonical 来源映射发现旧实体。对照分开记录实际模型理解、宿主提交、Situation/Intent 持久限定、Memory handoff/形成、prepare 和 Agent 最终采用。普通问候不提旧事不算失败；动作没有执行不能据拟议 choice 声称执行成功。源材料缺口、provider 失败都保留，不自动重试挑结果。

剩余边界：

- 没有实际来源映射、Memory 有限 sourceRefs 漏了来源，或旧 state 从未建 Episode/Claim 关联时，本包不能发现它；普通 Memory facts 仍可用。
- 独立无 Situation 的 Intent 没有新增冷 source 反向索引；只有实际已知近期 ID 可恢复。没有为假想路径新增表。
- 已知 parent 的单个 child 或全部支持本身超过工作集时，仍可能是 partial/excerpt。coverage 和 allocation 必须诚实限制使用，不能凭存在 ID 推断完整原文或授权 unseen 修改。
- 近期规则只从最近 Attempt 的实际选择续接；中间未使用后不继续保留。更远的重提依赖真实 Memory 路径，不能当作无限驻留承诺。
- 实际 Main canonical alias owner 映射、原文释放后的跨域恢复、真实模型能否选择旧 child 并正确更新范围，还需 Root 的跨域与付费验证。

最终生产只保留通过审查和实际验收的一条路径。交付没有 Arm 开关、替代 parser、回退 provider 或调参 UI；候选 runner/EQP/input 原始材料均在仓外。新 unit 文件属于长期回归，使用普通真实来源 fixture，不含 Arm 标签或运行时实验模式。

## Root 跨域集成与创建顺序修订

Root 验证了领域 8 文件的 before/after hash 与 patch SHA `44bf252e9214af4142d5e514082c2bdf595e47e166072b05556bd68f571f71e1`，再应用到隔离 integration。Main 的 `canonicalCognitionSources` 同时服务回收与找回，按真实 Chat/Run 元数据恢复 message 与 run/item 别名；不读取整段 Run 正文，不从 Memory.owner 推测原始来源。未映射来源、有限 sourceRefs 的省略均进入覆盖缺口；同一 canonical 的任意真实别名命中即可。

新增三条真实 SQLite/Main owner 跨域用例，经实际 Memory 创建、来源注册与 resolveEvidence，分别命中只有 Claim/只有 Episode 的 closed 事项、保持当前 revision 和 closed 状态，以及缺 owner、同源别名、跨 Persona 与省略计数。9/9 所在集成套件通过（22:51，0.757s）；随后完整候选 `verify:offline` 为 134 contract、1,075 unit/component、321 integration，共 **1,530**（22:52，1.13s / 7.06s / 10.28s），typecheck/lint/format 通过，两个既有 TanStack 警告。这仍是离线机制验证，不是 p05 或冷跨 Chat 的模型质量结果。

独立复核另外发现：同一毫秒两次真实 createAttempt 的 UUID 排序可选中旧 Attempt，使未再使用的 closed 事项仍驻留。该问题也影响失败重试判定。Root 采用同表 `creation_sequence INTEGER PRIMARY KEY` 记录实际创建顺序，UUID 保持唯一领域 ID；更新已有 Attempt 不修改创建序号，最近读取和 hasFailedWork 共用该顺序。它只排序当前保存行，不是永久流水号，无需 AUTOINCREMENT。Persona+creation_sequence 索引支持最新项查询；不增加第二个状态服务、用户设置或实验库迁移。

依据为 [SQLite Rowid Tables](https://www.sqlite.org/rowidtable.html)（页面更新 2025-05-31）、[CREATE TABLE](https://www.sqlite.org/lang_createtable.html)（2025-04-30）、[VACUUM](https://www.sqlite.org/lang_vacuum.html)（2025-07-12），均于 2026-09-15 阅读。无显式 INTEGER PRIMARY KEY 的隐藏 rowid 可能被 VACUUM 改写，因此没有直接依赖隐藏 rowid。固定逆序 UUID、同毫秒/时钟回退、更新旧 Attempt、失败状态和 VACUUM 后一致性的两条新回归通过；全领域 17/17（22:57，0.548s）。随后完整候选 134 contract / 1,077 unit/component / 321 integration，共 **1,532** 通过（22:57，1.21s / 6.81s / 10.20s），typecheck/lint/format 及 22:58 build 通过，既有警告保留。日志标识 `chara-attempt-offline-130`、`chara-attempt-build-131`，未运行 Electron 或真实 Provider 验收。


## p05 原始连续故事的真实对照与产品取舍

2026-09-15 23:24–23:32（Asia/Shanghai）完成同一故事24条原始来源、4检查点×2臂，共8次 gpt-6-astra；A先四点、B后四点，每臂独立空库并保留自然前态，无重试或人工预建closed父项。两臂共同使用 `charamate_cognition_analysis_v5` 与 creation_sequence，读页32KiB、prepare分配8192不变；该合同不同于先前感知比较的v3，不能跨实验相减。正式83文件冻结 `2cc9f319cf98994520697ec08a1207f00f5bb0115c96d84bde08a55189d60df2`，结束后无漂移。完整仓外 `cognition-resumption-live/REPORT.md` 哈希 `1b3bde9d81832e37ed8785c7597b101f2b943b352b3528aef78b738c21113187`。

| 实际层次 | A原读取 | B近期实际引用恢复 |
| --- | --- | --- |
| 请求完成 / 检查点 | 4/4 | 4/4 |
| 宿主分析提交 | 3/4 | 4/4 |
| c3原预算自然closed、目标fulfilled、退出注意力 | 是 | 是 |
| c4能读原预算当前revision并更新本地限定 | 否 | 是，rev3→rev4且继续closed |
| c4普通prepare带入“不撤销”与“仅本地、不分享”两项 | 否，空 | 部分；缺后者 |

A c4模型从原文理解了新限定，并试图关联旧事项；宿主因旧parent未被分配而拒绝，事务未提交。B实际读入原预算rev3和fulfilled目标，写回local-only Claim，并把新的八月只读事项与原九月预算关联，没有重新激活已完成目标。两臂均正确区分1190旧文件与1260新保存、界面无响应与未知结果、小游戏页面与用户偏好；这支持近期已知引用恢复的产品选择。样本只有一个故事，不能估总体成功率。B2选择fixture回应、A2静默，后续状态不完全相同；没有真实Agent、native编码或Memory第二阶段，不能据此宣称已执行回应或冷检索通过。

8/8有usage：A输入51,766/输出10,852，B输入54,435/输出11,202，合计106,201/22,054，缓存输入0；累计模型流455.68秒。最大Provider实际输入17,211、完整wire保守估算74,739，均远低于258,000，但代理精确count仍不可用；失败请求费用保留，价格未知不换算金额。

## 普通对话关联投影的后续缺口

独立只读诊断确认：B c4已经持久化local-only限定，最近实际选择也用到了e20，但普通prepare只保留当前八月事项和e23/e24。原Snapshot已有closed九月预算，因此缺口在现有projection，不能归因于embedding漏召回。原普通prepare仅2,298/8,192 bytes，单纯增加额度没有针对根因。

Root另行预注册 `cognition-related-context/PROTOCOL.md`：在原分配内先保留当前事项/目标及其原始依据，再追加它们实际直接关联且已在snapshot中的旧事项；保持旧状态与revision，不沿历史递归，也不携带旧动作指令。旧事项来源优先使用最近实际选择所用的支持，无法装入或来源缺失明确进入coverage。直接把所有旧事项正文提前加入会挤掉当前原话，已作为普通回归防止。

修订的5个定向用例、198个Cognition领域用例、95个依赖集成用例、typecheck/ESLint/格式检查通过（23:42–23:46）；没有据此宣布实际Agent质量通过。独立使用同一个B:c4数据库的只读比较：A2,298 bytes，B7,905 bytes；B含e20/e23/e24，原预算仍closed/rev4，当前事项不变，旧支持存在预算省略并明确标记。该补充修改晚于12故事冻结源码，其真实Agent A/B将单列，不回写原12故事输出。


### 普通Agent真实配对与选择

23:49完成同一B:c4数据库的两份新Chat副本，各使用原e24和实际AgentRuntime/prepareTurn/ContextCompiler/官方SDK。两臂69个实际编译输入只有projection不同，真实首次完整wire也只在Cognition输入项不同；2/2模型与Run完成，无失败、重试、客户端工具、搜索、PFC、形成或native。来源DB哈希未改变。仓外 `ordinary-agent/REPORT.md` SHA `59d34e0f891534a961dba989e7f103550b36c163bcb4bdb395478a0ab37363c7`，`LIVE-SUMMARY.json` SHA `753b52958a41a9d31a29a6db6260d5f19da8c0d4aad928de148bb934bc984940`。

A确认只是查看八月、九月1260不撤销；B同样确认，并自然说明八月版保留、也不上传或分享。两者当前回答都正确，A未谈分享不判错；B明确采用了已存在的e20限定，也未虚构文件操作。实际输入A8,413、B10,356，增加1,943（23.1%）；输出51/40，缓存0，两请求输入合计18,769/输出91。耗时3.244/2.784秒是单对且共享Provider，不称B更快。最大完整wire估算26,242，实际metadata与预先审读请求一致。

选择保留直接关联投影：收益是已知必要限定从持续状态进入普通对话，且当前来源未被挤掉；代价是本例额外1,943输入tokens及有限旧背景。实现不增加查询、递归图遍历、模型调用、额度或持久状态。只针对已有真实直接关系；普通问候无焦点或活动目标时不拉全部closed历史。一个配对只支持此读取机制与明显回归检查，不证明总体自然度/冷检索/商业可靠性。最终Main全量与桌面验收仍由Root统一完成。

### 当前情境反证原文的集成修正（2026-09-16）

Root审查同一投影时发现：current claim已经带出`contradictingEvidenceIds`，但正文收集只遍历支持ID，导致已在Snapshot中的反证没有进入普通Agent。直接相关旧情境的分支已读两者，当前分支不应丢掉反证。修订让两类依据进入同一个已有预算入口，不扩大历史查询、不改claim或检索排序。

先以当前受争议约定和新的用户原话复现旧路径漏源（5通过/1失败），再修正；297项Cognition及依赖集成、TypeScript、受影响ESLint/Prettier通过。初始fixture使用了错误状态枚举，最终按实际`disputed`合同校正，实际先验漏源失败仍保留。这是已知依据完整性的正确性修正，不是一次模型质量获胜，也不改变s06攻略标题的相关性判断。仓外`cognition-ordinary-contradictions/AFTER.json`保存前后hash；最终holdout冻结会包含这项，原在途553文件运行不回写。


### 最终 Main 与候选清理（2026-09-16）

本记录所选实现当时已进入 Main，该次统一源码通过1,615项完整离线验证、生产构建、26项Electron E2E、macOS arm64打包及实际4B/512编码器与SQLite向量Worker冒烟；这些验证不改变上文实验的样本与局限，也不是当前共同 v21 的打包重测。v21 晋级时的 Main 完整离线已通过，后续源码变更与待验项以 STATUS 为准，最终同版连续语义、桌面与安装验收仍待完成，见 [STATUS](../progress/STATUS.md)。

本包与相关来源/恢复包按 Root 核准的十组精确清单删除候选代码、runner和本包依赖链接，共2,692个文件及3个detached工作树；共享依赖不动。3,495个保留证据文件的hash前后一致，包括全部119份实际/重建/性能数据库。清理回执SHA `6da7eccccecb8af38f2ab5274df2f523632c7eb9e81e737895e9ef752beb4153`，保留清单SHA `6a6d024ace54379582e0391e51a3f7546eef738d3482c2bc63bed10d854e6f18`。相关 Root 自有普通Agent验证目录不在该清单内，须按各自交付记录处理；不把本清单夸大成全部仓外验证脚本均已删除。


Root自有旧恢复、关联投影、反证与引用集成前副本已另行完成清理：36个精确根、1,682个文件在逐成员核验归档后删除；702个实际输入/输出/SQLite/报告/manifest保留项hash不变。归档SHA `39e36dcaeab6258f6d91ef95e917bb6aa3db0413e529dba110f82f28a7ab5910`，执行回执SHA `2bb2a451e5270ffaefab162259a805595411741ac3eb27cb2e4435ae3f652dc4`。Main、最终冻结源、当前纵向验收helper与共享依赖均不在删除范围。
