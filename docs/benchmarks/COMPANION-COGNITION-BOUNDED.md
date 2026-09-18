# Cognition 有界日志读取与恢复

日期：2026-09-15。此处记录该冻结版本的一次合成开发测量，不是商业产品验收，也不评价注意力语义质量。当前 Main v21 保留有界读取，分析原文容量见[来源分配决定](COGNITION-SOURCE-ALLOCATION.md)；当前行动材料按[完整请求动态分配](COGNITION-DYNAMIC-ACTION-BUDGET.md)，本页32,768 bytes和旧协议版本不能代作当前完整配置或最终资源重测。

## 决定与边界

采用按预算从最老未提交来源连续读取的单一路径。32,768 bytes 是先前部署分配的工作集护栏，不是本实验选出的胜出阈值、模型协议上限或脑科学常数。它也不是最终请求 token 数；系统、Persona、输出 Schema、Memory 与多模态仍由共同输入预算约束。

旧路径先 SQL.all + JSON.parse 全部未分析来源，再筛选模型输入；积压已经进入 Main 内存。新路径在 SQLite 内先判断原文大小，按连续水位读取；单条大原文产生明确的 INCOMPLETE EXCERPT 和来源 ID，原文仍在证据日志，不使最老来源永远阻塞。当前情境、承诺意图和有效到期 cue 分配位置，但提前带入的 cue 不推进中间遗漏来源的水位。

持续情境内容也按预算显示。已显示的 Episode/Claim 按 ID upsert；未显示条目保留，隐藏旧 ID 的编辑被拒绝。巨大 scalar 的替代说明不能覆盖 canonical 原文。这个 partial update 改动服务于有界读取的正确性，不是根据此前三对 wire 试验弱延迟差异进行的算法提升。单个无法容纳的 Episode/Claim 暂不显示，模型无法改动它，当前仍是覆盖局限。

当时执行校验直接查询持久 generation、依赖实体 revision、最新来源与 cue 取消，不依赖当前页；较后用户发言会保守阻止旧页可选行动。当前 Main 已将分析与行动依据分开，并使用[实际快照接收边界](COGNITION-ACTION-RECEIPT-BOUNDARY.md)，不能继续把正文消费前缀当接收边界。配置改变显式重试失败或待处理工作，保留 OS sleep；失败不自行重复轮询。

## 一手依据

访问日均为 2026-09-15。

- better-sqlite3 13.0.1 [Statement.iterate](https://github.com/WiseLibs/better-sqlite3/blob/v13.0.1/docs/api.md#iteratebindparameters---iterator)：all 建立结果数组，iterate 可逐行取得。实际回归复现活动 iterator 中启动 consumer transaction 会报 connection busy，所以跨域恢复采用 keyset get，每次 yield 前结束语句，不把数据库游标交给消费者。
- SQLite [SELECT](https://www.sqlite.org/lang_select.html) 与 [Core functions](https://www.sqlite.org/lang_corefunc.html)：数据库内筛选、排序和 substr 提供有界投射能力；不能据此声称整段历史 JSON 更新为常数成本。
- SQLite [Limits](https://www.sqlite.org/limits.html)：引擎字符串硬上限与此产品工作集分配是不同层级。没有把默认引擎上限当产品配置。

## 方法与结果

外部 preregistration 在执行前写入；见外部工件集 companion-commercial-20260915 的 cognition-bounded 协议、结果与 SHA256SUMS。Apple M4 Pro / 24 GiB，darwin arm64，Node v24.18.0，better-sqlite3 13.0.1，SQLite :memory:。共 100,000 条纯合成 observation，经真实 repository.ingest 顺序写入，source epoch/sequence、内容与对象均存在。使用生产 Schema 和两个来源索引。没有真实桌面采集、模型调用、外部动作或 paid request。

| 测量 | 原全量读取 | 当前有界首批 |
| --- | ---: | ---: |
| 来源数 | 100,000 | 34 |
| JSON bytes | 93,166,676 | 32,413（含 coverage） |
| 同步调用耗时 | 313.397 ms | 3.750 ms |
| 本次 heapUsed 增量 | 202,300,328 bytes | 3,014,352 bytes |

完整实际 ingest 16,869 ms；逐条 p50 0.139 / p95 0.337 / max 53.058 ms。

恢复使用实际 readSnapshot → createAttempt → commitAnalysis → settled，提交空语义变更/quiet，仅检查连续来源序列。共 2,942 页，最大 32,755 bytes；100,000 条全部按原顺序经过提交，无重复无缺失，最终 cursor=100,000。读取 p50 3.332 / p95 4.667 / max 100.329 ms；提交 p50 0.747 / p95 1.168 / max 39.238 ms；整段恢复 12,906 ms。

## 不能据此声称的结果

- 3.75 ms 只是单次存储读取，绝不是 PFC 决策延迟。既往真实模型每步约 40–90 秒，且可能需要 recall 后再决策；34 条每页不能保证持续高频内容追得上。
- 12.9 秒恢复跳过了真实语义计算，不能代表离线一夜后的真实模型追赶速度。此试验只证明水位正确和物化有界。
- 所有页来自同一合成轨迹，延迟分位不是独立重复实验，也没有置信区间或真实 UI event-loop 指标。
- SQLite :memory: 持有全部数据与索引；同一进程先做旧全量基线，allocator/GC 和后续 attempts 仍影响最终 RSS（1,835,745,280 bytes）。不能用这个最终 RSS 作为有界工作集大小，或由一次测量断言内存泄漏。heap delta 仅是本次观察，不是隔离 RSS 实验。
- 大型 Situation 的 JSON 局部更新仍可能在 SQLite 内重写历史。恢复按 Episode keyset，来源由 Iterable 逐一读，但单个大 canonical 来源供 Memory formation 消费仍需其消费者预算。尚未证明无限历史实体或海量并发性能。
- 没有通过这次试验评价同 App 任务切换、跨 App 同目标、主动行为时机或用户体验。后续需要事件负载回放与真实模型开发/独立场景评价，分别记录输入量、语义覆盖与行动错误。

## 复现标识与删除

执行时四个核心源文件连接 hash：68342bb07c6d9ca05dfd551abfbc49999060a3d91671e82e394806d95c16230a。后续仅补充真实反馈查询、失败不 busy-loop 和说明性 context 文本；当前源应以交付文件为准，不冒充当时 bundle 完全相同。

raw JSONL、摘要、事前协议和 runner hash 留在此外部目录。临时候选 runner.ts、runner.mjs 与 node_modules symlink 在结果记录后删除。主仓只保留一条生产路径和必要回归，未新增实验设置、影子日志或第二调度器。


## 2026-09-15 交付补记

本文件由 root 集成为当前工程 Decision；商业质量仍未验收。上述结果对应明确执行时的代码快照；后续加入了当前视图预留、开放 Claim 形成回调、host-owned historyEvidenceIds 和视觉 resolver，不能把旧数值冒充最终 bundle 的重测。相关 unit 回归验证边界，不替代质量/吞吐评测。

当时覆盖基线使用 user/agent/system 三类 actor；当前 Main v21 另保留 unknown 归属，无法归因的原生操作不补造为 user 或 system。同 App 正文变化单独进入内容事件；AX/DOM/画面均仅所声明的局部可见范围。键鼠只取类别、频次、滚动，不保存键值或粘贴板；计数段不会逐击模型。用户输入/Persona generation、实体 revision、时钟/重要 cue 和真实 Tool 回执是执行校验依据。

当前图像以真实 PNG 的 input_image 输入，完整预算包含系统、工具/输出 Schema、Persona、Memory 和图像。32 KiB 本地工作集不等于模型输入上限；258,000 Token 是用户硬要求，不能因工作集很小漏算固定和多模态开销。普通同对象像素变化只留下后续分析 dirty 信号，不每帧杀模型。Activity final source guard 校验当前 surface id/epoch/metadata/actor；不是像素级原子操作保证。

原始来源保留尚有跨域生命周期工作：Activity distilled_at 只是 timeline 形成，不能作为 Cognition/Memory 已消费。Cognition 候选 IDs 保留接口覆盖未消费/活跃引用/未结束执行/最新图；活跃 Claim 的中性 history 可以长期存在。Cognition 的局部 text 不等于 canonical ActivityEvent JSON，不足以声称退休/闭合来源删除后可重新形成同一 version。Main 已接入独立 canonical source snapshot 与形成完成后的释放规则：已接管的历史文本来源可释放 raw 资产，未消费、未完成 Attempt 和当前图像仍需保护。形成失败仍保留，不能宣称无限容量或多年重启全覆盖已经验收。

连续正文 exact-splice 的外部真实模型比较未支持作为延迟改进晋级，后续结果见吞吐 Decision。小本地模型语义归并若再研究，需独立主源、部署成本与单变量证据，不能直接多加一个服务。

### 严格输出下的注意操作（2026-09-15）

发现并修复一个与分页相关的协议歧义：领域的 optional nullable 字段以省略表示保持、null表示清除；严格模型 schema 要求全部字段出现，原表示无法传达省略。仅要求重述现有ID也不充分，因为其实体可能未进入本页，重述会被当作新的设置校验。

该次修复的模型边界为 `charamate_cognition_analysis_v2`；当前 Main 使用后续[Intent完成合同](COGNITION-INTENT-COMPLETION.md)中的唯一 v6 wire。以下描述该次修复：对当前情境和承诺意图独立使用 keep / clear / set(id)。Driver 先验证封闭的操作对象，再分别映射到原领域省略/null/ID并经过原领域 schema；DB与状态机不新增模式。keep无需实体出现在本页，set仍要求实际可见或本次创建的实体。

新增回归覆盖三态、两个字段独立更新、当前实体未分配时保持、缺字段/非法操作/多余ID拒绝。两文件定向69项和全量离线通过；85项Cognition/Life/Opportunity为交接时领域验证。先前真实模型报告保持原wire版本，不能据此宣称新协议已完成真实质量验收。
