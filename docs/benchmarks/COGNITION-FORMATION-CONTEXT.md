# Cognition 形成来源上下文与索引查询

日期：2026-09-15。状态：认知索引、Main 来源桥与 Memory v6 已集成。Owner：cognition_research（认知领域）、root（共享 Schema 和 Main 集成）。本改动不调整模型或认知状态机；事实主体由 Memory 结合实际来源形成。

## 决定和直接体验

采用由 Cognition 维护的 Episode—Evidence 反向索引；Memory 形成材料除当前主来源外，可读取直接共享主来源的情节原文作为消歧上下文。主材料和消歧材料在 Main/Memory 的 `sources + evidenceSourceIds` 合同中区分。上下文只用于理解当前材料，不自动成为新用户事实。

已发生的开发失败 s24 说明了问题：用户先问角色“昨天你本来想做的那东西弄成了吗？”，随后说“今天可以继续自己的生活，不用一直围着拒信转。”Cognition 对角色事务的理解正确，但旧形成桥只传递 quiet-accompaniment 已闭合情节的 e05/e07/e08/e11，缺少 e10。两个真实形成调用把后一句误写为用户已准备恢复日常生活。这是缺少可消歧原文及形成过度断言的问题，不能写成模型已看过完整 e10 后仍忽视。新接口能沿共享 e11 找到 resumption 情节中的 e10；e12 比主材料晚，不会带入。

`owner` 是记忆归属与检索范围，不能等同说话者或事实主体。当前 Cognition Claim 只有文字、依据、状态和证据引用，没有结构化 subject 字段可以直接转交；不得从 Cog 摘要解析一个“事实主体”冒充来源。角色自身事务需要原始说话者、当前 Persona 参与者绑定和真实上下文来消歧。跨域主体形成修复由 Main/Memory 所有者完成，本文不能宣称已验证该真实失败消失。

## 唯一查询合同

`CognitionRepository.formationContext(personaId, anchorEvidenceIds): Iterable<CognitionEvidence>`：

- 只在同一 Persona 内找到任意主来源直接所属的持久 Episode，再取这些 Episode 的原始证据；不递归扩展、不按主题猜测。
- 仅返回 receiptSequence 不大于主来源最大 receiptSequence 的记录，主来源本身排除，结果去重、按实际接收序号排序。
- 一跳范围由已有 Episode 关系决定，可能跨 Situation；不是固定前一句，也不是任意最近若干句。没有任意 topK 或语义删除阈值。
- 每次只取一条原文，yield 时不保留活动 SQLite cursor，消费者可同时排入 Memory 工作。查询每步只重访索引命中的一跳来源范围，不扫描所有历史 Situation JSON。一个真实 Episode 本身拥有大量来源时仍会有局部查询成本；这次“无关历史不影响成本”的测量不证明无限长单情节恒定耗时。
- 此接口的 `CognitionEvidence.text` 仍是领域证据投影。Activity 的 canonical 来源是实际 ActivityEvent 数据，不能用 AX/OCR 摘要代替；Main 继续通过真实来源解析器读取 canonical RunItem/Activity 原文。

## 存储和生命周期

使用 root 所有的 `cognition_episode_evidence(situation_id, episode_id, evidence_id)`，主键为三元组，STRICT WITHOUT ROWID；覆盖索引 `cognition_episode_source_lookup(evidence_id, situation_id, episode_id)`。它是既有 Situation 关系的可查询投影，不是第二份 Episode 真相或新的工作队列。

完整保存 Situation 时替换该 Situation 的索引；有界局部更新只更新实际可见、已提交的 Episode ID 对应引用，未见 Episode 的来源不变。旧引用删除、新引用插入与 canonical JSON 和 Decision 提交处于同一 SQLite 事务；后续提交失败一并回滚。Situation/Evidence 删除通过外键级联清理关系。

没有新增旧库兼容分支、启动全历史重建或 backfill：此 v26 认知设计尚未发布，当时的开发 v24/v25 没有 Cognition 数据，新建表为空。隔离候选证据库不使用新实现原地续跑。性能 fixture 显式构造合成索引，不是生产迁移。

## 主源和版本

访问日均为 2026-09-15；实测 better-sqlite3 13.0.1、SQLite 3.53.3、Node v24.18.0，M4 Pro/24 GiB/macOS 26.6.2。实际 Node 版本以 indexed-results.json 字段为准。

- [SQLite Query Planning](https://sqlite.org/queryplanner.html)：多列索引、覆盖索引与查询计划是依据；是否命中以保存的实际 EXPLAIN QUERY PLAN 为准，不能仅因建了索引就声称避免扫描。
- [SQLite WITHOUT ROWID](https://sqlite.org/withoutrowid.html)：联合主键表可避免额外 rowid B-tree；这不是所有表通用的性能结论，本表只承载短引用关系。
- [SQLite WITH clause](https://sqlite.org/lang_with.html)：MATERIALIZED 是优化提示/屏障，不是协议硬约束。使用它避免重复相关子查询的成本，仍需测量实际计划。

本实验使用当前生产查询原文，主源 HTML、实际 SQL/EXPLAIN 和运行时版本保存仓外；不存在脑科学常量或 SOTA 断言。

## 公平测量及结果

隔离内存 SQLite，无模型调用，人工合成每个无关历史 Situation 约 4.3 KiB，分别 1k/10k/100k；目标情节固定含 e0/e1/anchor。两臂返回同样 e0/e1，indexed 完整消耗 iterator 的两条来源及终止查询。每规模五次交替顺序，未当作五名用户或独立总体样本。

比较对象是已经使用 MATERIALIZED anchors 优化的 JSON 关系查询，**不是**早期错误相关执行计划的 4.3 秒/10k 版本。前次优化版 10k 为 14.4–15.5ms；本次同 fixture 并排重复为 15.79–15.98ms。绝不借朴素版本夸大收益。

| 无关历史情节 | 优化 JSON 查询范围 | 索引 iterator 范围 | 新投影及索引页体积 |
| ------------ | ------------------ | ------------------ | ------------------ |
| 1,000        | 1.49–1.74 ms       | 0.029–0.091 ms     | 57,344 bytes       |
| 10,000       | 15.79–15.98 ms     | 0.029–0.103 ms     | 507,904 bytes      |
| 100,000      | 161.66–165.68 ms   | 0.028–0.111 ms     | 5,668,864 bytes    |

100k 合成 Situation JSON 总量为 429,466,743 bytes。首次构造该合成投影约 258ms；这仅解释 fixture 开销，生产对更新的 Episode 增量维护。选择索引的依据是避免 Main 对无关历史线性读取与 JSON 解析，以及关系维护的确定性正确性；该时间不是 PFC 模型判断、Memory 形成或用户可感知端到端延迟。

## 验证和局限

Cognition/Life/重要时刻受影响 focused 共 87/87 通过；认知主测试文件 59/59。新增覆盖实际原文、一跳截止、跨 Persona、未来排除、顺序去重、重启集合一致、迭代消费时写入、局部更新保留未见历史、事务失败回滚、全量替换和外键清理。ESLint/Prettier/git diff --check 通过，独立 cognition domain typecheck 通过。整树 typecheck 因隔离树尚未同步的 Main/Memory/Preload 接线报错（无 Cognition 诊断），不能称整树绿色。

这些是工程正确性与数据访问测量，不是商业陪伴质量验收。仍需真实形成重放确认 s24 主体及主材/上下文混淆已解决；被扩展上下文可能增加形成输入，需另测 source-set 去重、预算和积压。持续 PFC 仍可能用 40–90 秒生成一页完整状态，索引不能解决模型输出延迟；另有本轮低 reasoning 630 秒未闭合 JSON 失败，不能被本地亚毫秒查询成绩掩盖。

生产只保留索引查询；朴素和优化 JSON 对照只存在仓外临时 runner，结束后删除。原始结果/主源按 SHA256SUMS 保存，删除记录见 cleanup.json；不建立永久实验目录、运行模式或开关。

## Main 集成验证

Main 已把当前支持/反驳来源作为 primary，把历史断言及同 Episode 一跳原文作为 context；两者经真实 Chat/RunItem/Activity 解析器读取，不把认知摘要当来源。新增前文改变工作版本，不能冒充当前主材料。Memory v6 按实际单元归属区分全局用户记忆与当前角色记忆，来源说话者不再决定整份 Episode 的归属。

2026-09-15 18:48，当前整合版本完整离线 1,241 项通过（134 contract / 828 unit+component / 279 integration），随后 Electron E2E 26/26 通过（1.4m，含构建）。这些结果解决独立树跨域类型未同步的验收边界。s24/s02 的真实纠错和实际 Agent 使用仍在冻结 v6 快照上运行；不能据离线通过宣称语义错误已经消失。
