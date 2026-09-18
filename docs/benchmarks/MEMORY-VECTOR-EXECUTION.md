# 本地向量扫描的执行位置

Decision ID：`MEMORY-VECTOR-EXECUTION`。日期：2026-09-15。选择：单个常驻只读 SQLite Worker 执行当前精确余弦扫描。本文只决定执行位置，不决定 embedding、维度、融合、候选数或 ANN。

## 问题与来源

记忆检索不能在 Electron Main 上连续扫描大量向量并阻塞窗口、IPC 与取消响应。来源核对于 2026-09-15：

- [Node.js 24 Worker 文档](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html)，当日页面版本 24.21.0，实测运行时 24.18.0。Worker 可并行执行 JavaScript，适用于 CPU 密集计算；支持 ArrayBuffer 转移和 SharedArrayBuffer 共享。文档建议复用 Worker，避免逐任务创建成本。
- [SQLite WAL](https://www.sqlite.org/wal.html) 与[隔离语义](https://www.sqlite.org/isolation.html)：同机独立读连接可以与写连接并存；一次读事务持有一致快照，后续查询才能看到新提交。本文不更改现有 journal、checkpoint 或同步等级。
- [better-sqlite3 13.0.1 API](https://github.com/WiseLibs/better-sqlite3/blob/v13.0.1/docs/api.md)：同步查询和迭代不会自动让出事件循环；事务回调不能跨越 async。当前代码的 `MemoryRecallRepository.vectors` 流式读取向量，`searchMemoryVectors` 用有界堆保留结果，但若由 Main 调用仍会阻塞。

协议没有规定 Worker 数、行数、候选容量或延迟指标。单个串行 reader 是本产品当前避免重复连接和并行全表 I/O 的实现选择，不能称为理论最优。

## 实验与可复现边界

同一 Apple M4 Pro、14 logical CPU、24 GiB，Node 24.18.0、better-sqlite3 13.0.1。实际 Application SQLite schema、WAL/FULL；同一 `MemoryRecallRepository.vectors` 和精确扫描函数。同规模输入只改变 Main / Worker 执行位置，比较返回结果及 Main 事件循环延迟。每组 3 次；先 Main 后 Worker，没有随机化冷热 cache，因此扫描速度差不用于证明算法加速。

合成输入有 10,000 / 100,000 条 4,096 维 Float32 向量，查询分量为 `(index % 97 + 1) / 97`，每行按确定性规则改变一个分量。候选容量 125 由当时上下文分配的最小证据成本推导，仅为相同实验负载。直接写入数值 fixture，绕过形成和 FTS，不能据此评价记忆质量。

本项是性能诊断后作出的工程决定。执行前没有独立冻结的数值晋级阈值，不能包装成预注册确认性研究；保存输入公式、环境、原始结果和同算法输出一致性，选择依据是已经观察到的 Main 阻塞及更简单的单一解决路径。

| 向量条数 | 执行位置 | 扫描中位耗时 ms | 每次 Main 最大事件循环延迟范围 ms |
| --- | --- | ---: | ---: |
| 10,000 | Main | 461.8 | 454.8–469.8 |
| 10,000 | Worker | 449.4 | 1.58–2.72 |
| 100,000 | Main | 6,410.8 | 6,102.7–7,226.8 |
| 100,000 | Worker | 5,232.4 | 1.61–3.97 |

每行分母均为 3；报告全范围，样本不足以估计可靠总体 p95 或置信区间。同规模全部结果顺序与内容 hash 一致。100,000 条原始向量占 1,638,400,000 bytes，实验 SQLite 占 1,799,561,216 bytes，不含实际长期对话、来源和全文索引。读取是流式的，不把 1.64 GB 一次性装入 JavaScript 数组。

## 单一实现与回归

Main 完成数据库迁移后创建 `MemoryVectorSearchWorker`。同一常驻 Worker 使用只读连接，逐块扫描并检查原子取消标记。查询向量先复制再 transfer，调用方 buffer 不被 detach。串行队列避免多个大扫描争抢 I/O；关闭会取消当前扫描并拒绝后续工作。进程异常使本次请求失败，下次仍重建同一种 Worker，不回落到 Main 扫描。

实际生产端口 smoke 验证：第一查询返回 1 条；Main 在 WAL 提交第二条后，同 reader 下一查询返回 2 条；余弦为 1 / 0；预取消拒绝；原查询 buffer 保留。聚焦测试覆盖有序排队、运行中取消、退出与同路径恢复。Main 集成还必须在最终打包后验证独立 `memory-vector-search.mjs` 和 native SQLite 可以加载，不能用 Node smoke 替代 Electron 证据。

实验 runner、合成数据库和逐次结果在仓库外 evidence archive。生产只保留 Worker 路径与同一个扫描算法；算法本身的 focused tests 是生产函数回归，不包含 Main/Worker Arm 开关。未引入 ANN、第二数据库、外部向量服务或 UI 调参。

## 当前 512 维实现的容量与生命周期复核

2026-09-17，在共同源 `c62d0fab56b8c5c7fafffb67483c413bc83c3fc0e74b5d21bed097e9b54c4d5e` 上重新执行单域容量链，实际 Node 24.18.0、SQLite 3.53.3、M4 Pro / 24 GiB。使用已经选定的 Qwen3-Embedding-4B Q4_K_M、512 维；本节验证当前实现，不重新选择维度或扫描算法，也不将其与上面的旧 4096 维结果作因果加速比较。

正式输入为 1k / 10k / 100k **Revision**，分别归属 200 / 2000 / 20000 个 Memory；20% Memory 持有65%的版本，最大版本深度17。数值向量和正文是结构夹具，不能评价语义检索质量。每规模四种范围各执行一次 first 和七次 warm，共96次主读。包括写入、取消、编码、释放和重开在内共126次 search，其中3次是预期取消；六个 measure/reopen 子进程均正常关闭，正式父墙钟43.513秒。另一次1k接线的32次主读、42次search、两次编码与3.345秒单列，不混入正式分母。

| Revision | 查询范围 | 实际扫描行 | first ms | 七次 warm 中位 ms | warm 范围 ms |
| ---: | --- | ---: | ---: | ---: | --- |
| 1,000 | 全域当前 | 200 | 82.732 | 1.997 | 1.659–4.031 |
| 1,000 | 全域含历史 | 1,000 | 8.905 | 5.747 | 5.717–6.288 |
| 10,000 | 全域当前 | 2,000 | 92.449 | 12.710 | 11.976–17.260 |
| 10,000 | 全域含历史 | 10,000 | 108.367 | 93.605 | 85.486–102.177 |
| 100,000 | 全域当前 | 20,000 | 284.253 | 204.845 | 191.223–225.879 |
| 100,000 | 全域含历史 | 100,000 | 1064.610 | 883.156 | 871.959–1042.672 |

100k 的实体当前/实体含历史分别扫描1/17行，warm中位45.339/86.417ms；完整12组原值见仓外聚合记录。每组查询前的行计数已预热页面，first不是冷磁盘；同规模复用Worker，第一组还含初始化成本。仅七次warm不足以估计总体p95。20ms采样的Node/Worker RSS峰最高516.52MiB；10ms事件循环采样各组最大值不超过15.385ms，窗口包含运行器结果写入，短组没有采样不能记作零。这些数值不是实际Electron响应或独立encoder内存。

三规模均在真实Worker首行后暂停，实际Repository.create与index CAS于同一查询iterator关闭前提交，首读保留旧快照、下一读包含新增Revision。无暂停的1k/10k也实际重叠；100k的index提交115.135ms晚于iterator关闭101.162ms，保持 `not_exposed`，不补跑替换。三次取消均收到该requestId的AbortError并关闭iterator，随后同一owner查询成功。21次Worker close、三次encoder shutdown、六次DB close均收口；新PID核对引用、正文摘要、排序、两条新增Revision和外键一致。

六次真实query编码返回有限512维向量，三规模两次编码分别为689/69、686/66、1303/67ms；这些查询面对数值语料，只证明编码器到Worker接通。原111,000份canonical body释放后，quote/span/Revision/vector及下一查询保持；100k释放11.023秒来自仓外逐条release、每100条让出的机械循环，没有活跃Cognition消费者，**不是App三域维护或Main连续阻塞结果**。100k最终DB约850.80MB，释放形成可复用空闲页，未使文件立即缩小。

证据：`integration/final-memory-capacity-v1/formal-current-01`；构建manifest `d68e5c7c4a2a1c25f95079508cd7c864f84ba3ab80336ba14254a6deecaacdc7`，资源manifest `91ce0c2d8d1b46fe215042471692db477d607dcdb74c45f54b2aa6c4763cd8b3`，独立聚合 `303eee83dff6868b20ae645be521262815944c131b61f7f5777b2e0d703593ed`，独立报告 `fbe7d805f677f85cc262da55c6078b149118fa9f65183de6ea87cf30d02eafc6`。没有增加生产阈值、模式或候选依赖；运行器与数值库仍在仓外。

## 尚未解决

历史4096维实验的一次问题需约5–7秒；当前512维结构查询结果见上节，多个问题及排队仍会增加等待。Worker解决主线程阻塞，不等于解决所有检索延迟。是否需要ANN继续由真实语义质量和较大规模证据决定。当前单域容量结果尚未覆盖App三域退休竞争、Voice/前台Run/UI同时运行、强杀恢复或自然语义质量，也不证明多用户并发、数年记忆质量或长期资源表现。

证据标识：环境清单 SHA-256 为 `078fdcf95896637044c58ea1e7660fb9df835b403793b6d17115285a53c4a054`，逐次结果为 `fb06ba5aad97c72a2f5a0326c3ef0072605a8b6937f18bf354ad3601f501cc90`，生产端口 smoke 为 `d8dc34282f01bc9e1a37155203c9d70957e5836659e9635aa12a66ea99e06e3d`。结果返回 hash：10k 为 `75812a00f0865956d5ef3820674a0806f580a41e0c28d6cd604a7416246a4fc5`，100k 为 `2ccfb024f06bcf350130325c6e38d1b0670151a5f6dfe21de20c515a1f4d89bb`。
