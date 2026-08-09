# CharaMate 当前状态

> 更新日期：2026-08-09

## 当前里程碑

**Phase 3 — Done（2026-08-09）**

Phase 0–3 已完成。结构化输入、多模态图片输入、Memory、Context、Activity 与 Chat/Agent 自动形成均已进入唯一生产路径；跨 Chat 改口使用稳定 claim slot、当前 Run 目标 allowlist 与 Revision 精确更新，缺失目标、错 ID、字段冲突和旧数据首次绑定不会静默制造第二条 active 事实。Phase 6 的 Pet、Territory 基础、结构化 Item Manifest 与 Azure Image 工作包也已独立完成；Memory/Activity 到 Territory 的自动物件提案仍由后继集成包拥有。

退出条件：

- [x] `request_user_input` 是直接核心能力；问题卡支持选项/自由文本、取消、刷新与重启恢复，并在同一 Run 中只消费一次回答。
- [x] 用户图片附件与 `image.inspect` 复用一条 Main-owned 像素管线；支持视觉的 Provider 收到真实图片内容，不支持时返回明确能力错误。
- [x] Memory Revision、有效性、supersede、pin、归档/删除、来源、画像、候选、搜索和 `memory.search` 已贯通 Main、typed IPC 与 UI。
- [x] Chat/Agent 同一 Run 能把用户明确陈述的长期事实或偏好直接形成/修订为有来源 Memory；跨 Chat 改口由稳定语义身份精确定位，错 ID、未命中与冲突不会制造第二条 active 事实。
- [x] 生产只保留 SQLite FTS lexical Retrieval、`C2-PRE8` Context Recipe 和无 Graph 路径；dense、hybrid、rerank、向量表、模型 worker 与 Graph UI 均不存在。
- [x] Activity 采用变化采集、8 分钟确定性 Episode、每日 Digest、每周跨日候选与蒸馏后分层清理；原始 event/截图不进入普通 Memory 检索。
- [x] 数据库 v7、新装与 v4→v5→v6→v7、v5→v6→v7、v6→v7、引用清理、orphan sweep、重启恢复、Memory→Activity 来源跳转和截图证据均完成回归；migration 不猜测旧 Memory 的语义身份。
- [x] 中文 Decision Record、非敏感证据 hash、失败候选删除证明、完整 offline/build/E2E/package/smoke 验收均已完成。

## 工作包状态

| 工作包 | Owner | 状态 | 结果 |
| --- | --- | --- | --- |
| `P3-CONTRACT-INTEGRATION` | `main` | `done` | TypeBox Contract、typed IPC、Run Item 与数据库 v7 收口 |
| `P3-STRUCTURED-INPUT` | `main` | `done` | 直接交互工具、持久化问题卡和 continuation |
| `P3-MULTIMODAL-INPUT` | `main` | `done` | Composer 图片与 `image.inspect` 共用真实像素路径 |
| `P3-MEMORY-DECISIONS` | `main` | `done` | Storage、Retrieval、Context、Graph 四项 Decision 完成 |
| `P3-MEMORY-RUNTIME` / `P3-MEMORY-UI` | `main` | `done` | Revision、Profile、Candidate、Source、Usage 与单一路径检索 |
| `P3-MEMORY-FORMATION` | `main` | `done` | `F2-IN-RUN-TOOL + U2-SLOT-GUARD`；稳定 claim 身份、目标 allowlist、追加/替换、冲突候选化与跨 Chat/重启闭环 |
| `P3-ACTIVITY-DECISIONS` | `main` | `done` | Capture、Distillation、Retention 三项 Decision 完成 |
| `P3-ACTIVITY-CAPTURE` / `DISTILL` / `RETENTION` | `main` | `done` | 采集、Episode/Digest、候选和有界清理 |
| `P3-BENCHMARK` | `main` | `done` | 八份中文记录与仓库外 hash 证据；候选 runner 已删除 |
| `P6-PET-FOUNDATION` / `P6-TERRITORY-BASE` / `P6-TERRITORY-ITEM-MANIFEST` | `main` | `done` | 桌宠、领地场景与单一结构化资产安装入口 |
| `P6-TERRITORY-IMAGE` | `main` | `done` | Azure Generation/Edit、去背景、候选确认/恢复与内建 `territory.generate_item` Tool；Agent 只必填三个语义字段，尺寸、占地、锚点和插槽按同一 manifest 编译 |

当前无外部 blocker。Phase 4 生产实现仍以 `VOICE-ARCHITECTURE`、`VOICE-TRANSPORT`、`VOICE-TOOL-JOIN` 三项 Decision 为 Gate；Automation、独立 Voice 研究和后继 Territory 工作可按 ROADMAP 的所有权边界推进。

后续所有实验继续遵守十进制 **10 GB 实验进程总内存硬上限**：单模型、串行小批、流式落盘；不得为缩短耗时恢复全量 embedding 驻留或并发模型进程。Phase 3 dense 探针已在保守 `RSS + MPS driver < 7 GB` 边界内完成或提前停止，没有常驻实验进程。

## 最近绿色验证

2026-08-09，Phase 3 主线与 Phase 6 Territory Image 合并验收：

- `npm run verify:phase0`：通过，约 85 秒；完整执行 offline、build、开发态 smoke、package、打包态 smoke 与 Electron E2E。
- offline 共 382 项：65 contract、207 focused/component、110 integration；数据库新装与 v4/v5/v6→v7 迁移链、Territory Image Provider/持久化/Tool 均通过。Typecheck、Prettier 与 ESLint 通过，ESLint 为 0 error、2 warning。
- Electron E2E：16/16 通过，17.2 秒；覆盖 Agent Tool 生成结构化候选、Azure Generation/Edit 恢复链、去背景与候选确认，同时保留跨 Chat Memory 精确更新旅程。
- 开发态与打包态 smoke：SQLite、主 Renderer、桌宠 Renderer、固定 Chromium round-trip 均为 `true`，`visibleWindowCount=0`。
- macOS arm64 package：通过；包含 native SQLite、固定 Chromium、两份初始 Provider metadata 与两只内置桌宠。生产 build 仅保留既有大型 lazy chunk 提示。
- `npm run test:benchmark`：按设计报告 not-applicable；候选 runner 已删除，原始结果按各 Decision Record 的 SHA-256 保存在仓库外，获胜路径回归由 production tests 持有。

ESLint 只有 TanStack Virtual 与 React Compiler 的两条已知兼容性提示，无 error；Memory/Activity 没有把返回函数传给 memoized 子组件。

## Decision 与证据

- [`MEMORY-STORAGE`](../benchmarks/memory-storage.md)：`WAL + synchronous=FULL`，不增加自定义 checkpoint job 或数据库设置档位。
- [`MEMORY-RETRIEVAL`](../benchmarks/memory-retrieval.md)：选择 lexical FTS 单路径；记录并保留 Hybrid 在部分 reader 指标略高的机械结果及质量/成本/复杂度综合定案。
- [`CONTEXT-RECIPE`](../benchmarks/context-recipe.md)：选择 `C2-PRE8`；每个新 Run 注入一次 goal-last Memory evidence，不在循环内重复自动检索。
- [`MEMORY-GRAPH`](../benchmarks/memory-graph.md)：选择 `G0`，不建立 Graph 表、依赖或 UI。
- [`MEMORY-FORMATION`](../benchmarks/memory-formation.md)：选择 `F2-IN-RUN-TOOL + U2-SLOT-GUARD`。基础形成使用同一 Chat/Agent Run 的 `memory.record`；身份后继实验 U0/U1/U2 分别为 8/16、12/16、16/16，U2 错目标 mutation 为 0/2。逐项 U01–U16、失败分析、哈希、生产重写和删除证明均已记录；目标 Chat Live 因当前 Azure 资源仅提供图片部署而无有效语义样本。
- [`ACTIVITY-CAPTURE-RHYTHM`](../benchmarks/activity-capture.md)：`P15 + idle60 + S2-TRANSITION15M`。
- [`ACTIVITY-DISTILLATION`](../benchmarks/activity-distillation.md)：8 分钟 Episode、每日 Digest、无模型周归纳与跨两个日期的候选证据。
- [`ACTIVITY-RETENTION`](../benchmarks/activity-retention.md)：只清理已蒸馏原始层；截图 7 天、event 30 天、Episode 90 天、截图资产 512 MiB。
- [`TERRITORY-IMAGE-PROCESSING`](../benchmarks/territory-image-processing.md)：固定同一 Azure deployment、`1024x1024 + medium + opaque`、Edit `high` fidelity、纯洋红背景与边缘连通移除；确认时默认 `96x96`，显式 `visualSizePx` 仍复用同一归一化和安装入口。

所有自定数值门槛均作为决策证据而非自动否决线；记录同时报告质量、成本、延迟、资源、规模和复杂度，并在机械结论与产品选择不同时保留透明 amendment。

## 已知边界

- Chat 多模态真实像素路径由 Provider request-shape、附件/工具 E2E 和图片自然尺寸验证；尚未调用真实 Chat 视觉 endpoint。Territory Image 已用真实 Azure `gpt-image-2` 完成一次 Generation/Edit、去背景和候选确认桌面验收，但单样本不能外推质量、成本或延迟分布；完整发布环境 Live 批次留到 Phase 7。
- 自动记忆的 Tool/宿主协议、稳定字段、目标 allowlist、去重、来源、Revision、候选、Context 复用和 UI 已由 integration 与 Electron E2E 验证；当前可用 Azure 资源是 `gpt-image-2` 图片部署，未把它伪装成 Chat Live 语义效果。若旧 Memory 未被本轮 Context 预载且模型又选错一个全新 slot，宿主没有足够证据推断跨 slot 冲突；目标 Chat Provider 的字段选择质量与长期候选率留到 Phase 7 Live。
- Memory/Activity 已提供稳定来源，Territory 已提供统一候选 Tool 和确认入口；自动提案、来源关联、版本与 pin 仍由 `P6-TERRITORY-MEMORY` 集成包完成，不复制第二套状态机。
- Electron Forge Vite Plugin 仍由上游标为 experimental；升级时必须重跑 build、native module、package、packaged smoke 与 Electron E2E。
- 发布包仍较大；后续体积优化不得引入第二构建路径或破坏 Markdown、Pixi、native SQLite 与固定 Chromium。
