# COMPANION-MEMORY-SOURCE-STORAGE — 原始来源单份持久化与窗口形成

状态：2026-09-15，已完成Main同数据库outbox接线、旧版来源保留与删除边界回归；Main完整离线1,338项通过，桌面及打包待重跑。产品选择为唯一 canonical 原文块 + 有序来源引用 + 按预算生成当前形成片段；不保留全文 payload 算法或运行时切换。

## 产品问题与范围

开放断言和情节闭合会多次引用同一段真实消息、工具回执或 Activity 原文。原实现每个 `memory_work.payload_json` 都保存完整 sources。若第 k 次工作重用前 k 条原文，正文副本累计为 n(n+1)/2。仅将 pending `.all()` 改成一次一个 `.get()`，仍不能避免单个巨大 Episode 的整段正文物化和反复序列化。

此次让 canonical 六字段在 Memory 中保存一次；工作只记 persona/situation 等元数据及来源 ID、顺序和主材用途。形成阶段读取当前片段需要的原文窗口，提交后保存原文偏移，重启从该处继续。普通用户不管理这些引用、块或参数。角色依据、人工修订优先级、真实引文、旧回执和召回规则保持各自已有合同。

本记录不宣称队列所有容量问题已经解决：持续累积的来源引用仍可能 O(n²)，不同 key 的显式 `record` 与后台形成仍有调度问题，处理器升级时已有 partial 的协调也属于后续 Q3。未增加自动付费重试、年龄删除或全局 seen-source 跳过。

## 一手依据与版本

- `better-sqlite3` **13.0.1**，Node **24.18.0**，实际依赖与安装源码于 2026-09-15 核验。[官方 API v13.0.1](https://github.com/WiseLibs/better-sqlite3/blob/v13.0.1/docs/api.md)规定同步 transaction 的使用方式；`.get()` 返回后语句结束。没有把跨模型 await 的 `.iterate()` 当作有界安全替代。
- [SQLite Isolation](https://www.sqlite.org/isolation.html)，2026-09-15读取：同一连接在一个 SELECT 仍执行时修改其读取对象，其后续可见行为不应被依赖。[WAL](https://www.sqlite.org/wal.html)解释长读快照与 checkpoint 的关系。本包未调整 WAL 参数。
- 安装的 SQLite amalgamation **3.53.3**，source ID `2026-06-26 20:14:12 d4c0e51e4aeb96955b99185ab9cde75c339e2c29c3f3f12428d364a10d782c62`。实际 `sqlite3.c` 的 `substrFunc` 对 BLOB 调用 `sqlite3_value_blob`；对一般溢出列，VDBE 会先载入完整值。`length`/`typeof` 等特殊优化不能推广给 `substr`。因此 SQL 返回短字符串不证明原生内存仅加载该窗口。[SQLite 核心函数文档](https://www.sqlite.org/lang_corefunc.html)是函数语义依据，原生装载行为依据此次安装源码和实测。
- [SQLite Row Values](https://www.sqlite.org/rowvalue.html)，页面更新2025-05-31，2026-09-15核验：复合游标可使用 row-value comparison。Q1已证明 `(updated_at,id)>(?,?)` 可利用完整索引。此处 primary 使用 `(work_id,ordinal)` 主键范围；context 保持时间降序/ID升序，用“同时间下一个ID，否则更早时间首项”两次短 seek，避免混合排序方向下 OR 前缀重复扫描。

协议硬约束、库行为和本机选择分开：用户要求单次最终输入不得超过 **258000 token**；这不是磁盘持久量上限。本包的 source working-set 计价是现有闭合 plaintext 形状的保守字节启发式，不是 tokenizer，也不取代 Provider 对最终 instructions/input/tools/schema/多模态 payload 的守门。64 KiB 是本机容量/读取权衡，不是 SQLite 或模型协议规定。

## 预注册输入与环境

协议、输入、候选和原始结果均放在仓外 `evidence/memory-queue-candidates`，主仓只保留本中文 Decision 与获选实现/回归。没有调用模型或外部生成服务。

机器为 Apple M4 Pro，24 GiB物理内存，macOS Darwin25.6.0，arm64。各资源窗与其它模型/向量负载错开；重复次数为固定3次，不报告总体 p95 或统计显著性。

单大 Episode 输入 `q2-input-long-1.json` SHA256：`a8eb8b81c34346ad0f690df52d454011d754e05520ea1cd5f18c92fe9bf2dfe0`。含4160条来源、64条主材、33,672,800 ASCII正文内容字节。来源工作集预算16000，原选择结果7段。源 ID、原文、主材集合和顺序固定，标签不是预算分数产生。另有8个小故事×4种预算共32例，包括中英文、引号/反斜杠/控制字符、astral字符和孤立代理项。

## 逐阶段结果

### 1. 正文去重本身不足以解决大 Episode

同一情境累计500次更新，500条唯一原文517,890字节，累计125250条引用。原完整 payload 数据库约199.44MB；最初 canonical TEXT 候选约46.24MB，写入时间原5.71–6.09s、候选4.17–4.34s。独立500个工作没有正文重复，canonical TEXT 增加引用开销和写入成本（约2.404MB→2.384MB，但写入约76–78ms→104–108ms），不能只展示累积重用受益案例。原始结果36行均保留；其中最后一条可能与0.59s夹具准备重叠，未用于精确优势宣称。

这一 TEXT 候选仍重建全部 sources。33MB大 Episode 的一次初测显示，物化约35–47ms，而反复完整序列化分段耗16–17s。后续同输入、三个独立进程重复的基线分段耗13.92–14.44s。问题来自算法的重复工作，不是单凭数据库换表能消除。

### 2. 相同输出的增量计价与惰性片段

缓存不变来源元数据并增量计价，三次分段耗1.320–1.349s；保留全文输入但惰性给出第一段，首次约253–258ms，处理全部约1.35–1.39s。原7段内容/窗口/coverage完全相同。但该阶段仍持有完整33MB正文；若持续同步消费generator，主线程仍阻塞约1.4s。此中间结果已经明确标为不解决完整工作集问题。

### 3. TEXT/BLOB窗口编码与原生装载诊断

先做 TEXT 与 UTF-16LE BLOB 的固定窗口比较：ASCII下 TEXT 容量小，混合CJK/astral下 BLOB 有利于直接使用现有UTF-16引文偏移。保留了一次切开代理对导致的 oracle 不匹配和一版对 TEXT 不公平的前缀映射成本，二者均不是可用的胜出证据。

安装源码表明普通 `substr` 仍可能读取整值；因此随后使用干净进程，只持有窗口坐标和小哈希 oracle，不持有完整原文。

同一33,554,466字节UTF-16LE原文，读取前/中/后三个16000 UTF-16单位窗口，每种布局3次：

| 唯一正文布局        | VACUUM后DB字节 |    三窗口总时长 |          RSS增加 |
| ------------------- | -------------: | --------------: | ---------------: |
| whole BLOB + substr |     33,595,392 |   13.47–21.52ms |   32.89–33.00MiB |
| 8 KiB块             |     35,663,872 |     1.07–1.38ms |     0.84–1.02MiB |
| **64 KiB块**        | **33,824,768** | **1.04–1.23ms** | **1.12–1.17MiB** |
| 256 KiB块           |     33,632,256 |     1.66–2.63ms |     1.86–2.64MiB |

12/12读取窗口哈希相同。64 KiB相对8 KiB节省约1.84MB布局空间，相对256 KiB减少窗口读取内存；固定3次没有说明总体延迟分布。prepare另记录插入CPU和包含checkpoint/VACUUM的总时间，二者不混作同一指标。

### 4. 最终真实领域读取与输出相等

最终DB使用实际 `MemoryFormationRepository`，另一个prepare进程创建原文及工作引用，正式reader不加载原始输入JSON。reader读取主材/上下文元数据、当前原文块，使用生产async生成器；每次短数据库读取后可处理取消和事件循环。

第一版虽然保持相同7段，但仍对每个不可能放入的context读取尾窗：28736次窗口读，全消费4.10s、CPU3.94s、RSS增加约75MiB、Main最大4.16ms。该结果和bundle保留，没有删除慢样本。

随后增加同一计价的可证下界：若连1字节内容加最小必需字段都放不入，则该context任何非空suffix都不可能入选，可跳过原文读取。仍遍历其元数据、保持context顺序和遗漏计数，无新召回门槛。最终3次干净reader：

| 指标                 |                  三次实测范围 |
| -------------------- | ----------------------------: |
| 第一段可用           |               121.18–132.50ms |
| 全部7段消费          |               800.22–810.91ms |
| CPU                  |               514.19–526.06ms |
| Main事件循环最长延迟 |                   3.87–4.02ms |
| RSS增加              |                  6.53–6.92MiB |
| 原文窗口读取         | 每次72次，最长8205 UTF-16单位 |

3/3与原输出逐字段deepEqual，32/32小输入/预算也deepEqual，包括同样无法容纳有效Unicode字符的预算错误。输出hash受对象键次序影响，因此使用deepEqual验证语义相等，不把不同序列化键顺序说成内容变化。

最终大 Episode 库74,031,104字节；首次入库694ms单独记录。这是全来源第一次移交和写入成本，不是后台窗口读取时间。不同阶段并非同时随机配对，不把阶段改善冒充同机并行算法对照。

## 选定生产结构与不变量

- 复用 `memory_sources` 的来源ID/type/referenceId/createdAt/label；`raw_speaker/raw_length/raw_json_bytes`三列全空表示只有旧provenance，全有表示已原子接收canonical原文。后者中的JSON字节成本只是缓存，不是token计数。
- `memory_source_text_chunks(source_id,start_utf16,content)`为唯一原文，BLOB保存UTF-16LE，主键WITHOUT ROWID。所有块和完整标记在同一事务提交，保留NUL和代理项及引文偏移，不新增native addon、Python服务或第二存储路线。
- `memory_work_sources(work_id,ordinal,source_id,is_primary,occurred_at)`仅保存引用与用途。`UNIQUE(work_id,source_id)`拒绝重复来源，不用将全ID集合提前载入JS。
- `MemoryFormationIntake`只传metadata、repeatable有序source-use iterator和missing-source resolver。源已canonical时无需再次加载正文；metadata-only旧source必须读取真实原文补齐，不能从label构造。至少1个实际canonical主材，否则整个事务回滚。
- 完整 `registerSource` 明确提交六字段时，同ID任一不同就拒绝。仅传已存在ID是对不可变来源的引用，resolver未调用不代表软件比较过未提交的正文。Main须以已经核实不可变的Message/terminal Tool/Activity canonical身份构造ID。
- `MemoryFormationEpisode`为metadata；`MemoryFormationMaterial`只包含当前有预算的model工作集。连续主材先装、长主材稳定句界/Unicode分片，上下文再利用剩余预算；context不能独立形成，每个unit至少引用当前段主材。
- 进度为`source-windows-v1`的`(ordinal,start)`，处理器`source-evidence-formation-v8`。恢复直接从未处理窗口开始，引用offset由片段本地精确引文加global start恢复，不再对已经切片的内容用global offset再次slice。
- `MemoryFormationRepository`实际拥有来源/形成SQL和事务，RecallRepository实际拥有语义检索和embedding任务。共用应用DB连接让Main可将intake与outbox ack放入同一同步事务，wake在提交后。
- completed回执仍只报告目前可用Revision；删掉/改写/归档后的旧结果不重新生成。永久删除Memory的孤立来源清理同时检查revision引用和work引用，不能由purge破坏仍需恢复的来源。
- failed缺口仅由同persona/situation、单个complete任务完整覆盖原来源ID及primary/context用途时豁免；错误/状态/历史统计保留，pending/running不豁免，也不把“来源已处理”声称为“全部事实已记住”。

## 验证、交付和限制

领域交付时测试：`vitest run --project unit src/main/memory --project integration tests/integration/memory.test.ts`，**12 suites / 155 tests通过**。覆盖完整来源与块窗口、metadata-only补齐、显式冲突/事务回滚、空primary/duplicate/顺序、来源歧义、单complete覆盖、source保护、bounded fragment、全局引文offset、取消/重启、人工修订、当前回执以及同一Memory Tool路径。相关生产/测试文件ESLint、Prettier与diff whitespace通过。该时点detached checkout的其它领域尚未移接，所以领域结果不是应用全绿；随后Root完成Main集成，20:09完整typecheck/lint/format与1,338项离线全部通过。

19文件交付清单与前后hash在`q2-domain-handoff.json`，patch SHA256 `9659aa35e9840b9282d332a994963b2062efd44c5c591cd48557fe7ca3858e76`。shared/DDL由Root冻结并独占集成，尤其已存在的旧版`memory_sources`不能只依赖`CREATE IF NOT EXISTS`增加列；当时由Root核对开发库升级的真实来源/外键回归，未为仓外旧实验v26数据库加入兼容迁移。2026-09-17按用户新库范围删除旧迁移链，保留当前Schema及新库来源/外键约束；该历史交付说明不再要求旧库升级。

删除项包括full Episode生产输入、整Episode正文payload、回收后重建全文数组、同步全片段数组和RecallRepo的形成SQL。只有实际生产窗口路径；实验runner、whole/TEXT候选和对照代码均在仓外，不进入build/Settings。保留的测试helper只把显式原文fixture转成正式intake，无Arm开关。

剩余边界：首次外部source owner仍可能返回一个完整大字符串，入库本身也须处理此原始输入；Main引用桥接已完成，但不能宣称全应用输入有界。累积work refs、partial processor升级协调及pending superset合并待Q3。未进行此存储版本的真实Agent质量重测，不能把离线输入相等或吞吐改善写成长期陪伴质量提升。
