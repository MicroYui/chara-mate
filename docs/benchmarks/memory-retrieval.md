# MEMORY-RETRIEVAL：个人长期记忆的唯一检索路径

## 问题与决策边界

本 Decision 选择 CharaMate 发布版唯一的 Memory Retrieval Pipeline：召回 lane、融合、最终 `topK`、有效性处理及其资源形态。`ContextCompiler`、`memory.search` 与 Memory 页面必须复用同一实现。候选模型、向量表、worker、fallback、Settings 开关和实验参数不会进入生产树。

协议与产品正确性先于排序：默认查询排除已删除、归档、被取代和在查询时间无效的 Revision；显式历史时间查询按 `asOf` 选择当时有效 Revision。这是 Memory 语义，不作为某个 Arm 的隐藏优势。其余自定数值门槛只作为证据，最终同时考虑检索与回答质量、成本、速度、RSS、包体、更新维护和实现复杂度；机械结论与产品定案不一致时保留结果并写透明 amendment。

## 一手来源、版本与环境

- 执行日：2026-08-08；基线 commit `d539dff367a5e8af544d6dcf28e1112e8311d63b`；目标机 Apple M4 Pro、24 GiB、macOS/Darwin `25.6.0`、Node `24.18.0`、npm `11.16.0`。
- SQLite `3.53.3` 官方 [FTS5](https://sqlite.org/fts5.html) 与 [`bm25()`](https://sqlite.org/fts5.html#the_bm25_function) 定义词法候选的实际行为；生产依赖为 `better-sqlite3@13.0.1`，tag commit [`13625aa`](https://github.com/WiseLibs/better-sqlite3/tree/13625aa88646df36c55b5405be890841037c5735)。
- LongMemEval 当前源码 commit [`9e0b455`](https://github.com/xiaowu0162/LongMemEval/tree/9e0b455f4ef0e2ab8f2e582289761153549043fc)，cleaned dataset revision `98d7416c24c778c2fee6e6f3006e7a073259d48f`；LoCoMo 当前源码/数据 commit [`3eb6f2c`](https://github.com/snap-research/locomo/tree/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376)。
- Qwen3 Embedding 当前源码 commit [`44548aa`](https://github.com/QwenLM/Qwen3-Embedding/tree/44548aa5f0a0aed1c76d64e19afe47727a325b8f)，0.6B 模型 revision `97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3`；模型卡明确 32K sequence、1024 最大维度、instruction-aware 与 100+ 语言。公开榜单只说明候选合理，不代替 CharaMate 产品结果。

## 冻结数据

| 数据 | 用途 | 规模与 hash |
| --- | --- | --- |
| LongMemEval cleaned S | 公开长程检索；按官方 `has_answer` 做 turn evidence | 500 题、470 个有证据问题；源 SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442` |
| LongMemEval 分层配对子集 | dense/hybrid 配对与 30 个 abstention | 每种 question type 20 题，共 120；manifest SHA-256 `855ed565a7d3b92fb94d5089a7d2dcad76cd8e7ff2a3fa157a096f340aa720fa` |
| LoCoMo | 完整 10 段超长会话；官方 QA evidence 映射到 turn | 1,986 题；源 SHA-256 `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4` |
| 中文产品冻结集 v1 | 中英偏好、精确实体、改口、时间、组合、Activity、困难负例、abstention 与 graph probe | 52 条 Memory、68 题；SHA-256 `c287cb8075f3d7cfcf51fc410232d6cceeb6f83ed307edaba9e3b0ca8a27147d` |

LongMemEval 全量先跑词法；0.6B dense/hybrid 在预注册分层子集配对。LoCoMo 与中文集完整配对。调参只使用 LongMemEval 每类前 10 个稳定 hash 样本、LoCoMo 四个稳定 hash 会话和中文集稳定 hash 的约三分之一；其余为冻结确认集。所有最终分母和子类结果同时报告，不用开发集峰值冒充结果。

## 预注册 Arms 与分阶段触发

### 前级召回

| Arm | 唯一主要变量 | 冻结实现 |
| --- | --- | --- |
| `R0-FTS` | 词法召回 | NFKC + `Intl.Segmenter` word token；保留英文/数字词并为连续 Han 词补相邻二元词；FTS5 `porter unicode61` + `bm25()`；turn/Memory 为索引单元 |
| `R1-QWEN06` | dense 召回 | `Qwen3-Embedding-0.6B` revision 如上，BF16/可用设备默认 dtype、1024 维、exact cosine、文档不加 instruction；query instruction 固定为 `Given a personal memory question, retrieve passages that provide the evidence needed to answer it.` |
| `R3-HYBRID` | 双 lane 融合 | R0 + R1；只在两路 evidence 有互补时触发，RRF `k=20/40/60/100` 仅在开发集选择一次 |

所有 Arm 取相同过滤后的候选。Qwen 文本上限按 evidence 单元设置，不把完整长会话截断后再声称 dense 已看见证据。先使用 0.6B 的完整 1024 维质量上界；若 dense/hybrid 未显示产品价值，不继续量化、维度、8B、reranker、ANN 或向量存储实验。若触发后级，只逐项对当前 finalist 做增量比较，不运行笛卡尔积。

### 产品排序语义

在召回 finalist 上单独比较：仅 relevance 与 `validity → pin → importance → confidence → recency` 的稳定语义排序。validity 是硬过滤；其余只作为相关度接近时的有序 tie-break，不设计难以解释的乘法权重。只有产品更新/冲突子集不退化且总体质量不受损时，才进入生产。

### 后级触发

- 只有 top20 已召回而 top8 明显错序，才实验 Qwen3-Reranker-0.6B；否则不下载。
- 只有 0.6B 在中文与至少一个公开集存在稳定质量缺口，才下载 8B 质量上界。
- 只有 exact cosine 在产品目标规模出现实际 p95/内存问题，才实验 ANN。
- dense lane 晋级才触发 `MEMORY-STORAGE` 的 vector/compute 阶段；未晋级即不创建向量表、模型下载器或 worker。

## 指标与综合选择

- Retrieval：Recall@1/4/8/20、Hit@8、MRR、nDCG@8；多证据题报告分子/分母；按公开能力类型与中文困难子集拆分。
- Correctness：当前更新题的过期事实误召回、显式 `asOf`、归档/删除排除、无证据题的错误命中。
- Answer：在相同 reader、相同 top8 evidence token budget 上做配对回答；报告正确数/分母、引用覆盖和 abstention，不把 retrieval hit 直接称作回答成功。
- System：索引/更新耗时、query p50/p90/p95/p99、冷启动、峰值 RSS、模型/索引字节和每次更新成本。
- Complexity：新增进程、表、依赖、发布物、失败恢复和索引生命周期。

Hybrid 的机械晋级证据是：在中文确认集和至少一个公开确认集不低于最佳单路，并改善至少两类困难子集。但它不是单项否决器；最终必须把 effect size、回答质量、延迟、成本、资源与维护复杂度放在一起。质量相当选择最简单的 R0；dense 的小幅 Recall 增益若不改善回答或代价明显，不进入产品。

## 结果

### 资源校准与有效运行

词法基线一次完成。dense 首轮把 query-local 重复 evidence 与长序列批次同时驻留，运行到 `1100/1931` batch 时因交互内存压力被 owner 要求停止；它没有完整输出，标为 **resource-invalid / aborted**，不进入质量分母。此后 owner 将十进制 `10,000,000,000 bytes` 明确设为实验硬上限，dense 的质量不能因这次中止被预判失败，但后续必须小批、串行、流式并留出提前停止余量。

后续校准和修正过程完整保留：

1. batch 8 / token budget 4096 的 `1/32` shard 完成，但 `RSS + MPS driver` 保守峰值 `9,538,355,200` bytes，余量不足，仅作 resource calibration；SHA-256 `e462a78ae5dac48ca296ce1a040804483eec9a858d57e8eea9a7a8061e4bf41b`。
2. batch 4 / token budget 2048 在 batch 473 前测得保守上界 `10,390,306,816` bytes，按硬线自动中止，无结果。RSS 与统一内存设备统计可能重叠，但实验选择保守处理。
3. 按 161 个语料分片后内存降至可接受区间，但默认 MPS SDPA + FP16 normalize 产生非有限 hidden state；已完成的 10 个语料与一个两分片语料全部标为 **numeric-invalid**，不进入质量分母。
4. 最终固定 eager attention、归一化前转 FP32、batch 2 / token budget 1024，并采用 `161 个语料 × 每语料 4 个串行文档 shard`。任何时刻只有一个模型进程，局部 exact-cosine top20 按原始分数确定性合并；分片不改变模型、输入、维度、instruction 或排序语义。

有效 dense 运行覆盖 2,204 个 query、79,992 个文档和 80,075 个唯一 chunk，保守峰值为 `4,001,300,480 RSS + 1,222,082,560 MPS = 5,223,317,504 bytes`，距硬线保留 `4,776,682,496 bytes`。模型缓存为 `2,414,938,480 bytes`；累计模型加载、文档编码和 query 编码分别为 `642,360 / 9,968,297 / 322,338 ms`。报告中的 cosine p50/p95 `1.77/1.92 ms` 只是在 embedding 已存在后的排序时间，不能冒充端到端检索延迟。

### Retrieval 与系统结果

开发集选择 `RRF k=20`。确认集结果如下；所有 Arm 使用相同过滤和 evidence 判定。

| 数据集 | Arm | Hit@8 | Recall@8 / @20 | nDCG@8 |
| --- | --- | ---: | ---: | ---: |
| LongMemEval，n=60 | R0 FTS | 56/60（93.3%） | 85.8% / 89.9% | 0.7365 |
|  | R1 Qwen | 50/60（83.3%） | 73.1% / 87.9% | 0.6177 |
|  | R3 Hybrid | 57/60（95.0%） | 87.5% / 94.9% | 0.7278 |
| LoCoMo，n=1,125 | R0 FTS | 664/1,125（59.0%） | 54.2% / 63.5% | 0.4235 |
|  | R1 Qwen | 383/1,125（34.0%） | 30.1% / 37.7% | 0.2273 |
|  | R3 Hybrid | 618/1,125（54.9%） | 50.2% / 65.8% | 0.3424 |
| 中文产品集，n=39 | R0 FTS | 32/39（82.1%） | 79.5% / 87.2% | 0.7702 |
|  | R1 Qwen | 38/39（97.4%） | 97.4% / 98.7% | 0.9389 |
|  | R3 Hybrid | 38/39（97.4%） | 96.2% / 98.7% | 0.9127 |

R3 相对 R0 在 LongMemEval Recall@8 增加 1.67 个百分点、Recall@20 增加 5 个百分点，在中文产品集 Recall@8 增加 16.67 个百分点；但 LoCoMo Recall@8 下降 3.96 个百分点，nDCG@8 下降 8.10 个百分点。它因此也不满足预注册的“中文和至少一个公开确认集不低于最佳单路”机械证据。R0 的 470 题 LongMemEval 全量结果为 Hit@8 91.1%、Recall@8 83.5%、Recall@20 89.9%、nDCG@8 0.7008。

R0 在 252,684 个 evidence 单元上的 FTS 数据库为 `270,929,920 bytes`，构建 `13,902.7 ms`，query p50/p95/p99 为 `6.18/12.99/21.04 ms`，runner RSS `1,507,033,088 bytes`。这些是大型冻结集 runner 数字，不等同于普通用户库常驻量。

### 最终回答与排序语义

第一次 reader 比较固定先执行一个 Arm，产生顺序混杂；原始文件保留为 `retrieval-answer-raw.order-confounded-v3.json`，SHA-256 `d0b6753ead41c0f56b9398bdd2681c19107a6329f5f6844980cba8ceca909576`，不进入定案。修正版按冻结样本索引循环轮换，两个 Arm 各有 11/22 次先执行：

| Arm | 正确 | 全部主张有证据 | abstain | input / cached / output Token | reader 总延迟 p50 / p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| R0 FTS | 16/22 | 22/22 | 9/22 | 14,648 / 8,530 / 1,707 | 2.46 / 5.01 s |
| R3 Hybrid | 17/22 | 21/22 | 7/22 | 16,231 / 10,607 / 1,585 | 2.28 / 4.60 s |

Hybrid 多答对 1 个中文 mixed 样本；两者都未解决同一个 LoCoMo category-2 样本，Hybrid 另有 1 个 LongMemEval abstention 回答被 judge 判为 evidence 不支持。这个小样本点估计真实保留，但不足以把 retrieval 的公开集退化、模型工件和更新生命周期抹掉。

产品静态 tie-break 在 55 个有 evidence 的中文问题中改变 47 个结果顺序，Recall@8/@20 均不变，MRR 从 `0.7965` 到 `0.8056`，nDCG@8 从 `0.7750` 到 `0.7817`，更新子集未退化。冻结集没有真实 usage history，因此实验只测 `pin → importance → confidence → updatedAt`；生产把产品契约要求的 `lastAccessedAt` 放在 confidence 与 updatedAt 之间，仍只在相同 BM25 分数后确定性 tie-break，并用历史时间回归防止未来 usage 泄漏，不宣称它另有本实验未测得的质量增益。

有效原始文件 SHA-256：R0 `73c1c49c9eb5afb436b8ea8a8c90c1aa06f3c7f41d9077eb9ee3b339dd968315`；R1 `acb49ad688a5dc7bb69857f3234059ee4200b307a1fb2a3f175f311e8bc7c1bb`；比较 `0d80e35dd67347df6c84d1e6886f5ae9c12766d52b9fbdda17850a022be3116c`；平衡 reader `edcd80050e457052d10e74d562bf0709bbf7bc6bddc48d746aca7dc65ffad94f`。

## 综合定案

选择 **R0 FTS**。Hybrid 的 17/22 回答正确点估计和中文语义召回提升是正面证据，但整体代价包括 LoCoMo 明显退化、1 个 unsupported 回答、2.4 GB 模型工件、5.22 GB 实验峰值、昂贵的新增/更新编码生命周期，以及第二条索引和恢复路径。R0 为 16/22 且 22/22 有证据支持，公开集整体更稳、交互查询为毫秒级，并且无需模型、向量表、worker 或下载流程；综合质量、成本、速度、规模和副作用后更适合作为唯一生产路径。这不是因为某一置信下界或资源数字单项越线。

生产路径冻结为：先按删除/状态/有效时间/`asOf` 选择合法 Revision，再用 NFKC + 中英文 word/Han bigram FTS5 BM25 召回；相同 relevance 才依次使用 pin、importance、confidence、last access、updated time 和 ID。Revision 写入与 FTS 同事务更新，不做启动时全量重建。Context 与 `memory.search` 固定取 top8，Memory 页面复用同一 Pipeline 并可继续展示其余结果。

2026-08-27 的产品输出修订不改变检索、排序或 top8：Context 与 `memory.search` 的模型投影不再展开逐条来源，也不返回 Memory/Revision/来源 ID；每条只保留事实文本、类型、稳定字段、有效时间、rank，以及来源数量、类型和时间跨度。完整 provenance 继续由 Memory 详情读取真源。该修订消除“单条短 Memory 因数百条来源而生成数万字符 Tool Result”的结构性放大；它不是第二条检索或字符截断 fallback。

Reranker、8B、ANN 和 `MEMORY-STORAGE` vector/compute 阶段均不触发。生产树没有 dense/hybrid 分支、向量 schema、模型依赖、fallback、设置或 worker。候选 runner、venv、模型缓存、临时 FTS 数据库和 Storage 候选库已移到 macOS 废纸篓 `chara-mate-phase3-candidates-20260809`，可恢复；仓库外持久证据目录保留全部 raw JSON、无效运行、分片、manifest、日志和来源副本。

## 2026-08-27 调用边界澄清

长期偏好召回缺陷的修复不改变本 Decision 的获胜算法：FTS 文档、NFKC/分词/Han bigram、BM25、tie-break、top8 和事务索引均保持不变。`claimSlot` 只是与既有 type/status/asOf 同类的结构化过滤条件；模型在证据不足时提交的 query 改写仍由同一个 R0 执行，不构成 dense、hybrid、reranker 或第二检索 lane。

已绑定 profile/preference 的稳定画像投影属于 Context 装配，不参与 R0 排名，也不把 project/event 等全库注入。它解决的是稳定字段不应依赖当前问题词面命中的产品正确性边界；R0 继续负责当前请求相关的开放型 Memory evidence。生产不增加停用词表或硬编码同义词表来冒充语义召回。

## 限制

- 中文产品集表明 dense 对同义/混合问题有价值；若真实用户反馈形成新的代表性数据，应新开 Decision，而不是在当前发布物中保留隐藏 fallback。
- 22 题 reader 只使用记录的 `gpt-5.6-sol` profile；它支持产品取舍，不证明所有模型的绝对回答率。
- LoCoMo/LongMemEval 的 evidence 映射沿用各自公开数据语义；跨数据集的绝对数不能当作同一难度标尺。
- dense 的分片累计编码时间用于生命周期比较，不是并行优化后的最低可达延迟；相反，post-embedding cosine 时间也不能代表端到端成本。
