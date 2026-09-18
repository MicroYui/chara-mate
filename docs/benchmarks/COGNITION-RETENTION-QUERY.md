# 来源保护查询的单次计划展开

Decision ID：`COGNITION-RETENTION-QUERY`。2026-09-17，接受将未完成目录读取计划、活跃决定的来源依赖分别在同一 SQL 中展开一次；两项按顺序独立比较后合入 Main。单一生产查询、原来源保护规则和事务边界保持。当前选择解决已测的重复检查成本，**尚不代表十万来源下的完整 App 维护通过**。

## 问题与来源

Activity 清理和 Memory 原文回收共用 `retainedSourceUses`。原查询为每个待检查来源，再查该角色的决定记录并解析未完成读取计划。来源与历史决定累计后，即使没有待完成的计划，也会重复检查相同 JSON。

2026-09-17 核对 SQLite 官方 [WITH 文档](https://www.sqlite.org/lang_with.html)、[部分索引](https://www.sqlite.org/partialindex.html)和[查询计划](https://www.sqlite.org/eqp.html)。CTE 的生命周期属于单条语句，`MATERIALIZED` 可以限制重写；它不是保证更快的协议要求。本次实际 better-sqlite3 13.0.1 使用 SQLite 3.53.3，Node 24.18.0 的内置 SQLite 版本不用于描述该 addon。

原访问计划在每个 used 来源下运行 correlated subquery；候选只对本次涉及的角色建立 `pending_catalogue_reads`，再按角色和 evidenceId 联接。候选实际 EQP 出现一次 materialization；自动索引只显示 persona_id，不声称已经得到双字段组合索引。节点没有独立计时，不能把总差值全部归给某一节点。

## 同库比较与结果

共同源清单为 `c62d0fab56b8c5c7fafffb67483c413bc83c3fc0e74b5d21bed097e9b54c4d5e`。M4 Pro、24 GiB、darwin/arm64；相同只读数据库和显式读事务，原完整输入 10004 项，另按既有 1000 项分页和固定首项检查。每种 workload 首轮单列，再做五轮，先后手交替；不选择最快一次。

18 个成对 sweep、36 个 arm sweep，共156次查询、78次逐查询配对。独立核对全部参数、156份原结果 SHA 和有序 candidate/reason 数组；各轮及分页合并均等价，数据库 total_changes 为0。完整结果1004对、1003个来源，其中 unanalysed=1002、intent=1、current_view=1。此库没有 decision/handoff/claim/episode 正结果；正向待读资格另由真实 Repository 回归覆盖，不将这一规模样本泛化为大量活跃计划的性能。

单位毫秒；分页列为11页总和。下列是 prepare+all 的实际 SQL 调用时间，不含 Repository 的其它映射、清理事务、资产操作或 GUI。

| 工作量 | 首轮：原 → 候选 | 后五次中位：原 → 候选 | 中位变化 |
| --- | ---: | ---: | ---: |
| 完整10004项 | 3907.886 → 2058.646 | 3884.366 → 2082.863 | −46.38% |
| 1000项分页，全11页 | 3901.315 → 2099.538 | 3926.428 → 2089.901 | −46.77% |
| 固定单项 | 1.015 → 0.814 | 0.884 → 0.859 | −2.80% |

五对完整查询下降46.12%–46.75%，分页总和下降46.63%–51.29%；这是观察范围，不是总体置信区间。每轮最慢页的重复中位404.132→213.519毫秒，候选仍会同步占用 Main。单项实际 query 中位0.458916→0.458709毫秒，基本相同，不能声称稳定单项加速。

完整查询的 prepare/query 中位分别为原0.443/3883.886、候选0.487/2082.371毫秒。参数序列化在计时外，完整输入约1.34 MB、1.314毫秒。原与候选共用一个进程、缓存及分配器；同PID全程 RSS 高水位163.266 MiB，不作独立臂峰值比较。执行墙钟72.596秒，2026-09-16T23:36:03.881Z至23:37:16.477Z，进程自然 exit 0、事务和数据库关闭，无错误。

## 正确性与复杂度

严格保留当前 user generation、completionPending、coverage 超过目录审阅水位及 reviewed→analyzed 兜底规则。此分支没有新增终态过滤：failed/superseded 的未完成读取仍能保护来源。重复请求最终由原 UNION 去重；source kind/id/fragment 与跨角色资格、其它所有保护 reason、排序均不变。没有新增表、索引、缓存、配置、迁移或跨 yield 的保护快照。

候选四个相关测试文件86项通过，typecheck通过；新增回归也在原查询上通过，说明本次不是以基线错误为由改变资格。新增用例通过真实 Repository 建立 failed/superseded 的待完成计划，先验证实际原文不能回收，再分别推进用户generation、追平目录审阅或完成计划，验证允许释放。首次测试使用私有 saveAttention 导致类型检查失败；改为公开 updateAttention 后重新验证，原失败保留，生产 SQL 未因夹具变化改写。

Main 精确合入生产文件 SHA `0317b6537f52bee228371c665d5fdc84060aeb20120eaf5856ec92c048bd8d6f` 和修正后的测试 SHA `b7690d226a553f6a371d446527559468fa88b30940425bf3de3fefc823be7f1d`。本次 Main 集成后的完整回归仍待协调窗口执行；此前2399全离线属于集成前共同源，不能覆盖这一增量。

## 选择、限制与下一步

接受此改动，因为已测分页/批量成本显著下降，资格保持，且没有持久化复杂度。代价是单语句临时关系及可能的自动索引；单项没有明确收益但也未见有意义退化。其它分支不连带改写，下一项只针对已有 EQP 仍重复展开的 active Attempt 依赖单独比较。

十万来源、实际 Activity 清理、Memory 原文回收、写入、向量 Worker/编码器重叠和事件循环仍需同库验证。单项空结果不能代替全部原文回收成本；当前仍约213毫秒的最慢页也没有满足整个合并资源验收。

本库构造另修正了旧实验产物的两个部分索引：旧定义只含actor=user，当前源覆盖user/unknown。双方均使用修正后的同库，所有行不变。构库耗时由旧约59.9秒变为新约3.55秒属于夹具物理结构对齐，不算本次生产 SQL 收益，也没有为旧未发布实验库增加产品迁移。

原始输入、候选、结果与冻结保存在仓外 `integration/cognition-capacity-query-perf-v1`，runner freeze `3b4fe4ca0d5eb1659aac0b972c0155eaf80141cee8ff5533230feb24c3378a26`；独立报告 `0b51617482afe7cb02d10736aa916554be5e08d535c354589a0b8090ac8e2117`，聚合 `1732078f09411f1ab5df9b623435f9283632a63434bf1267434e2445e1eb771b`。SQL之后的独立 JSON 分析曾因反复解析参数被中断，止时UNKNOWN，可能短暂影响后来FCI宿主负载，保留原活动说明；它不在本次SQL计时内。生产树只保留获选查询和领域回归，实验运行器和两臂不进入仓库。

## 后续独立比较：活跃依赖展开

第一项选择后，实际计划仍为每个来源反复检查活跃 Attempt 的 `dependencies.evidenceIds`。本轮以已选 pending 查询为基线，仅增加 `active_decision_evidence AS MATERIALIZED`，按本次涉及的 persona 展开一次，再按 persona/evidenceId 联接。其它 reason、当前代 pending 资格、参数和排序不变。来源与工具版本沿用前述已核对的 SQLite 文档及 3.53.3 实际 addon；物化是本地选型，非数据库协议硬要求。

仍是同一未执行清理的 10004 项原库、同一显式只读事务、三个原 workload、18 对 sweep 和156次查询。2026-09-17T02:44:34.364Z至02:44:56.952Z，PID20441自然退出、数据库关闭、total_changes 0、无错误。前一真实模型比较全部关闭后独占运行，没有把两批查询合并成更大的独立样本。

| 工作量 | 首轮：已选 pending → 加活跃依赖物化 | 后五次中位 | 中位变化 |
| --- | ---: | ---: | ---: |
| 完整10004项 | 1865.218 → 37.831 ms | 1815.405 → 37.504 ms | −97.93% |
| 1000项分页，全11页 | 1805.884 → 40.778 ms | 1840.177 → 40.844 ms | −97.78% |
| 固定单项 | 0.760 → 0.491 ms | 0.628 → 0.462 ms | −26.47% |

五对完整查询下降97.73%–97.95%，分页总和下降97.77%–97.82%；是本机观察范围，非总体置信区间。每轮最慢页的中位188.633→4.283毫秒，候选实际最慢页4.763毫秒。单项只减少约0.166毫秒，不据百分比夸大产品价值。全部有序 candidate/reason 数组、分页合并和固定单项投影一致，原1004对/1003来源的保护集合不变。

候选 EQP 显示一次 active materialization，以及 persona_id/evidence_id 自动覆盖索引和 Bloom filter；没有节点级耗时，不能把全部收益归于某个节点。完整 query 中位1814.997→37.098毫秒；prepare 中位0.408→0.428毫秒。单PID总RSS高水位194.609 MiB，仍是交替执行的共同进程，不是两臂独立峰值。单语句临时关系与自动索引在语句结束释放，没有新持久表、索引、后台任务或缓存。

原库的 decision 正结果仍为0；此结果主要说明大量历史决定下反复展开的成本，不证明大量活跃依赖扇出的性能。两臂分别运行同一89项 Repository 回归及类型检查，覆盖旧 generation 仍活跃、多个 owner、重复引用、五种活跃状态与三种终态。active 分支仍不加当前 generation 条件；只有全部实际 owner 收口才释放。首版夹具先占用分析 owner 再调用 analyze 导致3例唯一约束失败；按真实合法顺序先完成 quiet 分析再建立执行依赖后双方通过，生产 SQL 未因失败改变。

接受第二项改动：批量及每页耗时显著下降，资格保持，没有新增持久化复杂度；没有理由保留旧逐来源 correlated 分支作为运行模式。Main 仅合入生产 SHA `cdfd4e55123928f779552abe5538431b08cac438aa172c54f9f477385a0da1e1` 与回归 SHA `24acb478979e3368d879249946d5b42b00e195cb39b60dcff91edf47d9e4aec8`。同两个文件进入接下来的目录组合源，四条件完全一致。独立复核重新检查156份结果、78对页及18对sweep，支持晋级；报告 SHA `84daa5527025cb71f43ac83a65dec74004e0c25f4248148af2016120681b321c`。

本次实际 Main 完整离线2448/2448（136 contract、1673 unit/component、639 integration）通过，50.094秒；生产构建13.756秒，格式和 diff whitespace 通过。运行区间02:49:35.730–02:50:39.719 UTC，在原FCI关闭后、新页面模型校准前。本次未重复桌面E2E；最后同版的原生/安装/独立连续验收仍单列，不能由SQL优化替代。

原结果 `integration/cognition-capacity-active-perf-v1/execution-10000-first/RESULT.json` SHA `68e0170cd385061cec594c704028ef6100ebd099258b960e5fbf7cdfa60dabc2`；两臂回归与原失败在 `cognition-capacity-active-validation-v1/v2`；精确合入回执在 `cognition-capacity-active-implementation-v1`。原库、旧冻结与失败保留，候选运行器/SQL文件不进入生产。下一项仍是同库十万规模下实际清理、写入、Worker/编码器重叠和 Main 响应验证。
