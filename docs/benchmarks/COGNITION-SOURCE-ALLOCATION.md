# COGNITION-SOURCE-ALLOCATION：原文分配与重复曝光的分阶段验证

2026-09-16 更新。Root 选择 C 实际使用读取规则及131,072 bytes分析原文容量，当前随共同 v21 保留于 Main。本次容量对照没有扩大 Recall 或普通 prepare 配额；后续普通投影与行动材料已改为[完整请求动态分配](COGNITION-DYNAMIC-ACTION-BUDGET.md)，不能继续把旧8192/32768行动额度当成生产默认。下文保留原阶段裁定、最终六对数值及失败。分析原文容量与 Recall 预算不是同一数值，也不能替代用户原话、同 Run 已完成回应的共同供给。

## 问题、来源与候选

细粒度桌面来源持续产生时，旧32KiB页在连续版本轨迹中积压。源码又把每个 recent Attempt 的完整 dependencies.evidenceIds 重新读入下一页：分析曝光既扩大下一次原文，也与真正使用的来源混在一起。第一处是容量问题，第二处是读取语义与重复成本问题，必须分开检验。

当前源版本由 stage1/BASE-FREEZE.json（integration 实际681文件）、两个 implementation/formal freeze 的 SHA 固定，而非只用 detached HEAD fc81239。所有正式快照在2026-09-15取得；Root随后独立加入 creation_sequence、query plan 与下游8192分配修正，不混入这72条结果。正式回放的分析间隔至少40秒，未由同毫秒随机UUID排序差异驱动。Root集成时仅用小patch保留后续修正。

本机 Apple M4 Pro /24GiB，Node24.18.0、better-sqlite3 13.0.1、SQLite3.53.3。SQLite事务与同步JS接口参考 [SQLite Transactions](https://www.sqlite.org/lang_transaction.html)、[better-sqlite3 v13.0.1 transaction.js](https://github.com/WiseLibs/better-sqlite3/blob/v13.0.1/lib/methods/transaction.js)。这些一手来源没有规定32/128KiB；两个数字、40/60/90秒虚拟模型时间、1秒调度都是本地实验水平。Provider完整输入258,000为用户要求，与磁盘持久量不同。这里仅真实 ModelCognitionDriver 构造领域 ModelRequest，再用当前 estimator 检查，不声称发送过SDK HTTP wire或得到精确token计数。

三个预注册比较依次执行、原分母均保留：

| 阶段 | 共同代码 | 唯一变量 | 正式进程 | fake phases |
|---|---|---|---:|---:|
| 1 | 共同拆分 analysisReadBudgetBytes / analysisBudgetTokens | 原读取规则 A32 / B128 |24|{'A': 359, 'B': 208}|
| 2 | 字节页同32768、Token限额不变 | A曝光回带 / C实际使用回带 |24|{'A': 359, 'C': 359}|
| 2容量追加 | 同一冻结C bundle | C32 / C128 |24|{'C32': 359, 'C128': 208}|

每阶段四条相同30分钟输入×40/60/90秒×两臂，共12对；pair交替先后，每臂fresh SQLite，真实 Repository/Service/ModelCognitionDriver，固定empty delta/quiet，零真实模型、encoder或Run行为。来源字段/IDs不重写、不喂gold parent；新旧阶段结果不代替对照。虚拟tick先注入全部到期来源，再完成到期请求，然后通过真实Service提交与调度下一页。首阶段另有4×2前120秒逻辑等价工程检查和6个巨大材料边界案例，不并入正式72条。

## 结果与归因

正式72/72运行完成，无Service错误、无canonical原始字段差异；每条meaning来源均至少一次以与原始text相同的全文实际进入Driver输入；最终unread=0。这个全文覆盖只说明供给，不说明模型注意或理解。数值只描述这些固定轨迹；每条件一个进程，没有合理的总体置信区间或商业p95分母。

输入计数（每30分钟）：counts_then_change 1802提交/1802入库/2 meaning；reading_scroll 1981/1981/181；typing_content 1801/1801/1801；identical_content 1801/2/2。λ分别用上述各分母除1800，不能把高频键鼠计数当独立记忆支持。

第一阶段大页减少连续版本轨迹的页数及积压，但在滚动阅读中无服务率收益，还把更多已消费原文自动填进128KiB。第二阶段只删除曝光回带，所有12对的调用数、水位、输入期积压与追赶时间完全相同；因此不能把它宣传为吞吐提升。它确实减少无实际用途的原文和请求成本：

| reading_scroll等待 | 旧原文供给次数 A→C | 完整领域请求估计总量 A→C | 变化 | readSnapshot样本p95 ms A→C |
|---:|---:|---:|---:|---:|
|40s|829→0|3,657,303→2,689,267|-26.5%|4.45→3.09|
|60s|409→0|2,448,688→1,977,422|-19.2%|4.77→3.49|
|90s|136→0|1,662,352→1,502,728|-9.6%|5.40→4.32|

C在全部固定quiet轨迹的已消费原文回带为0；这不是生产要求“永不重读”。真实选用的历史、当前Claim支持/矛盾、Intent效果、feedback、opportunity取消、在途Recall显式输入继续读取，独立回归验证了这些消费者。typing在32KiB中原本只有5次旧原文回带，所以C并未消除其新来源积压。

容量追加因此固定C规则再比较32/128KiB，得到：

| typing等待 | phases C32→C128 | 输入停止时未消费meaning | 停输入后追赶秒 | readSnapshot样本p95 ms | 估计请求总量变化 |
|---:|---:|---:|---:|---:|---:|
|40s|83→46|853→79|1558→41|4.97→7.08|-25.6%|
|60s|83→31|1183→119|3233→61|4.69→11.77|-36.3%|
|90s|83→21|1403→179|5733→91|4.83→22.75|-43.5%|

其余三个profile各条件的phases、积压及追赶时间均无变化。reading在C32/C128的最大实际核心页分别同为12,900/17,933/25,484 bytes，估计总请求完全相同；额度增大不再自动导致旧文本把页填满。typing C128最大核心页58,021/85,841/127,571 bytes，新的来源确实需要更多容量。

容量追加中typing C128每进程RSS峰值约208/210/217MiB，C32约266/269/269MiB，但峰值含仪表、全部原始输入、request/result/journal导出和GC，不能等同Electron常驻内存。同步readSnapshot C128最大7.26/12.54/23.68ms，90秒条件仍有主线程阻塞风险。独立事件循环仪表最高56.98ms，含GC/IO/其它代码，不是纯SQL或桌面动画延迟。各阶段存在同机任务，wall/RSS不是严格资源隔离的随机总体实验。

当前视图的捕获年龄没有改善：输入期typing完成时仍40/60/90秒，reading41/61/91秒；相对最新版本时间差仍40/60/90秒。更大历史页没有让正在运行的模型预先看到未来输入。所有quiet提交的actionFreshness为current仅因未声明当前事实依赖，不能当实际行为拒绝率或角色即时体验通过。

三阶段完整请求估计最高分别191,750、81,055、184,108；均低于共同258k估计守门分配。真实input/output/cache usage全部是明确synthetic 0；以上估计不表示付费token节省，也不证明代理exact-count能力。

## 正确性与失败记录

当前生产候选只增加显式analysisReadBudgetBytes，并取消Repository显式参数被默认32768暗夹回。Recall token配额不变。普通getSnapshot仍用独立默认有界读取。recent Attempt仍保留完整dependencies用于CAS，只有下一次原文加载从全曝光改为实际selectedChoice、evidenceUses、actionReadSet和feedback；不改canonical、状态、队列或表。

服务消费者核对和7条新回归覆盖：quiet/failed曝光退出但全read-set不变；实际选用保留、下一轮不再使用后退出；当前Claim支持/矛盾和Intent实际效果保留；awaiting_recall重启结束旧请求但持久当前state可读；在途recall期间70条新背景输入仍保留原第一阶段来源/水位；实际Run反馈；已取消opportunity即使水位越过也仍失效。现有冷Memory→parent→exact child/原支持、跨Persona、未见child不得改写、ActionContext精确读取回归同时通过。

最终受影响验证：Cognition9文件191/191，CognitionRuntime+MemoryBridge28/28，typecheck、3文件ESLint、Prettier均通过；未跑整仓offline/build/Electron/live。Root进行最终一致集成验证。

失败没有删去：Stage1第一次边界夹具错误使用不存在的allocation.partial，修正为真实preservedFields后六例通过，原失败保留；Stage1新增异步测试require-await按实际Promise改写。Stage2新夹具初次猜测不存在getEvidence/错误effect字段、Intent依据字面值及reported/observed，均由Schema或host拒绝，FIRST-TEST-ATTEMPT保存每次失败。两个旧测试默认下一轮可重新选择上一轮未选用的frame/已处理cue，改为明确选用frame及当前实际Chat来源，不放宽宿主资格。正式72进程没有失败重试。

巨大材料仍有边界：单1,440,000 byte来源只能显式excerpt，canonical不变且共同规则允许推进，不代表全文已被处理；大Situation300个children视图显示15/63但未见child修改被拒绝；巨大Persona通过既有Driver有界投影并声明partial，没有验证“大Persona+大state+多图”组合。32/128均未新增巨大source分段处理。

initialize把旧pending/analyzing/awaiting_recall/ready置superseded。初次分析在Recall前提交并推进水位，重启不保证旧Recall重做，这是共同基线边界。普通下页删曝光不改变这个恢复合同。任何已曝光但未被选用/未进入持续state的内容仍在canonical，但未来如何冷检索需依靠真实来源关联/Memory召回，不能因这次quiet模拟将它宣传为语义无损。

## 阶段裁定与后续

采用C作为后续唯一候选读取规则：其消费定义清楚、无新增状态，离线覆盖保持，阅读轨迹减少明确重复原文。保留32KiB当前调用默认；128KiB机械容量和请求成本证据足以进入真正Astra服务率/质量比较，尚未晋级。后续新6条120秒素材以同C为共同基础，仅比较容量；实际阶段数由Service调度产生，来源/标签在输出前冻结，既不强迫Recall，也不注入gold state。若真实大页产生过长输出、漏中间改口或画像/图片挤出，必须报告和重新裁定，不按假模型结果硬选。

拒绝把analysisBudgetTokens从32768直接改131072而同时改变Recall；拒绝把全曝光ID当旧正文持续加载理由；本阶段未实现动态请求余量推导页、并行PFC、任何local-model替代或新fallback。最终独立变量只是单一路径内部读取规则和可实验配置额度，不把Arm暴露为产品设置。

## 可复现标识与交付

三个正式目录保留全部原始来源、actual ModelRequest、SQLite、watermark/events、resource/statistics、失败日志和执行顺序。原始哈希用于普通复现；没有额外加密审计框架。原始数据仓外保存，当前Root要求暂不清理执行候选。生产合入前删除runner、bundle、Arm和候选依赖链接；仓内仅保留本中文Decision及归属普通模块的无Arm回归。

- `stage1/FORMAL-FREEZE.json` — `91c01e8647d91e78a8fd31f188e62339e9682b3af5d2d29a50efa62e72b2b324`
- `stage1/SUMMARY.json` — `7ae2a9583c67099d8a3849eb0abd4b85690dc27870848e5cf9956a3e4df295b4`
- `stage1/SOURCE-COVERAGE.json` — `3b836213fa606afbcda7dba90254f8636a0ee4aedb603e9a35b89ba387b99e7e`
- `stage1/EQUIVALENCE.json` — `0fa7e78503298f4ba405fa2b31360841a14eb6c0d74d17a25dca334cf03ee573`
- `stage1/BOUNDARY-RESULTS.json` — `3066da26363acb0255c8eac167c0c04884c8b5c1d3816b22e2384844e02e4c54`
- `stage2/FORMAL-FREEZE.json` — `e4ea49f063ff29fc39cf5f54b5811bddbb833e23b3b6706032197741e60c31d3`
- `stage2/SUMMARY.json` — `2c8bb51afc87ef1273bc534093f38828571532004148a1c798c0285419adfcc6`
- `stage2/SOURCE-COVERAGE.json` — `9b73765d735a89ef55e4f2f94a882657574390cc02f95e573b4986648e2ccb09`
- `stage2/capacity-followup/FORMAL-FREEZE.json` — `ed4bc8dd01c9f5d16d10e4c88751a142d735baa72ac9a26421a66236a367a14f`
- `stage2/capacity-followup/SUMMARY.json` — `94cd471adace6353f87cef77d19ac5c61ab19221a697762e3a9d41c2d0db6fee`
- `stage2/capacity-followup/SOURCE-COVERAGE.json` — `150ce27f07fd39afdbd0121dfe27074e1826426348f5b28fb3edc60a14085df5`
- `stage1-stage2.patch` — `1d21b9cac0ead02dcbc8cc1ca7b7a2869154b622c2504a65dbe5b7d1e97db50b`
- `STAGE1-STAGE2-HANDOFF.json` — `468d4d4509cbd44cc62f9a6421c9d242297b7980628f43dadcb281a32c1185db`

Root 2026-09-15 复核：已审阅全部72组的三阶段结果、原始覆盖计数、完整九文件补丁及消费者回归，接受C读取规则进入当前集成候选。合并后1,549项offline通过，23:26构建通过。最终12故事明确使用128KiB质量候选；新6对持续120秒的真实Astra比较另行冻结，32/128尚未完成生产取舍。

## 2026-09-16：真实六对最终裁定

以上9月15日阶段裁定保留原样，属于当时尚未真实运行的结论。本节补入最终12臂；没有回写72条离线结果、修改独立标签、重跑失败或将不同源码的结果合并成同一对照。建议选择 C 实际使用读取规则及131,072 bytes分析原文容量，作为单一生产方向交Root定稿：它在这组真实持续轨迹减少了有记录的调用和已知tokens、缩短了完成追赶，并未损害前台接管回答。它不保证120秒即时完整理解，也不能代替已显现的来源共同供给和形成依据正确性修复。最终晋级及跨域回归由Root负责，本仓外记录不改变Main配置。

### 版本、实际调用与失败分母

采用共同553文件快照 `825716884d6289e20c3e7c35ba34a3802e2b47b78e2d4a2a15df33ee4e607969`，与Root12故事链路当时同源。2026-09-15真实顺序从15:46:25.744Z运行到16:37:53.239Z：s01 A→B、s02 B→A、s03 A→B、s04 B→A、s05 A→B、s06 B→A。A/B均使用C读取规则，唯一容量变量32,768/131,072 bytes；Recall32,768 tokens与普通prepare8,192不变。此后Root的当前用户原话优先、ordinary projection等修复不在这份冻结结果里。

使用真实 `gpt-6-astra` / OpenAIResponsesModelProvider / SDK及实际CognitionService、SQLite、AgentRuntime。请求未显式指定reasoning或max_output_tokens，已完成响应报告reasoning.effort=medium、service_tier=default；模型名以服务响应为证，未得到可验证的固定内部权重版本。初始Memory为空，实际SQL检查向量池为0，真实lazy embedding与vector适配器调用均0；Memory表/形成work均0，共137个Cognition handoff持久等待，未运行形成消费者。不能把这些事实写成Memory验收或OS捕获验收。

| 分母                                    | A：32KiB | B：128KiB |
| --------------------------------------- | -------: | --------: |
| 已开始/已终止实验臂                     |      6/6 |       6/6 |
| generation请求                          |       69 |        36 |
| 其中PFC请求                             |       62 |        30 |
| PFC Provider completed                  |       56 |        24 |
| 真实host成功提交 / Provider completed   |    55/56 |     24/24 |
| 真实host拒绝                            |        1 |         0 |
| 70秒前台Run / completed                 |      6/6 |       6/6 |
| 额外assistant-initiated Run / completed |      1/1 |         0 |
| 实际接管取消、usage unknown             |        6 |         6 |
| 成功消费完全部作者来源的臂              |      5/6 |       6/6 |

105次generation中93次有完成usage，12次为真实用户接管引发的取消，未记录usage，不能计0。80个PFC完成输出只有79个真实提交。12个前台加1个额外自主Run是真实13次Agent运行，均已completed。HTTP200或Provider completed并不表示PFC持久成功；原文件FINISHED.error=null只表示外部执行正常收尾，同样不能替代领域错误分母。

唯一host失败在s06-A最后请求：模型准确读出了100秒PNG的金额1260、本地已保存、远端送达未知，但更新既有explicit_user Intent时把evidenceIds替换为单张截图，失去真实用户原话。Host以 `Explicit user intent requires a user utterance` 拒绝整次提交。保留原输出、错误和未完成队列；无自动重试。A最终21条作者来源未成功消费，其中6条从未供给，另15条已供给但不能算该次成功提交。不会用B未触发此错误来宣称大页在逻辑上消除了该错误。后续[partial Intent诊断与修复](COGNITION-PARTIAL-INTENT.md)进一步确认：该次只展示 partial 列表，canonical 用户依据仍应保留，拒绝还来自宿主仅校验可见合并值的缺口；不能把这里的早期归因继续解释为模型删除了完整已见支持。原失败与本次比较分母不回写。

### 成本、来源与追赶

| 已知完成回执        |         A |       B |  观察变化 |
| ------------------- | --------: | ------: | --------: |
| input tokens        | 1,017,834 | 788,667 |    -22.5% |
| output tokens       |    90,355 |  53,261 |    -41.1% |
| cached input tokens |         0 |       0 |         — |
| 有usage请求         |        63 |      30 |         — |
| usage未知请求       |         6 |       6 | 不能扣成0 |

两臂合计已知1,806,501 input、143,616 output，真实取消成本仍未知。调用数减少47.8%是实际调度产生的结果，不人为使请求数相同。服务还返回input cache_write等字段，原SSE与Provider回执均保留；未核此代理计费合同，故不把tokens伪换成确定美元费用或断言总体账单减少同一比例。已完成请求最大实际input A19,181、B50,202，低于用户258,000；最终wire保守估计最大119,229/215,419，payload bytes最大112,113/208,303。每Provider实例首次input_tokens端点实际404，此后能力缓存；计数缺口没有被估计冒充精确数学保证。所有完整请求仍由共同Provider守门，图片也在final wire内；没有因为结果较低而回溯宣称取消请求的真实token数。

每臂实际投入120条作者原文，共720/条件。A714/720、B720/720至少一次完整进入真实PFC wire；字段/正文与canonical不一致0。A最终成功消费699/720、B720/720。供给次数A903、B1039，大页并非减少所有原文曝光：包含历史用途、页跨度和取消前已供给内容；这些不能当独立记忆强化。模型的实际语义评分另列，来源ID暴露不记理解信用。

下表“提交”分母为该故事已完成PFC输出，不含取消；120秒积压仅作者来源，与全receipt水位差分开。追赶为停止输入之后的实际经过时间；s06-A失败终态不是成功追赶时间。

| 故事 | generation A→B | host提交 A→B | 120s作者积压 A→B |               完成追赶秒 A→B | 120s完整事实 A→B |
| ---- | -------------: | -----------: | ---------------: | ---------------------------: | ---------------: |
| s01  |           11→6 |      9/9→4/4 |            85→49 |                   175.1→78.7 |          2/3→3/3 |
| s02  |           11→7 |      9/9→5/5 |            85→49 |                   176.5→95.8 |          2/4→2/4 |
| s03  |           12→5 |    10/10→3/3 |           87→118 |                   267.5→68.3 |          3/4→2/4 |
| s04  |           12→6 |    10/10→4/4 |            88→91 |                   204.9→41.8 |          1/3→1/3 |
| s05  |           11→6 |      9/9→4/4 |           118→90 |                   261.5→57.2 |          2/4→2/4 |
| s06  |           12→6 |      8/9→4/4 |            89→92 | 未完成；失败后停在167.7→50.2 |          0/4→0/4 |

共同成功的前5对，追赶均值A217.1秒、B68.4秒；逐对减少80.7–204.2秒。B六臂全部完成，追赶范围41.8–95.8秒；A五臂完成范围175.1–267.5秒，另1臂失败未消耗完。不能把A失败停止的167.7秒混入“完成得更快”。120秒作者积压552→489，只减少11.4%，且s03/s04/s06的B在该时点积压更大：实际模型长调用尚未提交。更大容量不能预先看未来来源，也不保证大页更快返回。

70秒用户原话进入实际PFC请求的时点，A依次157.434/161.223/186.052/155.423/241.698/165.609秒，B依次70.216/70.216/70.210/70.182/70.222/70.211秒。这是本次FIFO容量导致的供给区别，不能说A模型早已看见却故意忽略。真实前台Agent始终直接收到当时用户原话；独立评审确认12/12任务回应正确，不要求70秒回答80/90/100秒才出现的事实。前台终态均值6.13→5.63秒，但中位数5.53→5.67秒且共享Provider，不能据此选择前台延迟胜者。

### 独立语义裁定与普通注意力边界

原文/22项必要事实标签在任何生成之前冻结。另一位agent按masked view复核每故事，未读assignment/本执行者derived；s01由explain_memory、s02–s06由cognition_research。不是双盲：实现者知道条件、评审知道项目；六组是编写的开发故事，不是独立真实用户样本，不给虚假的总体置信区间或p95。

| 层级，22命题/条件           | A supported / partial / missing | B supported / partial / missing |
| --------------------------- | ------------------------------: | ------------------------------: |
| 120秒已持久状态             |                      10 / 3 / 9 |                      10 / 3 / 9 |
| 最终实际持久状态            |                      19 / 2 / 1 |                      22 / 0 / 0 |
| 最终一次普通prepare语义正文 |                      15 / 4 / 3 |                      20 / 1 / 1 |

三个层级都未观察到标签列出的contradicted断言。120秒总分完全相同，不可写成128即时理解全面更好。B最终优势中的3个状态命题均来自s06-A host拒绝，属于整链路失败而不是截图识别差异：两臂最后模型都读懂了实际PNG。四个原图在actual input_image里decode后逐一匹配冻结PNG，A4次/B5次附件，均覆盖四张原图；B多一次附件不是多一个独立事实样本。

s01瞬态“南楼二层、适合围坐、未预约”两臂最终真实state/prepare均保留。s02旧周四、过渡周五、最新周一和未发送两臂最终正确；120秒最新周一尚未提交。s03两个人与跨App目标最终均正确，A普通prepare只留归属Intent，岗位/项目及跨App情况缺失；B有当前A，related B志愿讲解仍不足。s04两臂未把访谈引语/角色园艺/系统资源归成用户情绪或现实完成，prepare省略与当前对话无关的系统后台状态是注意力边界，不能单凭missing升级成产品错误。s05两臂区分历史8月1190与九月旧1260/当前1320，不把历史完成套在当下；当前1320原文未在普通prepare重装，语义来自已持久的正确claim。s06 A的失败使当前截图事实不能进入持久状态/prepare；B正确保留unknown，没有推为成功或失败。

普通prepare评分只指正文语义，并不证明全部所引原文或图片再次附给下游。s02、s05、s06均存在“claim/summary正确、最新原文未重装”的情况，原评审已单列。不能把某次prepare遗漏都叫模型没理解，也不能用完整数据库正确来掩盖必要下游内容缺失。后续Root普通projection修复属于另包，未重写本分母。

### 真实重复回应与接线核实

s06-A在70秒前台已经正确答复后，又在195秒自然启动同Chat确认Run，197.982秒headless surface accepted。内容没有虚构送达，但对已经回答的用户重复确认，属于真实额外回应体验。独立评审已单列；不会从费用/动作分母删除。

该例不是fixture漏接回执：冻结runtime.ts的RunEventService对全部事件调用与Main相同的CognitionRuntime.observeRun。前台assistant receipt78和terminal79分别在74.907/74.915秒入库；165.609秒PFC页只到through74，有用户73却无已完成回复78/79。模型按所供材料判断“未提供已回复凭据”，再次确认。下一页拿到真实前台回复后选择安静。额外Run自身也真实回投assistant/terminal/offered来源125–127。`S06-RUN-FEEDBACK-TRACE.md`保留源码位置、IDs与actual wire。Root要求后续用同域、同Run确切来源共同供给修复，而非依赖128页碰巧容纳；此后包不改本次冻结结果。

### 资源、局限与后续单路径

真实同步readSnapshot样本最大A13.59/B18.08ms，最大实际页31,870/128,546 bytes；记录进程RSS最大208.1/223.5MiB。来源投递延误最高44.97ms，事件循环最大约120–133ms含JSON日志、GC、IO、其它代码。读取更大页有更大同步工作，不把它包装成零成本；整个阶段存在Root并行Astra与一个encoder、Root多次TS/Vitest/SQLite离线任务、另两次普通Agent及本包两次用户原话供给诊断请求。全部已知实际共享窗口在ENVIRONMENT-ANNOTATIONS.jsonl，不能称独占CPU/服务测量或Electron动画帧率。

本包证据支持以128KiB替代32KiB作为统一读取容量方向：离线连续版本轨迹与本次真实六对都有较少阶段与较低已知token成本，相关最终语义没有变差；没发现需要保留运行时A/B模式。保留所有反例：120秒仍明显延迟、1个真实host拒绝、1次额外回应、原文/prepare边界、未知取消费用、0真实Memory形成、0OS捕获与0Native使用。Root仍须完成其完整Memory/Agent链路、最终回归与新同Run来源修复，不以本包结果宣称商业产品所有路径验收。

独立当前用户原话优先对照是随后普通正确性修复：有限重建同一s01真实前态，A read与原snapshot+coverage deepEqual，原始SQLite精确时点未保存的限制清楚注明；2次真实Astra+host都提交，B新增reported用户纠正，A未见该原文不获该信用。这2次36,120 input/2,386 output另计，不能并入上述105次容量分母。报告与独立评审位于 `cognition-current-user-source`，Root已单独集成离线验证；不倒扣或修饰原六对结果。

最终仓外新增 `FINAL-AGGREGATE.json`含每臂完整调用/提交/来源/真实Run/评分映射及review hashes；保留原CURRENT派生结果，修正其早期“undefined lane”和“失败停止等同catchup”的呈现，不改原raw日志。`FINAL-RESULT-MANIFEST.json`给出全部非敏感raw、汇总、协议、source/modelfreeze和独立评分的可复现hash。候选与runner暂按Root要求保留，正式晋级前再按既定清理合同移除可执行Arm，不在Main留下实验模式。

### Root 生产选择与集成边界

Root 已完整审读最终六对和独立语义复核，选择 C 规则与 128 KiB 读取容量。依据是共同成功轨迹追赶明显缩短、已知输入与输出减少及最终语义无退化；不是把 120 秒理解速度判为全面获胜，也不把共享环境延迟外推为商业 P95。容量保持内部单一配置，普通界面无调参项。

同 Run 反馈遗漏和 explicit_user Intent 更新丢失用户依据是独立正确性问题，原失败不删去。前者已进入独立修复包，最终源码须通过连续链路、独立 holdout 与桌面验证后晋级 Main。最终汇总 SHA `cc03163999a12912316e2c623ecea91c3e321f7e84bb5611d9b6150dfdf3e4d2`；496 文件结果清单 SHA `fcb786f3be0b55f0e978f7ac20e2964c81a5aa7494695c1336241a17e1cb4760`。


### 最终 Main 与候选清理（2026-09-16）

本记录所选实现当时已进入 Main，该次统一源码通过1,615项完整离线验证、生产构建、26项Electron E2E、macOS arm64打包及实际4B/512编码器与SQLite向量Worker冒烟；这些验证不改变上文实验的样本与局限，也不是当前共同 v21 的打包重测。v21 晋级时的 Main 完整离线已通过，后续源码变更与待验项以 STATUS 为准，最终同版连续语义、桌面与安装验收仍待完成，见 [STATUS](../progress/STATUS.md)。

本包与相关来源/恢复包按 Root 核准的十组精确清单删除候选代码、runner和本包依赖链接，共2,692个文件及3个detached工作树；共享依赖不动。3,495个保留证据文件的hash前后一致，包括全部119份实际/重建/性能数据库。清理回执SHA `6da7eccccecb8af38f2ab5274df2f523632c7eb9e81e737895e9ef752beb4153`，保留清单SHA `6a6d024ace54379582e0391e51a3f7546eef738d3482c2bc63bed10d854e6f18`。相关 Root 自有普通Agent验证目录不在该清单内，须按各自交付记录处理；不把本清单夸大成全部仓外验证脚本均已删除。
