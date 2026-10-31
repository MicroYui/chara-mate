# 13 证据索引与本次验证记录

外部资料检索从 2026-10-19 起，本地源码与资料复核补充至 2026-10-28（Asia/Shanghai）；各轮范围见下文。CharaMate Git 基线：`8e50d50f47fd961fbed9174d76f145a5e22b58d1`。历史实验的源码 hash、模型/硬件和日期沿用各自记录，不能用本 Git SHA 替换它们。

## 1. 权威文档与学习动机

| 文件 | 在本套材料中的用途 |
| --- | --- |
| [REFACTOR_PRODUCT_DESIGN](../../../REFACTOR_PRODUCT_DESIGN.md) | 产品行为、统一 Run/Item、连续认知、Memory 与工具边界；重点 §1.6、§4–7 及相关领域合同 |
| [CHARA_MATE_UI_DESIGN](../../../CHARA_MATE_UI_DESIGN.md) | Chat/Run/Voice/Memory 的用户可见过程；后台完成与可见反馈不能混淆 |
| [研究设计](../../../refactor-architecture-decisions-2026-07-31.md) | 候选比较、Decision 与实验纪律；不以研究候选 代替生产默认 |
| [STATUS](../../progress/STATUS.md)、[ROADMAP](../../progress/ROADMAP.md) | 当前状态与里程碑边界；本次只增补文档工作包 |
| [认知与生活研究](../../research/ai-companion-cognition-and-life-2026-09-15.md) | 目标维持、注意、角色经历的研究动机；历史建议与后来实现分开 |
| [记忆研究](../../research/ai-companion-memory-research-2026-09-15.md) | 形成、检索、使用和长期连续性的研究问题，不直接当当前选型 |
| [本地成熟度验收](../../progress/LOCAL_MATURITY_ACCEPTANCE.md) | 原场景、设备与版本分母；失败、未判定与未复测边界 |

## 2. 关键主张 → 当前代码 → 测试证据

测试链接指向可复核的测试定义，不表示本次运行了这些测试集。

| 主张/主题 | 当前代码入口与定位词 | 测试或核验入口 |
| --- | --- | --- |
| 文字 Run 生命周期与 Steering | [agentRuntime.ts](../../../src/main/agent/agentRuntime.ts)：`#start`、`steer`、`#drive`、`#executeTool`、`#refreshCognitionContext` | [Agent 目录](../../../src/main/agent) 的 模块旁的测试；[集成目录](../../../tests/integration) |
| Run 整理、Chat 摘要与恢复边界 | [contextCompiler](../../../src/main/agent/contextCompiler.ts)、[chatContextService](../../../src/main/agent/chatContextService.ts)、[checkpointRepository](../../../src/main/agent/checkpointRepository.ts)、[inputBudget](../../../src/main/providers/inputBudget.ts) | [精确测量定义](../../../src/main/agent/contextCompilerExactInput.unit.test.ts)、[运行机制定义](../../../src/main/agent/runtimeMechanics.unit.test.ts)、[Chat 预算集成定义](../../../tests/integration/chatContextBudget.test.ts)；第 15 章第 1 节 |
| Activity 捕获、读取和日周规则聚合 | [捕获协调器](../../../src/main/activity/activityCaptureCoordinator.ts)、[Service](../../../src/main/activity/activityService.ts)、[聚合](../../../src/main/activity/activityDistillation.ts)、[模式搜索](../../../src/main/activity/activityRecall.ts) | [蒸馏测试定义](../../../src/main/activity/activityDistillation.unit.test.ts)、[文字观察测试定义](../../../src/main/activity/activityTextObservation.unit.test.ts)、[活动搜索测试定义](../../../src/main/activity/activityRecall.unit.test.ts)；第 15 章第 5 节 |
| 先提交事件再发布 | [runRepository.ts](../../../src/main/agent/runRepository.ts)：`appendEvent`；[runEventService.ts](../../../src/main/agent/runEventService.ts)：`append` | 真实事务、重复 sequence 与 projection 的实现边界 |
| 无进展检测 | [loopGuard.ts](../../../src/main/agent/loopGuard.ts) | [Harness 决定](../../benchmarks/harness-loop.md) 与对应 focused tests |
| 模式/审批区分 | [approvalPolicy.ts](../../../src/main/agent/approvalPolicy.ts)：`toolAllowedInExecution`、`requiresApproval` | [Tool Registry tests](../../../src/main/tools/toolRegistry.unit.test.ts) 与执行集成 |
| 事件接入与无额外分类的当前上下文 | [cognitionService.ts](../../../src/main/cognition/cognitionService.ts)：`ingest`、`prepareTurn`、`yieldToUser`、`drain` | [当前用户来源](../../../src/main/cognition/cognitionCurrentUserSource.unit.test.ts)、[对话上下文](../../../src/main/cognition/cognitionConversationContext.unit.test.ts) |
| 本轮已读实体版本的事务校验 | [cognitionRepository.ts](../../../src/main/cognition/cognitionRepository.ts)：`commitAnalysis` | [部分 Intent 依据](../../../src/main/cognition/cognitionPartialIntentGrounding.unit.test.ts)、[Intent 完成](../../../src/main/cognition/cognitionIntentCompletion.unit.test.ts) |
| 桌面事件的实际生产与接入 | [Main 装配](../../../src/main/index.ts)、[捕获协调器](../../../src/main/activity/activityCaptureCoordinator.ts)、[ActivityService](../../../src/main/activity/activityService.ts)、[CognitionRuntime](../../../src/main/app/cognitionRuntime.ts)：setEventListener、observeActivity、observeRun、itemEvidence | 第 03 章第 3–5 节；活动保存与认知接入的事务边界分别说明 |
| 两层串行与持久化到期检查 | [AutomationScheduler](../../../src/main/automations/automationScheduler.ts)：refresh、#runChecks；[CognitionService](../../../src/main/cognition/cognitionService.ts)：runDue、schedule、drain | [调度器测试](../../../src/main/automations/automationScheduler.unit.test.ts)、[到期恢复测试](../../../src/main/cognition/cognitionDueRecovery.unit.test.ts) |
| 重叠输入、迟到分析与补检索边界 | [CognitionService](../../../src/main/cognition/cognitionService.ts)：yieldToUser、drain；[行动检查](../../../src/main/cognition/cognitionActionReadSet.ts)：receivedThroughSequence | [当前用户来源测试](../../../src/main/cognition/cognitionCurrentUserSource.unit.test.ts)：keeps takeover cancellation、keeps the original receipt boundary through recall |
| 模型实际读取范围与有限提议修复 | [快照读取](../../../src/main/cognition/cognitionSnapshotReader.ts)、[ModelCognitionDriver](../../../src/main/cognition/cognitionDriver.ts)：sourceCoverage、currentUserSource、correctionRequest | [当前用户回答测试](../../../src/main/cognition/cognitionCurrentUserResponse.unit.test.ts)、[Driver 测试](../../../src/main/cognition/cognitionDriver.unit.test.ts) |
| 选中行动的实际依赖 | [cognitionActionReadSet.ts](../../../src/main/cognition/cognitionActionReadSet.ts) | [ActionReadSet 测试](../../../src/main/cognition/cognitionActionReadSet.unit.test.ts) |
| 自主 dispatch/绑定/发布资格 | [cognitionRuntime.ts](../../../src/main/app/cognitionRuntime.ts)：`actionFreshness`、`publishCompleted` | [Cognition Runtime 集成](../../../tests/integration/cognitionRuntime.test.ts) |
| 普通 Chat 的已提交背景与选择范围 | [Service](../../../src/main/cognition/cognitionService.ts)：prepareTurn；[快照读取](../../../src/main/cognition/cognitionSnapshotReader.ts)：readConversationContext；[投影](../../../src/main/cognition/cognitionProjection.ts)：projectCognitionContext；[Agent 输入](../../../src/main/agent/cognitionContext.ts)：createCognitionContextInput | [对话上下文测试](../../../src/main/cognition/cognitionConversationContext.unit.test.ts)；第 03 章第 27 节说明当前未按 chatId/currentInput 语义路由 |
| 主动邀请与同一 Chat 的后续回合 | [主动界面](../../../src/main/journey/proactiveConversationSurface.ts)：reply、#engage、observeRun；[ChatService](../../../src/main/chat/chatService.ts)：createProvisional、establishProvisional、discardProvisional | [主动界面测试](../../../src/main/journey/proactiveConversationSurface.unit.test.ts)：首条回复、语音、到期与返回完整 Chat；只读定义，未运行 |
| 跨应用事项与共同参与边界 | [认知指令](../../../src/main/cognition/cognitionDriver.ts)、[Agent 常驻指令](../../../src/main/agent/agentInstructions.ts) | 区分物理前台与持续事项；主动开口不自动建立 Together Session；第 03 章第 28 节是据此构造的教学轨迹 |
| 记忆工作入队与交接确认 | [cognitionMemoryBridge.ts](../../../src/main/app/cognitionMemoryBridge.ts) | [Bridge 集成](../../../tests/integration/cognitionMemoryBridge.test.ts) |
| 无参数记忆工具与实际来源窗口 | [memoryTool.ts](../../../src/main/memory/memoryTool.ts)、[runMemoryIntake.ts](../../../src/main/app/runMemoryIntake.ts)、[ChatRepository](../../../src/main/chat/chatRepository.ts)：memoryFormationMessageReferences | [Run 来源窗口集成](../../../tests/integration/runMemoryIntake.test.ts)、[规范来源测试](../../../src/main/app/memoryFormationSources.unit.test.ts) |
| 规范原文、主要来源与可恢复切片 | [memoryFormationSources.ts](../../../src/main/app/memoryFormationSources.ts)、[memoryFormationRepository.ts](../../../src/main/memory/memoryFormationRepository.ts)、[memoryFormationSegments.ts](../../../src/main/memory/memoryFormationSegments.ts) | 来源身份、raw_digest、UTF-16 窗口、sourceCoverage、nextCursor；第 04 章第 3–5 节 |
| 形成模型提议与字段来源 | [memoryModels.ts](../../../src/main/memory/memoryModels.ts)：MemoryFormationBatchSchema、ModelMemoryFormation；[语义 Schema](../../../src/shared/schemas/memoryRecall.ts) | 第 04 章的两条完整提议、Provider 输出与内部对象差别、字段归属；[形成请求集成](../../../tests/integration/memoryFormationRequest.test.ts) |
| 逐表提交、引文定位与默认值 | [memoryFormationService.ts](../../../src/main/memory/memoryFormationService.ts)：#prepare；[memoryRepository.ts](../../../src/main/memory/memoryRepository.ts)：#insertMemory、#indexRevision；[memoryRecallRepository.ts](../../../src/main/memory/memoryRecallRepository.ts)：putSemantics、addSpan | [形成服务测试](../../../src/main/memory/memoryFormationService.unit.test.ts)：批次原子性、同版新支持、当前基线、片段续跑和迟到提议；第 04 章第 9–17 节 |
| 手动修订与 unresolved | [memoryService.ts](../../../src/main/memory/memoryService.ts)：`revise` | [Memory 集成](../../../tests/integration/memory.test.ts) |
| 异步形成、批次校验、版本冲突与恢复 | [memoryFormationService.ts](../../../src/main/memory/memoryFormationService.ts)：`MemoryFormationInputChangedError`、`MemoryFormationValidationError` | [Formation 请求](../../../tests/integration/memoryFormationRequest.test.ts)、[处理器恢复](../../../tests/integration/memoryFormationProcessorRecovery.test.ts) |
| 前一修订、旧内容处置与派生依据 | [memoryRevisionHistory.ts](../../../src/main/memory/memoryRevisionHistory.ts) | [History 测试](../../../src/main/memory/memoryRevisionHistory.unit.test.ts) |
| 局部巩固、独立来源与 inference | [memoryConsolidation.ts](../../../src/main/memory/memoryConsolidation.ts) | [巩固预算](../../../tests/integration/memoryConsolidationBudget.test.ts)、[巩固恢复](../../../tests/integration/memoryConsolidationRecovery.test.ts) |
| 按问题/通道轮转、最终同版重读 | [memoryRecallPipeline.ts](../../../src/main/memory/memoryRecallPipeline.ts)：`rankFusion`、`readFinal` | [Recall 测试](../../../src/main/memory/memoryRecallPipeline.unit.test.ts)、[证据读取](../../../src/main/memory/memoryEvidenceRead.unit.test.ts) |
| 精确 Memory 引用及历史向量索引 | [memoryRecallRepository.ts](../../../src/main/memory/memoryRecallRepository.ts)：`finishIndex`、`validateEvidenceReferences` | Recall/History 测试与 [向量修订记录](../../benchmarks/MEMORY-VECTOR-REVISION.md) |
| 精确余弦扫描与工作线程 | [memoryVectorSearch.ts](../../../src/main/memory/memoryVectorSearch.ts)、[worker](../../../src/main/memory/memoryVectorSearchWorker.ts) | [扫描测试](../../../src/main/memory/memoryVectorSearch.unit.test.ts)、[worker 测试](../../../src/main/memory/memoryVectorSearchWorker.unit.test.ts) |
| 证据“已供给”追踪 | [memorySuppliedReferences.ts](../../../src/main/agent/memorySuppliedReferences.ts) | [Run Memory provenance](../../../src/main/agent/runMemoryProvenance.unit.test.ts) |
| Persona 的字段、版本、表达与事实边界 | [Schema](../../../src/shared/schemas/persona.ts)、[Service](../../../src/main/persona/personaService.ts)、[Repository](../../../src/main/persona/personaRepository.ts)、[characterContext.ts](../../../src/main/persona/characterContext.ts)；普通 Text 在 agentRuntime 的 start 获取快照，Voice 另取声音配置 | [CharacterContext 测试](../../../src/main/persona/characterContext.unit.test.ts)、[Persona 集成测试](../../../tests/integration/persona.test.ts)；第 16 章第 1 节，禁语字段属于提示约束，不能当作已实现的输出拦截器 |
| 语音生命周期与模型身份 | [voiceService.ts](../../../src/main/voice/voiceService.ts)、[WebRtcVoiceDriver](../../../src/renderer/features/voice/WebRtcVoiceDriver.ts) | [Voice Driver 测试](../../../src/renderer/features/voice/WebRtcVoiceDriver.component.test.tsx) 与 Voice Decision |
| 触发式草稿与模型 replay | [evolutionTrigger.ts](../../../src/main/evolution/evolutionTrigger.ts)、[evolutionReviewer.ts](../../../src/main/evolution/evolutionReviewer.ts)、[evolutionService.ts](../../../src/main/evolution/evolutionService.ts) | [Trigger 测试](../../../src/main/evolution/evolutionTrigger.unit.test.ts)、[Reviewer 测试](../../../src/main/evolution/evolutionReviewer.unit.test.ts) |
| 记忆索引的表与约束 | [cognitiveMemory.ts](../../../src/main/db/schema/cognitiveMemory.ts)：修订、分块、向量任务、维度约束 | 第 05 章的实体关系与迟到结果推演 |
| 中文词法索引 | [memorySearchText.ts](../../../src/main/memory/memorySearchText.ts)：分词、相邻汉字词组、去重 | [召回中的词法与无索引读取测试](../../../src/main/memory/memoryRecallPipeline.unit.test.ts) |
| 修订提交时建立索引工作 | [memoryRepository.ts](../../../src/main/memory/memoryRepository.ts)：`#indexRevision`；[召回仓库](../../../src/main/memory/memoryRecallRepository.ts)：`scheduleIndex`、`finishIndex` | [Recall 测试](../../../src/main/memory/memoryRecallPipeline.unit.test.ts) 与本地成熟度中的调度修复 |
| 本地分词、分块、模型身份和编码 | [localEmbedding.ts](../../../src/main/providers/localEmbedding.ts)、[资源清单](../../../src/main/providers/localEmbeddingResources.ts) | [编码器选择](../../benchmarks/LOCAL-MEMORY-ENCODER.md)；当前打包资源的平台范围也要单独检查 |

### 2.1 一面后六问的新增定位

| 主张 | 源码／历史记录 | 本轮边界 |
| --- | --- | --- |
| 普通 record／search 与后台交接不同 | [memoryTool](../../../src/main/memory/memoryTool.ts)、[cognitionMemoryBridge](../../../src/main/app/cognitionMemoryBridge.ts)、[cognitionMemoryIntake](../../../src/main/app/cognitionMemoryIntake.ts)、[cognitionMemoryHandoff](../../../src/main/cognition/cognitionMemoryHandoff.ts)、[共用指令](../../../src/main/agent/agentInstructions.ts) | 核对入口、同事务入队／确认、形成在提交后启动；没有运行形成模型 |
| 原生语音与转写门控、审批关麦 | [Azure会话](../../../src/main/voice/azureWebRtcSession.ts)、[VoiceService](../../../src/main/voice/voiceService.ts)、[WebRtcVoiceDriver](../../../src/renderer/features/voice/WebRtcVoiceDriver.ts) | 当前 WebRTC 取消／clear、截断回执与旧手工 truncate 区分；设备体验未重测 |
| 主动间隔、退避、展示与反馈 | [策略](../../../src/main/journey/companionInitiativePolicy.ts)、[仓储](../../../src/main/journey/companionInitiativeRepository.ts)、[surface](../../../src/main/journey/proactiveConversationSurface.ts)、[运行时](../../../src/main/app/cognitionRuntime.ts)、[准入](../../../src/main/cognition/cognitionProjection.ts) | 核对默认档位、最近三条历史、实际 offered 与 replied；不是长期体验实测 |
| 本地诊断与未来多用户运营 | [logger](../../../src/main/observability/logger.ts)、[RuntimeObservability](../../../src/main/observability/runtimeObservability.ts)、[VoiceMetrics](../../../src/main/voice/voiceMetrics.ts)、[ProductMetrics](../../../src/main/observability/productMetrics.ts) | 当前是本地能力；遥测、集中问题平台和分批发布为方案 |
| 检索演进不是一场整体胜利 | [早期检索](../../benchmarks/memory-retrieval.md)、[编码器](../../benchmarks/LOCAL-MEMORY-ENCODER.md)、[融合](../../benchmarks/MEMORY-RANK-FUSION.md)、[范围修复](../../benchmarks/MEMORY-RECALL-STRUCTURED-SCOPE.md) | 原始分母和未启用通道保留；没有取得并重跑仓外原始实验 |

## 3. 选型与失败记录导航

| 需要解释的取舍 | 直接记录 |
| --- | --- |
| 按需规划、循环检测、压缩与原始判定 | [HARNESS-LOOP](../../benchmarks/harness-loop.md) |
| 长尾发现、核心原语与身份范围 | [TOOL-DISCOVERY](../../benchmarks/tool-discovery.md)、[身份范围修正](../../benchmarks/TOOL-DISCOVERY-IDENTITY-SCOPE.md) |
| 完整分析依赖与行动依赖分离 | [COGNITION-ACTION-CONTEXT](../../benchmarks/COGNITION-ACTION-CONTEXT.md)、[实际快照接收边界](../../benchmarks/COGNITION-ACTION-RECEIPT-BOUNDARY.md) |
| 更复杂 Appraisal 未形成端到端收益 | [COGNITION-APPRAISAL-MODELING](../../benchmarks/COGNITION-APPRAISAL-MODELING.md) |
| 稳定 Persona 与动态 Character State 的 12 例比较及评审边界 | [CHARACTER-DIALOGUE](../../benchmarks/character-dialogue.md)；Codex 逐例评审，不是独立人类双标 |
| 普通新会话是否主动回忆 | [MEMORY-COLD-INFORMATION-DEPENDENCY](../../benchmarks/MEMORY-COLD-INFORMATION-DEPENDENCY.md) |
| 形成引用子片段、出处和资格 | [MEMORY-HISTORY-DISPOSITION-SPAN](../../benchmarks/MEMORY-HISTORY-DISPOSITION-SPAN.md) |
| 巩固覆盖、共享检索、独立来源 | [MEMORY-ADAPTIVE-CONSOLIDATION](../../benchmarks/MEMORY-ADAPTIVE-CONSOLIDATION.md) |
| 候选融合与覆盖 | [MEMORY-RANK-FUSION](../../benchmarks/MEMORY-RANK-FUSION.md) |
| 4B/512、量化、MRL、100k 与复杂度 | [LOCAL-MEMORY-ENCODER](../../benchmarks/LOCAL-MEMORY-ENCODER.md) |
| SQLite 与旧存储选型边界 | [memory-storage](../../benchmarks/memory-storage.md)；当前 pragma 以 [database.ts](../../../src/main/db/database.ts) 为准 |
| 提前自然回应和完整提交的代价 | [TEXT-MEMORY-ACK-ORDER](../../benchmarks/TEXT-MEMORY-ACK-ORDER.md) |
| 原生语音与串行 Tool continuation | [VOICE-ARCHITECTURE](../../benchmarks/voice-architecture.md)、[VOICE-TOOL-JOIN](../../benchmarks/voice-tool-join.md)、[工具身份](../../benchmarks/VOICE-TOOL-CALL-IDENTITY.md) |
| 有限制的多 Agent 与结果后取舍 | [MULTI-AGENT](../../benchmarks/multi-agent.md) |
| Review 草稿、接受与 Skill replay | [SELF-EVOLUTION](../../benchmarks/self-evolution.md) |
| 早期形成与后续实际接入 | [memory-formation](../../benchmarks/memory-formation.md) |
| 原始来源何时可以清理 | [MEMORY-CANONICAL-RETENTION](../../benchmarks/MEMORY-CANONICAL-RETENTION.md) |
| 早期词法/混合检索比较 | [memory-retrieval](../../benchmarks/memory-retrieval.md) |
| 向量计算迁出主线程 | [MEMORY-VECTOR-EXECUTION](../../benchmarks/MEMORY-VECTOR-EXECUTION.md) |
| 图结构是否有必要 | [memory-graph](../../benchmarks/memory-graph.md) |

阅读 Decision 先看当前决定及后继修订，再看原实验。原候选结果需要保留，但不能把文件里出现过的所有机制都当当前生产路径。

### 3.1 重要数字怎样复核

先找到表格所在的实验，再读前面的任务定义和后面的限制。不能在多个历史阶段之间挑选最漂亮的数字拼成一个成绩。

| 主题 | 本套使用的结果 | 读原记录时必须同时确认 |
| --- | --- | --- |
| 按需规划 | 600 个配对任务完成 585 与 586 个；工具选择完全符合预期 512/520 与 509/520 | 业务成功、工具正确和首响应是不同指标 |
| 认知 Appraisal | 四组故事共 16 个检查点，局部 14/16 与 15/16，完整流程均 11/16 | 检查点相关，成本与新增实现复杂度 |
| 编码模型与维度 | 60 条记忆、28 个问题，两组最终选择均 27/28 | 小开发集、候选覆盖、标签歧义，未测最终答案 |
| 候选融合 | 主比较均 27/28，压力比较必要证据出现数为 2/7 与 7/7 | 七个证据出现项不是七个独立最终答案 |
| 自进化触发 | 正例 12/16 到 16/16，总体 26/30 到 30/30 | 任务集合、负例和触发漏检，不能等同长期学习收益 |
| 技能草稿模拟复盘 | 注入的 10 个坏补丁挡住 5 个 | 模型模拟没有真实执行，不足以独立担保正确性 |
| 原 d01 修正 | 25 个候选选 13 个；完整轨迹 71.066 秒、7 次生成 | 历史真实场景、原失败保留，单次修正不外推总体 |
| 十万条索引 | 真实编码约 10003.784 秒，另有形成与整合待办 | 索引完成不等于所有语义处理已追平 |
| 文档教学演算 | 100 例配对、曝光分母、NPC 容量 | 为解释方法人工构造，绝不能称为历史实测 |

### 3.2 读懂一份决定的顺序

先读当前决定，找后续修订；再确认原问题和候选究竟改变了什么；然后读输入规模、设备、模型、成功定义与异常处理；最后看结果、失败样本和选择理由。对每个数字写出完整中文含义，不能只抄表头。

如果要复现实验，继续核对数据与源码标识、是否还能取得模型版本、原始证据存放方式和候选代码是否已经删除。本仓库按规则删除了已结束的实验实现，文档能够支撑理解不代表当场运行一条命令就能重现所有历史结果。重新实验需要独立工作包，不在此次写作范围内。

## 4. 外部一手来源登记

E01–E34 的首次访问日期为 2026-10-19 至 2026-10-20；E35–E36 于 10 月 24 日补读。10 月 25 日复核 E18 的 MATCH／BM25，补读 E37–E38。正文直接承担讲解，链接用于复核。页面未来可能变化；未固定 commit 的 OSS 仍只作为官方功能入口，不称为逐行源码审计。

| ID | 来源与版本/日期 | 本次使用范围与限制 |
| --- | --- | --- |
| E01 | Miller & Cohen，[PFC 原论文](https://web.math.princeton.edu/~sswang/literature_general_unsorted/miller_cohen01_annu_rev_neurosci_prefrontal-theory.pdf)，2001 | 已读目标维持、Stroop 与控制要求相关正文；理论综述不提供软件架构或阈值 |
| E02 | Sridharan 等，[网络切换论文](https://cns.iisc.ac.in/sridhar/assets/publications/Devarajan_PNAS_2018.pdf)，2008 | 已核对三组实验 18/13/22 人、时间分析与 Granger 方法；文件名含 2018，论文实际为 2008，不把方向性统计当直接干预 |
| E03 | McClelland 等，[互补学习原论文](https://web.stanford.edu/~jlmcc/papers/McCMcNaughtonOReilly95.pdf)，1995 | 本轮成功取得原 PDF，读快速学习、干扰和整合的相关正文，核对 433–435 页企鹅实验并查看图 11；不把网络权重实验等同数据库设计 |
| E04 | Jeff Orkin，[F.E.A.R.，GDC 2006](https://gdcvault.com/play/1013459/Three-States-and-a-Plan) | 官方演讲说明，规划/FSM；不是 LLM 系统 |
| E05 | Michael Booth，Valve，[Left 4 Dead 讲义](https://cdn.fastly.steamstatic.com/apps/valve/2009/ai_systems_of_l4d_mike_booth.pdf)，2009 | 原始 95 页讲义中动作、感知与节奏章节；不是玩家情绪精确测量 |
| E06 | Ubisoft，[Neo NPC](https://news.ubisoft.com/en-ca/article/5qXdxhshJBXoanFZApdG3L)，2024-03-19 | 官方研发原型介绍，不作商业上线效果证据 |
| E07 | Ubisoft，[Teammates 中文官方介绍](https://zh-cn.ubisoft.com/news_detail?id=4286)，2025-11-24 | 可玩原型与封闭测试，不推断未公开技术栈细节 |
| E08 | Park 等，[Generative Agents v2](https://arxiv.org/abs/2304.03442v2)，2023-08-06 | 正文中的检索、反思、规划与受控评测；模拟结果，不外推长期真人效果 |
| E09 | Yao 等，[ReAct v3](https://arxiv.org/abs/2210.03629v3)，2023-03-10 | 已读正文的推理/行动/观察机制；不提供产品事务和恢复保证 |
| E10 | Wang 等，[Voyager v2](https://arxiv.org/abs/2305.16291v2)，2023-10-19 | 课程、技能和反馈研究；不等同 NPC 社交质量 |
| E11 | Vezhnevets 等，[Concordia v2](https://arxiv.org/abs/2312.03664v2)，2023-12-13 | Agent/环境结果分离思想；不直接采用 LLM 裁决奖励 |
| E12 | Shinn 等，[Reflexion v4](https://arxiv.org/abs/2303.11366v4)，2023-10-10 | 已读第 3 节执行者、评估者、反思与记忆；文字经验不混同权重训练 |
| E13 | Maharana 等，[LoCoMo](https://aclanthology.org/2024.acl-long.747/)，ACL 2024 | 多 session 长对话评测方向；不是当前项目成绩 |
| E14 | Wu 等，[LongMemEval v2](https://arxiv.org/abs/2410.10813v2)，2025-03-04 | 500 问题与五类能力；指标必须带数据/版本 |
| E15 | Liu 等，[Lost in the Middle v3](https://arxiv.org/abs/2307.03172v3)，2023-11-20 | 位置敏感性的压力测试启发；不对新模型作未测断言 |
| E16 | Qwen，[4B 模型卡](https://huggingface.co/Qwen/Qwen3-Embedding-4B)、[技术报告 v3](https://arxiv.org/abs/2506.05176v3)，2025 | MRL 与模型规格；具体本地选择由 CharaMate Decision 支撑 |
| E17 | SQLite，[WAL](https://sqlite.org/wal.html) | 官方事务/日志机制；项目 pragma 另核源码 |
| E18 | SQLite，[FTS5](https://sqlite.org/fts5.html)，2026-10-25 复核 MATCH 与 bm25 章节 | 词法索引与评分函数、较小分数优先；具体中文预分词和最终融合另按项目代码解释 |
| E19 | [Letta 官方仓库](https://github.com/letta-ai/letta)，当日 README | 当前源入口变化；未审计新仓库全部实现 |
| E20 | [Mem0 官方仓库](https://github.com/mem0ai/mem0)，当日 README | Memory 层与作用域接口研究；不采信未复现性能为自有结果 |
| E21 | [Graphiti 官方仓库](https://github.com/getzep/graphiti)，当日 README | 时间事实、来源与图检索入口；未作独立 benchmark |
| E22 | [云栖大会官方页](https://yunqi.aliyun.com/2026/session?agendaId=187)，2026 活动入口 | 动态页当前未取得完整技术讲稿；不支持声称米哈游内部具体架构 |
| E23 | Malkov 与 Yashunin，[HNSW 原论文](https://arxiv.org/abs/1603.09320) | 分层近邻图的机制与待比较维度；项目当前未采用 ANN |
| E24 | NIST，[二项比例置信区间](https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm) | Wilson 区间和小样本比例解释；不替代配对与相关性分析 |
| E25 | Rafailov 等，[DPO 原论文](https://arxiv.org/abs/2305.18290) | 偏好训练方法的适用问题；不宣称本项目已训练 |
| E26 | Peter Higley，Monolith，[GOAP 工业讲义](https://media.gdcvault.com/gdc2015/presentations/Higley_Peter_Goal-Oriented_Action_Planning.pdf)，GDC 2015 | 完整讲义文本；前提/效果、反向搜索、减少变量与专门系统分工；教学送餐例子由我们设计 |
| E27 | OpenAI，[Introducing dots](https://openai.com/index/introducing-dots/)，2026-09-29 | 发布时间与持续责任定位；产品文章不证明内部数据库或算法 |
| E28 | OpenAI，[Dot Tasks and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory)，2026-10-20 读取，10-27 复核 | 自有笔记、持续责任、跨联系渠道和主动研究的公开行为；后台研究不直接发消息，不据此推断内部算法 |
| E29 | OpenAI，[Dot Controls](https://learn.chatgpt.com/docs/dots/controls)，访问于 2026-10-20 | 已读完整页面；主动研究、行动与停止范围；不把相关政策扩成 CharaMate 新权限体系 |
| E30 | OpenAI，[Dot Computers and apps](https://learn.chatgpt.com/docs/dots/computers-and-apps)，访问于 2026-10-20 | 已读完整页面；环境归属、连接与在线条件，不证明无损任务迁移 |
| E31 | OpenAI，[Dot October update](https://learn.chatgpt.com/docs/whats-new/dots-october-9-2026)，2026-10-05 至 09 | 已读完整更新；续接任务、多余通知和恢复改进，未提供量化收益 |
| E32 | OpenAI，[Codex as a platform](https://developers.openai.com/blog/codex-as-a-platform)，2026-08-19 | 已读技术文章；Harness 与业务产品的职责，不当 Dot 内部实现说明 |
| E33 | OpenAI，[Open Source](https://learn.chatgpt.com/docs/open-source)，访问于 2026-10-20 | 已读官方开源清单；本次未找到可确认的 Dot 完整服务端仓库 |
| E34 | OpenAI，[Codex 固定提交](https://github.com/openai/codex/tree/014489466a1739c2c563cdfe57880c2c7c8680e3)，访问于 2026-10-20 | 已读 TypeScript SDK 的 thread.ts、exec.ts、events.ts，以及 app-server README 相关合同；文件直链见第 14 章，未运行 SDK 或审计整个 Rust 核心 |
| E35 | Epic Games，[Replication Graph](https://dev.epicgames.com/documentation/en-us/unreal-engine/replication-graph-in-unreal-engine)，2026-10-24 读取，页面显示 UE 5.8 | 已读完整页面中的持久分组、空间及角色相关集合；借鉴模型前的兴趣订阅，不把网络复制机制称为 LLM 架构或性能证据 |
| E36 | Epic Games，[Behavior Tree Overview](https://dev.epicgames.com/documentation/en-us/unreal-engine/behavior-tree-in-unreal-engine---overview)，2026-10-24 读取、10-25 复核，页面显示 UE 5.8 | 已读事件驱动、Blackboard 条件观察与中止；用于解释快速动作与较慢语言推理的分工，迁移方案未实测，不证明百毫秒响应 |
| E37 | WiseLibs，[better-sqlite3 官方 README](https://github.com/WiseLibs/better-sqlite3)，2026-10-25 | 已读同步 API、事务、Worker 支持及基本调用说明；本项目锁定 13.0.1，不使用 README 性能宣传充当项目实测 |
| E38 | Node.js，[Worker threads](https://nodejs.org/api/worker_threads.html)，2026-10-25，页面显示 v26.12.1 | 已读线程、CPU 工作和内存交换说明；项目约束 Node 24.18.x，本章仅引用稳定概念，不声称项目已升级到网页版本 |
| E39 | Samuel 等，[PersonaGym v5](https://arxiv.org/html/2407.18416v5)，2025-09-05；2026-10-25 读取 | 已读环境选择、多维任务、评分锚点与人类对照的相关方法和结果；用于设计跨场景角色评测，不把论文评审指标当 CharaMate 实测 |
| E40 | Artstein、Poesio，[Inter-Coder Agreement for Computational Linguistics](https://aclanthology.org/J08-4004.pdf)，2008；2026-10-25 读取 | 已读可靠性与有效性、Cohen's Kappa、类别分布及多标注者讨论；正文混淆表为自行编写的教学演算，不宣称项目有人工一致性结果 |
| E41 | Koedinger、Pavlik、McLaren、Aleven，[Is it Better to Give than to Receive?](https://www.cs.cmu.edu/~aleven/Papers/2008/Koedinger_ea_CogSci2008.pdf)，CogSci 2008；2026-10-25 读取 | 已读 assistance dilemma、稳健学习与示例／练习取舍的相关正文；帮助图与游戏指标是设计推论，论文不提供等待三天等阈值 |
| E42 | Guo 等，[On Calibration of Modern Neural Networks](https://proceedings.mlr.press/v70/guo17a/guo17a.pdf)，ICML 2017；2026-10-25 读取 | 已读分类概率校准、验证集与温度缩放的相关正文；不是给生成式模型自报置信度背书，不把采样温度混为校准温度 |
| E43 | Zheng 等，[Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena v4](https://arxiv.org/html/2306.05685v4)，2023-12-24；2026-10-25 读取 | 已读单答／配对／参考评审与位置、冗长、自偏好的局限；游戏评审需要另外的人类锚点，不能复制其一致性数字 |
| E44 | Anthropic，[Memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)，2026-10-27，接口 memory_20250818 | 已读客户端处理器、存储归属、指令和跨会话流程；工具协议不提供应用语义可靠性保证 |
| E45 | Anthropic，[Effective context engineering](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents)，2025-09-29；10-27读取 | 已读按需检索、混合供给、压缩和结构化笔记相关正文；不把编码场景经验当NPC实测 |
| E46 | Chhikara 等，[Mem0 v1](https://arxiv.org/html/2504.19413v1)，2025-04-28；10-27读取 | 已读抽取／更新、来源窗口、异步摘要及评测设置；不复制其总分为项目成绩 |
| E47 | Lin 等，[Sleep-time Compute v1](https://arxiv.org/html/2504.13171v1)，2025-04-17；10-27读取 | 已读上下文预计算、任务构建、可预测性和函数实现相关正文；不等同每晚定时写记忆 |
| E48 | OpenAI，[Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations)，2026-10-27 | 已读工具结果接续与打断／截断；WebRTC与WebSocket职责不同，当前产品仍按Azure源码核对 |
| E49 | OpenAI，[VAD](https://developers.openai.com/api/docs/guides/realtime-vad)，2026-10-27 | 已读server／semantic VAD、创建与打断响应、会话类型限制；不假定当前deployment支持全部字段 |
| E50 | OpenAI，[Transcription](https://developers.openai.com/api/docs/guides/transcription)，2026-10-27 | 已读相关上下文、keywords／languages及代表性音频测试建议；新模型参数不能套进当前whisper-1 |
| E51 | OpenAI，[Realtime client events](https://developers.openai.com/api/reference/resources/realtime/client-events)，2026-10-27 | 核对官方参数说明中原生音频与异步转写的区别；大型API整页未完整读取，不宣称审计全部事件 |
| E52 | Défossez 等，[Moshi v1](https://arxiv.org/html/2410.00037v1)，2024-09；10-27读取 | 已读多流建模、文本与音频配合、训练及局限相关正文；未部署或评测中文工具Agent |
| E53 | Iqbal、Bailey，[Oasis 原论文](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/TOCHI-Oasis-final.pdf)，TOCHI 2010；10-27读取 | 经Microsoft Research论文页取得，已读任务边界、识别特征、调度与实现部分；不提供NPC冷却参数 |
| E54 | Zhang 等，[Ask Less, Ask Better v1](https://arxiv.org/html/2610.24411v1)，2026-10-17；10-27读取 | 已读注意力成本、记忆辅助自检、对照／消融、结果及限制；英语模拟用户证据不能当中文陪伴体验 |
| E55 | OpenTelemetry，[Traces](https://opentelemetry.io/docs/concepts/signals/traces/)，2026-10-27 | 已读span、event、上下文及异步links；借鉴关联结构，不代表项目已安装或上线OTel |
| E56 | OpenAI，[Evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices)，2026-10-27 | 已读持续评测、数据来源、人工校准与按阶段定位；文档示例阈值不作为项目标准 |
| E57 | Cormack 等，[RRF 作者公开论文](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf)，SIGIR 2009；2026-10-30 读取 | 核对排名倒数求和公式及 pilot 固定 k=60；第 20 章计算为教学例子，不是新的项目实验 |
| E58 | Character.AI，[Smarter Memory for Smarter Chats](https://blog.character.ai/memory/)，2026-05-21；10-30 读取 | Story Memory、固定重要消息与自动 Facts 的公开交互；不据此推断内部检索或长期陪伴效果 |
| E59 | OpenAI，[Models](https://developers.openai.com/api/docs/models)，2026-10-30 | 核对当前目录的 Realtime 2.1；本项目实际部署另据源码和历史验收，用户已确认 2.5 是记忆误差 |
| E60 | Microsoft，[Realtime WebRTC](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio-webrtc)，2026-10-30 | 复核客户端连接与原生音频路径的相关说明；具体字段与已完成验证以当前 Azure 适配器和 Decision 为准 |
| E61 | Lu 等，[Proactive Agent v3](https://arxiv.org/abs/2410.12361v3)，2024-12-03；10-30 复核摘要 | 主动任务预测、接受／拒绝标签与评估；不把其基准成绩当作本项目真人体验 |
| E62 | Du 等，[流式 ProactiveBench v1](https://arxiv.org/abs/2609.12658v1)，2026-09-11；10-30 复核摘要 | 连续响应／沉默、时机窗口、遗漏与重复；本章引用固定 v1，页面另列 v2；与 E61 的同名数据集区分 |

未使用新闻转载或论坛评论替代技术实现的主要依据。外部资料到第 09、14、16–20 章设计的延伸均是我们的推论；E51的整页读取限制单独保留。论文只声明实际阅读的相关部分，不把摘要说成全文审计。

获取边界也保留：CLS 原 PDF 在前轮超时，本轮经作者网站成功取得；部分网页的 Markdown 被浏览工具拒绝后，以同站点公开 Markdown 读取；Codex GitHub API 限流、Git 连接失败后，改由公开仓库页确认提交并读取固定版本原始文件。F.E.A.R. 2006 原 PDF 未取得，不把 GDC 简介称为完整原稿；深入 GOAP 机制依据本轮读到的 2015 Monolith 讲义。

10 月 25 日 PersonaGym 的 ACL PDF 两次超时，随后核对 arXiv 最新版本为 v5 并读取正文，未混用 v3 的模型数量与 v5 结果。2007 年 assistance dilemma 手稿在 CMU 站点返回 403，本章改用作者公开的 2008 年 CogSci 正文并如实标年份。E06 Ubisoft 官方原型介绍已复核，不能从编剧工作流推断其未公开服务架构。

## 5. 本次交付验证

2026-10-22 已沿源码完成第 03 章前 26 节和第 04 章的 27 节记忆全过程。2026-10-24 保留这些内容，在第 03 章追加第 27–29 节：普通 Chat 的认知背景、多个事项与会话归属、主动邀请与接话、Overleaf→查资料→B 站完整轨迹，以及多人 NPC 的订阅、合并、在途判断、公平排队和容量方案。同步 S2、Q09/Q10/Q12、A03、总目录及来源索引。

10 月 19–20 日的外部资料仍按原日期登记，10 月 24 日新读的 Epic 官方页面单独列为 E35–E36，未重查全部旧外链。Overleaf 和多人咖啡馆案例是教学推演，未调用真实模型；容量数字、具体措辞与预期轨迹不属于实测性能或行为成功率。

下表保留 10 月 24 日的检查结果；10 月 25 日新增章节的检查单独列在后面，不将旧数量误作最新目录统计。

| 检查 | 结果与边界 |
| --- | --- |
| 文档结构 | 检查目录现有 17 个 Markdown：16 份主材料与既有侧边问答记录；每份唯一一级标题，111 张表列数一致；围栏闭合，无乱码替换字符、NUL、制表符或尾随空白 |
| 本地链接 | 361 次本地引用均解析到现有文件或目录；36 个外部来源编号连续，目录内共 47 个不同外部 URL。本轮没有统一验证全部外链可达性 |
| 规格覆盖 | R01–R11、A01–A15、Q01–Q72、S1–S11、E01–E36、第 03 章 1–29 节及第 04 章 1–27 节连续且无重复；个人学习验收仍未执行 |
| 示例与图块 | 9 个 JSON 围栏示例通过解析；5 个 Mermaid 围栏检查闭合与图类型，未运行渲染器或截图验收；本轮新增 3 个文本流程块，简化 TypeScript 不当作可编译生产片段 |
| 记忆案例的数据核对 | 保留 10 月 22 日结果：第 04 章 6 个 JSON 示例、两条提议的实体与来源、U1 的 55 个 UTF-16 单元、引文区间 [4,24)、[25,33)，以及示例三张表的 40 个列名均核对过；本轮未修改第 04 章，也未重复其专用字段校验或向产品数据库写示例 |
| 本地代码定位 | 本轮核验 19 个源文件／测试文件的 66 个关键片段，并检查 prepareTurn 未使用 chatId/currentInput 执行路由；覆盖装配、普通背景、主动分配、临时 Chat 与接话。存在性检查只防止定位失效；行为说明依据读到的函数、分支及测试定义，不把字符串匹配冒充运行测试 |
| 关键口径 | 保留前轮状态／行动、代际／恢复、记忆形成／索引的区别；新增物理焦点／持续事项／目标／Chat 的区别，明确当前背景选择的不足、疲劳推断的证据要求，以及定时／事件／准入各自作用 |
| 历史实验与新方案 | 原形成、巩固、存储实验的分母、成本和失败保留；初始 importance／confidence 解释为当前赋值，未虚构校准结果；人物消歧、语义去重和游戏多 worker 仍有明确边界 |
| Git 边界 | git diff --check 与文档独立空白检查通过；改动仅在面试目录及 STATUS 文档工作包，没有生产源、测试、锁文件或依赖改动，未提交或推送 |

未运行 verify:offline、build、Electron E2E、package、真实模型或 benchmark。本轮是文档变更；当前工作区未发现 node_modules/.bin/vitest.cmd，未为文档验收安装依赖。测试表中所有“测试”均指现有测试定义，不冒充本轮运行结果。

仓库 .prettierignore 排除 *.md，没有把格式脚本跳过 Markdown 当作格式通过。文档用单独的 Python 检查链接、表格、标题编号、JSON、围栏、示例字段／引文与空白。既有侧边问答记录纳入结构检查，正文未修改。

### 5.1 2026-10-25：七组连续追问

新增第 15 章，逐条解释压缩时机和两类摘要、三种认知对象的完整字段及实际投影、FTS5/BM25 与向量排序、实验记录中的具体主题、Activity 捕获／保存／日周聚合、Worker 线程及多版本读取。同步总目录、S1/S2/S4 衔接、02/05 章导航和 A05 验收。

独立文档检查通过：18 份 Markdown（17 份主材料与既有侧边问答记录）、425 次本地引用、126 张表、9 个可解析 JSON；围栏与编号连续，E01–E38 齐全，49 个不同外部 URL。未统一复查所有外链，也未运行 Mermaid 渲染器。

源码定位检查覆盖 26 个文件、77 个关键片段。另从真实 Schema 提取 Situation 的 16 个、Intent 的 19 个、AttentionState 的 13 个顶层字段，核对本章字段表没有遗漏；这只验证说明与字段对应，不是模型更新正确性的运行测试。

执行了第 15 章简化 SQL 的内存教学例子：Python 自带 SQLite 3.45.3、三版 FTS 行均保留，当前版本条件只返回 R3。它没有加载 better-sqlite3、没有调用编码器，也不替代产品集成或检索质量实验。未重跑真实模型、benchmark、离线回归、Electron 或构建。

本轮补读来源为 E18/E37/E38，记录原实验的摄影、运动转换与同浏览器任务区分案例；没有取得外部冻结语料的全部原文，人工示例明确标注。git diff --check 与文档独立空白检查通过；没有生产源、测试、依赖或锁文件变更，未提交或推送。

### 5.2 2026-10-25：NPC 对话、提示与评测七组追问

新增第 16 章，沿源码说明 Persona 的 13 个设定字段、3 个版本字段、3 张表、Run／Voice 快照及真实 12 例比较，再展开未知问题、战斗有效指令、卡关提示、百 NPC 一致性、标注与 Kappa、游戏版本知识和实际评测回流。各游戏流程均为方案，提示台词、版本与阈值数据均为教学例子。同步总目录、S2/S7/S8/S9/S11、A08–A12 和相关章节导航，个人学习未验收。

文档独立检查通过：19 份 Markdown、454 次本地引用、146 张表、10 个可解析 JSON，55 个不同外部 URL；标题、围栏、空白及 R/S/Q/A/E 编号通过，来源 E01–E43 连续，第 16 章 1–10 节完整。没有统一探测全部旧外链，也没有运行 Mermaid 渲染器。

本轮阅读并核对 13 个源码、测试及历史记录文件的 45 个定位片段；Persona 表逐一覆盖 Schema 的 16 个快照字段。定位片段检查只防止引用失效，行为结论来自实际读到的入口、事务、编译和记录，不把它称为运行测试。确认禁语字段仅在角色编译中供给，未发现独立 Persona 输出拦截器；Persona 逐例评审是 Codex，独立连续材料的分区复核不能证明人类双标。

Python 教学演算的 7 项断言通过：两张 Kappa 表分别为 0.70 与 -1/19；三档阈值在两组代价下为 190/230/455 与 290/130/105；快响应示例预算 150 ms；两种标注预算 38 与 58 小时。计算正确不表示这些参数已经过玩家体验或性能验证。

新读原始来源登记为 E39–E43，另复核 E06/E36 的相关官方正文。未重跑真实模型、benchmark、verify:offline、build、Electron E2E 或 package；未安装依赖，也未改生产代码、合同、测试、数据库或锁文件。git diff --check 和文档独立空白检查通过，未提交或推送。

### 5.3 2026-10-28：一面后的六项追问

新增第17–19章：记忆读写的职责与三路演进；原生语音、打断、全双工及ASR；主动聊天的真实策略与发布者问题闭环。同步总目录、SDD学习单元、六项追加验收和相关旧章导航。明确当前审批期间关麦、转写门控、WebRTC截断职责、最近三条主动反馈退避，以及28问没有覆盖第三路的实验限制。没有把个人学习状态预填为通过。

独立文档检查通过：22份Markdown、525次本地引用、169张表、10个可解析JSON、68个不同外部URL；标题、围栏、空白、S1–S11、Q01–Q72、A01–A15及E01–E56编号检查通过，第17／18／19章分别有8／9／12个完整主节。5个既有Mermaid围栏检查闭合，未运行图形渲染；没有统一探测全部旧外链。

源码定位检查覆盖15个文件、52个关键片段，另逐段阅读入口、等待边界、取消与展示分支；字符串检查只用于防止定位失效，不是运行测试。复核了历史检索Hit@8、22题reader、28问选证、语音首音频和3段提示比较的原始记录。Python的5项教学演算断言通过：主动退避、Float32净荷、语料组合数量、CER及两模型权重大小；它们不是新实测成绩。

本轮新增一手来源E44–E56，复核E28；保留论文版本、阅读范围和API整页读取限制。没有取得仓外原始实验并重新运行，没有进行真人听审或长期用户研究。未运行verify:offline、build、Electron E2E、package或付费模型，也未安装依赖、改生产代码／合同／测试／数据库／锁文件。

git diff --check与文档独立检查通过。编写阶段验收时，面试目录整体尚未跟踪，因此不能仅靠git diff检查其内容，本轮单独遍历了所有22份材料；既有侧边问答正文未改。以上记录对应提交前的文档验收。

### 5.4 2026-10-30：四条优化故事

新增第 20 章，把记忆、语音、认知注意与主动陪伴各写成第一人称口述稿，并展开起点、失败定位、研究启发、实现、历史实验和补证方案。同步 README、学习安排和四项闭卷练习；用户已确认酒会只记得“超类脑”概念，“陪伴又不打扰”是自己提出的问题，语音版本为 gpt-realtime-2.1。没有代写对方的回答，也没有把待做实验写成已取得的成绩。

本轮文档检查通过：23 份 Markdown、574 次本地引用、182 张表、10 个可解析 JSON、80 个不同外部 URL；一级标题唯一、围栏闭合、空白与字符检查通过。第 20 章主节 0–5 连续，四个专题各有 8／9／10／9 个小节，E01–E62 连续。源码定位检查覆盖 11 个文件、42 个片段，另有 3 项教学计算断言；这些检查验证引用与演算，不替代产品运行测试。检查脚本通过标准输入运行，未增加仓库脚本或依赖。

基线为 9df3c06a377868062a79d2272c99087bfcae79c7；相对前轮 8e50d50f47fd961fbed9174d76f145a5e22b58d1 的 src 差异为空。历史实验按 Decision 与验收记录核对，没有重新访问全部仓外原始证据，没有重跑实验。特别保留：28 问未检验第三路的增益；7 个必要证据槽不是 7 个独立问题；Appraisal 的行为结果有小幅优势而整体验收与复杂度不支持保留；语音早期六个时延数不是 Azure STT/TTS 与 Realtime 的配对比较；48 个主动场景不是 48 位真人。

新补来源 E57–E62，并复核第 20 章使用的官方语音、Dot 页面及相关论文摘要或正文片段，未统一探测全部旧外链。本轮 CLS 作者 PDF 请求超时，使用 PubMed 摘要核对基本主张并沿用既有章节的阅读记录；不把本次摘要复核称为重新读完全文。Dot 与 2026 年 10 月的 Ask Less 作为后续复盘与改进依据，不倒推成 9 月代码的原始来源。

git diff --check 与文档独立空白检查通过。未运行 verify:offline、build、Electron E2E、package、真实模型或 benchmark；本轮仅改面试文档和 STATUS，不改代码、合同、数据库、依赖、算法默认值或既有 Decision，未提交或推送。个人学习验收仍未执行。

## 6. 以后更新材料的方法

先记录新的 Git 基线，重查与变化相关的入口、测试和 Decision；修改当前行为的口径，保留历史数字的原版本。新实验需要自己的一份报告，不能把已知失败改名后混入旧冻结测试集。个人学习状态只在完成相应验收后更新。
