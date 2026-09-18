# Memory 待处理工作逐项读取

2026-09-15。选择短查询逐项读取，并把 memory_work_pending 索引的完整顺序设为 (status, updated_at, id)。本包当时只解决积压任务全部正文一次进入 JS 的问题。后续[来源存储](COMPANION-MEMORY-SOURCE-STORAGE.md)和[引用入口](MEMORY-SOURCE-INTAKE.md)已在 Main v21 将工作迭代改为引用与 canonical 原文窗口；下面的旧 Episode payload 比较保留原输入。首次外域来源读取仍可能物化完整字符串，因此不宣称整个形成流程具有永久固定内存上限。

## 问题与一手来源

原 `pendingFormationEpisodes()` 使用 `.all()`，随后一次解析全部 `payload_json`。Maintenance 才开始按任务串行调用形成模型，首个任务必须等待积压正文全部加载。启动恢复还返回一次不被调用方使用的同样列表。

依据为 2026-09-15 实际源码、`better-sqlite3 13.0.1`、SQLite `3.53.3`：

- [better-sqlite3 v13.0.1 API](https://github.com/WiseLibs/better-sqlite3/blob/v13.0.1/docs/api.md)：同步 `.get()` 完成一次查询；事务回调不能跨异步等待。
- [SQLite isolation](https://www.sqlite.org/isolation.html)（2026-09-15 读取）：同一连接上 SELECT 仍在逐行执行时修改正在读取的表，其后续可见性未定义。因此不能用跨模型 await 的 `.iterate()` 机械替代 `.all()`。
- [SQLite WAL](https://www.sqlite.org/wal.html)（2026-09-15 读取）：长读快照可能阻止 checkpoint 完成。这是生命周期依据，不是改 WAL 参数或新建线程的理由。

协议/API 不规定本产品 batch、topK 或并发数。这里的 `LIMIT 1` 是短语句返回一个 durable 工作的实现，不是记忆质量截断；一个 pass 持续读到当时无下一条，后续入队由已有 wake 继续处理。

## 实验与结果后修订

实验仅在外部目录执行，不调用模型。固定 short / mixed 两种原文分布，各 10、100、1000 个待处理工作；每个任务使用真实 SQLite 表、原 MemoryRepository 写入与原读取方法。所有任务故意具有相同 `updated_at`，验证真实队列批量入队时的排序。mixed 1000 任务有 6,294,530 字节 payload，包含少量 256 KiB 长文。

先比较原 `.all()` 和原索引下的 `(updated_at,id)` keyset `.get()`；每组合独立进程，3 次交替顺序，共 36 次。原 get 候选暴露额外排序：EXPLAIN 显示 `USE TEMP B-TREE FOR LAST TERM OF ORDER BY`，总耗时明显退化。完整失败结果保留。

查看结果后，增加一个明确的工程修订：只给相同 get 查询配齐索引末列 `id`，再与 all 进行同输入、同次序、3 次交替比较，共另 36 次。没有更换 tie 顺序、合并任务或修改输入。该修订不是原预注册候选，不掩盖前一候选失败。

环境为 Apple M4 Pro、24 GiB 内存、macOS arm64、Node 24.18.0。以下是 3 次独立进程的完整最小—最大范围，不能当总体 p95 或置信区间。

|1000 条 mixed 任务|首条可用|全量消费|Main 最大事件循环延迟|RSS 增量|
|---|---:|---:|---:|---:|
|原 all，第一轮|7.39–7.81 ms|114.4–123.0 ms|8.67–9.50 ms|32.7–33.8 MB|
|get，原索引|2.32–2.56 ms|656.2–662.8 ms|6.13–7.12 ms|18.8–19.2 MB|
|原 all，配对修订轮|7.06–7.40 ms|110.2–113.5 ms|7.79–9.28 ms|32.6–34.0 MB|
|get，完整顺序索引|1.37–1.55 ms|101.3–102.8 ms|3.25–3.39 ms|9.40–9.65 MB|

修订轮 short 1000：all 总耗时 84.9–90.1 ms；get-index 为 83.5、115.3、84.1 ms，有一个离群结果。小输入的吞吐没有稳定巨大收益；选择依据是混合积压的首项等待、内存、阻塞和不退化的整体复杂度。72 次测量中同一输入的处理 ID 顺序 hash 完全一致。没有模型抽取、召回或用户体验质量提升的推断。

## 选中生产路径

- 仓储返回懒 `Iterable<MemoryFormationEpisode>`。先取一行，保存该行原始 `(updated_at,id)`，在语句完成后把解析的 episode 交给形成 owner。
- 当前任务更新 status/timestamp 不改变已保存 cursor；不会在同一 pass 因未改变的 pending key 重复取同一工作。
- 在 cursor 之前入队的新工作由已有入队 wake 触发下一 pass。取消后不再读取，未读任务保留；重启仍用 durable 状态恢复。
- 启动 `recoverInterruptedWork()` 只修改中断状态，返回 `void`；Maintenance 的正常迭代负责读取，取消无用的提前全量读。
- 保留原一个 formation lane、一个索引 lane及共享取消，不添加新的工作队列、并发池、重试定时器、Settings 或算法模式。
- 配套修改已有索引为 `(status,updated_at,id)`；没有新增第二个同用途索引。跨域 schema 由 root 唯一集成。

回归使用实际 SQLite：懒读取可见迭代前的新入队；同时间排序一致；获取后状态更新；当前 pass 之前的新键在下一 pass 可见；取消与中断恢复；failed 只在明确 retry 后再次出现。新 focused 文件加现有 Maintenance 套件共 31/31 通过。全量离线、最终索引集成与桌面验证由主集成记录。

## 证据、复杂度与剩余限制

外部证据包 `memory-queue-candidates`：

- 输入清单 `q1-input-manifest.json`：`052023abc67b2dce916e4824d3acb3c1a8d751585b8e1baa3d22be18f4e13d88`。
- 原36行 `q1-results.jsonl`：`5215bacb96898e2ca985855828ce0620a5802d551f98b9dbdfc99e74bdcb3296`。
- 修订36行 `q1-index-results.jsonl`：`1a2548facd55af5cdc41320a6660525ddf656d20b9f1b23e530457f44e391da6`。
- 外部生命周期结果包含 Q1/Q2 独立范围，`lifecycle-results.json`：`57d7c9effa76d619b3dba4a086a072d59da31a7db3752db19fef135b141c540a`。

首次非正式冒烟发现统计脚本把初始内存与 peak 指向同一对象，已在正式36次前修正；该冒烟没有纳入结果。所有原候选、输入、脚本和数据库留在外部，不进入生产仓。仓内仅保留选中代码、回归和本文，未保留 all/get Arm 开关。

此修改不消除一个工作内部的超大 sources，也不消除同一原文被多个工作复制。独立真实合法长 Episode（4160 个 sources，33.67 MB 原文）已观察到旧分段函数约16–17秒主线程阻塞；这个实际问题由原文规范化和形成工作集候选继续解决，不能以本项通过代替验收。

## 后续查询形状与索引工作修正

2026-09-15 在 Q1 原始与补索引的 72 行结果均保留后，增加一项查询形状比较。前两轮的正常消费会把已读取任务移出 pending，掩盖 OR 游标对未消费前缀反复扫描的问题。独立 SQLite 3.53.3 fixture 保持 10,000 条任务均 pending，比较同三列索引上的 OR 与 row-value 游标，3 次交替顺序：

| 本次读取数 | OR 总耗时 | row-value 总耗时 | 完整 ID 顺序 |
| --- | ---: | ---: | --- |
| 1,000 | 28.77–29.15 ms | 3.84–4.23 ms | 3/3 相等 |
| 10,000 | 2,209.62–2,256.44 ms | 38.85–39.83 ms | 3/3 相等 |

EXPLAIN 中 OR 只定位 `status=?`；`(updated_at,id)>(?,?)` 定位 `status=? AND (updated_at,id)>(?,?)`。最终生产采用后者。timestamp/id 均非空，因此左到右比较与原有排序同义。SQLite 官方 [Row Values](https://www.sqlite.org/rowvalue.html)（页面更新 2025-05-31，2026-09-15 核实）明确介绍联合键分页；这不是新的产品数值阈值。上述固定重复不是总体分位数，输入 SHA-256 为 `e5ae0a2093832b09654e6615f604aefdad24128737b72af414678ef91e493b0c`，原始结果外部 `memory-queue-candidates/q1-cursor-results.json`。

同样的正文峰值问题还存在于索引工作：`scheduleIndex` 先 `.all()` 读取全部候选 Revision 文本，`indexWork` 再 `.all()` 读取全部 pending 文本，并跨编码器 await 保存。修正为两个明确阶段：前者在原同步事务中按 Revision 主键短 get 后入队；后者按 `(updated_at,id)` 短 get 后交给唯一编码器 owner。kind、模型命名空间、pending、未删除资格保持不变；完整向量不重复排队，失败任务仍需显式重试。没有新的线程、重试机制或算法回退。

索引工作新增 4 条真实 SQLite 回归，与 pending、Maintenance、RecallPipeline 共 55/55 通过，ESLint/Prettier 通过。隔离 worktree 全局 typecheck 被其尚未同步的 Main/Agent/Renderer 接线阻塞，错误均位于本次两个文件之外；正式集成仍需在一致主树验证。本修正让文本读取工作集不再同时持有全部待处理正文，但 `scheduleIndex` 的同步全库发现仍可能有总 CPU 开销，单个超长 Revision 也仍需编码器自己的分片。不能据此宣称索引所有生命周期都有固定延迟上界。

## 一致主树验证

2026-09-15 19:33，root 按必要差异集成本项与并行队列/来源改动；`npm run verify:offline` 通过1,280项（134 contract、860 unit/component、286 integration），typecheck、lint、format通过。向量交换函数两处多余非空断言在首次lint失败后删除，不改变算法或已测结果；原失败日志保留。最终桌面、打包和真实长期质量仍由里程碑验收负责。
