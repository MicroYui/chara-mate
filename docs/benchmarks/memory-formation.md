# MEMORY-FORMATION：Chat/Agent 使用期的基础记忆形成

> 2026-09-16 当前状态：以下 F2/U2 记录保留原阶段的选择与结果，已不定义 Main v21 的形成 wire 或生效规则。当前 memory.record 从实际来源窗口形成，经同一 Memory 服务提炼、比较和事务提交；create/revise/support、显式依据/观察/推断及修订历史按后续 Decision 执行。推断保持 inference，不沿用“所有推断均进入待确认候选”作为当前默认。当前入口见 MEMORY-SOURCE-INTAKE、MEMORY-SUPPORT-EVIDENCE-OPERATION、MEMORY-REVISION-LIFECYCLE 与 MEMORY-FORMATION-VALIDATION；最终质量仍待独立验收。

## 定案

选择 **`F2-IN-RUN-TOOL + U2-SLOT-GUARD`**：Chat 与 Agent 的当前回答模型在最终回答前调用始终加载的 `memory.record`，Main 把用户明确陈述直接创建或修订为 active Memory，把语境推断和 Agent 执行观察写成待确认候选。profile/preference 使用闭集稳定字段，更新只能命中当前 Run 已预载且与字段一致的 Memory；缺失目标、错 ID、字段冲突和旧数据首次绑定均转候选或拒绝。来源、时间、Chat/Run reference、direct/candidate 生效和重复恢复幂等均由宿主决定。

生产不保留关键词规则、手动-only 模式、后台 reviewer、Arm 开关、形成参数设置或第二套 Memory 写入路径。手动新建/编辑仍是用户可用动作，但不是普通 Memory 的唯一入口。

本次定案包含透明的 owner amendment：执行环境没有可用 Chat deployment，故 `F2` 的 Live 语义召回没有有效样本，不能宣称模型侧质量 Gate 通过。用户于 2026-08-09 明确要求把基础自动形成补回 Phase 3；综合产品契约、规则基线暴露的自然语言漏召回、宿主回归和复杂度后选择 `F2`。无效 Live 不被伪装成胜出证据，完整发布环境的 Provider Live 旅程仍须在 Phase 7 重跑。

## 问题与边界

要回答的问题是：用户在普通 Chat/Agent 使用中表达的耐久事实、偏好、项目、事件、方法和承诺，怎样无需手动录入而进入既有 Memory/Revision/Source 系统，同时不把推断、执行观察、临时请求或凭据直接当成事实？

本 Decision 只覆盖基础 Memory 形成。以下内容不在范围内：

- Phase 4 的 Voice transcript 来源接入；
- Phase 5 的异步 Experience Review、Skill/new Skill、replay 与高级任务方法学习；
- 新的 Retrieval、Graph、向量、后台 Job 或用户可调阈值。

## 一手来源与环境

- 执行日：2026-08-09；macOS/Darwin `25.6.0`、Apple M4 Pro、24 GiB、Node `24.18.x`。
- OpenAI 官方 [Function calling](https://developers.openai.com/api/docs/guides/function-calling)：Function Tool 使用 JSON Schema；应用执行 call 后以匹配的 `call_id` 回传 output，再继续生成最终回答。
- 仓库锁定 `openai@6.49.0`，tag commit [`04671d2`](https://github.com/openai/openai-node/blob/04671d278ef1531692ae31a870251eec90f3c2d2/src/resources/responses/responses.ts)；本地源码确认 namespace、function、`strict` 与 `defer_loading` 的实际 wire type。
- 这些来源只定义协议构件，不定义哪些内容应直接成为 Memory。direct/candidate、来源绑定、去重和 Phase 边界是 CharaMate 策略。

## Arms 与冻结规则

| Arm | 唯一变化 | 生效方式 |
| --- | --- | --- |
| `F0-MANUAL` | 不做自动判断 | 只有 Memory 页面手动创建 |
| `F1-RULE` | Main 用小型关键词/否定规则分类 | 命中后由宿主直接创建、修订或候选化 |
| `F2-IN-RUN-TOOL` | 当前回答模型提交结构化形成意图 | Main 绑定证据并执行既有 MemoryService |

所有 Arm 使用同一组 16 条合成中文输入和同一 disposition 标注。`F2` 的生产宿主还固定以下正确性规则：

- `explicit_user_statement` 才能直接 active；`inference`、`run_observation` 只能 pending；
- profile/preference 的 `claimSlot` 来自闭集，裸 `type=profile/preference` 不在 Tool Schema 中；宿主派生 Memory type 与单值/集合基数，模型只能选择 `create/replace/append/remove`，不能自造身份 key；
- 任意更新携带的 `memoryId` 必须来自当前 Run 预载的 active Memory allowlist；ID、type、slot 任一不一致即拒绝，缺失合法目标时只生成候选；模型不能提交 source ID；
- NFKC、空白归一化与 exact active/pending 去重在持久化前执行；
- Tool Item ID 作为直接来源 ID，Chat/Run reference 由 Main 从当前 Run 解析；
- 直接陈述使用 `confidence=1`；候选使用中性 `confidence=0.5`，`importance=0.5`，新候选 `novelty=1`。这些值不是晋级阈值，只是现有必填字段的固定 metadata；它们不决定 direct/candidate。

## 冻结样本与逐项结果

数据集 SHA-256：`4f01943c829010f2d28469286c4590b0a25922a524b7494bb6ccba086ad956e3`。

| ID | 输入内容 | 期望 | F0 | F1 | 分析 |
| --- | --- | --- | --- | --- | --- |
| F01 | 我叫林遥，以后可以直接叫我林遥。 | direct profile | 漏 | 对 | 明确画像 |
| F02 | 我更喜欢技术回答先给结论，再给必要依据。 | direct preference | 漏 | 对 | 明确偏好 |
| F03 | 我正在长期维护 Lantern 桌面应用。 | direct project | 漏 | 对 | 长期项目 |
| F04 | 记住：每周五下午我要整理本周的研究笔记。 | direct commitment/procedure | 漏 | 对 | 明确周期承诺 |
| F05 | 之前那条说我住在北京的记忆不对，我现在住在上海。 | direct revise 指定旧 ID | 漏 | 对 | 明确纠正 |
| F06 | 帮我把下面这段日志概括成三点。 | none | 对 | 对 | 一次性请求 |
| F07 | 这是假的测试 key `sk-example…`，请不要泄露。 | none | 对 | 对 | 假凭据也不持久化 |
| F08 | 文档里写着“用户喜欢安静的咖啡馆”，请分析这句话。 | none | 对 | 对 | 复制资料不是用户事实 |
| F09 | 我这周三次都在早上六点开始写代码，可能我是晨型人吧。 | candidate preference | 漏 | 对 | 用户自己也表达不确定 |
| F10 | 今天北京天气怎么样？ | none | 对 | 对 | 临时信息请求 |
| F11 | 我的项目下个月发布 1.0 版本。 | direct event/project | 漏 | **漏** | 无关键词的自然事件 |
| F12 | 从现在起，提交说明都用中文。 | direct preference/procedure | 漏 | 对 | 明确后续约束 |
| F13 | 写方案时，先把决定放在第一段，对我更有帮助。 | direct preference | 漏 | **漏** | 自然改写偏好 |
| F14 | Lantern 是我接下来半年的主项目。 | direct project | 漏 | 对 | 项目改写 |
| F15 | 不要记住这句话：我喜欢红色。 | none | 对 | 对 | 否定优先 |
| F16 | 如果你猜我喜欢爵士乐，那只是猜测，我没这么说过。 | none | 对 | 对 | 否认推断 |

离线基线聚合：

| Arm | disposition 正确 | exact 正确 | none 上错误写入 |
| --- | ---: | ---: | ---: |
| F0 MANUAL | 6/16 | 6/16 | 0/6 |
| F1 RULE | 14/16 | 14/16 | 0/6 |

规则原始聚合 SHA-256：`3630b27d377dad0469bb7c6ffa3a865d67d6a618e0386f235275d6f8202ae8c7`。F1 在这组小样本上已漏掉 2/10 条应形成内容；继续补关键词会把中文改写、其他语言、否定和类型边界变成永久规则系统，因此不作为生产 baseline。

## F2 协议、宿主与 Live 结果

确定性生产回归覆盖：

- Chat 模式能直接调用非 deferred `memory.record`，不开放其他 effect Tool，也不产生执行 Approval；
- Agent 模式的执行观察只生成 `tool` 来源候选；
- 明确陈述直接创建、明确改口形成 Revision、推断候选化；
- exact Memory/candidate 去重、候选被明确陈述确认后的收口、来源绑定；
- 新形成 Memory 在下一 Run 通过既有 `C2-PRE8` evidence 进入 Context；
- Memory UI 同时显示候选原因和来源，接受后沿用既有 Revision/Source 详情；
- Tool 调用保存为可恢复 Run Item；若中断后重放，同内容检查使写入幂等。
- 跨三个新 Chat 的 Electron 旅程验证“徒步 → 游泳 → 回忆”：最终只有一个 Memory ID、两个 Revision、一个稳定字段绑定、零冲突候选；旧内容不再进入后续默认 Context。

Live 预检使用当前环境唯一 Azure deployment `gpt-image-2` 和 API Version `2025-04-01`；它是 Image deployment，不提供本实验所需 Responses Chat 路由。第一次请求返回 HTTP 404，`0/16` 样本执行，结果标记为 **protocol invalid**，不计作 F2 失败或成功；未打印或保存 API Key。失败预检没有 raw 结果 hash。

## 综合选择

选择 F2，而不是把 F1 的 14/16 当成可发布质量：

1. F0 与用户“使用期间自己慢慢添加”的明确产品要求冲突。
2. F1 的漏项恰好是普通自然改写；补规则会形成第二个语言理解系统，并需要永久维护类型、否定、多语言和冲突分支。
3. F2 复用每轮已经存在的 Chat Model 与 Function Calling，不增加每轮后台 reviewer；只有实际形成时才产生 tool continuation。
4. 风险较高的判断不交给模型直接生效：宿主按 basis 强制 candidate、绑定真实来源、redact、去重并复用事务/Revision。
5. 异步 post-Run reviewer 仍留给 `SELF-EVOLUTION`，没有作为 F2 的隐藏 fallback。

这是产品选择而不是“F2 Live 分数最高”的统计结论。若 Phase 7 的目标 Chat Profiles 对 `memory.record` 出现不可接受的漏调或错误 basis，应新开同一 Decision 的后继实验并重写唯一生产路径；不能悄悄启用 F1 fallback。

## 生产重写与删除证明

- 生产只有 `memory.record → MemoryService.form → MemoryRepository`；`memory.search` 仍是只读 deferred 能力，两者不组成候选模式开关。
- 数据库 v6 只增加 `memory_claims` 与 `memory_candidate_formation` 两张窄表，分别保存 active Memory 的闭集字段身份和形成候选的 operation/slot；没有后台进程、依赖、Settings、阈值 UI 或 Arm flag。
- v5→v6 migration 不猜测旧内容的语义字段；旧 unkeyed Memory 首次更新进入定向候选，用户接受后原地形成 Revision 并绑定字段。
- 一次性 runner 曾位于 `/tmp/charamate-memory-formation-20260809/benchmark.mjs`，不属于仓库；记录完成后已删除。冻结样本只以本记录的逐项内容/哈希和改写后的产品回归存续，不保留 candidate runner。

## 不能声称什么

- 无有效 Chat Live 样本，不能声称所有 Provider/Model 都会以同样 recall、类型或 basis 调用工具。
- 当前只验证 Chat/Agent；Voice 来源由 Phase 4 接入同一宿主能力。
- 只有旧 Memory 被本轮 Context 预载、且模型选择正确闭集字段和 operation 时，明确改口才自动形成同一记录的 Revision；检索未命中或模型语义选择不确定时会进入候选，不能声称所有自然语言改口都能无确认定位。
- `run_observation` 只是普通 Memory 候选，不证明 Skill、自动流程或自我进化有效。
- 16 条合成输入只能暴露基础边界，不能替代发布环境长期接受率、编辑率、拒绝率和候选增长观测。

## 后继实验：跨 Chat 精确更新

> 状态：2026-08-09 已完成并晋级 `U2-SLOT-GUARD`。冻结样本、期望和门槛在结果产生前未修改。

用户进一步明确了 Phase 3 的正确性要求：切换 Chat 后，“喜欢 A → 现在喜欢 B”不能因为旧 Memory 未命中、模型提交错 ID 或身份 key 漂移而留下 A/B 两条 active 事实。此后继实验只改变 Memory 身份解析与冲突处置，不改变 F2 的同 Run Tool、basis、来源、Retrieval 或 Context Recipe。

环境沿用本记录的一手来源、硬件和锁定依赖；协议仍以 `openai@6.49.0` Function Tool JSON Schema 为边界。该协议不定义事实身份，claim slot、目标 allowlist 与候选化均为 CharaMate 正确性语义。

冻结数据位于一次性仓库外文件，SHA-256 为 `f60ed6eeaae9e51de33f84d6b496d2969e3d0ac1dc84d641dfcfbe3afbddfdd9`。16 项依次覆盖：带合法目标的跨 Chat 替换、未命中、目标不在本轮 allowlist、合法列表中的错目标、同 slot create 冲突、exact replay、集合追加、单值误追加、推断替换、Tool 重放、数据库重开、旧版无身份记录、候选接受，以及无 slot 项目的有/无目标替换。

| Arm | 唯一变化 | 预期代价 |
| --- | --- | --- |
| `U0-ID-ONLY` | 当前 top-8 Context 中的 `memoryId` + exact content 去重 | 无新持久化；未命中或错 ID 可双活/错修订 |
| `U1-FREE-KEY` | 模型提交自由文本 claim key，宿主按 key 唯一解析 | key 拼写、同义词和单复数仍可漂移 |
| `U2-SLOT-GUARD` | profile/preference 使用闭集 claim slot；宿主派生类型/基数，交叉校验本轮目标 allowlist；其他类型只有合法目标才能直接更新，未命中或冲突一律候选化 | 两张小型身份表、一次 Schema migration 和额外宿主分支 |

晋级门槛：16/16 disposition 正确；U04/U05 错目标 mutation 为 0/2；所有未命中、冲突、推断或无合法目标场景 6/6 不新增 active；所有明确且合法更新 7/7 命中同一 Memory Revision；replay 不增加 Revision；重开后身份不丢失；接受定向候选只修订目标而不创建第二条 active。若质量等价，选择表、状态和模型自由度更少的 Arm。

### 逐项结果与分析

`✓` 表示命中冻结期望；`✗` 后写出实际失效。U0/U1 为仓库外一次性状态转移实现，U2 的相同规则另由生产 MemoryService/SQLite/Runtime/Electron 回归执行；没有把表格手工结论冒充运行结果。

| ID | 冻结场景与期望 | U0 ID only | U1 free key | U2 slot guard | 结果分析 |
| --- | --- | --- | --- | --- | --- |
| U01 | 首次 `preference.hobbies` create：1 active / 1 revision | ✓ | ✓ | ✓ | 三者都能正确新建。 |
| U02 | 新 Chat 有合法目标，将徒步 replace 为游泳：同 ID / 2 revisions | ✓ | ✓ | ✓ | 有明确旧目标时三者都能修订。 |
| U03 | replace 但本轮无合法目标：pending，旧值仍是唯一 active | ✗ 新建第二条 active | ✗ free key 越过本轮证据直接修订 | ✓ | 不能仅凭模型生成的 key 或“像是同一字段”静默改历史事实。 |
| U04 | 提交不在本轮 allowlist 的 ID：拒绝且零 mutation | ✗ 修订未加载目标 | ✗ 修订未加载目标 | ✓ | allowlist 必须由宿主从当前 Run checkpoint 解析。 |
| U05 | 合法列表中的 ID 属于另一 slot：拒绝且零 mutation | ✗ 错修另一条记忆 | ✓ | ✓ | ID 合法仍不够，必须交叉校验 type 与 slot。 |
| U06 | 同 slot 再次 create 不同内容：pending，无第二条 active | ✗ 新建第二条 active | ✓ | ✓ | slot 唯一约束阻止 A/B 双活。 |
| U07 | exact create replay：duplicate，不增 revision | ✓ | ✓ | ✓ | 规范化内容去重对三者都有效。 |
| U08 | 集合字段 append 且目标合法：同 ID 新 revision | ✓ | ✓ | ✓ | append 写入模型提供的完整新快照，不另建 Memory。 |
| U09 | 单值 `profile.home_location` 误用 append：pending、零 mutation | ✗ 直接修订 | ✗ 直接修订 | ✓ | 闭集字段的宿主基数约束阻止不完整合并。 |
| U10 | inference replace：pending，旧值仍唯一 active | ✓ | ✓ | ✓ | basis 的 direct/candidate 宿主规则保持不变。 |
| U11 | 已成功 replace 的 Tool replay：duplicate，不增 revision | ✓ | ✓ | ✓ | checkpoint 恢复保持幂等。 |
| U12 | 数据库重开后 replace：仍修订同一 ID | ✓ | ✓ | ✓ | 持久化身份跨进程重启有效。 |
| U13 | v5 旧 unkeyed 目标首次绑定：pending 等用户确认 | ✗ 未确认即绑定/修订 | ✗ 未确认即绑定/修订 | ✓ | migration 不用内容猜 slot，避免错误批量回填。 |
| U14 | 接受定向候选：原目标同 ID 新 revision，无新 active | ✗ 新建 superseding Memory | ✓ | ✓ | 候选确认延续同一事实时间线。 |
| U15 | 无 slot project replace 且无目标：pending，无第二条 active | ✗ 新建第二条 active | ✓ | ✓ | project/event 等也必须有本轮合法 ID 才能直接更新。 |
| U16 | 无 slot project replace 且目标合法：精确修订该 ID | ✓ | ✓ | ✓ | 外部类型不强造全局 key，仍由 allowlist 精确限定。 |

聚合结果：

| Arm | disposition 正确 | U04/U05 错目标 mutation | 晋级 |
| --- | ---: | ---: | --- |
| `U0-ID-ONLY` | 8/16 | 2/2 | 否 |
| `U1-FREE-KEY` | 12/16 | 1/2 | 否 |
| `U2-SLOT-GUARD` | 16/16 | 0/2 | 是 |

U2 同时满足：六个未命中/冲突/推断/旧数据场景 6/6 未新增 active；七个明确合法 create/update/replay 场景 7/7 保持预期身份与 Revision；重开后字段身份仍在；定向候选接受只增加目标 Revision。报告 SHA-256 为 `1607ef821c931e96e04e48c5148f1db016ebf0b9cefab154e689e40185520079`，一次性 runner SHA-256 为 `89f3412e67e8e1eb2ac3baf6415fbae73059657a05289a36093904ee313c9125`。

### 选择、生产重写与删除证明

选择 U2。它是唯一同时通过全部门槛并把模型自由文本身份收窄为可验证闭集的 Arm。生产重新实现为一个路径：`C2-PRE8 Context → checkpoint allowlist → memory.record(operation, claimSlot/type, optional memoryId) → MemoryService guard → MemoryRepository transaction`。profile/preference 必须使用闭集 slot；project/event/procedure/commitment 才能使用无 slot type。SQLite 用唯一 `claim_slot` 保证同一稳定字段最多绑定一个 Memory；候选保存 operation/slot/target，接受时原地修订目标。若模型在已预载另一个同类型稳定字段时把改口误报为新 slot create，宿主也先候选化，避免直接形成跨 slot 双活。

U0/U1 实现、Arm 分支、runner、冻结 JSON 与 raw report 均只曾存在于 `/tmp/charamate-memory-identity.AC5qQm`，三份哈希复核后已逐文件删除并移除目录；仓库不保留 Arm flag、自由 key schema、候选依赖或设置入口。获胜行为被改写为不含 Arm 名称的 contract、integration、component 与 Electron E2E 回归。

### 不能声称什么

本实验是确定性宿主正确性比较，不使用当前不可用的 Chat deployment，也不把它冒充模型语义召回评测。目标 Provider 对 `operation/claimSlot` 的真实选择质量仍需 Phase 7 Live；若旧 Memory 没有被 C2-PRE8 预载，而模型又错误地把改口声明为全新的另一个 slot，宿主没有足够证据判断两者冲突，因此仍可能形成不同 slot 的事实。闭集覆盖当前常见 profile/preference 字段，不代表所有用户表达都可归入这些字段；未覆盖的 project/event/procedure/commitment 只在有本轮合法目标时直接更新。生产能保证的是“本轮证据可辨识时精确修订；同 slot、错 ID、缺目标和预载同类歧义时候选或拒绝”，不是“模型永远理解正确”或“不依赖检索即可发现所有语义矛盾”。

## 2026-08-27 旧数据显式归一化修订

生产数据复核确认，v5→v6 的“不猜测旧内容”迁移正确保留了 unkeyed profile/preference，但 Memory 页面没有后续的人工收口动作，导致这些记录既无法成为稳定画像，也会继续依赖词面检索。本次修订不改变 U2 的宿主身份规则，而是补齐其用户确认生命周期：

- 手动新建 profile/preference 必须显式选择闭集 `claimSlot`；project/event 等仍按原类型创建。
- 稳定画像中的全部已绑定字段都进入更新 allowlist，但“另一个 slot 的 create 是否歧义”只检查当前 R0 实际命中的同类型字段；仅因画像有界预注入而出现的无关字段不阻断新字段形成。
- active unkeyed profile/preference 的详情允许用户选择与类型匹配的 slot。slot 无 owner 时，在同一 Memory 上创建用户确认 Revision 并绑定；slot 已有 owner 时，界面同时展示两条内容，要求用户提交合并后的完整快照。
- 合并在单一事务内修订既有 slot owner，新 Revision 以 `user_edit` 来源分别引用 owner 与 unkeyed Memory ID；两边原始 evidence 继续保留在各自既有 Revision 中。unkeyed 记录变为 `superseded` 并指向 owner，没有第二条 active 字段事实，也不删除旧 Revision。
- 绑定和合并都必须由显式 UI 动作触发；应用启动、迁移、检索和模型 Tool 都不做语义自动分类。

确定性回归分别覆盖无 owner 绑定、已有 owner 合并、slot/type 校验、来源与 Revision 保留、失败事务零部分写入，以及 Renderer 提交的完整合并内容。这是已选 U2 的缺失产品路径修复，不新增候选 Arm、迁移表或设置。

## 2026-08-27 模型可见标识收口

生产复核发现，Context 与 `memory.record` Tool Result 暴露的 Memory/Revision UUID 会诱导模型在普通回复中复述内部标识。U2 的正确性依赖“宿主私有 allowlist”，并不依赖模型看见或复制 UUID。因此本修订把稳定字段更新改为：模型只提交 `claimSlot`、operation 和完整新内容；宿主仅当该 slot 的唯一 active owner 属于当前 Run 私有 allowlist 时解析目标并在原 Memory 上创建 Revision。内部服务调用仍可显式携带 ID 并接受原有交叉校验，模型 Tool Schema 与 Tool Result 均不再暴露 ID。

无 slot 的 project/event/procedure/commitment 若没有宿主内部精确目标，继续进入 `missing_target` 候选；旧 unkeyed profile/preference 继续由 Memory 页面显式绑定或合并。确定性回归必须证明 Provider 可见 Context、`memory.search`、`memory.record` continuation 和 Run `displayOutput` 都不含内部 UUID，同时合法稳定字段改口仍命中同一 Memory Revision。

### 2026-09-17：原ic02被拒提案的提交复测

固定原Formation L11供给、L12真实公开提议和L13 basis失败，仅投影其两实际target、三实体及四canonical source/精确span，沿当前Service实际分段、校验和事务回放同一提议。旧控制只撤回承诺guard增量，同一units[1].semantics.basis拒绝且整批无写；当前Main一次形成无反馈，两个原Memory各增加一个Revision。旧助手承诺、active、9月1日发生时间保留，9月12–13日作为用户明确的新限定，旧承诺为retained_history；两个版本均独立PID重开与各自最终details/evidence/entities相等。

实际四进程66452/66453/66456/66458于11:08:31.230–31.736Z完成且不存在。没有新Provider、4B、PFC或App调用，历史L12不再计费；这是原失败校验/持久化的针对证明，不是新语义成功率、完整旧库/检索现场或普通回应采用证明。前态明确省略其它三份比较材料及后台work/index，不以它们冒称全现场重放。当前API绑定33依赖，Main Service SHA `f8c608c0ca025da534b33ad9fc3329de9441e42c4ed3ec6c3bc498ca7853ec38`；仓外包 `ic02-retained-proposal-replay-v1`冻结 `25f7ea1dfee83616a1ad3cde8af621ff3adee397a60a6eb456203239f755d0af`。最终F若改变调用接口，整合阶段沿同提议复用该回归，不重跑全部48或增加语义实验。
