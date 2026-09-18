# Activity 引用分段回收与主线程响应

2026-09-16。Root 选择固定 1000 条真实扫描页。4 文件精确补丁基于 `platform/candidate-v2`，逐文件 before/after、patch hash 见 `SOURCE-HANDOFF.json`；源码在 `source/`。Root 已将四文件与最终三个索引合入隔离集成源；61 Activity 单元、116 跨域/数据库与完整类型检查通过。Main 代码尚待最终统一交付。Root 是唯一集成 owner。

## 变更与合同

`ActivityRepository.cleanup` 改为 async，构造器仍只接受 database，唯一页大小在实现内固定为 1000，无范围参数、实验 Arm 或生产开关。年龄阶段先取真实 PK 页，再在同一同步事务内判断截图自身 7 天、其它 raw 30 天、蒸馏和当前消费者保护。即使整页不合资格也会完成本页后让出事件循环，不用 LIMIT 返回条数冒充扫描范围限制。

每页提交前调用当前 guard，不跨让出保存删除资格；Root 的组合 guard 也必须在当次调用重新取得 canonical snapshot 集合。让出后出现的新引用可以继续保住 PNG；不因新引用存在而重新延长已无消费者的其它旧事件。只有实际零引用才删 asset 行，提交与真实累计删除数在同一事务。容量目录按 `(created_at,id)` 键集分页，预检有界；提交仍重新查保护及容量，未释放资产不提前减字节，达到容量后即结束后续预检。

`ActivityService` 复用已有 visual asset 队列串行保存/回收；stopMaintenance abort 当前维护并等实际完成。正常停止只忽略自身取消，真实文件失败仍上报；中断或错误保存已提交进度，后续从实际库恢复，不回滚已完成页。既有 retention_runs 可表达进度，无新增表、Worker、缓存或后台维护路径。

截图按自身 7 天退休是 Root 已明确的产品规则，与此前“共享 asset 全组保留至年轻引用到期”存在 7–30 天差异，不称全历史语义等价。生产回归明确保留这一差异。

## 验证

- Activity 9 文件、95 项：通过，910ms。包含新 13 项真实 SQLite/PNG 与取消/重开回归；现有 integration 仅把 repository.cleanup 调用改为 await。
- 全副本 typecheck、四文件 ESLint 和 Prettier 检查：通过。未运行新模型、native、build、E2E 或全域回归，由 Root 合并后验证。
- 新回归保留年龄差异、年轻/受保护共享引用、末引用释放、全部不合资格、让出后的新保护/新引用、guard 消失、容量预检、满足容量即停止、真实 SQLite 关闭重开、实际维护 owner 停止和真实 ENOTDIR 报错。
- 容量机制使用有效小 PNG 和模拟 byte_length，不冒充物理 512MiB 文件。单次初始 fixture 断言把“新增引用保住 PNG”误当“最后旧事件也必须保留”；原失败与更正保留，未改生产实现绕过。

资源结果与源版本见 `maintenance-reference-v2-1/RESOURCE-REPORT.md`。100k 普通保护库固定 1000 的总时 3277ms、Main 最大采样停顿 98.5ms；100k 单 asset 为 3512ms / 69.1ms；全部不合资格为 160ms / 5.0ms。不是硬实时保证，固定保护集合不代表最终三域 SQL 成本。新的 capture 持久化仍会等待本轮同队列维护完成，总时约 3.3s 的取舍需保留。原集合及其它页大小代码仍仅在仓外证据包中，待 Root 集成及最终组合验收后按精确清理清单归档删除。

## 最终唯一 DDL 与代价

完整定义见 `DDL.sql`，共三个索引。Root 已确认集成基线没有这三个同名索引，因此以新增 `IF NOT EXISTS` 定义加入 current schema；现有初始化在重开时执行 current schema，不新增版本、迁移或每次 drop/rebuild。曾有的不同 artifact 索引仅存在仓外候选库，未冒充生产迁移需求。

1. `activity_events_artifact_idx`：唯一保留 `(CAST(json_extract(details_json,'$.artifactId') AS TEXT),id)`。它涵盖之前 CAST affinity 修正并新增真实引用 ID 范围排序；不再另建单表达式重复前缀索引。100k 事件的索引从 1,241,088 增至 4,980,736 bytes，增加 3,739,648 bytes。原无 CAST 的初次未采用索引失败保留，不称单独索引解释全部旧 198s 收益。Repo 当前所有五处资产表达式均明确 TEXT。
2. `activity_assets_created_idx(created_at,id)`：容量目录范围及 high-water 实际消费的覆盖索引；1000 资产占 73,728 bytes，不能由 artifact 索引替代。真实 EQP 从 SCAN+TEMP ORDER 改为范围 SEARCH，无临时排序。
3. `cognition_evidence_object_observed_idx`：persona + object.key + observed_at DESC + receipt_sequence DESC，仅 observation，无 actor 过滤。保留每 Persona 的真实对象和排序资格；1k 合成库 118,784 bytes、三域保护完整集合及领域表行相同。写入/最终大库成本尚未测。它与 Persona 全对象 `latest_observation_idx`、原始来源查询索引用途不同，不替换它们。

本次 Activity 两索引三条件写入比较使用相同 1000 事件/资产记录：事件写 44.21/42.62/41.77ms，资产元数据写 11.14/10.30/10.17ms；固定顺序单次结果不能证明零写入开销。created 索引令该资产写后 WAL 时点体积从 424,392 增至 519,152 bytes；事件写后 checkpoint 前 WAL 未独立保存，明确不提供差值。原/新行 hash 相同。具体原始数值与 EQP 见资源报告，最终不保留实验配置参数。

官方依据及版本沿用 `maintenance-reference-v2-1/SOURCES.md`、`combined-source-retention/OBJECT-INDEX-REPORT.md`：SQLite 3.53.3，source_id `2026-06-26 20:14:12 d4c0e51e4aeb96955b99185ab9cde75c339e2c29c3f3f12428d364a10d782c62`；2026-09-16 阅读 [expression indexes](https://www.sqlite.org/expridx.html)、[row values](https://www.sqlite.org/rowvalue.html)、[query planner](https://www.sqlite.org/queryplanner.html)。数值 1000 是本次产品工程选择，不是 SQLite 协议限制。

## 后续硬项

Root 最终组合源的 1k/10k/100k 三域 guard/同维护入口资源；完整输入 258k 的真实计数部署缺口；全部候选合入后同版 packaged native/4B 512维 Worker/临时 userdata 生命周期；相依回归、E2E 与最终单路径清理。此清单不因本包 95 项通过自动关闭，详情沿用 `PLATFORM-OPEN-ACCEPTANCE.md`。
