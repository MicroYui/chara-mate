# MEMORY-STORAGE：SQLite journal、写入与维护策略

> 2026-09-16 当前状态：本记录的 WAL/FULL 选择继续生效；下文“dense 尚未晋级、无向量工件”是 2026-08-08 阶段边界。Main v21 已按 LOCAL-MEMORY-ENCODER 与 MEMORY-VECTOR-EXECUTION 接入同库向量投影、4B/512 和单一 Worker；未新增数据库或 journal 模式。原存储比较不因此增加模型质量或并发验证分母。

## 问题与决策边界

本 Decision 只选择 CharaMate 的关系型 metadata journal 与最小维护策略。向量字节和计算位置只有在 `MEMORY-RETRIEVAL` 证明 dense lane 值得晋级后才触发；若最终检索不使用 dense，则不创建向量表、segment、worker 或本地服务。

协议硬限制、来源行为和产品启发式分开处理。SQLite 的事务、foreign key、journal 语义是来源事实；本实验的负载规模与 `16 ms` 交互帧时间只用于解释桌面可感知性，不是自动否决线。产品定案同时考虑写入/读取延迟、磁盘、恢复、实现与维护成本；若机械门槛与综合选择不同，保留原结果并写明 amendment。

## 一手来源与环境

- 执行日：2026-08-08；基线 commit `d539dff367a5e8af544d6dcf28e1112e8311d63b`；`package-lock.json` SHA-256 `e4579634f5977e833b9aafa5379fc6ef76ec05f4eb2f338690fab09d5b9c426b`。
- `better-sqlite3@13.0.1` tag commit [`13625aa`](https://github.com/WiseLibs/better-sqlite3/tree/13625aa88646df36c55b5405be890841037c5735)，随包 SQLite `3.53.3`；目标机 Apple M4 Pro、24 GiB、macOS/Darwin `25.6.0`、Node `24.18.0`、npm `11.16.0`。
- SQLite 官方 [WAL](https://sqlite.org/wal.html)、[PRAGMA journal_mode](https://sqlite.org/pragma.html#pragma_journal_mode)、[PRAGMA synchronous](https://sqlite.org/pragma.html#pragma_synchronous) 是 journal、checkpoint 与 durability 语义来源。官方 WAL 文档所列多连接损坏问题已在 SQLite `3.51.3` 修复；本次 `3.53.3` 不受该已知版本问题影响。

## 预注册设计

### Arms

| Arm | journal | synchronous | 角色 |
| --- | --- | --- | --- |
| `J0-DELETE-FULL` | rollback `DELETE` | `FULL` | 当前简单基线 |
| `J1-WAL-FULL` | `WAL` | `FULL` | 只改变 journal |
| `J1N-WAL-NORMAL` | `WAL` | `NORMAL` | durability/延迟诊断，不与 J0 冒充单变量配对 |

每个配置使用全新数据库并重复 5 次。逻辑数据、准备语句、事务边界、顺序和随机种子相同；只改变表中配置。负载包含 25,000 条 Chat/Run 小写入、100,000 条 Activity Event 批量写入、10,000 条 Memory/Revision 写入及读查询。记录每事务 p50/p95/p99、同步阻塞、主库与 sidecar 字节、WAL passive checkpoint、关闭重开、`integrity_check`、`foreign_key_check` 和逻辑行数。

### 选择规则

数据不一致或无法重开属于正确性红线。其余数值只作证据：若多个 Arm 均远低于可感知阻塞且吞吐差异不影响产品，选择状态和维护更少的 Arm；只有 WAL 的延迟/并发收益在目标负载下有实际意义时才承担 sidecar/checkpoint 生命周期。最终报告点估计、离散程度、磁盘与复杂度，不因自定 p95 门槛单项机械淘汰整体更优方案。

## 结果

15 次运行（3 Arms × 5 repeats）全部通过 `integrity_check`、foreign key、预期行数与关闭重开校验。下表是五次运行的中位数；括号为该指标五次的最小值–最大值。

| Arm | Chat p95 / 总时长 | Activity p95 / 总时长 | Memory p95 / 总时长 | Read p95 | checkpoint / reopen |
| --- | --- | --- | --- | --- | --- |
| `J0-DELETE-FULL` | 0.348 ms（0.340–0.423）/ 691.1 ms | 0.653 ms（0.584–0.687）/ 262.4 ms | 0.369 ms（0.331–0.413）/ 291.7 ms | 0.121 ms | 0.0002 / 1.480 ms |
| `J1-WAL-FULL` | 0.073 ms（0.069–0.078）/ 122.2 ms | 0.285 ms（0.272–0.296）/ 132.6 ms | 0.073 ms（0.071–0.086）/ 58.1 ms | 0.116 ms | 0.763 / 1.882 ms |
| `J1N-WAL-NORMAL` | 0.030 ms（0.030–0.031）/ 57.4 ms | 0.237 ms（0.230–0.245）/ 112.4 ms | 0.045 ms（0.043–0.046）/ 36.1 ms | 0.118 ms | 1.548 / 1.969 ms |

三者关闭并 checkpoint 后主库均为 `12,595,200` bytes；没有残留 journal/WAL/shm。所有事务 p95 均远低于一帧时间，因此这里没有“过线/不过线”的机械淘汰。相对 DELETE/FULL，WAL/FULL 的 Chat、Activity 与 Memory 总写入时间中位数分别减少约 82%、49% 与 80%，读取基本相当；被动 checkpoint 的亚毫秒到约 1 ms 成本不在交互热路径。WAL/NORMAL 继续降低小事务等待，但没有改善读取或体积，且改变 durability 语义。

原始非敏感证据为 `storage-raw.json`，SHA-256 `94d798a4bd3ab687c867acc147a90ad62d3c121aa6e22d1c2a100c3d4eb51aad`。其中保存每次 repeat 的 p50/p95/p99、总时长、checkpoint、重开、文件字节、完整性和逻辑行数；仓库不依赖本机绝对路径理解结果。

## 综合定案

选择 **`J1-WAL-FULL`**：它已取得对桌面混合写负载有实际意义的时延收益，同时保留本次范围内最强的 SQLite durability 语义。`J1N` 的额外速度真实存在，但三项方案都已经远离用户可感知区间，当前没有业务收益支持用它交换 durability；这不是因为某个自定 p95 门槛。

生产使用 SQLite 默认 WAL autocheckpoint，不增加自定义 checkpoint job、busy timeout 档位或 Settings 控制。后续 Activity 使用显式事务批量提交；长清理与重建不进入交互事务。当前 Retrieval 尚未证明 dense lane，因此 vector/compute 阶段暂不触发；若 dense 最终未晋级，本 Decision 即以“无向量工件”闭合。

候选数据库和一次性 runner 在结果 hash 核验后删除；生产只写入 `journal_mode=WAL`、`synchronous=FULL` 这一条路径，不保留 DELETE/NORMAL 分支或 feature flag。

## 限制

- 负载覆盖目标机上的单进程 Main 写入和典型批量，不声称代表多主机网络文件系统或所有磁盘故障模式。
- 本阶段没有并发多进程 writer；CharaMate 当前架构也没有该产品需求。
- SQLite 的同步语义来自官方文档；本实验只能说明目标环境中的性能与逻辑恢复，不能把正常关闭重开夸大为掉电证明。

## 2026-09-18：十万条准备暴露索引调度阻塞

最终v6容量准备使用原固定20k Memory/100k Revision、100k Activity和500 pending Formation。2026-09-17 19:50:19 UTC开始，19:51:13进入scheduleIndex后主进程一直没有下一次回调，也没有启动4B。19:56:03发给自有监督进程的SIGINT无法让同步Main处理取消；19:57:29仅强制终止该Main，父进程19:57:29.998以exit1结束，总430.426秒。原DB、WAL、结构前态和首条进度保留于`integration/combined-100k-arrival-replay-source-v2-execution-prep-v1/execution-source-v6-01`；这不是正常关闭、索引完成或十分钟到达实验结果。

同日复核SQLite官方[EXPLAIN QUERY PLAN](https://sqlite.org/eqp.html)及[查询优化说明](https://sqlite.org/optoverview.html)，实际随better-sqlite3运行SQLite3.53.3。旧JOIN被优化器从memories_list_idx驱动，再按memory_id读取revision，每取下一条都出现TEMP B-TREE排序，且整个循环在Main同步事务中。诊断同一合成100k库的旧查询前三行分别约26.5/27.3/27.8毫秒；旧全量实际已阻塞，不为比较再次运行，也不按前三行外推完整加速倍数。

修复保留原Memory工作表与索引版本语义：按revision主键有序范围读取，关联资格使用EXISTS；只返回仍缺索引且未已有pending/running/failed任务的revision，或仍有自身pending-model占位的项。单条短事务创建工作并删除自己的占位，然后让出事件循环；每轮检查取消，Pipeline等待调度完成后才启动编码器。中途新建且排在游标之前的revision保留占位供下轮处理，不用全局DELETE丢掉它；只有已被当前合法purge删除的孤儿占位单独清理。失败仍需显式retry，complete但向量缺失仍可重建。不加表、索引、状态、worker、任意批次阈值或旧库兼容分支。

同一固定合成100k、SQLite3.53.3、WAL/FULL的一次完整诊断：调度13.130秒、100000次短事务、100003个事件循环回调，最大间隔60.24毫秒，100k工作均pending且内容hash零差异；next查询使用revision主键id范围，无临时排序。已有100k完整索引再新增唯一revision：144.92毫秒、只返回1项/2次get/1次事务；最大回调间隔144.91毫秒，其中首次全集资格扫描138.82毫秒。后者仍是实际同步成本，不能宣称完全无阻塞。这些合成库没有调用编码器，且旧全量并无可比较完成时间；最终原100k真实4B准备和2403到达/600000ms测量仍待执行。候选与原失败/精确版本记录在`integration/memory-index-scheduling-cursor-v1`；相关回归和Main集成状态以最终交接及STATUS为准。

## 同一原负载的实际完成结果

2026-09-17 20:40:31.692–23:27:20.375 UTC，v8 原前态的真实 Qwen3-Embedding-4B 索引准备正常关闭；编码/索引阶段10003.784秒，100000 Revision、chunk、embedding及完成work逐项计数一致，原500形成work前后仍全部pending。没有远端生成或导入合成向量代替此次索引。

随后原600秒到达窗完整接收2400 Activity与3条消息，三条消息均按有限建议、暂停和重新邀请的要求回答，进程和全部owner正常关闭。Main采样RSS最高1023.266MiB，Main及后代RSS之和最高3.492GiB；这是5秒采样且共享页会重复计，不是物理内存/GPU峰值。到达迟到p50 1.917ms、p95 764.702ms、p99 1312.555ms、最长2555.245ms；Main事件循环分段最大2659.189ms，短时尾延迟真实存在。没有采样栈、SQL与GC分段，不能把相关性当根因，也不能全部归因于4B或观察器。

窗口最终form205 complete/309 pending、reconcile2 complete/5 pending、embed100006 complete；形成分母含14个新增work，不用205/500冒充历史完成率。原502及关闭取消保留，pending和来源按已有持久队列恢复合同保留；该固定窗口不要求清空队列，没有增加drain或新跨日实验。完整索引不意味着十万内容语义正确，部分最新进展尚未进入Memory，当前Chat/会话/Cognition已保存。

证据为同一 `combined-100k-arrival-replay-source-v2-execution-prep-v1` 的 `PREPARATION.json`、两个执行回执及 `SEMANTIC-REVIEW-FINAL-V8.md`、`RESOURCE-REVIEW-FINAL-V8.md`；输入SHA `14570806…`、生产冻结`348d74ee…`。这些实际结果补全本轮容量范围，旧SIGKILL失败不删除。本地交付接受已测高积压下的短时尾延迟与异步形成边界，不宣称无卡顿、实时全量理解或任意规模成熟度。
