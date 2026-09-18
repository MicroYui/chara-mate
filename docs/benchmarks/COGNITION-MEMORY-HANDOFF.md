# Cognition 到 Memory 的持久交接

2026-09-15。领域实现已通过 focused 验证并由 root 接入 Main/Q2；root 的完整回归与本包零模型回放分别记录。修订后 96 次独立恢复测量已全部完成，无模型请求。

## 选择与产品行为

采用认知事务内的来源待交接表：用户改口后，只要新的认知状态提交成功，待交接的真实来源 ID 就同时持久化。即使此刻程序退出，启动只恢复这些尚未进入 Memory 的材料。Memory 成功持久接收后，同一个应用数据库事务删除对应待交接项，之后由 Memory 已有 work/receipt 管理形成、失败和重试。

这解决的是“认知已提交，但 Memory 尚未入队”的恢复窗口。它不改变角色理解情境的模型，不替代 Memory 形成，不改善 PFC 模型响应速度，也不证明连续桌面语义摄取已经追得上输入。

旧入口每次启动遍历所有 Persona 的 grounded claims 和 closed episodes，展开原文，再构造完整 Episode/版本。候选删除 Service 的 `onEpisodesClosed`/`onClaimsChanged` 和 Repository 的 `getClaims`/`getClosedEpisodes`，统一为提交后的 `onMemoryHandoffPending` 通知。通知不是存储；通知抛错仍保留已提交待办。原有按需 `formationContext` 只读查询不再承担启动恢复。

## 来源、版本与约束

2026-09-15 读取 SQLite 官方 Transaction、Savepoints、WAL 页面，以及本地固定 better-sqlite3 13.0.1 的 `lib/methods/transaction.js`；实际执行环境为 Node 24.18.0 / SQLite 3.53.3 / macOS arm64。依赖源码 SHA-256 为 `40b71d6113f328f96cec8f6f888ffddd98b5926d38fb1e2746939c7daba93e2e`。

- SQLite 同时只允许一个 writer；显式事务嵌套通过 SAVEPOINT，而非再嵌套 BEGIN。内层 RELEASE 不代表外层事务已经持久提交。[SQLite Transaction](https://www.sqlite.org/lang_transaction.html)、[Savepoints](https://www.sqlite.org/lang_savepoint.html)
- better-sqlite3 13.0.1 当前实现对嵌套同步 transaction 使用 SAVEPOINT/RELEASE，异常回滚，返回 Promise 则抛错。候选复用这个已存在的应用数据库连接，不跨 await 保留写事务。[固定版本源码](https://github.com/WiseLibs/better-sqlite3/blob/v13.0.1/lib/methods/transaction.js)
- WAL 的读写并行与 checkpoint 行为不消除单 writer 约束。本回放使用 WAL + synchronous=FULL；未更改 checkpoint 或 busy timeout 默认值。[SQLite WAL](https://www.sqlite.org/wal.html)

同提交或同回滚属于正确性要求。100/1,000/10,000、五次重复和本文来源长度属于实验采样，不是生产容量上限、保留时长或调度阈值。普通去重 hash 仅识别完整来源描述相等，不是安全证明或证据链。

## 唯一领域合同

`cognition_memory_handoffs` 保存 id、personaId、situationId、committedAt、primaryEvidenceIds、historyEvidenceIds，以及 contextGroups。表不复制对话、Activity 原文、模型总结、图片或 Memory 状态。

稳定 grounded claim 的主材料是当前支持与矛盾证据；被替换的旧来源保持为中性 history，不能升级为一次新确认。纯推测不会形成新的事实材料；撤回先前 grounded claim 可交接实际来源。闭合 Episode 的主材料是该 Episode 的原始 Evidence IDs。没有 primary 就不生成待办。相同 Persona/Situation 的相同完整来源描述在尚未交接时精确去重。

所有 Situation/Episode 的最终部分更新及 `cognition_episode_evidence` 索引先保存，再冻结共享 Episode 的实际一跳关系。contextGroups 每组保存共享该 Episode 的 anchor 子集和实际成员 Evidence IDs；相同 context 集合可合并 anchors，关系不变。这里没有递归关联、语义猜测或最新 Situation 指针替代历史。

Main 先解析候选 primary，得到真正 accepted 的来源。上下文只读取与 accepted anchors 相交的组，并限制到 accepted primary 的最大 receipt。排除一条更晚、不可用于形成的 primary，不能将上下文时间范围向后推。提交之后 Episode 再改组，已有待交接项仍保持原关系。公共 evidence 读取仅返回来源元数据，正文由来源所属域读取；Cog 的局部 text 不是 Activity canonical JSON。

Main 需要区分不支持形成的控制材料与本应存在但实际缺失的原文。前者可明确跳过；后者保留待办，不能借总结补造或无声 ack。Memory 入队与 acknowledgement 在一个同步事务里完成，wake 在事务外。每次 iterator yield 都不持有 SQLite cursor，消费方可以安全写入并确认。

待交接项引用的 Activity 来源继续受保护，直至原子 acknowledgement；已有 Memory 文本 snapshot 不单独解除尚未交接来源的保护。确认后的生命周期归已有 Memory/source snapshot/当前视觉保护负责。

当前 Cognition schema v26 尚未发布，真实 released 数据没有旧 Cognition 表；候选没有历史回填、全库启动扫描或兼容分支。

## 来源关系表示的机械比较

同一实际关系的 JSON 表示，逐 context 重复 anchors 与按 Episode 分组分别为：1 anchor/32 context：3,681 vs 1,335 bytes；8/256：99,329 vs 10,344；64/4,096：10,534,913 vs 162,288。三个 accepted-anchor 子集关系展开一致，因此选择更小的 groups 表示。此测量只涉及元数据，不能用来声称模型质量或完整系统延迟改善。

## 零模型负载回放

前瞻协议为 `PROTOCOL.md`，细节与代码 hash 在 `REPLAY-FREEZE.json`。同一显式索引 fixture 复制给两臂：两个人格，每段历史一个 grounded claim 和一个 closed Episode，每段两个真实 ActivityEvent 来源；普通短来源，以及每 100 段的 primary 含一条较长来源两种形状。规模 100/1,000/10,000，待交接数 0/3；最初预注册每条件五次独立 Node 进程、交替顺序，共 120 次测量、60 对。

唯一变量是旧历史恢复与新 pending 恢复。两臂都使用真实 ActivityRepository 和同一个 Main canonical 来源解析函数，以及同一个既有 Episode id/version 构造函数。新臂没有同时纳入 root 独立研究的来源引用入口或 Q2 intake 优化。pending 来源、primary/context 用途、Episode id/version 的完整结果必须相等。

fixture 通过显式 SQL 构造合法状态及源索引，是外部实验数据准备，不是候选运行时 backfill。没有用户桌面采集，也没有 Provider 调用。历史均被视为已经交接，只有最后指定的三项尚待交接；因此比较目标正是恢复成本是否依赖已经完成的历史。

记录同步恢复墙钟、首个完整 Episode 时间、原文 resolver 次数/序列化字节、待交接元数据字节、DB/WAL 大小。event-loop 指标是在同步恢复前排入一个 setImmediate，记录该回调实际恢复执行的时间；它是该 Node 同步工作段的阻塞时间，不是 Electron 全应用 event-loop 分布。冷进程包含首个用到的 Ajv schema 编译；没有把这一项拆算为数据库读页时间。

### 透明采样修订

10k 第一个旧路径条件的前三次恢复实际用时 207.482、217.670、207.283 秒。按原计划完成二十次 10k 旧路径恢复约需七十分钟。因此在结果已可见后，root 批准按实际工程时间减少尚未开始的重复；理由不是来源一致性、质量或候选胜负。批准时第一个条件第五次旧路径已经启动，全部五次及对应新路径保留。其余三个 10k 条件只保留原定 rep0 一对。100/1,000 的五次重复不变。

原计划 120 次测量、60 对，修订为 96 次、48 对；24 次尚未启动的测量取消，不记为完成、失败或右删失。已在途进程没有收到信号或中止，全部保留实际结果。旧调度没有外部请求边界，实验入口因此新增一次明确的 `sampling_boundary_stop`（exit 75）：它在下一项测量开始前结束旧调度。该项是调度控制、没有进入测量，不能混为算法失败。修订调度随后继续三个原定 rep0 条件。测量 bundle 原字节和 SHA 保持不变，说明见 `SAMPLING-AMENDMENT.json`；原调度记录也保留。

root 在旧 10k 恢复期间并行执行过两轮各约 20–30 秒的离线 static/contract/unit/integration 验证，并有短暂源码读写；后续还执行过小型 Provider/事务测试，本领域执行过约一秒的 focused suite、TypeScript、lint/format。没有同时运行本地生成模型或大 encoder 扫描。不能声称严格 CPU 隔离、精确 p95 或延迟置信区间。正文只报告样本值及五次条件的中位数/范围。RSS 是恢复结束时 `process.memoryUsage().rss`，不是峰值；进程快照另记当时 RSS。

### 完整结果

96/96 次实际测量完成，48/48 对均得到结果；24 次计划中的测量在启动前取消，无测量失败、无在途删失。另保留一次 sampling-boundary 控制记录，不计为算法失败。22 对非空 pending 条件的三条完整 canonical Episode（来源、primary/context 用途、id/version）逐项相等；26 对空 pending 均为空。这是实际来源构造等价，不是模型记忆语义质量评分。

下表单位为毫秒；五次条件显示中位数及最小–最大值，单次条件只显示实际值。“长”指历史中偶有长来源，当前三个 pending 都是短来源。

| 历史段数 | 来源 | pending | 每臂次数 | 旧历史恢复                             | 新 pending 恢复         | 原文读取次数：旧→新 |
| -------- | ---- | ------- | -------- | -------------------------------------- | ----------------------- | ------------------- |
| 100      | 短   | 0       | 5        | 70.061（69.609–71.704）                | 0.079（0.070–0.091）    | 400→0               |
| 100      | 短   | 3       | 5        | 69.134（68.670–71.158）                | 30.296（29.963–30.510） | 400→6               |
| 100      | 长   | 0       | 5        | 71.699（70.690–72.266）                | 0.087（0.066–0.091）    | 400→0               |
| 100      | 长   | 3       | 5        | 72.230（71.397–72.669）                | 30.793（30.482–30.866） | 400→6               |
| 1,000    | 短   | 0       | 5        | 1,539.383（1,510.769–1,644.492）       | 0.083（0.069–0.093）    | 4,000→0             |
| 1,000    | 短   | 3       | 5        | 1,524.631（1,511.980–1,540.188）       | 31.514（31.015–32.244） | 4,000→6             |
| 1,000    | 长   | 0       | 5        | 1,545.207（1,538.271–1,551.625）       | 0.081（0.075–0.089）    | 4,000→0             |
| 1,000    | 长   | 3       | 5        | 1,575.358（1,564.836–1,665.506）       | 32.211（31.800–41.405） | 4,000→6             |
| 10,000   | 短   | 0       | 5        | 210,018.197（207,283.292–217,670.462） | 0.081（0.081–0.082）    | 40,000→0            |
| 10,000   | 短   | 3       | 1        | 204,768.031                            | 45.489                  | 40,000→6            |
| 10,000   | 长   | 0       | 1        | 205,949.326                            | 0.080                   | 40,000→0            |
| 10,000   | 长   | 3       | 1        | 206,552.096                            | 45.215                  | 40,000→6            |

10k 已完成历史的旧恢复仍读取 40,000 份原文，序列化来源约 29.28 MB（短来源）或 50.83 MB（偶有长来源）；新路径无 pending 时为 0，三个 pending 时只读 6 份短来源。三个待办描述共 1,374 bytes。10k 三待办的恢复实测约 45 ms，包含冷进程 schema 首次编译、来源读取和构造；不能把它称为 45 ms 的纯 SQL 读页。

10k 旧恢复结束时 RSS 约 804–805 MiB，新路径空待办约 73 MiB，三个待办约 106 MiB；这是终点值，不是峰值。同步工作段期间，排队的 setImmediate 也只能在恢复结束后运行，故此测量直接暴露主线程同步恢复的阻塞风险，不能替代 Electron 全应用事件循环测试。

实验结果支持取消已完成历史的重复来源展开。新路径开销由尚未交接的实际材料决定；45 ms 与小规模约 30–32 ms 的差别仍包括冷缓存、fixture 规模和并发负载，本文不宣称严格常数延迟。零模型请求，也没有以减少 Memory 内容或跳过当前纠正换取速度。

原始结果 SHA-256：`fe2110630c6619f5e77e3c2996961dbd9b4650132aaa2bbd8c02af1a2eb20a91`；完整聚合、每对相等性及其它输入/记录标识见外部 `REPLAY-RESULTS.json`。

## 已验证的领域边界

最新 focused suite 为 120/120、7 文件，覆盖 Cognition 和相邻 Life/Opportunity；focused TypeScript、Cognition ESLint、受影响 Prettier 和 diff whitespace check 均通过。新增普通回归验证：

- 状态、Episode 索引和 pending 写入一起回滚；提交后重新实例化 Repository 能找到相同待办。
- 用最小 receiving-domain SQLite fixture 验证嵌套 enqueue、ack 前失败、ack 后但提交前失败一起回滚；这不是 Q2 Memory 集成测试。
- 通知失败不回滚已提交状态，也不删除待办；ack 必须在已有同步事务内。
- 同一来源的精确 pending 去重，纠正及中性旧来源保持独立，两个 Persona 不互串。
- one-hop context 冻结、accepted-primary cutoff、无递归、未来证据排除、部分 child 更新保留未见历史。
- 删除 owning Persona 清理 pending；实际缺失 Evidence 会报错且保留 pending；待交接 Activity 源继续被保护。
- handoff 和元数据读取不加载巨大 Cog text。

真实 Memory Q2 enqueue/ack、Main 启动恢复与 retirement 由 root 的独立集成包完成；root 报告同日 1,338 项完整离线回归通过。本领域 receiving fixture 不能代替这些跨域验证，也不在恢复速度表中重复计数。源码交付文件/散列见 `HANDOFF.json`，记录的是已交付 handoff bundle，不包含随后独立的 action freshness 候选。

## 复杂度与未解决问题

新增一个领域表和一个直接实现交接职责的模块，没有新进程、计时器、设置、重试状态机或模型调用。交接成功后删除待办，后续状态只保留在 Memory 原 work 中。

一个真实 Episode 关联很多来源时，冻结的 ID 元数据仍可能大；如果来源持续缺失、intake 一直失败，pending 会积累。本包没有通过静默覆盖中间纠正或任意丢弃历史解决它。Main 可以逐项消费，因为 iterator 不持有游标；单个首次 canonical 来源仍可能需要读完整正文，这属于另一个 source owner/Q2 入口包。回放的长来源位于已完成历史，最后三条 pending 仍是短来源，因此未覆盖单条巨大 pending 的入队资源成本。

旧恢复查询的历史尺度问题不等于模型语义吞吐。之前连续桌面回放揭示的 PFC 数十秒状态更新、历史水位追赶和全部分析 read set 导致行动过时拒绝，本包均未改变。禁止用这里的恢复加速声称商业连续陪伴已验收。

## 清理

最终结果已写入；外部 executable runner、临时数据库克隆/fixture、node_modules 链接与本包临时 tsconfig 按 `CLEANUP.json` 删除，仅保留非敏感原始结果、输入/源码标识和中文 Decision。旧 getClaims/getClosedEpisodes 及双 callback 已从本包源码删除；Root 完成 Main 接线后再做跨域单路径审计。
