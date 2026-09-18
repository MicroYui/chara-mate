# MEMORY-QUERY-PLAN：已知记忆引用与关联检索

2026-09-16 状态更新：本记录选定的准确引用和消费者计量已进入 Main v21；下文“本轮没有改主仓”及“待 Main 晋级”指原 2026-09-15 实验时点。原固定 8,192 prepared 额度随后已由[动态行动材料分配](COGNITION-DYNAMIC-ACTION-BUDGET.md)取代，原实验数字与失败保留。当前 semantic channel 使用已选实际本地编码器，不能用本批零向量初态证明其质量；最终同版持续场景与冷检索仍待验收。

2026-09-15，Root 已独立复核实际输入、PFC/回答、四次 consumer 重放与机制诊断，接受明确 `Memory/Revision/use` 引用的 B 契约，并纳入按最终 consumer 消息计量的共同修复。此次复核已知方案和阶段汇总，不是盲评。B 在已知未来记录、历史修订和角色计划上取得了实际收益；它没有证明完整语义召回已成熟，也没有解决持续感知的数十秒延迟。

本轮没有改主仓代码。旧 16 条件、补充 4 个执行阶段的结果分别保留：不能用补充成功把原消费者失败抹掉，不能把 PFC 选中了正确内容写成用户已经收到回答。

## 选择的问题与来源

用户已经明确给出、或真实保存回执已经携带某条 Memory/Revision 时，只能将它放进自由文本搜索，容易产生两种错约束：把 Memory ID 填进 entityIds；把“现在回忆”误写为“事件必须发生在现在之前”。未来约定以及没有发生时间的偏好可能因此一起消失。用户接收到的表现是“想不起来，请你再说一次”。

A 为冻结的原整条检索实现。B 在同一个 `RecallPlan` 增加 `references=[{memoryId,revisionId,use:current|history}]`：空 query 只读明确引用；非空 query 将准确读取与关联检索汇入同一候选、selector、预算和 EvidencePack。entity/time/owner 搜索条件只约束关联检索；准确引用仍核对 pair、Persona、删除/归档、历史用途与当前资格，不静默换成别的修订。所选 Memory 在 dispatch、bind 和 publish 继续走实际资格检查。

这是检索请求契约及真实执行的一个整体变量，不能把收益归因于某一句提示词。没有新 Provider、进程、队列、用户设置、检索 fallback 或第二个状态机。

一手来源与版本：

- [JSON Schema annotations](https://json-schema.org/understanding-json-schema/reference/annotations)，2026-09-15 访问。description 是语义注解，不承担业务资格校验；因此准确配对与可见域必须由 Memory 实现检查。
- [SQLite expressions](https://www.sqlite.org/lang_expr.html)，2026-09-15 访问。实际查询的时间比较与 NULL 语义影响资格；缺失发生时间不能偷偷用记录时间填补。
- 本地权威源码为冻结 A/B 各 625 个 source/tests/config 文件，只有 Root 预登记 13 文件不同。依赖为 Node 24.18.0、OpenAI JS SDK 6.49.0、better-sqlite3 13.0.1 / SQLite 3.53.3。真实 `response.created` 的 52 个响应均报告 medium；这是本轮观察，代码没有显式覆盖 reasoning。
- macOS 26.6.2（25G83），Mac16,7，24 GiB 内存。模型经同一现有本地代理访问 gpt-6-astra，不启动本地 encoder。32,768 来源页、8,192 prepared 分配和 1,000ms 批次沿用已有工程配置，不是协议硬限额或本轮实验胜出的数字。

## 冻结与实际执行

8 个全新普通 development 案例，每例 3 条预写要求；未读取原 holdout，未把旧 i01/f05 等已看结果当新题。A/B 每例交替先后，共 16 条件。初态以真实 MemoryRepository、canonical Message/Chat source、修订及 quote span 写入 SQLite。历史 memory.record 成功回执是固定初始 fixture，只证明对应真实 SQL 记录；本批没有实际 formation。

q01/q07 的重要时刻由真实 Memory 和 ProactiveOpportunityService 生成；q08 在 dispatch 前真实修订 Memory，以未送达 Cognition 通知的窗口检查执行资格。当前问题是孤立的待处理认知来源，未并发前台用户 Run，不能据此主张每次问候都应先经过 PFC。

所有条件均走真实 CognitionService/Driver、MemoryRecallPipeline、词法/实体时间/关系、Astra selector、CognitionRuntime、AgentRuntime、Run/Item writer。每个初始库向量数真实为 0，semantic channel 不完整；调用 encoder/formation 会失败。只注册 memory.search；surface 为实际产品投射服务加合成接收器，不能宣称真实 Electron/Android 已验证。

原 16 实际 HTTP generation 区间为 **15:03:28.013–15:21:07.950 UTC**。与独立 local-perception 批次的共享远端区间到 15:10:45.573 UTC，故延迟不是独占服务率。无请求重试、补跑、固定墙钟 kill；所有已启动条件完成。52 次 generation 均 HTTP 200 并有完成终态，未观察尾空白/JSON 未闭合；这不保证未来不会复发。

完整 ModelRequest 和最终 HTTP 输入都用生产保守估算，按用户 258,000 及 Provider 更小限额拦截。原最大实际 input 14,445 Token、最大完整保守估计 69,119；补充最大实际 6,280、估计 29,745。原 46 次 count 返回 404；补充发出 5 次 count 也为 404。**不能声称接近上限时已精确计数**；本批实际 usage 证明请求远低于上限。

## 原 16 条件的结果

| 实际量                     |        A：原契约 |      B：明确引用 |
| -------------------------- | ---------------: | ---------------: |
| 条件数                     |                8 |                8 |
| 真实模型调用               |               23 |               23 |
| PFC / selector / Agent     |       15 / 3 / 5 |       15 / 5 / 3 |
| 实际 Recall                |                7 |                7 |
| 新 Run / 合成 surface 接受 |            5 / 5 |            3 / 3 |
| consumer 计量失败          |                1 |                3 |
| 预期 Memory 修订拒绝       |                0 |                1 |
| input / output Token       | 171,294 / 24,630 | 174,592 / 24,762 |
| 缓存 input Token           |                0 |                0 |
| 模型完成耗时合计           |         532.9 秒 |         525.0 秒 |

所有调用 usage 已知；无可靠单价，未推算费用金额。两组请求阶段数不同，不能把两组合计耗时接近解释为独立吞吐等效。PFC 仍需数十秒，不属于持续桌面输入的负载验收。

| 新开发案例             | 原 A 实际结果                                           | 原 B 实际结果                                                  |
| ---------------------- | ------------------------------------------------------- | -------------------------------------------------------------- |
| q01 未来换苗与陪伴方式 | occurredTo=now 排掉已有未来材料，quiet                  | 两个准确引用均读到，选中聊蕨类；原 consumer 失败，未发出       |
| q02 七月/现在睡前阅读  | Memory ID 放进 entityIds，空结果，请用户重述            | 正确旧 history/新 current，得出悬疑→散文；原 consumer 失败     |
| q03 角色园地原计划     | 未取回内容，诚实说想不起                                | 实际回答“我的种子标本架”，明确现在不摆，无动作/跨角色混入      |
| q04 已删旧卡           | 关联候选未被拿来替代，实际说明读不到                    | 精确 pair 不可读，实际说明读不到；不猜删除原因                 |
| q05 抄错引用对         | 从另一个修订的真实归属识别不匹配，但回显长 UUID         | 精确 pair 拒绝；host 只暴露不可用，回答保留无法判定，不换记录  |
| q06 八月理由+十月约定  | 八月/九月读到，owner=user 漏掉角色域约定；consumer 失败 | 三项读到，时间轴正确；consumer 失败                            |
| q07 刚刚已回答         | 1 PFC 后 quiet，无 Recall/新 Run                        | 同样 quiet；旧 fixture assistant 绝不算新投递                  |
| q08 current 修订竞态   | 未取回偏好，实际问用户重述；未覆盖所选 Memory 的竞态    | 正确声明 current Memory；真实改版后 memory_changed，0 Run/投递 |

实施者按预写 24 项逐条评审，A 为 15 pass / 6 fail / 3 N/A，B 为 22 / 1 / 1。**这些是分阶段的局部要求，不是端到端成功率**：B q01/q06 只在“选中资料/指令”层面满足条目，原本仍被 consumer 阻止；q02 的实际 delivery 明确 fail。评分者知道 Arm 和实施，不是独立盲评。Root 的后续复核另行登记，不预先声称全部获其批准。

q06-B 没有设置硬八月 occurredFrom/To，只在问题和内容中区分八月/九月。因此本真实例不能证明“硬八月过滤+未来精确引用”的完整分支被模型自然覆盖，相关 SQL/Run integration 证据应单列。q03-B 对只解释旧计划仍绑定 current_recollection，有过度依赖风险；本题未发生该记录变化，不声称已经误阻止。

## 2026-09-17：全计划过滤契约澄清（待最终运行验证）

已闭合的自然场景 d01 再次出现不同范围混用：普通用户同时询问当天试用与日常习惯，模型填写“工作间、李舟”，精确别名解析只得到李舟，因而所有问题的词法、向量及结构候选都必须关联该人物。已保存且仅关联用户的投影用途和自然光偏好被首轮排除；同一库的正确巩固已经存在，实际候选额度也未用满。另一条件把当次事件区间用于整组问题，排除了没有绝对发生时间的原件。部分条件自主二查取得原文，M没有继续查，原回答缺口保留。这是实际过滤机制与消费路径诊断，不是单变量算法比较，也不证明模型的内部原因。

当前实现把实体名称解析为全计划硬范围，但旧Schema仅明确称实体ID为硬条件，Agent又要求提出实体名称。Root依据Product §6.6澄清现有合同：只有含义已知、对所有问题都必要的实体或发生区间才填入可选过滤；仅提及、联想或未知时区的日期留在query/questions，不同范围分别查询。重要证据缺失时重新核对自身推断条件，保留用户明确要求的限制。三文件只改描述与指令，SQL、字段、预算、准确引用及主体资格不变，没有自动去条件、额外Planner或第二检索器。Text与Realtime共用该段；描述不能独立保证模型执行正确。

2026-09-17重新核对[Elastic官方query/filter定义](https://www.elastic.co/docs/reference/query-languages/query-dsl/query-filter-context)，仅用于区分相关性与是/否过滤，未引入其产品或参数。生产机制依据当前MemoryRecallRepository、Pipeline和Recall Schema；本地诊断报告SHA `be0ad3a04de4c46c56e6b59664d9fee7e5bef81b0f7fa6926a588ecc61d48b6a`，三文件候选冻结SHA `111843713bb3f3152358f1fd3646b7caee0320a411f9a2272ebc40acadcb3f2a`。Root与第二位审阅者已完成静态核对；三文件已于2026-09-17合入Main，受影响运行检查尚待当前真实对照窗口结束，实际效果由既定完整连续场景检查，不增加字符串镜像测试，不把文案澄清称为稳定召回已完成。原自然实验源、输入和结果保持不变。

## 从原始计划到 SQL 的零模型诊断

2026-09-18 后续收口：上节“待验证”为修复当时的状态。相同原 d01 在 v8 又因根本未检索而漏答，原失败保留；v9 仅补共享 Agent 的回顾题历史覆盖要求后，自然提出两题、没有错误硬过滤，实际取回13项依据并正确区分日常自然光、临时设置和来访约定。原问题/前态不变，全部进程正常退出；7次生成126618输入/3042输出，71.066秒。完整过程及取舍见[回顾题修复记录](MEMORY-RECALL-STRUCTURED-SCOPE.md#2026-09-18普通回顾问题的历史覆盖修复)和 `d01-retrieval-scope-targeted-v9-execution-v1`。这属于已曝光缺陷定向，不改原比较成绩，不新增自动放宽或固定搜索次数。

保留实际 initial.sqlite、原 RecallPlan，调用同一冻结 MemoryRepository.eligibleIds，只移除一个约束，不重跑模型：

| 条件  | 原资格数→移除单约束后 | 解释                                                                  |
| ----- | --------------------- | --------------------------------------------------------------------- |
| q01-A | 0→2，去 occurredTo    | 未来活动与未给发生时间的陪伴偏好被排除                                |
| q02-A | 0→1，去 entityIds     | Memory ID 不是实体关系 ID；仅证明恢复了一个资格，不宣称旧版也同时恢复 |
| q03-A | 0→1，去 occurredTo    | 原计划无发生时间，NULL 与 now 比较不会变成过去事件                    |
| q06-A | 2→3，去 owner         | 共享角色约定在 character 可见域，user 来源不等于 user owner           |
| q08-A | 0→1，去 occurredTo    | 偏好实际存在但无发生时间；不能把空结果解释为未保存                    |

这是后验机制诊断，未回填原模型结果，也没有在生产增加自动删条件的 fallback。

## 消费者计量缺陷及对称补充

原 materializer 计量的是 checkpoint 对象，其中同时保留 Memory 来源结构和最终文本；实际进入模型的 materialized message 只含应发送的内容。四个原条件因此在固定 8,192 分配下被误挡。

| 原条件 | checkpoint bytes | 实际 consumer message bytes |
| ------ | ---------------: | --------------------------: |
| q01-B  |            9,003 |                       5,215 |
| q02-B  |            8,743 |                       4,587 |
| q06-B  |           12,094 |                       6,229 |
| q06-A  |           10,276 |                       5,678 |

Root 修复只改成按实际 consumer 消息计量，8,192 不变。B 从原 B 只应用此单文件修复；A 从原 A 只应用相同修复，没有带入 B query 契约。复制已关闭的原 DB，在副本恢复原已提交失败 Attempt 为 ready，沿同一个真实 Service dispatchOrSettle/Runtime 执行；没有新 PFC/selector 决策，不暗示生产自动恢复错误已实现。

原三例补充在执行前因 A 也出现相同失败，透明修订为 q01-B→q02-B→q06-B→q06-A；保存原未执行 freeze。真实补充区间为 **15:22:16.540–15:22:57.505 UTC**，实际 **6 调用：5 Agent、1 selector；1 新 Recall；4 Run/4 surface；0 错误**。input 31,584、output 1,275、cache 3,806 Token，与原 46 调用分开。

- q01-B：“你之前说，换苗前想聊聊那盆银脉凤尾蕨。我有点好奇：当初是什么让你选中了它？”没有假装看到植物、参加过活动或替用户排练。
- q02-B 实际区分七月快节奏悬疑与九月舒缓散文，并保留“暂时放一边”。没有向用户输出内部 ID。
- q06-B 在 1 个 Agent 步骤回答八月原理由、九月后来的交通考虑和十月 3 日上海 19:00 聊天约定，不代订活动。
- **q06-A 的 Agent 自主再次 memory.search，去掉原 user 范围后取得真实十月约定，再回答完整。** 因而修复后 A/B 都完成该事实任务，A 多一次 selector 和一个 Agent 步骤。不能继续把它写成最终漏记忆，也不能抹掉 PFC 阶段漏召回和额外调用。

q06 两组回复仍较长，包含源日期和“全面核实”等说明，事实正确不等于陪伴表达已经自然。q05-B 的不可用结果也没有区分明确配对错误与其它读取缺口；它避免错误替换，但还不能精确向用户说明原因。本轮不为追求评分新增模糊 fallback。

## 取舍、边界与单一路径

选择 B 的准确引用契约与 consumer 计量修复作为唯一生产路径；生产集成由 Root 负责。依据不是“22/24”这一数字本身，而是实际存在的记录能被准确取到、历史/当前保持配对、主体域不混、实际修订后执行被挡住，并且没有新增并行系统。q03 已实际改善角色回答；q01/q02 在消费者修复后也完成了原本需要用户重述的回忆。

保留 A 的自由文本搜索能力作为同一契约里的关联检索，不保留 A/B 开关或失败后切另一搜索器。q06-A 后继 Agent 的真实 memory.search 是产品已有能力，不应删掉来夸大 B 收益。

不能声称：完整 semantic recall 质量、多人/跨平台覆盖、真实长期用户满意度、连续桌面吞吐已达标、一般 p95、人格情绪理解或类脑优越性。8 个非随机开发案例和其相关条目不能当总体概率；没有用这些条目计算虚假的独立置信区间。实际 Memory 由固定真实 SQL 初态支撑，未验证自动 formation 质量；q05 也是用户手工 ID 边界，不是自然日常界面的代表样本。

执行中新 memory.search 所取证据不属于原 PFC 的 selected readSet；本批没有新证据随后又被修改的第二次竞态，不能把 q08 的成功资格检查推广为覆盖所有 Agent 后继事实的新鲜度。

## 复现标识与清理

原始 16 输入冻结：`4cbdb00eeb4f303d1c39b416b84c6b1c1dcc9637e4967cd2e419c5e14ff34efa`。Arm A/B source manifests：`ecadabf85e87fdb4371cf86cc2b9665541e755bda7eca6e78f374a328f67b18d` / `8f0369c42c126f623ae969b041c2c6d4a295faf777cc89052b06ceb1d623d4a2`。

最终四例 consumer 补充冻结：`75a1c462c8adb8f8bb4cb5f86ac337fa4c6f28f1e45ef5f2d9d01387dc823bda`。Root 单文件 patch：`1ba39f0d7e66845f47c0b36f550f1b3481f7bf0808536ef857d12b027cc681d6`；A/B 修复后 cognitionActionContext SHA 分别 `e71aa0a5322f19b9f8aabb398569857bfad86e101348d0401b3756bbf899c137` / `eacf7b183b4d3e66c8547cfa30a25f0cec5fe93b073440235e4fa53c8c2c3d83`。

实际数据索引为仓外 `memory-query-plan/live-development/review/ACTUAL-RESULTS.json`、`ACTUAL-OUTPUT-SUMMARY.md`、`QUALITY-REVIEW.json`、`POST-RESULT-QUERY-DIAGNOSIS.json`；补充为 `consumer-replay/ACTUAL-REPLAY-RESULTS.json`。原始 requests、SSE、真实 SQLite、阶段记录、初始来源和失败全部保留。原始证据总索引 `RAW-EVIDENCE-INDEX.json`（1,623 文件，SHA `8dc353bd2e77a745d14cb61f1529fde34e4509af45900ee4f3f1124167fa7384`）逐项记录这些仓外文件。

清理前核对原 A/B 各 625 文件、304 个原输入及 1,377 个补充冻结文件，均无 mismatch；两个真实 runner 均以 exit 0 结束。已删除仅本实验 22 个松散脚本、4 份松散源码副本和 6 个 node_modules symlink，复查两个实验目录无 `.ts/.mjs/.py` 残留。按 Root 明确要求，四份冻结源码保存在仓外 `FROZEN-SOURCE-ARCHIVE.tar.gz`，实际 2,501 个普通文件（含 source-a 的额外元数据）；无 node_modules 或 symlink，SHA `d9352c1b26cbe074bfd2bf2d03ed884c1d4dbb5b8bb1316de130861fd8357aa7`。这是一份保留的复现归档，不是生产分支。

实际清单见 `CLEANUP-MANIFEST.json` 与 `PRE-CLEANUP-VERIFICATION.json`；没有动 Root 的 query-planning/continuity、共享依赖或主仓源码，没有提交。

Root 2026-09-15 独立复核：已完整审读8个原条件对的实际PFC/查询/回答摘要、4个原失败consumer的真实执行输出，以及上述SQL单约束诊断和原始输入合同；接受明确引用契约与共同consumer计量修复。原A/B失败、q06-A下游真实补回和阶段评分局限保持不变。13文件已进隔离集成候选，合并C读取规则后1,549项offline及build通过；Main源晋级和最终12故事/holdout仍未完成。

## 2026-09-17：形成内部实体线索的范围修复

冻结原48的ic05发生实际内部漏供给：F1提出“用户”和“用户的妹妹”，只有“用户”精确解析成功；宿主把该列表填入RecallPlan.entityNames，因而具名妹妹记录被所有通道的资格过滤排除。实际Selector只收到一条暂停对话记录，F2没有妹妹过敏旧事实及具名实体，最终又建泛化妹妹。普通回答仍借暖Cognition正确区分人物；这不抵消形成内部缺陷。原输入、输出与实体并存原样保留，独立报告冻结 `8f30a8d57fc9157d94b5695b1a91d1bc8bf8da762edd92eca8051e45c786dd2e`。

按产品§6.6，宿主自动解析的形成实体只补充同次结构候选，不是用户要求的检索硬范围。保持原精确name解析，不加入新alias策略；同一个Pipeline内部第5参数只进入原entity_time通道，在原资格SQL内匹配后LIMIT。显式entityIds/已解析entityNames或发生范围仍按原范围查询；空/未知提示不激活全库近期候选。词法、向量、最终资格、owner/Persona/历史及异步改版检查保持。没有删除同实体结构候选，所以语义索引未就绪且没有词法重叠的住所修订仍能对照原事实。没有新Schema、表、模型、预算、开关、自动合并或第二检索器。

依据是2026-09-17实际Main的FormationService→RecallPipeline→RecallRepository源与上述真实失败；同日核对[Elastic官方query/filter定义](https://www.elastic.co/docs/reference/query-languages/query-dsl/query-filter-context)，只用来区分相关性与资格，不采用其参数或产品。这是既有合同的正确性修复，不新增算法择优实验。Root完整审阅三生产和两既有集中测试差异后于10:55:21Z合入，候选冻结 `0420f60e51c78bdeae11760230a2d3e20aec93dc0f40210360e5ba99551de263`，补丁 `7173a72cf7647cb8a9fc03f83c48b49d782ed4c28b00f237b5d49686eacf619e`。

真实SQLite回归先通过生产Service建立用户住所、具名妹妹过敏，确认FTS能见黄油且向量尚未索引。原生产在同次F2材料遗漏妹妹而失败；修复同次供给结构住所和词法妹妹，注入模型复用实际具名ID并持久化。关联回归涵盖原硬范围、主体资格及选后改版/取消；它们证明调用与持久正确性，不是实际模型同名消歧质量。Main受影响29文件577项通过（6.409秒），format/lint/typecheck通过。最初新测试mock返回类型的lint失败与原RED保留，修正测试类型后通过；产品原件未随评测修改。

真实4B、Selector与F2是否在ic05原前态正确采用，待原48资源释放后按最终整合版做一次针对复测；不能由确定性测试预先宣称关闭。修复可能让先前被过滤的语义候选产生真实编码/选择开销，暂无无代价结论。候选只在仓外普通副本，生产只有一个实现；最终保留本说明及改写为生产回归的10条用例，不保留Arm或比较开关。

## 2026-09-18 整合源 v3 的既定定向复测

原F27领域输入及实际prepared input含timeContext等值，原F28回放一次后，最终v3真实4B/Selector/F2已采用原具名妹妹：来访与暂停范围各在原Memory上修订，同事保持独立，新事件只记录已交付建议，未创建generic妹妹。7条重新索引及一次query embedding是本轮实际成本，不能当作旧索引原样复用。Selector覆盖为partial；F2实际只选来访与暂停两比较项，过敏profile未进入F2，旧profile保持不变，不能外推所有历史材料完整或下一回答正确。3项提交经新PID重开一致。原ic05正确暖答及内部泛化创建的旧事实均保留，新两生成不增加原检查点或抹除旧失败。

证据：`integration/ic05-entity-scope-live-retest-v1/live-integrated-01-review/{REPORT.md,AGGREGATE.json,BINDING.json,FREEZE.json}`，独立FREEZE `432a30a06cdbb2544edbaae1b0a051dbdd198098a18d32dd5c9d6b49eff6d328`；实际Root接受为`integration/final-local-completion-queue-v2/NODE-INDEPENDENT-ROOT-REVIEW.json`。旧包 `ROOT-REVIEW.md` 明确是执行前审阅，不代替live接受。首次 `mechanical-integrated-01` 旧Selector mock schema失败保留；runner-v2只适配 `mechanical.mjs` 到v2 wire，真实phase/replay/Provider字节不变。它是机械脚本接线适配，不是本次生产失败；原真实实体错误仍按旧报告保留。

本结果固定于 SOURCE-FREEZE `0cbc46b68b3eb62f10f1e72f8a3acc97b533ee1a171473940955845a5c28f3b0`。后续共享表达改动与最终安装另行绑定；不回写原48成绩，不以内部调用替代最终桌面/冷检索。
