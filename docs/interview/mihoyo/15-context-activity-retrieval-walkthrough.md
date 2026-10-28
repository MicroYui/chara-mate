# 15 从上下文到数据库：七组追问的完整执行说明

核对日期：2026-10-25；代码基线：`8e50d50f47fd961fbed9174d76f145a5e22b58d1`。本章把 Run 压缩、认知字段、活动感知和多版本检索接起来。原理例子均标为教学推演；历史实验依据仓库决定记录，本轮不调用模型、不改生产代码。

## 1. Item 变多时，什么时候压缩，压缩后还剩什么

### 1.1 先分开数据库记录和模型输入

Run 的 Item 是持久化执行记录，例如用户消息、助手消息、工具调用、审批和压缩事件。`active.data.input` 是当前准备发送给 Provider 的输入数组。两者有对应关系，但不是同一份数据。

压缩修改的是本次 Run 后续使用的输入数组，并保存新的恢复检查点；它不会顺手删除历史 Items、工具回执和聊天消息。故“数据库里有两百个 Item”不等于“下次模型请求必须带两百个完整 Item”。同样，数据仍在磁盘，不等于模型当前看得到；压缩掉的细节若没有进入摘要或显式保留材料，当前回答就可能不知道。

### 1.2 触发依据是完整请求的输入预算，不是 Item 数量

[AgentRuntime](../../../src/main/agent/agentRuntime.ts) 在每次 `#modelTurn` 准备请求时，先合并新用户补充、移除过时的普通认知背景，调用 `#compact(active, false)`，然后按当前输入代次刷新认知背景并物化图片。等待期间又收到输入，就回到准备过程，避免发送已经过时的请求。

[ContextCompiler](../../../src/main/agent/contextCompiler.ts) 通过 Provider 的测量接口判断能否容纳。实际测量的是带 instructions、工具定义、图片等内容的请求，不只是把对话中文字数相加。有效预算见 [inputBudget](../../../src/main/providers/inputBudget.ts)：

```text
有效输入预算 = 以下有效限制中的最小值：
  项目明确要求的 258000
  Provider effectiveInputTokens
  Provider maxPromptTokens
  Provider maxContextTokens - 为输出预留的 token
```

258000 是代码注明的既有用户要求，不是所有模型的窗口规格。没有精确计数时，当前实现使用估计值及本地 0.9 安全余量，并参考此前实际 usage 与请求字节；初测放不下时，再请求精确测量。有精确计数就按完整预算判断，不能概括成“固定达到 90% 就压缩”。

这也是为什么按 Item 个数判断不可靠：一百个很短的调用回执可能比一张图片和一篇长文章便宜，工具 Schema 也占输入。

### 1.3 Run 内整理目前是宿主编译，不是每次再请模型总结

当前 `ContextCompiler.#compact` 从已维护的状态重新组织材料：

| 保留对象 | 具体作用 |
| --- | --- |
| handoff 的四组信息 | 已有进展、决定、约束和下一步 |
| Chat 的既有摘要 | 保留同一 Chat 的较早会话背景 |
| Cognition 背景和选中行动依据 | 普通背景去重；已选行动的依据不能被普通背景刷新悄悄替换 |
| 必要工具调用及对应输出 | 保留最近的工具边界、最近非图片工具边界、最近失败回执，以及当前有效图片检查所需的调用、输出和图片引用 |
| currentPlan | 显式保存最新完整计划；不靠旧 plan.update 文本残留 |
| 当前请求与最新用户补充 | 两者不同时都保留；不能把中途纠正埋进旧摘要 |

不是保留全部工具结果，也不是只保留最后 N 条消息。调用和输出按身份配对，不能留下模型无法对应的孤立工具回执。

handoff 也不是模型压缩接口返回的黑盒：例如 `completedToolState` 把“工具名：result.summary”追加到 currentProgress，用户 Steering 追加约束，审批等待更新 nextSteps。代码通过这些事件维护结构化进度。压缩发生时将它编成 developer 背景消息。

### 1.4 同一 Chat 的历史摘要是另一条路径

[ChatContextService](../../../src/main/agent/chatContextService.ts) 按 chatId 读取：

```text
已保存的 Chat 摘要
  + 覆盖边界之后的已完成消息
  + 本轮额外材料和当前输入
```

超出预算时，它按完整会话片段组织待覆盖的旧消息，检查摘要请求自身能放得下，再调用模型把“旧摘要 + 新覆盖的消息”整理成新的摘要。不是一次把无限历史塞给一个总结请求。

摘要成功后，以 expectedGeneration 校验并推进 `chat_context_snapshots` 的覆盖边界；冲突时不能用旧总结覆盖新状态。摘要与当前完整请求均要重新测量，仍超限则明确失败。

摘要字段包含 chatId、summary、generation、formatVersion、coveredThroughMessageId、coveredThroughCreatedAt、updatedAt，以及可选的 lastInputTokens、lastModelId、lastRequestBytes。覆盖边界意味着后续不用重复投影那些已覆盖的完整消息，不意味着这些消息已经从聊天记录删除。

### 1.5 压完仍太大怎么办

当前存在两层防线与一个边界：

1. 普通背景按剩余空间投影；工具读取可以使用已实现的分页／节选合同；历史会话可分批更新摘要。
2. Provider 实际报告 `PROVIDER.CONTEXT_LIMIT_EXCEEDED` 时，当前 Run 允许一次强制整理路径。首次请求可优先整理持久 Chat 历史；否则强制重新编译 Run 输入。只有请求真正改变，或新用户输入改变了请求，才有继续尝试的依据。
3. 不保证任意大的请求都能成功。单条用户输入、必要图片、必须完整保留的工具结果，或者不断增长的 handoff 本身仍可能放不下。

尤其是 handoff.currentProgress 当前会随着工具完成累加，编译器没有在这里再对它做一轮模型语义摘要。不能把“已有压缩”说成“无限长 Run 已解决”。若要继续改善，应比较有来源引用的进展归并、工具输出分页与可回读工件、摘要质量和恢复成本；这些是待评估方向，不是本次已实现的补丁。不能靠静默删掉当前纠正和效果回执来声称成功。

### 1.6 下一个 Run、下一个 Chat，以及 checkpoint 和 handoff

| 对象 | 所属范围 | 下一个同 Chat 的 Run | 全新 Chat |
| --- | --- | --- | --- |
| 原消息和 Run Items | 各自 Chat／Run 的历史 | 可由 Chat 投影选取消息；不是原封复用旧 Run 输入数组 | 不自动复制另一 Chat 的完整历史 |
| Chat 摘要 | chatId | 会读取该 Chat 的摘要和覆盖边界之后的消息 | 不读取旧 chatId 的摘要 |
| Run handoff | 一个 Run 的执行状态 | 新 Run 不是直接继承旧 handoff；继续旧 Run 则按检查点恢复 | 不自动携带 |
| Run checkpoint | runId | 恢复同一个未完成 Run 时使用 | 不是跨 Chat 记忆 |
| Memory／Cognition | 各自作用域和生命周期 | 按检索、角色与当前背景资格重新供给 | 仍可能供给，所以新 Chat 也不等于角色彻底失忆 |

[CheckpointRepository](../../../src/main/agent/checkpointRepository.ts) 保存 runId、generation、phase、context、lastCompletedSequence、updatedAt。phase 区分 model、tool、approval、input、interrupted；context 内含输入、handoff、计划、待处理工具／问题等。它服务“从哪个执行边界继续”，不是为了减少 token。把同样大的输入保存到 checkpoint，丝毫不会缩小模型请求。

本章 handoff 是 Run 内的简短执行交接材料；第 04 章的 Cognition→Memory handoff 是可靠传递记忆形成工作，两者名字相同、合同不同。SQLite WAL checkpoint 又是把日志页推进数据库文件的存储操作，也不是 Agent 恢复检查点。

教学例子：读了十个资料页后，旧页面长输出可以退出模型输入；handoff 留下读过什么和结果摘要，必要最新工具回执留下，checkpoint 保存这份状态。进程退出后恢复原 Run，能够继续但不能宣称模型仍看见十页全文。另开 Chat 讨论同一主题，需要该 Chat 的当前输入、合格认知背景或 Memory 检索提供依据。

## 2. Situation、Intent、AttentionState：字段、更新和上下文位置

### 2.1 用同一个请求建立三者

教学输入是：“我在写毕业论文，今天先把第三章的三个论点理顺，别直接改 Overleaf。”

这里的 S论文、I论点、E原话都是方便口述的符号，不是可直接写入产品 Schema 的 UUID。预期语义是：

- Situation S论文：正在修改第三章；关联实际文档对象；保留关于当前内容的有来源判断。
- Intent I论点：目标是理顺三个论点；依据为 explicit_user；成功条件是完成这次有限的讨论，并遵守“不直接修改”的要求。
- AttentionState：物理前台是当前应用对象；currentSituationId 指向 S论文；committedIntentId 可指向 I论点。三者各有版本，不能都称为“同一个状态版本”。

真实用户原话先作为来源保存，模型提出语义更新；宿主校验身份、来源、完整／部分视图和预期修订后，在短事务中提交。不能直接把示意内容插进生产表当作模型已正确理解。

### 2.2 Situation 的完整顶层字段

以下依据 [Cognition Schema](../../../src/shared/schemas/cognition.ts)；星号说明可选字段。

| 字段 | 含义与本例 |
| --- | --- |
| id、personaId、revision | 事项身份、角色归属、此事项修订；例如 S论文、第 4 版 |
| status | current／background／suspended／closed；说明事项状态 |
| title、summary | “毕业论文第三章”及当前概况 |
| objectRefs | 实际对象引用；每项含 key、identity，以及可选 appId、appName、title、url；identity 区分适配器身份与临时推定身份 |
| episodes | 具体经历段落；含 id、label、state、startedAt、可选 endedAt、evidenceIds、objectKeys、boundaryReason |
| claims | 关于事项的判断；含 id、text、basis、state、evidenceIds、contradictingEvidenceIds，可选 historyEvidenceIds、alternative |
| unresolved | 仍未解决的问题，例如第二个论点缺少指标定义 |
| relatedSituationIds | 与其他事项的关联，不意味着把其全部目标都激活 |
| journeyId*、togetherSessionId* | 已真实建立的长期事项／共同参与关联；不能因打开文档自动创建 |
| supersededBy* | 此事项被另一个事项取代时的指向 |
| createdAt、updatedAt | 建立和最后更新的宿主时间 |

Claim 的 basis 是 observed／reported／inferred；state 是 supported／uncertain／disputed／superseded。“页面显示第三章”可以是观察；“用户说想先理顺论点”是报告；“用户可能卡住了”只是推断，不能都写成已经观察到的事实。

### 2.3 Intent 的完整顶层字段

| 字段 | 含义与本例 |
| --- | --- |
| id、personaId、revision | 目标身份、角色归属、目标修订 |
| situationId*、journeyId* | 目标关联的事项与已建立的长期事项 |
| owner | user 或 character；谁的目标 |
| basis | explicit_user／inferred_user／character；目标从哪里来 |
| status | candidate／active／suspended／fulfilled／abandoned |
| goal | “理顺第三章的三个论点” |
| successCriteria | 如何判断有限目标完成；不能写成“毕业论文全部完成” |
| evidenceIds | 支持目标及约束的真实来源 |
| blockers | 缺少哪些材料或条件 |
| resumeConditions | 等待条件，含 kind、description，可选 referenceId、after；不是任意自然语言条件都已有自动订阅执行器 |
| progress | 已经推进到哪里 |
| effectEvidenceIds | 实际效果相关证据 |
| completion* | 完成依据；每项 evidenceId 对应 performed_effect／user_report／completed_reply |
| nextWakeAt* | 可以再次考虑的时间；并非每个目标都必须有 |
| createdAt、updatedAt | 创建与更新时间 |

已保存的回答确实完成“给三个论点”的有限请求，可以支持 completed_reply；它不能证明文档已经改好。若用户说“我已经填完数据”，是 user_report；工具确实修改文档并返回有效回执，才是对应范围的 performed_effect。

### 2.4 AttentionState 的完整顶层字段

| 字段 | 谁负责与作用 |
| --- | --- |
| personaId、revision | 角色归属和注意状态自身的修订 |
| userGeneration | 宿主管理的用户控制代际；用户接管、停止等可以使旧自主工作失效 |
| focusRevision | 宿主管理的物理前台变化版本 |
| lastReceiptSequence | 已接收的来源序号上界 |
| analyzedThroughSequence | 已连续处理的来源边界；不能因专门读了最新一条就跳过中间积压 |
| catalogueReviewedThroughSequence* | 来源目录的审阅进度；不等于所有原文已完整读过 |
| foregroundObject* | 当前物理对象的引用，不一定等于当前语义事项 |
| foregroundObservationClock* | observedAt、sourceKind，以及可选 sourceEpoch、sourceSequence，用于判断观察时序 |
| currentSituationId* | 当前注意事项 |
| committedIntentId* | 当前承接的目标 |
| nextWakeAt* | 宿主安排再次考虑的时间 |
| updatedAt | 最后更新时间 |

这些对象持久化在 Cognition 自己的表与关联证据中，结构定义见 [数据库 Schema](../../../src/main/db/schema/cognition.ts)。它们不是每轮临时从聊天文字重新猜一遍的几个 prompt 变量。

### 2.5 更新不是只在一个时刻发生

| 时刻 | 立即发生的变化 | 稍后可能发生的语义变化 |
| --- | --- | --- |
| 收到新观察 | 来源身份／接收序号入库；适用时更新物理对象和 focusRevision；安排考虑 | 模型判断属于哪个 Situation、改变哪些 Claim 或进展 |
| 收到用户接管／纠正 | 控制代际变化，取消相关旧自主执行；真实原话另有来源 | 把 I论点 的范围改为“先只看第二点”等 |
| 分析模型返回 | 先校验本轮实际读到的实体版本与控制状态 | 合格的 Situation／Intent 提议、注意选择和相关工作在短事务提交 |
| 工具效果／回答完成到达 | 保存效果或已完成消息的真实来源 | 据其范围更新 progress、effectEvidenceIds 或 completion |
| 到期或等待条件变化 | 宿主安排重新考虑 | 可能继续、暂停、完成，也可以保持安静 |
| 普通 prepareTurn | 读取已提交状态，按预算投影 | 它本身不负责完成一次新的认知分析 |

若模型分析旧 Overleaf 页面时，你已经切去搜索页，不能让迟到提交把物理焦点改回 Overleaf。当前提交代码分别处理实体更新和注意指针；物理焦点版本已变化时，不照搬旧分析的注意选择。动作是否仍能做还要另查其实际依赖，不能用“状态已入库”代替动作许可。

### 2.6 注入时机、位置，以及哪些字段真正交给回答模型

普通 Run 准备时调用 prepareTurn，读取已提交的角色认知状态。初始输入组织为“本 Chat 历史投影 → 可用认知背景 → 当前真实用户输入”。实际模型请求前还会按输入代次清理和刷新普通背景，刷新时将新背景置于当前输入数组前部；因此不是所有请求都固定在第 N 个位置。

[CognitionContext](../../../src/main/agent/cognitionContext.ts) 先生成类型为 `charamate_cognition_context` 的内部输入，发送前物化为 `role: developer` 的背景消息。正文明确说明它是有限证据背景、推断不代表授权、当前用户纠正优先。Persona 等常驻指令还由请求的 instructions 组成；不能把这里说成“把 Cognition 写成一条假用户消息”。

[projectCognitionContext](../../../src/main/cognition/cognitionProjection.ts) 也不是把三个完整对象原样 JSON.stringify：

- Intent 通常投影 id、revision、owner、basis、status、goal、progress、completion、blockers、evidenceIds。
- Situation 通常投影 id、revision、title、summary、status、claims、unresolved。
- 注意状态主要用于选材料，并在覆盖说明中提供当前事项／承诺指针与接收、分析边界；不是把全部宿主游标当作人物知识。
- 另给必要来源、反证和一跳相关事项；缺失、节选、超预算及尚未分析的新观察要标明。
- 字段是否真的出现，还受实际读取范围、部分视图和 token 预算限制。

普通用户输入的代次改变时，可在下一次模型请求前刷新；同一输入代次已经准备过时会跳过。当前没有因为每一条后台数据库变化，就无条件重注入整个正在运行的请求。普通回答也不会为了拿“最新推断”强等后台分析。已选自主行动的依据有不同保留要求，不能被普通背景刷新替换。

接着例子：从 Overleaf 切到检索页，foregroundObject／focusRevision 可先改变，S论文 和 I论点 仍延续；你说“先别改文档，只聊思路”，当前消息立即约束普通回答，后台随后修订目标；三个论点给完，只能完成这次有限对话目标，论文事项本身仍可继续。

## 3. SQLite、better-sqlite3、FTS5、BM25 和向量各做什么

### 3.1 它们不是五个并列的数据库

| 名称 | 当前职责 |
| --- | --- |
| SQLite | 保存关系表、修订、来源、全文索引和向量字节的嵌入式数据库引擎 |
| better-sqlite3 | Node/Electron 调用 SQLite 的原生库；当前锁定 13.0.1，提供 prepare/get/all/iterate/run/transaction 等同步 API |
| FTS5 | SQLite 的全文索引模块；用 MATCH 找词项匹配的行 |
| BM25 | FTS5 内置的匹配评分函数；给已经匹配的行排序 |
| embedding 模型 | 把查询／记忆正文转换为数字向量；数据库不会自己理解中文语义 |
| 精确向量扫描 | 读取合法候选的向量，由 Worker 计算余弦相似度并保留排名靠前的版本 |

better-sqlite3 不是比 SQLite 更高级的第二套存储，也不是 ORM。本项目的 SQL 由各领域 Repository 编写；普通短查询和写事务主要在 Main 执行。官方 README 说明其同步 API 和 Worker 支持；本文不借用它的宣传性能作为项目实测。[better-sqlite3 官方仓库](https://github.com/WiseLibs/better-sqlite3)

### 3.2 FTS5 与 BM25 确实一起使用

[词法路径](../../../src/main/memory/memoryRecallRepository.ts) 的核心 SQL 是：

```sql
SELECT r.id
FROM memory_fts
JOIN memory_revisions r ON r.id = memory_fts.revision_id
JOIN memories m ON m.id = r.memory_id
LEFT JOIN memory_revision_semantics s ON s.revision_id = r.id
WHERE m.deleted_at IS NULL
  AND m.status = 'active'
  AND r.id = m.current_revision_id
  AND memory_fts MATCH @match
ORDER BY bm25(memory_fts), r.id
LIMIT @limit;
```

上面是当前版本查询的简化 SQL；为突出索引和排序，省去了实际代码中的角色、有效期、实体、派生资格等条件，不能替代生产查询。

先由 MATCH 匹配，再由 bm25 排序；分数相同再按 Revision ID 稳定排序。FTS5 的 bm25 返回值越小越靠前，内部对常见 BM25 方向取了负号，因此这里是升序。BM25 通常考虑词项稀有度、词频和长度，FTS5 具体实现以官方定义为准。[FTS5 官方文档](https://sqlite.org/fts5.html)

中文先经 NFKC、转小写、Intl.Segmenter 分词，补相邻汉字双字，再用 Set 去重；查询词以 OR 连接。因此不能说它保留了正文里原始的全部重复词频。FTS5 也不自动理解“不是我的爱好”和“以前喜欢”，这些语义仍需字段、来源和后续选择。

### 3.3 SQLite 怎么查 embedding

数据库保存 `memory_search_chunks` 与 `memory_chunk_embeddings`，后者包含 chunk_id、model_key、dimensions、vector BLOB。当前模型输出为 512 维 Float32，每个向量的原始数值占 2048 字节。向量通过浮点字节保存，不是把数组写成普通文字再做 LIKE。

一次语义查询实际是：

```text
自然语言问题
→ 本地编码器 embedQuery，得到查询向量
→ Worker 按人物、时间、版本及 modelKey 从 SQLite 流式读取合法分块向量
→ 每一块计算 cosine(query, chunk)
→ 同一 Revision 的多块取最高相似度
→ 保留有限数量的 Revision，按相似度降序返回
```

同分时按 Revision ID 稳定排序。SQL 负责资格和数据读取，JavaScript 扫描负责相似度；这里没有 sqlite-vec、专用向量数据库或 HNSW。向量扫描是精确计算，不代表“语义理解一定正确”。

### 3.4 最终并不是把 BM25 与余弦分数直接相加

当前每个信息问题产生词法和语义列表，必要时还有实体／事件时间的结构化列表。`rankFusion` 依次从各列表取下一名并按 Revision ID 去重；多问题也参与轮转。

教学例子：

```text
词法列表：A、B、D
语义列表：C、A、E
结构列表：F、B

轮转去重：A、C、F、B、D、E
```

某条材料同时出现在两条列表，不因重复命中就占两个名额或自动加权。直接指定的合法记忆引用及各问题／通道首项另有候选保留处理，之后仍受总材料预算限制。

语言模型再从带正文、主体、时间、来源、历史状态的候选中，选择各问题真正需要的证据。若缺材料，可以有一次关联扩展与再次选择；最终材料还要重读和检查资格。历史编码器实验使用过 RRF，但后续 [MEMORY-RANK-FUSION](../../benchmarks/MEMORY-RANK-FUSION.md) 已决定采用现在的交替方式，不能混报为当前实现。

## 4. “60 篇文档、28 个问题、20 个故事组”究竟是什么

### 4.1 这里的“文档”是检索材料，不是六十篇论文

[LOCAL-MEMORY-ENCODER](../../benchmarks/LOCAL-MEMORY-ENCODER.md) 保存了冻结输入的规模与 hash：60 条检索文档、28 个问题、20 个故事／人物关系组。材料从连续故事的开发部分抽取并扩展了人物、时间、纠正、计划与结果等对照；不是线上随机抽样的六十名真实用户。

一组里可能有几段同一经历、几次纠正和多道相关问题。不能因为 60÷20=3 就声称每组恰好三条，也不能把 28 道题当成 28 个完全独立的人。

同组材料共享角色、措辞和故事背景，随机按句切训练／测试可能泄漏。记录中的分组 bootstrap 也以 20 个组为重采样单位，不能用逐题独立的假设夸大区间精度。这仍是小开发集，不能替代独立大库和长期交互验证。

### 4.2 原记录能够支持的摄影例子

下面是依据决定记录的**语义重述，不是原始 JSON 的逐字恢复**：

| 材料 | 应理解为 |
| --- | --- |
| 用户帮表妹挑摄影课的经历 | 摄影需求可能属于表妹 |
| 对“把摄影当成用户本人爱好”的纠正 | 应修正人物归属，不能继续把浏览行为当用户偏好 |
| 用户另有“喜欢船、在海上最放松”的明确自述 | 这是用户自己的另一条放松偏好 |

原问题只问“本人喜欢的放松活动”，没有给摄影背景。两组配置都选了与海上放松有关的真实自述，却没有覆盖原标注要求的摄影纠正材料。按冻结标注，两组都保留 27/28；不能事后修改答案，把主结果写成全对。

后来固定候选，只在问题中补上“替表妹挑摄影课曾被误认成用户爱好”的背景，两组都选中了纠正记录。这次诊断说明：候选已经存在，问题却没有表达预期区分。它不是重训后的结果，也不是新一轮召回全对。

这里还可以追问分层指标：摄影纠正材料在原维度比较中，4B 排第 10，8B 排第 3；两者都进入当时实际的最终候选集合。只看 top5 会觉得体验差距很大，但最终选证共同受问题歧义影响。不能把中间排名差异直接等同最终回答差异。

### 4.3 两组更具体的对照

决定记录还保留了以下真实主题；下表中的问法用于讲解，不冒充冻结题面。

| 故事／关系组 | 可以包含的材料与冲突 | 教学问法与期望区分 |
| --- | --- | --- |
| 攀岩转游泳 | 春季攀岩、手腕不适后改游泳、实际泳池频次与换气体验 | “最近怎么放松？”应区分过去背景、转变原因与当前活动，不能只找运动关键词 |
| 同浏览器内的支付排查与休闲 | 排查支付重复执行，稍后浏览休闲内容／手冲咖啡 | “刚才在查支付的什么问题？”浏览器相同不等于任务相同；闲聊材料不能支撑支付工作的正向结论 |
| 普通习惯与特殊约定 | 平日习惯、纪念日安排 | “这一天怎么安排？”不能让更常出现的一般习惯盖过有日期依据的特殊约定 |

来源分别见编码器决定与 [融合决定](../../benchmarks/MEMORY-RANK-FUSION.md)。原记录也提醒，辅助材料未被标成必需证据，不等于一定无关；某条“不是单位采购”的文字可以帮助解释归属，即使历史文档 ID 含 irrelevant，也应按正文判断。

### 4.4 面试中怎样给一个完整样例

可以现场构造一组教学材料：

```text
D1：林岚春天每周去攀岩。
D2：林岚后来因为手腕不适，暂停攀岩。
D3：林岚最近改去游泳，并说换气时很安静。

Q1：林岚最近做什么运动？       必要材料：D3
Q2：为什么没有继续攀岩？       必要材料：D2
Q3：活动经历有什么变化？       需要 D1、D2、D3 的时间关系
```

这是人工讲解例子，名字、原句和必要材料由本章设定，不能写成真实 60 条语料中的三个 ID。它说明同一组可以有多个问题，多证据题也不能只算“至少命中一条”。

当前仓库只保存决定和仓外工件的标识，完整冻结语料／56 次选证结果在原记录指向的外部工件集合 `companion-commercial-20260915`。本轮没有取得并核验那 60 条完整原文，不补造其余题面。已核实的是决定内保留的样例语义、分母、候选覆盖与限制。

## 5. Activity 怎样获取、保存、查询和形成日周摘要

### 5.1 Activity 是独立领域，RAG 是使用材料的方法

Activity 的主要存储仍在同一个应用 SQLite 文件，但由 Activity Repository 管理，不能因此把它们叫成 memory_fts 中的一批记忆。

| 保存位置 | 数据 |
| --- | --- |
| activity_events | id、actor、source、details_json、started_at、ended_at、episode_id、distilled_at、created_at |
| activity_episodes | 合并后的片段，包含起止时间、摘要、应用、域名、来源类型、截图引用、事件数等 |
| activity_digests | daily／weekly 摘要，时间范围、证据日期数与标题／摘要 |
| activity_digest_evidence | 摘要到 Episode 的关联和证据标签 |
| distillation_runs | 本次聚合的开始、结束、状态和错误 |
| Activity 资源目录与资源记录 | 实际 PNG 文件；数据库保留 storageKey、哈希、宽高、大小等身份 |

[ActivityAssetStore](../../../src/main/activity/activityAssetStore.ts) 把像素写为受管理的文件，不是把每张截图直接变成 embedding。Memory 形成若引用某段 Activity，还会维护规范来源及消费者关系；原活动记录、来源材料和形成后的记忆仍是不同对象。

### 5.2 怎样区分应用名、标题、正文与截图

不是模型先猜“这个软件值得截屏还是只读标题”，而是各捕获适配器报告自己实际拿到的层次：

| 来源 | 当前实际获得的材料 | 明确的边界 |
| --- | --- | --- |
| 系统应用／窗口观察 | appId、appName、windowTitle、前台与生命周期变化 | 知道窗口标题不代表看过文档正文 |
| macOS Accessibility | 焦点控件的 title、description、value，按集合去重组成可读文字 | scope=focused_element；不是整棵界面树、整份论文或所有后台窗口 |
| CharaMate 托管浏览器 | URL／域名／页面标题，可视区域 DOM 文字及操作计数 | scope=viewport；不是其他浏览器所有标签页的完整 DOM |
| 视觉来源 | 像素变化信号、当前表面的帧、视觉元数据与可用 OCR | 变化通知不等于模型已经看过图；实际图片要在需要时加载 |
| idle／Agent Run | 空闲边界、Agent 自己的执行经历 | 不能把 Agent 自动操作算成用户真实兴趣 |

代码见 [ActiveApplicationSource](../../../src/main/activity/activeApplicationSource.ts)、[macOS 焦点捕获](../../../src/main/activity/native/macos-active-application-observer.mm) 和 [ManagedBrowser](../../../src/main/browser/managedBrowser.ts)。

原生实现先检查安全输入控件，受保护内容标为 protected，不读取值。普通焦点控件读取不到内容则为 unavailable；截断要标 truncated。托管浏览器按视口判断可见文字，排除脚本、隐藏区域、输入框等指定节点，并限制遍历／文本量。

视觉是并行证据通道。捕获协调器注册变化监听和帧供应者；变化先通知需要考虑，到认知分析前由 beforeAnalysis 消费最新可用帧，检查表面身份、代次与内容版本，保存后才能实际供给图片。不是每次按键都保存全屏图、再让模型做一次 OCR，也不是有 Accessibility 文字就永远不用图。

外部 Overleaf 若开在普通浏览器，不能承诺获得托管浏览器级 DOM；它能拿到什么取决于系统焦点接口与视觉权限／内容。当前原生实现主要是 macOS 路径，不能因为此仓库位于 Windows 就声称已经验证 Windows 的等价捕获。

### 5.3 三种问题走三种读取

| 用户实际问什么 | 路径 | 返回与限制 |
| --- | --- | --- |
| “最近哪些天在写论文，花了多久？” | activity.search | 读取时间范围内 Episode，聚合应用／域名模式；当前不是 embedding 或 BM25 搜索 |
| “刚才那个页面具体写了什么？” | activity.observe | 按 eventId 精确读取，或按时间／表面／定位字段寻找最新保留观察，返回可分页文字与来源范围 |
| “之前为什么决定暂停攀岩？” | memory.search，必要时再读活动依据 | 若形成了具有目标、归属与因果的记忆，走长期检索；原活动统计本身不能补出心理原因 |

`activity.search` 用查询词与 Episode 的名称、标题、摘要词项相交计分，再按总时长、活跃天数和标签排序；当前最多返回 8 个模式，这是已有本地规则，不是普遍最优值。它返回的 observedBehaviorOnly 正在提醒：有使用记录不等于本人喜欢，更不等于已完成任务。

`activity.observe` 的 reference 直接使用 eventId，并支持 offset；latest 使用时间边界、surface 和标题／应用等定位字段的字面匹配，按开始时间与 ID 逆序选一条。它会保留 missing、局部不可读、节选及 continuation 的区别，异步测量后检查来源仍相同。它标明 retainedOnly=true、liveScreen=false：读的是已保存观察，不是调用工具时重新拍下的屏幕。

这两个工具都不是“先向量召回再让模型猜是哪条活动”。但精确查询也只在对应数据仍被保留时可用，不能把旧记录已清理解释成“那段活动没有发生”。

### 5.4 当前“蒸馏”具体做了什么

[activityDistillation](../../../src/main/activity/activityDistillation.ts) 是无模型的规则聚合，不是神经网络蒸馏，也不是每晚自动推断性格。

第一步把已经结束的事件形成 Episode：

1. 主事件按时间顺序处理；actor 必须一致。
2. 相邻事件必须有结束时间，且间隔在当前 8 分钟合并窗口以内。
3. active_app 的签名包含应用身份和窗口标题；idle 会形成边界。浏览器事件在下一步单独附着，不能把它们全部解释为按应用窗口相邻合并。
4. 浏览器观察按时间和 actor 关联到相应片段；截图作为相应证据附着，不能靠截图自己任意扩展用户活动时长。
5. Episode 汇总标题、应用／域名、来源、操作计数，以及末次可读内容的片段。

这些规则比 Cognition 的语义事项简单：两个窗口可能同属一篇论文，两个同域名页面也可能属于不同任务。因此 Episode 不是 Situation 的另一种命名。不能把“活动片段合并成功”直接当“持续事项识别正确”。

第二步生成日期摘要：

- 启动 initialize 时会补做可生成的摘要。
- 当前维护间隔复用 8 分钟窗口，先收束结束已足够久的事件，避免刚结束又相接的片段被过早定型。
- 跨当地日期后，生成此前尚未覆盖的日期摘要；不是必须在零点在线才有日报。
- 周摘要围绕已经结束的自然周、按周一边界生成。
- 日报与周报都直接从 Episode 汇总，不是“先让模型总结每天，再让模型总结七段日报”。
- 摘要按应用／域名归组、累计已记录时长，保留 episodeIds／证据关联及 evidenceDays。

当前 createDailyDigest／createWeeklyDigest 都将 candidateIds 初始化为空。仅产生日报不会自动把“用了三小时 Overleaf”提升为“用户热爱学术”。当前默认搜索／维护涉及 90 天 Episode 范围，但这不等于所有原始文字、截图都保留 90 天；原始材料有独立清理与消费者保护规则。8 分钟、90 天等是仓库当前参数，不是脑科学常数。

### 5.5 活动如何进一步变成长期记忆

认知路径可以把真实 Activity 作为证据，建立有关持续事项和经历的提议，并在状态提交中登记 Memory handoff。[CognitionMemoryBridge](../../../src/main/app/cognitionMemoryBridge.ts) 解析真实来源，把形成工作入队并确认交接，随后唤醒 Memory 形成处理。详细字段和事务见第 04 章。

顺序因此可以是：

```text
Overleaf 的可读观察
→ Activity 原始事件
→ Cognition 基于来源解释论文事项
→ 合格经历的 Memory handoff
→ Memory 形成与修订
→ FTS 同步更新、向量异步编码
→ 后来用 memory.search 找到这段经历

同时：
Activity 原始事件 → Episode → 日／周活动摘要
```

这两条支路的用途不同。当前回答“昨天主要用了哪些应用”可以不经过长期记忆形成；回答“为什么改了论文实验方案”则需要真正支持原因的来源，不能由应用时长自动推出来。

## 6. Worker 是线程还是进程，哪些 SQLite 操作在那里

### 6.1 当前向量 Worker 是 Node 工作线程

[MemoryVectorSearchWorker](../../../src/main/memory/memoryVectorSearchWorker.ts) 使用 `node:worker_threads`，不是为每个查询启动一个独立 OS 子进程，也不是另开数据库服务器。

Node Worker 能在独立 JavaScript 执行环境运行 CPU 工作，并通过消息、ArrayBuffer 或 SharedArrayBuffer 交换数据；这与 child_process 的进程边界不同。官方页面本轮显示 v26.12.1，仓库工具链约束为 Node 24.18.x；本章只引用稳定 Worker 概念，不把网页版本说成项目运行版本。[Node 官方文档](https://nodejs.org/api/worker_threads.html)

当前只有一个持久向量扫描 Worker，查询通过 Promise 链串行交给它。它按需初始化，读取的是 Main 已初始化好的同一个数据库路径，自己的连接为 readonly=true、fileMustExist=true；没有扫描失败就改在 Main 同步重扫的第二条生产路径。

### 6.2 三个执行位置应分别画出来

```text
Electron Main
  ├─ 普通领域 Repository 的短 SQL 和写事务
  ├─ FTS／结构化候选查询、选择及最终资格重读
  ├─ 调用本地编码器，得到查询向量
  └─ 发送查询向量和检索范围给 Worker
         ↓
Node Worker 线程
  ├─ 自己的只读 better-sqlite3 连接
  ├─ 流式 SELECT 合格向量
  ├─ 精确余弦扫描、分块归并、有限候选堆
  └─ 返回 Revision ID 与 similarity

本地模型运行时
  └─ 执行 embedding 编码，与上述扫描线程不是同一项工作
```

所以“所有 SQLite 都放在 Worker”不符合当前代码。Memory 写入、版本指针更新、FTS 写入、Cognition／Activity 状态等仍由各自 Main 领域处理。重的向量遍历被专门移出 Main，避免同步数据库迭代加浮点计算阻塞主线程。

Worker 降低主线程被扫描占用的时间，不会消除扫描总计算量，也不会把一条串行查询瞬间并行成几十条。它仍要读取每个符合条件的块；保存候选的堆只占 O(limit) 状态，主要计算仍随块数和维度增长。

### 6.3 查询、取消、并发更新的完整一轮

1. Main 构建 RecallPlan，在有可搜索向量时调用 embedQuery。
2. Worker 包装器等待前一查询结束、确保线程就绪，复制查询向量并转移 ArrayBuffer，附带 plan、modelKey、limit、now。
3. 取消使用 SharedArrayBuffer 中的标记；Main 用 Atomics 写入，扫描循环逐行检查，而不是等待被长循环堵住的普通消息回调。
4. Worker 用自己的只读连接流式 SELECT。数据库 WAL 使一次读取有其一致快照；这次开始后提交的新版本，不保证混入已经开始的扫描。
5. Worker 返回候选，Main 后续读取真实内容、调用证据选择模型，再重新验证这些明确的 Revision。

第 5 步必不可少：Worker 读到合法旧版本，不意味着模型选完以后它仍是当前版本。跨线程不是自动一致性，取消信号也不是最终事实校验。

## 7. 一个 Memory 有多个 Revision，到底按什么顺序查

### 7.1 不是“先搜最新版，搜不到就降到上一版”

用三个版本作教学推演：

| 版本 | 正文含义 | 后续如何解释 |
| --- | --- | --- |
| R1 | 林岚喜欢冰美式 | 后来明确说这是记错了，R1 被纠正 |
| R2 | 林岚当时实际偏好热拿铁 | 后来真实偏好发生变化，R2 可保留为过去成立 |
| R3 | 林岚现在偏好热燕麦拿铁 | memories.current_revision_id 指向 R3 |

R2 保存 predecessor_revision_id=R1，并记录对 R1 的 corrected；R3 指向 R2，并记录 R2 的 retained_history。每版正文、FTS 行和分块向量可以继续存在。R1 的向量即使非常接近当前问题，也不会自动获得作为现行事实的资格。

### 7.2 先确定“问的是什么时间、用来做什么”

[MemoryRecallRepository.#where](../../../src/main/memory/memoryRecallRepository.ts) 为词法、向量和结构化通道提供相同的主要资格规则：

| 检索范围 | 当前资格逻辑 |
| --- | --- |
| 普通当前查询 | 排除删除、归档及失效派生材料；要求 active 且 r.id=current_revision_id；默认检查当前有效时间 |
| includeSuperseded=true | 允许历史版本进入候选；历史标签必须保留，不能把所有旧版本都当过去正确 |
| knownAt=T | 找 T 时已经写入的该 Memory 最新一版；按 created_at 和同刻 rowid 排除当时已有更新版本 |
| validAt=T | 检查事实的有效区间；这是“何时适用”，不等于“系统何时知道” |
| occurredFrom／occurredTo | 限定事件实际发生范围，不代替写入时间 |
| 明确 Memory ID＋Revision ID | 读取指定身份，仍检查存在、作用域、使用类型和当前／历史资格 |

knownAt 的版本选择与历史真假判定使用不同依据。它不是把整个数据库回滚到 T：当前删除、归档与派生约束仍会影响可用性。历史处置沿显式前驱链判断，不能用 created_at 的大小证明一条旧记录过去是真的。

owner、persona、实体等范围还会继续加入条件。领域代码决定合法范围，排序算法不能突破这些范围“补一条更相似的”。

### 7.3 当前查询怎样执行

假设问“现在替林岚点什么”：

1. 构造问题与作用域；明确是当前事实。
2. FTS 的 JOIN／WHERE 只允许 R3 匹配并参与 BM25 排序。R1／R2 即使 FTS 行存在，也不能作为当前版本挤进候选。
3. 向量路径也只扫描合格版本且 modelKey 一致的分块。若 R3 尚未编码，不能用 R1 的高相似度向量冒充当前依据。
4. R3 可以经已同步写入的 FTS、适用的结构化查询或明确引用被找到；这不保证所有同义问题都能命中。缺索引状态应该如实体现在覆盖／未完成原因中。
5. 跨通道融合的是 Revision ID，之后才带完整正文和语义给证据选择模型。
6. 回答最终依据应是 R3 的实际内容及适用条件，而不是把同一个 Memory 的三版拼成“既喜欢冰美式又喜欢两种热拿铁”。

这里说的是普通当前查询的初始通道。明确历史引用或后续关联扩展可以依合同带入旧版背景，但必须保留历史标签；不能把这种补充背景说成“当前版没命中就自动退回上一版”。

本轮用 Python 自带 SQLite 3.45.3 的内存教学库验证了简化 SQL：保留三行 FTS，current_revision_id 指向 R3，当前查询只返回 R3。它仅演示 WHERE 资格，不是运行 better-sqlite3 产品回归，也没有评估 embedding。

### 7.4 历史问题怎样处理纠正与真实变化

如果问“以前为什么推荐错了”，可以读取 R1，但要标明 corrected；它能证明系统过去有过这条错误记录，不能用来证明林岚过去确实喜欢冰美式。

如果问“口味后来有什么变化”，R2 的 retained_history 可以提供过去偏好，与 R3 对照。没有明确处置的旧版是 unresolved，不能自作主张解释为历史真相。

[MemoryRevisionHistory](../../../src/main/memory/memoryRevisionHistory.ts) 从当前根沿 predecessor_revision_id 链读取处置声明。当前 active 根为 current；历史节点选适用声明，corrected 优先于一般处置，再结合链上的位置。若没有合格处置，保留 unresolved。这个规则防止一条已经纠正的错误，仅因后来的普通更新而被重新当成真实历史。

检索可以展示错误历史以便解释；行动 grounding 的验证会拒绝 corrected／unresolved 被当成事实依据。“能检索到”和“能据此执行”仍是两个条件。

### 7.5 选择模型在等待时发生了 R4，怎么办

时间线：

```text
t0 读取 R3 候选，记录 memoryId + revisionId
t1 证据选择模型开始等待
t2 用户纠正，形成或编辑提交 R4，当前指针转向 R4
t3 选择模型返回“选 R3”
t4 readFinal 在短事务中重读所选的 R3 及当前资格
```

当前普通查询若发现 R3 已从 current 变成历史，会剔除这条过时当前依据，记录相应覆盖缺口。它不会悄悄把 R3 的选择替换成 R4，因为模型还没判断过 R4 的内容；也不会把旧候选正文直接返回并假装没有变化。

最终材料若还要 await 完整请求测量，测量返回后再做一次 readFinal，比较内容、当前性、历史处置、来源和派生状态等实际投影；期间变化则重新评估最终材料是否可交付。这里重读的是已经选中的明确版本，不是无限重跑搜索和证据选择。

因此当前调用可能返回材料减少／缺口，Agent 需要据此决定重新检索、澄清或承认证据不足，而不是本函数保证一次就自动拿到所有新版本。最终检索重读也不是对后面整段流式回答的永久锁；自主行动还有自己的执行和发布资格检查。

### 7.6 用一句完整流程回答“先查谁，后查谁”

```text
真实问题 → RecallPlan／人物与时间范围
→ 按版本和来源规则限定合法集合
→ 各问题的 FTS＋BM25、embedding＋精确扫描
→ 有条件的结构化查询
→ 按列表轮转融合并去重
→ 按预算读取有来源的 Revision 内容
→ 模型按信息问题选择必要证据
→ 必要时一次关联扩展与再选择
→ 同版重读、资格和材料预算复核
→ 带覆盖／缺口的 EvidencePack
→ 回答模型使用，实际行动另做资格检查
```

“最新优先”只描述了部分资格，不是完整检索算法；“相似度最高优先”只描述语义通道内部排序，也不是最终答案依据。

## 8. 本章闭卷验收与来源定位

### 8.1 七个必须现场推演的变化

本章接到既有 A03、A05、A06、A07、A09，个人状态均未执行：

1. Run 只有三个 Item，但其中一个含巨大工具输出；解释为什么仍可能超限，哪些材料不能静默删，以及压缩后 checkpoint 保存什么。
2. 同一 Chat 再发一句，与全新 Chat 再发一句分别加载什么；区分 Chat 摘要、Run handoff、恢复 checkpoint、Memory 和 Cognition。
3. 用户从 Overleaf 去搜索页，再说“只讨论第二点”；分别修改三种认知对象，标出立即控制与异步语义提交。
4. 写出 FTS 与 BM25 的关系、SQLite 向量存储和 Worker 的扫描循环；手算第 3.4 节轮转结果，不用“混合检索”四字带过。
5. 用摄影例子解释：标签未覆盖、候选缺失、问题歧义、最终回答错误为何不是一个指标；准确复述原 27/28 和补情境诊断的关系。
6. 仅得到浏览器标题时，不能说看过正文；只有日报时，不能说已经形成性格记忆；给出分别读取原观察和长期经历的工具。
7. 在扫描后、证据选择等待期间、最终材料测量期间分别提交新 Revision，解释会看到哪份快照、剔除哪一版、是否自动替换和最终如何回答。

关键错误包括：按 Item 数决定窗口、checkpoint 能压缩 token、FTS5 与 BM25 二选一、better-sqlite3 是向量数据库、所有 SQL 都在 Worker、每天日报都会调用模型形成长期记忆、旧版相似度高就可以覆盖当前版本。出现任一项仍需复练。

### 8.2 代码和证据的最短复核路线

| 问题 | 代码／记录 |
| --- | --- |
| 压缩时机、保留内容和恢复 | [agentRuntime](../../../src/main/agent/agentRuntime.ts)、[contextCompiler](../../../src/main/agent/contextCompiler.ts)、[chatContextService](../../../src/main/agent/chatContextService.ts)、[runtimeCheckpoint](../../../src/main/agent/runtimeCheckpoint.ts) |
| Cognition 完整字段与实际投影 | [Schema](../../../src/shared/schemas/cognition.ts)、[Repository](../../../src/main/cognition/cognitionRepository.ts)、[Projection](../../../src/main/cognition/cognitionProjection.ts)、[输入物化](../../../src/main/agent/cognitionContext.ts) |
| FTS、候选、版本资格与最终重读 | [memoryRecallRepository](../../../src/main/memory/memoryRecallRepository.ts)、[memoryRecallPipeline](../../../src/main/memory/memoryRecallPipeline.ts)、[历史处置](../../../src/main/memory/memoryRevisionHistory.ts) |
| 扫描线程与相似度 | [线程实现](../../../src/main/memory/memoryVectorSearch.worker.ts)、[消息与取消](../../../src/main/memory/memoryVectorSearchWorker.ts)、[扫描与堆](../../../src/main/memory/memoryVectorSearch.ts) |
| Activity 全链 | [CaptureCoordinator](../../../src/main/activity/activityCaptureCoordinator.ts)、[Service](../../../src/main/activity/activityService.ts)、[Repository](../../../src/main/activity/activityRepository.ts)、[聚合规则](../../../src/main/activity/activityDistillation.ts)、[模式查询](../../../src/main/activity/activityRecall.ts) |
| 实验具体证据 | [编码器选择](../../benchmarks/LOCAL-MEMORY-ENCODER.md)、[融合选择](../../benchmarks/MEMORY-RANK-FUSION.md)、[Activity 聚合选择](../../benchmarks/activity-distillation.md) |

本轮核对源码与已有测试定义，没有运行产品测试、Electron、真实模型或历史 benchmark。仅执行简化 FTS／版本资格教学 SQL 及文档结构检查，不将它们表述为上述产品链路已重新验收。
