# Chat 的记忆形成来源窗口：定向查询提案与实测

状态：已选择并重新实现定向 Run 查询，主树 Chat/Main/schema 已集成；实际 API 回测与候选清理完成。日期：2026-09-15。下文提案与分条件结果保留原实验口径，当前集成结论见末节。

## 结论

`runMemoryEpisode` 为获取当前 Run 和紧邻前一段对话，实际先通过 `ChatRepository.listMessages(chatId)` 读取并验证整个 Chat。10 万条合成消息时，该步骤中位约 469 ms，物化 10 万条对象、约 85 MB 文本；最后只用 4 条。建议增加一个 Chat 仓储方法，在同一同步调用内读取当前 Run、定位其前一条完成消息、再读取该消息所属 Run。两个针对实际查询的索引使读取工作随这两个 Run 的消息量增长，避免全聊天正文物化。实验选中的 F 在相同 10 万条数据上约 0.27–0.30 ms，返回相同 4 条。

这不是一个新的记忆窗口大小选择：不增设条数/token 截断，不修改形成内容、Tool 边界或已接受的语义。长 Run 仍完整保留。它也不解决形成队列吞吐、当前 Run 自身过大、或模型抽取质量。

## 当前实现与必须保持的语义

审查入口与行号来自本次冻结的主仓源码；文件 SHA 见 `source-manifest.json`。

- `src/main/app/runMemoryEpisode.ts:23–39`：取当前 Run items；读取整个 Chat 后保留 completed；在 `(created_at,id)` 排序的消息中找第一条当前 Run 的 completed 消息；取紧邻其前的 completed 消息的 `runId`。
- `src/main/app/runMemoryEpisode.ts:41–60`：取当前与上述 Run 的全部 completed 消息，然后才过滤空白和 Tool 的时间边界。此前 Run 有晚于当前第一条消息的交错回复时，当前实现仍会保留；本次保持这个事实，没有将其擅自改为“只取更早时间”。
- 前一条 completed 消息的 `run_id IS NULL` 时，当前实现**停止于无前 Run**，不会继续向过去找非 NULL Run。空白 completed 消息仍参与选择 Run，之后才去掉空白来源。
- `src/main/chat/chatRepository.ts:391–400`：`listMessages` 以 chat_id 查询，`.all()` 后逐条 `readMessage` / 实际 MessageSchema 验证。`src/main/chat/chatRepository.ts:550–559` 已有 `listRunMessages(runId)`，但缺少 Run 索引。
- `src/main/db/schema/current.ts:408–421`：消息有真实 `FOREIGN KEY(run_id,chat_id) REFERENCES runs(id,chat_id)`；Run ID 全局唯一。因此当前 Run 消息自身足以确定其 Chat，不需要在 Run 查询上再增加 chat_id 谓词。
- `src/main/db/schema/current.ts:1234–1235` 现有 `messages_chat_idx(chat_id,created_at,id)`。它能按 Chat 排序，却不能按 Run 定位，也不跳过长段非 completed 消息。

## 官方依据与版本

以下来源在 2026-09-15 查阅。它们定义 SQL/索引行为，并不规定产品 topK、延迟目标或必选索引。

1. [SQLite Query Planning](https://www.sqlite.org/queryplanner.html)：多列索引从左到右匹配，排序需求与统计信息影响优化器选择，covering index 可避免回表。本实验未额外运行 ANALYZE 或强制 INDEXED BY；以真实 EXPLAIN 为依据。
2. [SQLite EXPLAIN QUERY PLAN](https://www.sqlite.org/eqp.html)：查看 SEARCH 所使用的约束，不仅看是否出现“SEARCH”。`SEARCH ... (chat_id=?)` 在一个 10 万条的 Chat 内仍会检查全部这些消息。官方说明 EXPLAIN 输出格式可随版本变化，因此只保存为诊断证据，不作为产品协议或自动解析契约。
3. [SQLite Row Values](https://www.sqlite.org/rowvalue.html)，页面更新 2025-05-31，语法自 SQLite 3.15.0（2016-10-14）支持：`(created_at,id) < (?,?)` 按字典序比较。两列实际均 NOT NULL，符合定位严格前驱的需求，无 OFFSET。
4. [SQLite Partial Indexes](https://www.sqlite.org/partialindex.html)，页面更新 2022-04-18，自 SQLite 3.8.0（2013-08-26）支持：`WHERE status='completed'` 将未完成消息排除出前驱检索索引；查询使用完全相同谓词。
5. [SQLite CREATE INDEX](https://www.sqlite.org/lang_createindex.html)，页面更新 2026-05-06：未另设 collation 时使用 BINARY。候选数组合并也按字符串 `<` / `>` 比较时间和 ID，不用 localeCompare 替代 SQL 顺序。

本机真实运行：better-sqlite3 **13.0.1**、SQLite **3.53.3**，`sqlite_source_id()` 为 `2026-06-26 20:14:12 d4c0e51e4aeb96955b99185ab9cde75c339e2c29c3f3f12428d364a10d782c62`；Node **24.18.0**，Darwin arm64，Apple M4 Pro，24 GiB RAM。使用实际 `openApplicationDatabase` 当前 STRICT schema、FK、WAL、synchronous=FULL、4 KiB page，未更改数据库调优参数。完整 compile options 随三份数据元信息保存。

## 提议的最小 API 与 SQL

仅新增 Chat 域公开仓储方法，无 IPC/shared 新合同：

```ts
listMemoryFormationMessages(runId: string): Message[]
```

返回按 SQL `(created_at,id)` 顺序排列的当前 Run 与其紧邻前 Run 的 completed 消息，仍包含空白，交由已有形成代码处理。当前 Run 无 completed 消息时返回空，当前 Run 的 Tool 回执仍由原入口独立处理。

单个同步方法内执行：

1. 复用实际 `this.listRunMessages(runId)`，保留 completed。没有完成消息则返回空。
2. 最早完成消息给出 `chatId` 和 `(createdAt,id)`，执行一次前驱查询。
3. 前驱具有非空 runId 时，复用 `this.listRunMessages(priorRunId)` 并保留 completed；否则不继续追溯。合并两组并以 BINARY 对应顺序排序。

已有 Run 读取 SQL 不变，只补索引：

```sql
SELECT id, chat_id, run_id, role, status, content, created_at, updated_at
FROM messages
WHERE run_id = ?
ORDER BY created_at, id;
```

前驱 SQL：

```sql
SELECT run_id
FROM messages
WHERE chat_id = @chatId
  AND status = 'completed'
  AND (created_at, id) < (@createdAt, @id)
ORDER BY created_at DESC, id DESC
LIMIT 1;
```

这里 `LIMIT 1` 是“唯一紧邻前驱”的定义，不是记忆质量 topK 启发式。

建议仅集成实测 F 的索引：

```sql
CREATE INDEX messages_run_idx
  ON messages(run_id, created_at, id);

CREATE INDEX messages_completed_chat_idx
  ON messages(chat_id, created_at, id, run_id)
  WHERE status = 'completed';
```

第二条将 run_id 放在末列是为了覆盖前驱输出，不包含正文。不要建包含 content 的巨大 covering index。现有 messages_chat_idx 继续服务普通完整消息列表，不能因这项优化删除。

`runMemoryEpisode` 的最小接线只将 `.listMessages(run.chatId)` 换为 `.listMemoryFormationMessages(run.id)`；保留后续已有筛选和排序即可保持完全相同的 output/version。实验中的候选 Chat 端口直接将所选数组提供给原始函数，验证了这一接法。长期清理重复筛选可另做，不是本包必需变更。

读取是无 await 的同步方法；当前产品业务写入也在 Main 串行执行。本实验没有考察其它进程同时写 Chat 的情形。不要为本查询新增连接、worker、缓存、后台任务或面向用户的设置。已有真实数据的 schema 升级由根集成 owner 串行实施；本包没有擅自新增 migration。

## 实验设计与公平性

初轮 preregistration/freeze 在执行前保存，追加协议也在 E/F 执行前保存。三个独立合成 Chat 为 **1k、10k、100k 消息**，每 Run 两条，中文正文有长短变化。使用实际当前 RunSchema、MessageSchema 与数据库 FK，源内容自写，无私人消息、holdout 或 Provider 调用。生成器保留每条内容稳定摘要；数据不是只有空行的玩具表。

每个规模测试前四分之一、中段和尾部三个位置。前 75% 中穿插少量未完成消息；最后约 25% 为非 completed，仅最后一个 Run 完成。后者是可成立的资源边界样本，**没有声称其真实用户频率为 25%**。其中“紧邻前 Run”与“Run 编号减一”不同，防止 SQL 靠数据排列碰巧成立。

初轮四条件：A 为实际全历史调用，B 为无新索引的三个定向 SQL，C 仅在 B 上加 Run 索引，D 仅在 C 上加 completed Chat partial index。首轮顺序跨规模交错，每个条件独立进程/同源数据库副本。追加 E 与 C、F 与 D 的索引和数据完全相同，仅改变查询组织；同连接交错先后执行，比较查询形状的单变量影响。

每个目标：保留首次读取、一次预热、8 次 warm 计时。下表为 warm **中位数**；原始逐次样本另存。8 次是资源微基准重复数，非真实用户或独立故事样本数，也不能估计线上 p95。首次读取只是新连接/该目标首次调用，OS 文件缓存未清空，不能称磁盘冷读。

计时包含 actual SQLite `.all()` / `.get()`、正文解码到 JS、实际 MessageSchema 验证和筛选；分列 SQL get/all 用时与其余 JS/prepare 用时。GC 在计时外。输出摘要和正文 byte length 在计时外计算，避免 A 因观察器额外扫描正文而被人为放慢。实际代码运行在 Node 实验进程，**不是打包 Electron 的响应时延证明**，机器上的其它进程也未被停止。

## 结果

A / E / F 为最终产品成本参考；A 与最终 F 是复合实现比较，不把全部收益归因于一个索引。E/F 来自追加阶段；单变量同阶段对比见下一表。单位 ms，每格 n=8。

| 消息数 | A 当前：1/4 / 中段 / 尾部 | E Run 定向，仅 Run 索引 | F Run 定向，两索引 |
| --- | --- | --- | --- |
| 1,000 | 4.157 / 4.301 / 4.207 | 0.175 / 0.191 / 0.235 | 0.153 / 0.156 / 0.141 |
| 10,000 | 40.465 / 40.645 / 40.720 | 0.256 / 0.235 / 0.827 | 0.234 / 0.217 / 0.246 |
| 100,000 | 467.899 / 469.024 / 470.111 | 0.261 / 0.250 / 9.307 | 0.271 / 0.301 / 0.292 |

仅改变查询形状的同阶段 100k 对比：

| 同数据/索引 | 原形状：1/4 / 中段 / 尾部 | 分 Run 查询：1/4 / 中段 / 尾部 |
| --- | --- | --- |
| C → E，仅 Run 索引 | 36.678 / 36.557 / 47.200 | 0.261 / 0.250 / 9.307 |
| D → F，两索引 | 38.676 / 39.550 / 40.766 | 0.271 / 0.301 / 0.292 |

首轮 B/C/D 虽然都只返回 4 个对象，仍未取得预期的寻址成本。100k 三位置 B 为 44.885 / 54.198 / 80.509 ms，C 为 35.521 / 35.493 / 44.392 ms，D 为 37.487 / 39.824 / 40.978 ms。实际原因：最终 `chat_id + run_id IN(...) + ORDER BY` 让优化器选 messages_chat_idx，先检查整个 Chat；D 的第一条当前消息查询也选择了 completed Chat 索引。增加索引本身没有解决不合适的查询形状；这些结果完整保留，没有只公布较快条件。

最终 F 的计划为：

```text
SEARCH messages USING INDEX candidate_messages_run_idx (run_id=?)
SEARCH messages USING COVERING INDEX candidate_messages_completed_chat_idx
  (chat_id=? AND (created_at,id)<(?,?))
```

E 普通位置和 F 接近；E 在非完成尾部逐条跳过大量消息，100k 为 9.307 ms。F 的 partial index 避免这项与失败尾部长度相关的扫描。本次建议 F 的依据是这个结构性差异及较小的一次性索引成本，不是将 0.25 与 0.30 ms 的噪声差异解释成某个条件“质量更高”。

100k 中段的物化成本：

| 指标 | A | F |
| --- | --- | --- |
| 实际 Message 对象 | 100,000 | 4 |
| 读取正文 UTF-8 字节 | 84,988,132 | 2,642 |
| SQL get/all 中位 | 310.353 ms | 0.132 ms |
| 非 get/all 部分中位 | 158.308 ms | 0.164 ms |
| 总耗时中位、观测 min–max | 469.024 ms，460.440–477.468 | 0.301 ms，0.231–0.373 |
| 调用前后 heapUsed 增量中位 | 115,619,188 B | 27,436 B |
| 调用后进程 RSS 中位 | 360,538,112 B | 98,287,616 B |

SQL/非 SQL 各自中位相加不必恰好等于总耗时中位。heap delta 是该调用的分配信号，不等同保留堆；RSS 包含 SQLite cache、运行时和此前查询，两个条件的进程历史不同，不能将 RSS 差值精确解释成每次调用释放的内存。没有宣称进程峰值或硬件能耗已完整测量。

索引成本（100k）：Run 索引 **10,805,248 B**，completed covering 索引 **10,883,072 B**；数据库由 **245,833,728 B** 增至 **267,522,048 B**，增加 **21,688,320 B（约 20.68 MiB / 8.82%）**。首轮构建 C 索引 91.366 ms，构建 D 两索引合计 155.276 ms。这里只测了创建成本和 dbstat 空间，**没有独立测持续 INSERT/status-update 的写放大或升级首启 UI**。这两索引会增加写入维护；产品接线应在现有 schema 升级和 Chat 集成回归中验证，不引入运行时备选条件。

## 正确性与失败保存

3 规模 × 3 目标 = **9 个独立数据查询**。初轮与追加总计 **720 次测量输出**（含 warmup/first read）与 A 完整 Message 数组 SHA 一致；这不是 720 个独立质量样本。

另有 **12 组真实 SQLite 夹具**及一个 Tool-only 变体，比较候选与原始 `runMemoryEpisode` 的完整输出，包括来源内容、顺序、`evidenceSourceIds`、`recordedAt`、version；同时检查写定的 source IDs 和 FK。覆盖：无 current completed、第一 Run、同 timestamp、前一 NULL run、空白前文、非 completed 前文、当前多条、Run 交错、Tool through 时间边界、另一 Chat、voice来源、单 Run 257 条无截断。全部通过。候选正确性端口仅替换 Chat 读取，实际 RunRepository 从 SQLite 读取 Run/items，不伪造来源内容。

首次夹具运行因外部构造的 RunItem 漏必填 `artifacts` 被真实 schema 拒绝，未进入该条比较。保留 `correctness-v1.mjs`、`correctness.sqlite` 与 `correctness-v1-failure.json`；修正夹具为 `artifacts: []` 后在新的 `correctness-v2.sqlite` 重跑成功。汇总脚本曾有一个在执行前即报错的括号语法笔误，修复后才读取结果；它不修改任何原始测量。

## 接线范围与未验证项

若根 owner 采纳：仅需 ChatRepository 的一个公开同步方法、两条索引的真实 schema 升级、`runMemoryEpisode` 一行入口接线，以及 Chat/Main 来源形成回归。将本次小型语义夹具按产品测试约定改写为无条件分支的 regression；不要将 A–F 候选或 runner 放入生产仓库。

没有测试 Electron/package/E2E，没有用真实用户数据库，未运行模型，没有建立 100 万条表、多人并发或含超大单 Run 的内存上界。既有单 Chat 内消息全量显示仍调用 listMessages；本次仅解决 **记忆形成来源读取**。若产品希望“只允许当前第一条消息之前的前文”，那是另一个明确的语义修改，不能悄悄混入性能优化。

复现标识和文件：`source-manifest.json`、两个 freeze、三份 messages 元信息、12 份初轮 result、6 份 query-shape result、`aggregate.json`、`correctness-result.json`。所有数据库、runner、原始结果均在外部 evidence；生产源码零修改。


## 主树集成与复核


2026-09-15；这是实际生产源码回测，不是继续运行候选 F。实际 `ChatRepository.listMemoryFormationMessages(runId)`、已接线 `runMemoryEpisode` 和两条生产 DDL 均从主仓重新打包到独立 Node 进程。生产 bundle / runner 在运行前冻结于 production-freeze.json；本包不改生产源码。

## 结果

三份冻结原始 SQLite 分别复制为 production-*.sqlite，新 schema 仅初始化副本，原始数据库不变。检查只有 messages_run_idx/messages_completed_chat_idx 等正式索引，没有 candidate/correctness 索引。每个规模 3 目标 ×（首次、预热、8 次warm），共 **90 次**实际 API 输出与旧版冻结数组摘要一致。warm中位（ms，每位置n=8）：

| 消息数 | 1/4位置 | 中段 | 非完成尾部 |
| --- | --- | --- | --- |
| 1,000 | 0.139 | 0.117 | 0.129 |
| 10,000 | 0.127 | 0.136 | 0.128 |
| 100,000 | 0.165 | 0.135 | 0.123 |

实际 EXPLAIN 为按 `messages_run_idx(run_id=?)` 定向读 Run，前驱为 `messages_completed_chat_idx(chat_id=? AND (created_at,id)<(?,?))` covering SEARCH。每次仅返回4条消息；100k中段heap增量中位27,584B（约26.9KiB）。10万条副本初始化（包括打开数据库/DDL）160.253ms。两索引分别10,805,248B与10,883,072B。此次独立单形状进程未交错旧查询，因此比前一轮约0.30ms更低的绝对值不被解释为新的算法收益；首次读取仍不是OS冷缓存。

**12组完整来源语义＋1个Tool-only/无Tool变体通过**：使用真实 ChatRepository、RunRepository、SQLite 和新 runMemoryEpisode；与冻结旧入口逐字段比较完整输出，并校验已保存的expected source IDs/version。原始Tool时间界、voice、NULL前驱、空白、同timestamp、交错、另一Chat、257条当前Run无截断均保持；FK检查通过。原有夹具失败证据仍保留。

本次未运行Electron、package、Provider或整仓回归；Root负责获选路径的正式无Arm回归与全域验证。新API没有Candidate开关、调参UI或第二套生产实现。

## 清理和复现

已删除外部活跃目录中的22份脚本/bundle/失败夹具数据库，并将这些文件逐项验证后收为一个只用于复现的外部源码归档；已删除12份可从基线重建的条件数据库副本，释放1,135,886,336B；移除本目录node_modules软链接。保留冻结输入、所有原始结果/协议、原始数据DB、成功语义夹具和实际生产回测DB。没有删除实际依赖目录，没有进入Main构建目录。外部活跃目录无可执行候选文件，生产路径不包含这些实验。

外部复现源码归档：`query-reproduction-archive.tar.gz`，SHA256 `a2578e4e2610cabe4a1e5fea6e8caedc16647b3fe3e99bec0412298fd6914923`，140,530B。旧manifest中的源文件现从该归档按原文件名取出；归档成员bytes与删除前SHA逐个一致。`cleanup.json`记录完整迁移/删除清单和生产源码SHA。需要复现时应在新的临时目录解包并连接官方既有依赖，不把候选恢复进生产仓库。

结果：`production-result-{1000,10000,100000}.json`、`production-correctness-result.json`、`production-freeze.json`、`cleanup.json`。这次清理没有删除任何失败结果或修改冻结统计。

主树正式产品回归为 `tests/integration/runMemoryEpisode.test.ts`，7项覆盖逐条渠道/用途、NULL边界、空白/未完成消息、交错同时间消息、257条无截断、Tool-only与真实截止。没有复制A–F条件或候选适配器。连同Chat数据、数据库、Agent和Voice共114项集成通过（1.80s），typecheck通过。新索引由现有统一schema初始化在真实升级后安装，没有增加版本分支；没有操作用户数据库。整仓离线与最终打包验收由STATUS分别记录。
