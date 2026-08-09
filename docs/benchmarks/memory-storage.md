# MEMORY-STORAGE：SQLite journal、写入与维护策略

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
