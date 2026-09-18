# Intent 完成依据与刚结束话题的承接

## 2026-09-17：补齐实际文字交付

原独立48故事中的 `isa-dialogue` 三个局部问答点均通过，但另一项实际状态问题必须保留：首请求只要求将原句重排为一行角色台词，真实完成的助手消息已经写出这行台词，随后PFC却直接创建 suspended 意图，理由是没有用户结果报告或 performed 效果凭据。五次PFC后该意图仍保持 revision 2；不是先完成后被重开。整体剧本是否完成未知，并不妨碍判断这次有限改写已经交付。

修改前 Main 的 `cognitionRuntime.itemEvidence` 已从真实 completed assistant Item 保存 agent/utterance、Run/Item/Persona 和实际正文；当时 Projection、Driver 与 Schema 却只准两种完成依据。这是现有产品语义遗漏，不是Provider协议限制。2026-09-17读取的当前源码和已闭真实请求构成本次来源依据；不新增数值门槛或比较课题。

产品§2已补充 `completed_reply`：本次实际可见的真实完成回复文本，可以满足有限对话目标；不能以“我已保存”等自述证明外部动作，也不证明引用中的人物行为、实际投递或用户阅读。节选是否足够由可见目标及必要条件决定，不新增全文相等硬门槛。沿用原同Persona、供应范围、修订、keep/set/clear、当前消费者和来源回收机制，不加表、旧库适配或自动确认循环。

独立实现包 `cognition-conversational-completion-v1` 已冻结并经 Root 审查，于13:33:50 UTC与窄对话目标绑定修正按精确前像组合进入 Main。7 个生产文件和 6 个测试文件扩展现有合同；Repository 透传本来就收到的实际供应，避免将无正文的依赖元数据误当模型看过的回复。新完成须有真实可见非空正文，只有回收标记或空节选不能满足；原完成 keep 和执行读集不重新索取历史全文。

旧生产两例因第三依据缺失而拒绝；初稿另有 metadata-only、实际回收后的 metadata、Reader 零字符片段三项错误准入，Root 发现后已修正。最后修正后的 41 文件、710 项领域/合同/集成检查及 typecheck/lint/format 均通过（13:05:45–13:05:59 UTC）。真实 Agent 流验证 completed Item 在父 Run 后来取消后仍成立，未完成 Item 不产生合格来源；这不是实际模型语义采用结果。包冻结 SHA `ecde9ac4c5e6fa810409de5738af5c254247dfa1a0984a62ebb8762415851478`，补丁 `215191668482ef40196aca4082a5ac181f80bba95666e3296ac527b874060573`；原失败和首轮测试装配错误保留。

合并后的实际 Main 41文件711项受影响检查、typecheck/lint/format均通过（13:34:06–13:34:22 UTC，检查期间628个src/tests文件未变）；没有启动真实模型、4B或App。完整回执为仓外 `cognition-completion-and-binding-main-integration-v1`，最终完整离线与桌面检查仍待其余Memory修复整合。

原 `isa-dialogue` 六步已准备按最终整合源定向复测，未增加用户确认或另造正确状态。原报告SHA `2d587ab55c9a5c1cdeeadd153cbb835be1e59b58e8b1d5a5bb10f9f79f424cb1`，冻结SHA `5486c520b7037566d2083c2b05fa95654222828b640e55a44dfe7f46d7f7a8c5`。下文是原两依据设计及其当时结果，不能被这次修改倒算为已支持文字交付。

随后原f02也曝光同一缺口：85字开场改写实际保存为completed assistant Item且完整进入PFC，有限改稿Intent仍因缺少独立送达或用户报告保持suspended。其原三来源/撤回标准不覆盖该问题，局部通过不抹掉它；原冻结`5f4068b3ed21cf6e5a2ef682fbd39bbfac55d56e657a406b65c3595b11b0d0ee`，Root复核`064e83a3d3eb76af4cc82337aa82c3e8d9c27d122d366810684abaf6404102bf`。同例另一个定时提醒涉及指定时间/原Chat投递，不能自动按纯文本目标收口。沿已准备的dialogue真实针对和最终桌面验证，不另加整个f02重跑。

2026-09-16。独立完成依据合同已进入 Main，领域验证与八条真实语义场景已完成；完成资格符合预设规则，普通聊天暴露的两个承接失败已完成消费者修复并进入 Main，固定原认知状态后的八次普通 Agent 回归及当时 Main v6 工程验收均通过。该路径已随共同 v21 集成 Main，v21 晋级时的完整离线通过；最终同版连续语义、桌面与安装验收仍待完成。本记录保留第一次结果，不用后续修复覆盖原分母。

## 问题与单一路径

原独立连续验收 s17/c08 的第八次 PFC 请求把已有意图从 suspended/revision 2 改为 fulfilled/revision 3。实际保存结果如此，并非局部视图的显示错误。来源中有重试授权、正文声称保存成功但 typed outcome=unknown 的效果；没有用户报告目标已经完成。旧守卫只要在一般 evidenceIds 中找到用户话语，就可能把请求当成完成依据。

新合同把完成用途独立为 `completion.evidenceUses`，不再从目标来源或执行历史自动推导完成：

- `performed_effect` 必须引用本次实际供应、同 Persona 的 effect，且 typed outcome=performed；成功只读只能证明读到的信息，不证明文件已写入或消息已发送。
- `user_report` 必须引用本次实际供应的真实用户话语，并由模型明确选作完成报告。消费者仍以用户报告归因；宿主结构检查不证明自然语言一定是完成陈述。
- 首次完成、改变目标/成功条件/owner/basis/完成声明后仍称完成，必须重新显式 set。目标或必要条件被预算隐藏时，不能作新的完成断言。
- completion 作为整体 keep/set/clear；隐藏字段的操作保留到原事务，不做部分数组合并。未改含义的历史完成可 keep，缺少原依据的旧记录不补造证明。重新开启目标时 clear 当前完成声明，原执行历史保留。

严格模型输出升为唯一 `charamate_cognition_analysis_v6`，没有旧版本分支、第二模型、关键词分类器、新表、重试上限或内部 Settings。Life 计划工具只能计划和接续；重新打开原 Run 绑定的目标时保留 ID 和效果历史、清除 completion，并避免另建一个默认目标。

来源为实际 Main v5 working tree、原请求/SSE/SQLite，以及 [OpenAI Function calling 文档](https://developers.openai.com/api/docs/guides/function-calling)（2026-09-16 访问）。官方协议定义调用结果的供给方式，不定义 CharaMate 的完成含义。候选环境为 Node 24.18.0、SQLite 3.53.3、better-sqlite3 13.0.1、TypeBox 0.34.52、Ajv 8.20.0、SDK 6.49.0；没有新增依赖或数值门槛。

## 读取、来源和消费者

完成字段在 SQL 的实际字节预算内整体读取或省略；省略记录为 preserved field，不先物化任意大的数组。长回执正文被节选不一律拒绝：可见 typed outcome 与相关内容仍可能足够，但不能假称未供应的正文也被看见。模型负责判断实际可见内容是否覆盖全部目标，宿主负责来源身份、类型和事务一致性。

完成依据进入普通/所选上下文时保留 basis；所选行动仍验证真实 read-set 和来源是否存在，不解除已有用户接管、Persona、执行审批与 dispatch 条件。第一版候选将所有 fulfilled 原文常驻，Root 拒绝后收窄为当前 committed 目标及真实在途消费者。退出当前用途可释放完整原文，保留声明、来源身份和必要引文；不承诺所有历史全文永久可得。

第一次真实正例揭示另一个层次：正确释放可执行承诺后，普通对话仍需理解刚结束的事项。ic02/ic06 的最新实际 Attempt 已选择完成目标，Reader 也供应了当前 canonical Intent 和真实原文；但普通 projection 仅接受 active/suspended 或 committed fulfilled，导致 clear committedIntentId 后只剩 466 字节说明前缀。两次 Agent 均自然搜索空 Memory 后请求用户补充，构成实际承接失败。

已晋级的三文件消费者修正复用最新实际提交决策已经选择的目标，读取当下 canonical 内容和完成依据。它不能回溯挑选旧成功、装入全部历史完成、注入旧 action instruction、恢复执行或新造 TTL。来源回收与这个实际消费者同步。原八条模型判断与数据库结果保持不变，另评普通消费者；不把宿主接受作为端到端成功。

## 第一版离线结果

20 文件候选（含 Root 拥有的两份 Life 文件），新增一个通用 focused 测试文件；未改 Memory、Provider、DDL、调度或原验收标签。

- Cognition/Life：303/303，16 文件，1.76 秒；相对先前新增 36 项。
- 全合同及 integration：462/462，46 文件，10.31 秒。
- typecheck、改动文件 lint/format 和前像补丁适用检查通过。

覆盖 whole-field 操作、部分视图、独立完成资格、原子回滚、水位不前进、来源删除、版本冲突、当前消费者退出、用户报告归因，以及真实 Life 工具接续。旧 fixture 的完成声明、可选 SQL 字段和来源身份装配失败均保留；最终用例没有放宽完成校验。另有一个明确标作合成守卫对照的零模型实例，旧守卫接受请求＋unknown，新守卫拒绝；不算模型质量样本。

## 八条前瞻真实语义样本

八条普通中文任务、20 条原始来源，在调用前冻结。案例作者也按预先 rubric 复核，Root 独立检查实际输出与保存结果；这不是数据来源独立的统计 holdout。每例新 SQLite、真实 CognitionService/Driver/commit，再由同库真实 AgentRuntime 在新 Chat 回答“这件事现在进展怎样？”。没有预种正确记忆。

Memory 是真实空库和查询通路；无候选时不调用 encoder/selector，相关端口若被调用即报错，不伪造向量或检索包。没有运行后台形成。Tool 回执是明确标记的合成来源，并未真的写入 fixture 文件或日历。普通 Agent 只注册只读 Memory，不执行这些写入。

| 场景                                      | PFC 与实际保存                                       | 普通 Agent                                        |
| ----------------------------------------- | ---------------------------------------------------- | ------------------------------------------------- |
| 重试保存采购清单，结果 unknown            | 未完成；保留核验需求，没有把授权当完成               | 正确说明尚未确认，避免盲目重写                    |
| 用户报告三盆薄荷全部浇水                  | fulfilled，明确 user_report                          | 话题被 projection 丢失，needs_input               |
| 摄影展简介及两张照片完成，未打包          | 保留部分进展和剩余选片，整体未完成                   | 正确区分完成与未完成部分                          |
| 读完退租说明，但尚未保存备忘              | 只读成功不满足写入目标                               | 区分读取与保存；“未写入”比证据更肯定              |
| 查询图书馆开放及最后入馆时间              | performed_effect，查询目标完成                       | 正确回答三项时间；本例另有 current Situation 承接 |
| 合成 performed 写入回执包含完整烤蘑菇食谱 | fulfilled，performed_effect 覆盖全部要求             | 话题被 projection 丢失，needs_input               |
| 助手声称 PDF 已保存，只有 Run 结束        | 不将话语或 Run 终态当效果                            | 承认保存与版式仍待核验                            |
| 合成旧训练写入回执，再要求改期并移除旧项  | 同一目标重新 active，clear 旧 completion，保留旧回执 | 区分原创建完成与本次改期尚未执行                  |

共 18 次真实生成：8 PFC、10 Agent 续步；没有 PFC recall、自动模型重试、encoder 或后台 dispatch。8/8 宿主提交，普通 Run 为 6 completed、2 needs_input；后两条是上下文缺失失败，不能因需要补充本身合法就算产品承接成功。两次自然 memory.search 返回真实空结果，不算冷记忆成功。

实际用量：输入 169,324，输出 12,706，缓存输入 17,828（包含在输入总量中），18 次 usage 均已知；单次最大实际输入 10,381。每条完整 wire 检查低于用户 258k 限制，代理精确计数端点仍不可用；小输入不证明临界容量。实际首个生成 HTTP 为 02:50:02.404 UTC，最后模型结束 02:54:20.470 UTC。顺序运行含代理等待，不作独占延迟或总体稳定率结论。

原 rubric 为 19 条必要事实，20 是来源条数。PFC 语义与综合状态各为 18 supported / 1 partial；普通输入为 15 supported / 4 missing，实际回答为 14 supported / 1 partial / 4 missing。ic01 未在新 progress 中重述旧失败，保留来源 ID 不直接等于表达了理解；ic07 回答没有重述 Run 终态这个背景子事实。ic04 的“尚未写入”比“尚无写入证据”更肯定，虽然没有虚称已保存，也不应称措辞完美。

事后 selected-context 读取为 3/8 可构造；另外五例的选择绑定 revision 2，而 Service 在用户接管收束后将 canonical 状态更新为 revision 3。精确读集拒绝旧绑定是预期的版本检查，不是五次新 PFC 失败或已证实容量不足。该诊断没有执行选定行动，dispatch 为 0；普通消费与真实行动可执行性分别验收。

完整作者复核 `semantic-runner/live-review/REPORT.md` 的 SHA 为 `3e190ba8b1fbefb3b838f6f40e8220000843e58a2e76e15d37e23ca3191d7e48`，逐事实记录为 `baf2a7cd6f7948645170db478a63d941a3bbf9043513496785578144b19adf1a`。另一位参与实现的复核者在未读标签的情况下核对 ic01/ic02 全部来源、wire、SSE、SQLite 和回答，确认 unknown 与用户报告的区别及消费者缺口；这不是盲评。其报告 SHA 为 `285f2c4845048d826252dd6c46ec4508f617718937a3291bd9039dac1b0ca880`。

## 普通消费者修复

三文件 `cognition-completed-context` 已精确合入 Main，只有 Projection、SourceRetention 与新通用测试。Reader、模型输出 v6、DDL 和实际行动守卫未变。最新 Attempt 必须具有合法提交状态，实际选项、selectedBasis、selectedIntent 和 dependencies 相互对应且属于同 Persona；先取最新，再核资格，不筛出更早的成功记录。旧选择只说明当前可读对象，内容取 canonical 当前修订，不复制旧行动说明。

新增 SQLite 回归 17/17 通过，旧实现同组为 4 失败 / 13 通过；Cognition/Life 320/320，全合同与 integration 462/462，最终 typecheck/lint/format 通过。覆盖换话题、失败/未提交、同毫秒顺序、其他角色、当前完成来源替换、整 Attempt 省略和低预算。初次 fixture 与测试类型检查失败保留在仓外日志，没有放宽断言。

641 文件源冻结 SHA 为 `76851100db60df620e25e4e713834bae487b7b1a4a785d400ccea0f9bc5b6524`，三文件补丁 `7c5024a4cd7e8776e2386160b9ed514122b07dedd7ae539b20ba24a418bc579d`，Main 晋级记录 `79eeff3d449946341f1c1474280dfe9fd2aa1d964f89b3dc03b8ed4dd6e4a039`。完整 Attempt 或必要原文超出预算时仍保留缺口；没有扩大历史读取到无界，也未重新证明任意规模来源保留的 CPU 成本。

## 普通 Agent 的实际重放与统一 Main 验收

复用原八份真实 final SQLite；同一 Repository 已确认其中所有 Cognition 状态与原 Agent 前快照完全相等。只在副本中新建 Chat，固定原 Persona、时刻与“这件事现在进展怎样？”；不重新运行 PFC，不注入总结、正确记忆或原 Agent 回答。新消费者仍走实际 prepareTurn → AgentRuntime → Provider → Run/Item。

第一次离线模型列表 fixture 只有模型 ID，遗漏真实输出额度。真实调用前已按原保存的 /models 响应重新装配，使 SDK 自行产生相同 `max_output_tokens=128000`；不手调生产限额。原离线版本和审核记录保留。八份新首请求与旧实际首请求相比，唯一差异是 Cognition 内容；新增调用时再次核对与最终离线完整 wire 深等。源代码、模型、工具、问题和预算无其他变化。

新增 **8 次 generation / 8 completed / 8 已知 usage**；八例均满足原普通用途，必要事实在输入为 19/19，回答表达为 18 supported / 1 partial（ic07 没有重述 Run 终态，仍准确区分声称完成与实际待核实）。ic02 自然说明“你刚才说”三盆已浇水、余水已倒掉；ic06 正确返回文件位置及蘑菇、橄榄油、盐、200 度、18 分钟。原来其余六例继续正确承接；ic04 的“还没有保存完成”仍比“尚无完成证据”更肯定，这处措辞限制保留。

全部 Cognition 表和快照前后不变。新 PFC、形成、encoder、selector、dispatch 与自然 memory.search 均为 0；当前输入充分而直接回答，不把没有调用检索称为冷检索提升。工具效果仍是合成历史回执，实际写文件、日历及后续执行没有在本包验证。

新增实际输入 **80,413**、输出 **708**、缓存输入 **0**，单次最大输入 **10,385**；完整 wire 最大保守估计 28,391。实际首生成 HTTP 为 03:11:08.124 UTC，末次模型终态 03:11:34.407 UTC。24 次 HTTP 为 8 models、8 count 404 与 8 generation，无生成错误。旧普通阶段为 10 次调用且含 17,828 cached input，不能按总输入降幅推算金额；前后非随机重复，不能推导总体稳定率或独占延迟。

当时 Main v6 同版 **1,734 离线 / 26 E2E / arm64 package / 实际 4B、512 维向量 Worker smoke 全部通过**。记录 `main-v6-validation/MAIN-V6-VERIFICATION.json` SHA `060727ed06ed6cebc9f3959ebea6162463871e2d796fd8efff2096fbea352b09`。原 v5 失败及修正单例单独保留，当时确已重新跑完整桌面套件；这不代替当前 v21 的同版打包与桌面验收，见 [STATUS](../progress/STATUS.md)。

## 证据

仓外包标识 `cognition-intent-completion`：

| 文件                                   | SHA-256                                                            |
| -------------------------------------- | ------------------------------------------------------------------ |
| CANDIDATE-SOURCE-FREEZE.json，640 文件 | `61d025cc54e04a720f0187325177f37b8415e1c230d2f5bef49032fbbc02999d` |
| HANDOFF.json                           | `6e7d7eac4cc129b607cd69f5c9c0806cd7ad232e7ac711d578500b4280fe22f8` |
| candidate.patch                        | `9fa3bf79fbbecb81d290db1d29ec7cb955283f0f618e730b0fbfa34dfaeeb456` |
| semantic-cases/inputs.json             | `44761fff4b5092b209b38dc79930b6c4015db8f1c1f24a1221ef7e393e6c5a17` |
| semantic-runner/REVIEW-FREEZE.json     | `4a91d5bed046c71179a6a7e0bf5d60081f74e79d8a269fc90db1e869624fd3f6` |

原实际输出目录 `semantic-runner/live-2026-09-16T02-49-57.826Z` 保留 wire、逐块 SSE、模型事件、数据库、真实 context 和 Agent Item。新增消费者结果位于仓外 `cognition-completed-context/ordinary-replay-runner/live-2026-09-16T03-11-04.037Z`；最终执行冻结为 `e93e50e015d0832a82df4cb547d8d91d673b7edf034557e96578738cf82330ca`，Root 审核 `24623620c398d1465d860e7418290d3ccd0bc7ba63eaaf5af9ced8719736ffd4`，新调用账本 `04a3cb677bff2fdaae0450000b1e55dc17731e242e41042e7cda9c6eba473866`，逐事实复核 `b023394b468036667e6d6da9afd8c005e6aa796c2c751d18d1e9967f0aeb8bf8`。新原始证据为 146 文件/12,283,199 字节，manifest `58d3751a4d05bb264e9ed76b6d95b0fae37dd482786e7d80fb57afde7ec339e8`。Root 另读全部八份实际回答，并复核八份 wire 与全部 Cognition 表/快照不变。 新普通消费者的完整中文报告 SHA 为 `adc35555fca77d59b9f0c66514a4d6fb51ba7ae573d82f99aba4b534c2de31a5`。

没有更改原 12 故事 holdout 或将这些开发例冒充独立验收，也没有用本包证明长期真人陪伴、非空检索或自主外部执行质量。

候选代码清理于 2026-09-16 03:21 UTC 完成：25 个精确根目录中的 1,302 个文件、4 个符号链接与 118 个空目录已移除；归档 1,424 个成员逐项核对，原始 wire、SSE、数据库、上下文、结果及修改前副本等 2,074 个保留文件（含 214 个数据库）哈希均未变化。候选目录和运行器的可执行依赖已移除；保留的初版运行器只作修改前副本。Main 与共享依赖未改动，符号链接仅解除而未跟随到目标。仓外包 `cognition-completed-context/cleanup-inventory` 的归档 `completion-code-20260916T032126Z.tar.gz` 为 19,487,306 字节，SHA `d21c9e6af38093cc7436e9aa78755f6c20caf5717ab4cc02265a1a87c1958aa3`；`RECEIPT.json` SHA `4e7d18f4e9540d0ff30a1b5b848a6e3ca34d63c74626dd6e2432ad8ea4c171d3`，保留文件清单 `FINAL-PRESERVED.json` SHA `235f4fc8ea21fa52fa32bb7dc62fe48258c81e845f80f731213e8af0a92135fe`。
