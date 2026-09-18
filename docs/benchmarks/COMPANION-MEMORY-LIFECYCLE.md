# COMPANION-MEMORY-LIFECYCLE：曝光中性排序与保留旧事可达性

> 2026-09-15 后续状态：曝光不等于用户支持、不可仅按年龄抹去重要旧事的结论仍适用。本文实验针对第一轮 R0/top8 原型，不能授权新的语义检索、形成与动态证据预算；新的商业级 Memory 路径仍在独立连续场景验收中，见 LOCAL-MEMORY-ENCODER 和 STATUS。

状态：选型完成；获选规则已合入主工作区，通过 Memory 域及完整离线回归，应用构建和桌面验收结果见 [STATUS](../progress/STATUS.md)。日期：2026-09-15。实验基线：fc81239。本记录当时仅修订既有 MEMORY-RETRIEVAL 中曝光参与同分排序的条款，当次比较保持 R0、FTS、Revision 和 top8；当前 Main v21 的问题化混合检索与证据预算由后续 Decision 负责，不再沿用 R0/top8 作为唯一检索默认。

## 定案

保留现有 R0 FTS5、当前/历史 Revision 过滤、稳定画像与 top8 Context；仅移除排序中的 last_accessed_at。Context/Tool 曝光继续可记录，但它不是用户重提证据，不影响排名。BM25、pinned、importance、confidence 之后，按 updated_at 与稳定 ID 决胜。

本轮不采用自动年龄淡化，不新建交互 clock/频次/支持分表，不自动归档或硬删长期事实。没有充分证据支持为排序引入新的持续状态。真实用户改口继续通过现有 Revision 更新发生作用；“真正用户重提”语义识别仍未实现或验证，不能用检索命中冒充。

这是更小的产品修正，不是声称 R0 的语义召回已充分：本组广义主题查询仍暴露出短而无关条目挤占长情景证据的问题。应优先改善形成内容和按语境使用，而不是用年龄掩盖形成噪音。

## 问题、来源和环境

比较：①把系统曝光当访问优先，还是将真实用户证据与曝光分开；②自动淡化旧的单来源普通情节是否值得；③相同淡化函数采用交互日还是日历日；④当没有更广泛收益时，能否用更少状态阻止纯曝光自强化。

认知来源采用 [Bjork & Bjork 1992](https://bjorklab.psych.ucla.edu/wp-content/uploads/sites/13/2016/07/RBjork_EBjork_1992.pdf) 的存储强度/提取强度区分、[Anderson & Schooler 1991](https://journals.sagepub.com/doi/abs/10.1111/j.1467-9280.1991.tb00174.x) 的需求规律、[MemoryBank AAAI 2024](https://ojs.aaai.org/index.php/AAAI/article/download/29946/31654) 的简化衰减原型。它们提供假设，不提供生产阈值。来源版本、工业源码 SHA 与局限见[同日期记忆研究报告](../research/ai-companion-memory-research-2026-09-15.md)。SQLite 排序机制采用[官方 FTS5 文档](https://sqlite.org/fts5.html)，查阅日 2026-09-15；本机实际执行版本为 SQLite 3.53.3。

环境：Darwin arm64，Node v24.18.0，Vitest 4.1.10，better-sqlite3 13.0.1，实际 SQLite 3.53.3、WAL。每一对照都调用基线 MemoryService、MemoryRepository 与 LexicalRetrievalPipeline，实际建立 SQLite 数据库并执行查询。没有使用用户真实对话，没有模型调用或费用。

Memory/Revision、查询、FTS、top8、标签与状态过滤固定。用户证据条件将冻结输入中的来源投影到既有 last_accessed 查询使用的表形状，这是实验表示法，不是生产已有“重提识别”的证明。淡化是取回后的候选过滤，不补取 top8 之外的结果。中性排序候选通过实验数据库 prepare 适配仅移除 ORDER BY 的访问时间项，保留实际 exposure 日志。

## 冻结输入与阶段

12 个手写独立主题故事，各有连续、稀疏、长期离开、后台事件密集四个时间表：48 轨迹，每轨迹 8 查询，384 查询/条件。各时间表共享故事，不是 48 名独立真实用户；统计单位主要是 12 个故事模板。

每轨迹约 17 条记忆，包含具体经历、稳定偏好、约定、未来事件、改口与普通片段。普通片段是为检查候选取舍而刻意放入的形成噪音，不能宣称它们代表当前 F2 正常形成的比例。冻结内容由服务直接写入，因此本轮评估检索和使用候选的可达性，不评估模型形成质量。

查询含广义主题、冷门具体旧事、显式找回、当前改口、历史版本、归档、删除与未知事实。先按故事需求标注所需证据，再写候选；标签不从排名公式生成。数据 hash 在首次运行之前冻结：

- dataset.json：b27542fd897ff1ee4774c395d1b7938553741d391d4178c08bced7272c1ff19d
- preregistration.md：9854858a03a30a8daec75c15cc24bf3b54e5ba6bddecce3c3c0675feadeb3d38

主阶段的条件是曝光、用户证据、用户证据加交互年龄淡化、用户证据加日历年龄淡化。16 个日单位与新 Revision 两个互动日保护只是本轮粗粒度候选参数，不是生物事实或预先认可的生产默认。当前 stable claim、pinned、active commitment、未来事件和新 Revision 受保护。

主结果显示年龄规则丢失强相关旧事后，另行登记了最小中性排序确认，不覆盖原预注册：followup-preregistration.md hash 41149df35e664d979ce97ecc52a87fcc298c4d5b79ae7cab2962d9e6a4119749。该后继条件保留所有 exposure 数据，仅移除其排序作用；复用未重标的冻结输入。

## 结果

| 条件 | 必需证据命中 / 336 | 完整覆盖所需查询 / 240 | 自动无关条目 | 冷门旧事自动命中 / 48 | 同旧事显式命中 / 48 | 当前/历史 Revision 正确 / 96 |
| --- | --- | --- | --- | --- | --- | --- |
| 原曝光排序 | 240 | 192 | 384 | 48 | 48 | 96 |
| 用户证据投影 | 240 | 192 | 384 | 48 | 48 | 96 |
| 交互年龄淡化 | 228 | 180 | 192 | 36 | 48 | 96 |
| 日历年龄淡化 | 216 | 168 | 0 | 24 | 48 | 96 |
| 后继中性排序 | 240 | 192 | 384 | 48 | 48 | 96 |

自动查询共 96 次。排除稳定画像后的自动注入条目数依次是 432、432、228、24、432，因此减少无关条目时也必须看返回量与必需证据损失。不能把返回很少甚至不返回一切称为更好的记忆。

用户证据投影和后继中性排序对原条件的 384 个查询，结果顺序与集合均 0 差异。本组没有证明频次/clock 状态能提高质量。年龄条件分别改变 36、72 个查询集合。

交互年龄的冷门旧事自动召回差异为 -25 个百分点；按 12 模板重采样的描述性 95% 区间为 [-37.5, -12.5] 个百分点。日历年龄为 -50 个百分点，区间 [-75, -25]。这些区间只描述当前手写模板变化，不代表用户总体置信度；同一模板共享结构带来的零变化也不能当成总体等价证明。

每条件 96 个归档/删除查询均无泄漏，48 个未知事实查询均为空。每条件检查 200 个保护对象时没有被淡化过滤。但这些检查不代表它们一定能进入 R0 top8：广义主题查询的原始召回问题依然存在。保护“已经被取回的结果”与“确保召回”不能混为一谈。

### 具体反例

用户输入“雾谷”，唯一相关的旧情景描述了第一次徒步迷路与后来愿意再试的经历。原 R0 已准确返回它，交互年龄条件在连续/稀疏使用后仅因它只有一个支持日、年龄已大而移除；Context 只剩稳定画像。“青禾面试”“银湾旅行”“星河读书”等出现同类结果。

这表明“单次、很旧”不足以区分重要经历和普通噪音。显式 memory.search 的 48/48 可达不等于每一次实际模型都会发现缺失并补查，本轮没有模型闭环证据；不能把补查的可能性作为自动丢失记忆的补偿。

日历规则还在用户长时间没互动时丢失这些旧事；交互规则在离开/背景密集的场景较好，但在用户持续互动时仍有同样的语义问题。因此不通过调大时间常数隐藏问题，也不保留两个运行模式。

### 曝光同分诊断

另用两条相同 token 长度、相同查询词频的独立事件进行真实 SQL 诊断。两者 BM25 都是 -0.000001：

1. 初始按 updated_at 排列：新事件在前。
2. 只有旧事件被 Context 曝光一次，原排序把旧事件移到前；中性排序保持不变。
3. 随后旧事件拥有新的 Revision，两个排序均按更新时间将其排前。

这是 1 个受控同分诊断，不是独立性能总体。它证明不需要新 clock/评分表，就可以阻止“系统自己看过”改变结果优先级，并保留 Revision 所提供的真实状态更新路径。

### 延迟与容量

主实验原条件查询 p50/p95 为 0.181/0.772 ms，用户证据 0.167/0.468 ms；后继中性排序 0.175/0.742 ms。测试循环有固定条件顺序，缓存和日志数量也不同，后继又是单独运行；这些数字只说明本地规模下绝对开销小，不能宣称可靠的速度提升。

每个模板约 17 个记忆与完整应用 schema；原条件注入 400 条 exposure usage，文件平均约 1,015,040 bytes。中性排序仍有 400 行，平均约 1,014,955 bytes；页面分配差异不构成存储收益。用户证据条件只有 18–20 个投影行，文件为 884,736 bytes，这不是可发布的历史压缩算法，不能把少保存日志获得的差额宣传为获胜方案释放了空间。

多年容量仍须按真实互动率、每回合使用条数、Revision、附件与保留策略测算。本轮没有跑真实一年的写入负载，也未测百万用户并发，不能从这些小库线性推断平台成本。

## 细粒度事件与输入预算

额外的 48 条 clock 轨迹中，49,440 个 application、reading、pointer、keyboard、model-output、activity、tool-result 事件以及重复 user-turn 重放没有错误推进用户互动日。这里是冻结事件上的纯 reducer 回放，不是 macOS 原生采集验收；它检查的只是计数语义。

更细的桌面感知可以增强 Activity 事实和 Episode：软件活动、当前阅读片段、交互动作与任务变化有助于形成情境，但不按每次按键/鼠标移动生成长期 Memory 或一次模型请求。一个 Episode 的多个原始来源也不是多个独立用户确认。它们不能直接加强用户偏好或“羁绊”。

用户硬约束是每次完整模型请求输入不超过 258,000 Token，包含系统、历史、Memory、Tools 与多模态估算。持久容量与输入工作集分开：长期保存不代表全部注入，扩大感知不代表扩大每轮 Context。此实验 0 模型请求，没有借大窗口规避选择问题。

## 最小生产规则与后续

获选生产排序：

- 有查询：bm25 升序 → pinned → importance → confidence → updated_at 降序 → stable ID。
- 无查询：pinned → importance → confidence → updated_at 降序 → stable ID。
- lastAccessedAt 仍投影检索或上下文引用时间，usage 继续保留 Revision 关联，但不解释为用户确认或记忆强度，也不参与排名。
- 不改变 archive/delete/asOf/Revision 语义；不增加年龄抑制或逐事件长期形成路径。

不要把“不采用年龄过滤”解释为每轮积极提起所有旧事。角色应在已有模型中按当前请求使用证据，适度提及与不主动炫耀记忆交给单独回应策略比较。若将来要选择性自动淡化，应先获得能区分有意义单次经历与普通事件的语义标签和真实使用反馈，再比较有界工作集策略。

已重写的生产代码仅在 [LexicalRetrievalPipeline](../../src/main/memory/lexicalRetrievalPipeline.ts) 删除两处 ORDER BY 中的 last_accessed_at，保留原 Repository 的 usage 写入、历史时间投影与 Revision 机制。Repository 没有其他使用曝光排序的路径，因此无需改动。没有增加依赖、表、后台任务、Settings 或运行时分支。

[Memory 页面](../../src/renderer/features/memory/MemoryPage.tsx) 将“被使用记录”改为“检索与上下文引用记录”，分别显示“检索返回”和“提供给回答上下文”，避免把结果取回显示成已经被用户再次确认或被模型正确使用。普通用户无需管理新层级或逐条审批。

[Memory 集成回归](../../tests/integration/memory.test.ts) 覆盖 Tool/Context 两种曝光均不改变同分查询与无查询排序，且日志时间仍能查到；真实内容修订后更新时间仍能影响同分顺序；两年前的单次具体经历在近期无关事件之后仍能通过 Context 和显式查询找回。已有回归继续覆盖历史 Revision、归档删除与稳定画像去重。[页面回归](../../src/renderer/features/memory/MemoryPage.component.test.tsx) 检查两类引用渠道和对应 Revision 内容。

这些小样本已改写为获选行为的长期回归：不含候选身份或 Arm 开关，没有保留实验 runner。共享 schema 不需要为本胜出规则改动。未来价值预测、自然语言重提识别、交互时钟和自动语义淡化仍是研究项，不宣称已经实现。

## 失败、复杂度和删除

首次 runner 把 memoryId 字符串误传给 hitFor(memoryRecord)，在保护对象读取处失败，未生成完整结果；修正调用签名后重跑，输入与算法未变。失败数据库保留，未混入有效统计。

主数据结果 SHA-256：c6d6435b048ff3e352569c7180271a562dfdefe8db2889be0fe44e0caf7d28ec。

后继数据结果 SHA-256：0128375992bd7c4e554c0ad5d89a25fad2277ead37afd99de3a59bca76da911c。

同分诊断 SHA-256：76a78a96589fe2ec062b96169011891d95d2a0c98a8de91193bf5cbcfc814a2d。

统计与环境 SHA-256：9cfd4d353eb39187d64782a2565865b8e525f284d031479e378a81a0d8b6428b。

原始文件位于仓库外 `evidence/memory` 证据包。归档 manifest 的 11 个已有文件 hash 全部复核通过，另归档 Vitest 配置，SHA-256 为 d77c059291b51c8dd36c2422ad05dd1e86f867deaafadffe5906cbceb981611e。重跑应从 fc81239 创建独立工作区，把归档的 runner、输入与配置恢复到相同相对目录，不能用已经改过排序的当前源码重跑旧基线。

候选目录 `memory-experiment` 的 freeze.mjs、run.test.ts、analyze.py、vitest.config.ts 已删除，目录也已删除。被否决的 clock、用户证据投影、年龄参数、prepare 适配器仅在仓库外复现证据中保留，不进入产品运行路径。获选行为在独立工作区源码重新实现；没有提交或推送。

测试执行：主实验 Vitest 1 test 通过，完成 4 × 384 查询；后继中性确认及同分诊断 2 tests 通过，完成 384 查询加受控诊断。测试“通过”表示实验程序和正确性守卫执行成功，不表示所有候选质量过关。形成、自然语言重提、情感回应、真实跨月用户体验均未在此实验验证。

实施验证（2026-09-15，独立工作区）：

- `vitest run --project integration tests/integration/memory.test.ts`：30 tests 通过，636 ms。
- MemoryPage component、memoryTool unit 与 Memory contract：3 files / 20 tests 通过，1.28 s。
- `npm run typecheck`：通过。
- 四个改动源码/测试文件的 ESLint：0 errors，MemoryPage 原有 TanStack Virtual incompatible-library warning 仍存在。
- 改动文件 Prettier 与 `git diff --check`：通过。

本包没有执行完整应用 build、Electron E2E 或真实模型请求；整体离线回归、构建及桌面验收由集成 owner 完成后在当前进度文档记录。页面文字已做组件验证，未把它写成桌面视觉验收。

## 2026-09-15 商业重构的来源与迁移补充

本节是新来源类型的存储正确性记录，不改变上述历史实验成绩。`activity_event` 引用实际桌面事件；形成任务保存经过持久化边界处理的完整原文及归属、时间，后续可以恢复同一来源，不使用摘要冒充原文。

2026-09-15 刷新 [SQLite 官方 ALTER TABLE 的一般表重建步骤](https://www.sqlite.org/lang_altertable.html#making_other_kinds_of_table_schema_changes) 与 [foreign_key_check](https://www.sqlite.org/pragma.html#pragma_foreign_key_check)。固定依赖 `better-sqlite3 13.0.1`，当前实际 SQLite 3.53.3。官方步骤要求在事务外关闭外键 enforcement，事务内建立替代表、复制现存数据、移除原表、重命名并重建相关索引/触发器，检查外键后提交；当时的开发 v25→v26 升级依此扩展现有三张 Memory 表的来源 CHECK。无 `writable_schema` 修改，不为尚未发布的 v26 再造迁移分支。当时的本地 v24 测试数据通过真实版本链升级；新库直接使用同一当前 schema。2026-09-17用户确认没有已发布用户后，旧迁移链及纯迁移单测已移除；当前结构和新库行为保留，以上仅为历史结果。

真实 SQLite 回归覆盖旧 CHECK、来源/Revision 引用、索引保留与新 activity_event 写入。失败事务回滚，finally 恢复外键检查；完整离线 2026-09-15 18:16 的 279 项 integration 通过。它是数据正确性验收，不是对检索或仿生遗忘质量的证明。
