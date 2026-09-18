# COGNITION-CURRENT-USER-SOURCE：当前原话优先供给

## 当前结论

交付单一路径候选：在原有同一读取预算中，最旧 FIFO 身份之后优先读取当前 Persona 最新尚未消费的真实用户原话；原 FIFO、CAS、行动新鲜性、Memory 形成和前台 Run 都不改变。本次是由真实来源供给延迟触发的正确性与响应性修订，不是 32/128 KiB 容量选型，也没有新增真实模型结果。

Root 于 2026-09-16 批准将与该 query 完全一致的 partial index 加入未发布 v26；本子包不修改 DDL。生产不增加开关、配置、额外模型或后台任务。

## 来源与版本

- 候选基于 Root integration 工作树复制快照，633文件，BASE-FREEZE SHA256 `d28762d6b6faa760896513acd6b6962bcd2623d6e7d54254404634efa2e4f466`。实际代码原文/时点见该manifest，不把仓库旧HEAD冒充当前未提交源。
- Node 24.18.0，better-sqlite3 13.0.1，实际 SQLite 3.53.3，source ID `2026-06-26 20:14:12 d4c0e51e4aeb96955b99185ab9cde75c339e2c29c3f3f12428d364a10d782c62`。
- SQLite 官方 [Partial Indexes](https://www.sqlite.org/partialindex.html) 与 [EXPLAIN QUERY PLAN](https://www.sqlite.org/eqp.html)，本次于 2026-09-16 阅读；索引适用条件与查询相同，不把EQP展示文本作为应用协议。
- 原冻结六对实验 s01/s02 真实输入与独立复核说明：大页能够较早覆盖该条，小页当时 PFC 没有原文；前台 Agent 已有原句并回答正确。详细识别符在相邻 `cognition-source-budget/quality-live-preparation/USER-CORRECTION-SUPPLY-DIAGNOSIS.md`。此次不回写其分母或输出。

## 行为与预算

按持久 receipt_sequence 选择最新符合 `persona_id=current AND actor=user AND kind=utterance AND source_kind!=memory` 且尚未消费的来源。先为旧 FIFO 和该来源保留真实身份，随后在剩余预算中提供当前原话的全文或精确节选，然后沿已有最小当前实体、来源关系和旧 FIFO 分配。只保证最新一条优先；之前的多次改口仍由 FIFO 消费，不能声称完整多轮理解。

`coverage.currentUserSource` 给出 evidenceId 与 complete/excerpted/omitted。completion 若没有该正文须如实为 omitted；节选保持原 UTF-8/Unicode 内容与现有 INCOMPLETE EXCERPT 标记。若连最小身份与覆盖信息都不够则明确失败。所有本文数值是读视图字节，不是 Provider Token 上限；258000 Token 的最终请求守门保持原样。

提前供给不推进 `analyzedThroughSequence`，不把来源曝光当新的用户确认，不绕过 throughSequence 后存在 user/control 的 actionFreshness 检查。长原话优先可能进一步减少其它材料的本页份额；coverage保留此不足，而不是宣称所有背景已读。旧页仍按既有精确节选机制逐页前进。

## 验证与分母

同版全TypeScript检查和4文件ESLint通过；Cognition与真实Agent/Voice/Cognition Main桥接的15 suites、325 deterministic tests全部通过，含12条新增回归。新增测试涵盖连续多次纠正、Persona与speaker区别、同 observedAt按receipt排序、消费后不因曝光重读、首条去重、长Unicode/最小身份预算、真实recall completion、yield取消后下一分析、awaiting_recall重启、实际 actionFreshness。

首轮10项中4项失败属于新fixture错误（未将ready提交结算便创建第二Attempt、错误引用不存在的getEvidence方法、将evidencePack错写recalledMemory）；已经按实际公开契约修正。保留原调试日志口径，不把这类离线fixture失败混入真实模型质量分母。最终新增12/12通过。上述领域交接时尚未运行真实模型；其后2次结果见下节。Electron E2E、packaged smoke和encoder不属于该单对。

## 100k查询证据

源与运行前协议、完整查询计划、DB与runner均在本目录。A现有索引，B只有新增当前用户partial index。100000行性能合成数据中第1条为用户原话，其后99999条为observations；正文短且合法形状，不代表真实语义分布。

| 查询 | A耗时，三次ms | B耗时，三次ms | 结果 |
| --- | --- | --- | --- |
| 最旧一条用户匹配，cursor0 | 21.951 / 21.894 / 22.732 | 0.028 / 0.010 / 0.023 | 相同ID |
| 无未消费用户匹配，cursor1 | 22.643 / 23.091 / 23.639 | 0.015 / 0.014 / 0.020 | 均无结果 |

同步event-loop阻塞由A21.96–23.67ms降至B0.032–0.051ms；这里只是该同步调用对下一次setImmediate的影响，不是整体应用P95。实际EQP从 `cognition_evidence_persona_cursor_idx` 改为 `cognition_evidence_current_user_idx`；二者都有SEARCH文本，但前者仍需逆序检查大量非user行，不能只看SEARCH就声称已避免扫描。

该初始数据只有1条用户索引项，增加4096 bytes不能代表用户多年的索引总量。追加三轮1000条mixed（每10条一条user）事务，A11.45/14.84/12.66ms，B10.97/13.16/21.92ms；样本与共享CPU不足以宣称写入无成本。索引建立14.28ms，最初100k构造904.06ms，均单次描述。

本机同时有Root真实流程与本包focused测试，SQL窗口 `2026-09-15T16:21:29.304Z–16:21:29.572Z`；不是独占资源试验。主要可确认结果相等及查询索引定位，不能宣传整体PFC速度、模型质量或容量胜出。

## 真实单对的前态重建边界

存在完整 `s01-A/before-foreground.json`（逻辑08:01:10.029，全部Situation/Intent/Attempt原始持久态）以及全部canonical evidence与真实提交日志，但没有08:01:10.210之前独立SQLite备份。不能将最终DB回退几个字段冒充该瞬间。

后续先按该完整持久态、当时receipt上界与随后真实user/control事件重建独立读视图fixture，逐项记录与原实际请求的差异；未恢复完整状态就仅做读取机制检查，不进行“原请求精确重放”的质量声明。拟固定同一重建库和原始用户原句，A/B唯一变量当前用户供给，未来各一次实际analyze+host commit，无自动重试。这是执行前计划，实际重建与两次生成结果保留如下。

## 集成与清理

Root按4文件before/after SHA和精确patch集成；DDL归Root。未新增运行时模式，未触碰原六对runner或输入。候选树与仓外SQL原始证据目前按Root要求保留。集成完成后删除可执行候选及临时DB，只保留必要哈希、聚合和中文记录，胜出回归继续由Cognition领域拥有。

## Root集成复核（2026-09-16）

Root完整审阅4文件patch并逐项核对before/after SHA后纳入隔离integration；随后单独加入窄partial index与既有v24迁移重建断言。未新增版本或运行模式，当前未发布v26的表定义仍为单一路径。Main源码未晋级，在途原12故事及六对容量试验保持其旧冻结。

00:27完整`npm run verify:offline`通过1,583项：134 contract（0.984s）、1,121 unit/component（5.90s）、328 integration（9.63s）；typecheck、lint、format通过。该总数同时包含此前普通断言相反来源修复，不能全归因本包。Root源码/DDL与验证manifest SHA256为`2d1d278a49931b841032d2b86ce20c66baa2786a20b257652a8714bd9db4929e`；4文件集成manifest SHA256为`a754ccd2aa49879131801ce60de2872e117848a37f8d077e6fdcbb9e6fb5dd18`。

最终Main、Electron、打包与候选清理仍由Root验收；真实单对仅证明下述一个触发条件。


## 原积压前态的一次真实配对

先使用完整持久前态及当时已实际发生的user/control事件构造同一SQLite副本；原读取与保存的08:01:10.203实际请求snapshot及coverage逐字段一致。重建库SHA256 `246fbb29e654bd22605ea4480eb929babe17d2d931888ae6d1d2652eca2c0537`，73条来源、durable watermark18。它是经相等性核对的重建，不声称原时刻有该独立备份。

固定32KiB、原Persona/availability/时间，A原读取先一次，B仅改变当前原话优先再一次；真实gpt-6-astra的严格解码和host commit均2/2完成，0重试、0额外召回、0世界动作。SDK实际wire与各自预先冻结请求的JSON值完全相同，文件排版字节并不相同。A/B实际输入18,000/18,120、输出915/1,471、缓存0；请求到提交20.48/29.97秒。共享Provider窗口00:35:45–00:36:36，不作为独占性能比较，也不能称B更快。

A没有收到receipt73用户原话，正确保留页面中的候选地点和未定状态。B获得该原话后保存reported纠正“南楼只在比选草稿，不能视为已订场地”，唯一支持是用户实际来源，并将其列为当前断言。两臂均remain_quiet。A不能因缺少未供应材料而被判作模型忽略。

已消费through为A35、B34；B为当前原话让出一个旧viewport位置，未越过FIFO。两臂actionFreshness仍为control_changed，canonical正文提交前后完全一致。该结果支持当前用户供给修复在这个积压触发下的行为，不替代六对容量选择、实际Agent回答或总体连续理解验收。

执行冻结SHA256 `e07df9bf87832b1b3a9b70ce04d3052e7d1b125864305625fd42e131a2a13be8`；原始结果manifest `9c49faf7f50f576516312e894c7c043c92cb8144455ac0f4e4d03df39877e585`。两次input_tokens端点仍404，实际请求均远低于258,000；完整wire保守估算不是精确tokenizer计数。初始runner字段和override元数据的两处修正发生在零generation阶段，保留原日志。独立来源复核完成（非盲评）：报告SHA256 `8408aeb977479eac5b60bd99b8f0ae25204c250318a5dce60e4902147f0f5a92`、附件manifest `bc49f0574e95caa2f5378b1f9739d2f2ed4530327f4f630239174ec4d04d03ad`。复核另确认B剩余预算容纳了1个旧episode和1个旧claim，输入并非仅添加一句话；当前纠正自身唯一依据仍是receipt73。两臂执行校验被原through之后的72/73控制来源阻止，不能据此声称积压中的行动时效已经解决。


### 最终 Main 与候选清理（2026-09-16）

本记录所选实现已进入 Main。最终统一源码通过 1,615 项完整离线验证、生产构建、26 项 Electron E2E、macOS arm64 打包及实际 4B/512 编码器与 SQLite 向量 Worker 冒烟；这些验证不改变上文真实实验的样本与局限。跨话题及独立故事语义验收另见连续评估记录。

本包与相关来源/恢复包按 Root 核准的十组精确清单删除候选代码、runner和本包依赖链接，共2,692个文件及3个detached工作树；共享依赖不动。3,495个保留证据文件的hash前后一致，包括全部119份实际/重建/性能数据库。清理回执SHA `6da7eccccecb8af38f2ab5274df2f523632c7eb9e81e737895e9ef752beb4153`，保留清单SHA `6a6d024ace54379582e0391e51a3f7546eef738d3482c2bc63bed10d854e6f18`。相关 Root 自有普通Agent验证目录不在该清单内，须按各自交付记录处理；不把本清单夸大成全部仓外验证脚本均已删除。
