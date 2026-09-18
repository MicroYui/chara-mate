# 认知行为依据与实际执行上下文

## 2026-09-17：窄对话与执行目标的绑定

原48的 `iv-seats` 三个问答点通过，却曝光一次未交付的主动提示：PFC 已选只读短对话，内容仅涉及新草图及用户本次座位条件，但仍绑定未采用的广义“实际选座及路线方案”候选。运行时按既有 active 资格拒绝，随后用户主动发问才取得答案。此结果不改写原评分，也不是应解除执行条件的证据。原独立报告 SHA `59a4c41788847fc9aecb1f31c8024611b6aca157d76bd0a58315a5c0ba21c9b4`，冻结 `0d7ab837aba3d11a95a650aed40a8881af8b9844507ae17888d7e5f02954693b`。

2026-09-17 读取原 e05 源及当前 Main：Schema 的 intentId 本来可选；ActionReadSet、ActionContext 和 App dispatch 支持无目标的独立 start_conversation，仍保留所选断言、来源、前台版本、忙碌和最终投射检查。Projection 的非 active 目标拒绝是当前行为，不是外部协议要求。Driver 同时写有非安静选中 fulfilled 目标时须带完成来源，未充分区分材料可读与执行资格。本次只澄清两处指令，保留所有结构与执行守卫，不增加状态、阈值或模型路径。

产品§1.6已明确：choice.intentId 绑定真正推进/恢复的目标；独立窄对话可只依据实际选中的情境与来源。不能省掉真实目标依赖、把候选强行转 active，或将未供给的目标正文搬入指令。既有等待输入、请求续接和角色生活不属于可随意去掉目标的范围。读过的 Situation summary 也不会自动全部进入执行输入，实际所需条件与反证仍要选择。

修正只有Driver两处指令和一个既有Runtime集成文件，已与completed_reply组合进入Main；实际Main的41文件711项受影响检查及静态通过。新增真实SQLite→Attempt提交→行动材料→Agent请求回归保留来源、当前条件和反证，但使用两条文字观察，不宣称本案两张PNG经过实际Agent。定向复测复用原L7完整输入与两张原PNG，运行一次实际Driver，不改旧输出、不强制选择、不追加问题；本案真实PFC语义与通用SQLite/Agent机械验证分开记录，不从部分输入伪造完整原库提交。最终桌面另验真实提示。模型若自然选择安静，按实际曝光记录，不重复调用到成功。此处不新开研究课题或重跑整个 seats 故事。

## 既有选型和结果

2026-09-15。本文汇总 v4 机制、实际声明、Q4 离线合同、原 16 例与后续 9 例实际调用。不同版本、手工机制、离线合同与真实模型质量不混作一个通过率。最终仓库保留这一份 Decision；非敏感原始证据留在仓外。

当前交付状态（2026-09-16）：选中实现已随共同 v21 集成 Main；该次 v21 完整离线验证通过；最终同版连续语义、桌面与安装验收仍待完成，进度见 [STATUS](../progress/STATUS.md)。下文 Q4 与后续9例保留各自冻结源码和分母；当前行动材料分配见[动态预算决定](COGNITION-DYNAMIC-ACTION-BUDGET.md)，接收边界见[实际快照接收边界](COGNITION-ACTION-RECEIPT-BOUNDARY.md)。不能把这些后续修复回计到旧结果。

角色答应安静陪伴后，另一份文档更新，不该自动推翻这个决定；角色想评论“现在这幅画”时，该画被改动则必须重新判断；解释“刚才那张图是什么颜色”又应保留历史用途。选择的路径把“本次分析读过什么”和“本次行为依赖什么仍成立”分开，并让真正执行的同一 Agent Run 收到与后一集合相符的材料。它修复了可复现的过度取消，也让漏声明当前依据成为明确可测的问题。它不解决大模型结构更新的全部延迟，不保证模型永不漏绑，也不等于商业陪伴验收完成。

## 选择的实现与用户感受

分析提交仍校验其完整 CAS 依赖。模型对所选 choice 声明实际证据用途，主机在提交事务中编译 actionReadSet：history 支持过去事实；current_object 要求对象内容当前；current_foreground 还要求目标仍在前台；current_recollection 绑定准确 Memory/Revision 的当前资格。当前 Claim 引用包含真实支持与矛盾来源，所选 Intent 自动绑定真实 revision。用户控制、Persona、所选状态和重要时刻取消不会因为拆开依赖而被绕过。

执行前、原子 Run allocation.bind 及表面发布前复用同一资格校验。当前对象发生变动都需检查，包括操作归属为 unknown 的来源；actor 不能成为忽略真实对象变动的理由，也不能仅凭画面可见就断言用户兴趣。旧的“分析全部背景都必须不变”的执行 guard 被移除，生产没有两种 guard 开关。SQLite 事务仅保证本地持久/Run 分配一致，不能冻结外部桌面。

Q4 补齐了真实执行输入的缺口：自主 Run 只得到所选 Intent、当前 Claim 与明确用途的原始来源，不把当前 Situation 所有旧画像、其他目标、title/summary 一并灌入。普通用户 prepareTurn 仍按其当前对话职责工作。声明之外的后台材料不再偷偷参与生成；必要来源消失或装不下时明确失败，不照原指令继续并假称完成。

检索所得是独立 recollection，文本取实际 Memory 内容，保留原 basis、visibility scope、修订与发生/记录时间。actor=system 表示读取动作，不猜原说话人；owner 不是 speaker 或语法主语。真实角色话语可以按 reported 保存“角色曾这样说”，不能自动证明世界动作成功。Memory inference/unknown 不被重写为新 user/agent utterance，也不能升级为新用户授权或完成事实。

Attempt 只存所选引用和必要 RecallPlan/coverage/gaps，不永久复制整份候选 Pack。执行时同步按准确 pair 从 Memory 公共端口重读、验证并组装，仍装入的 revision 才能支撑 coverage。纯历史用途单独明示，Memory item.current 保持真实读取状态，不为了用途把 true 改成 false。Source 缺口、历史状态和未证实解释都应在模型材料中保留，但可见回复应使用日常语言，避免向用户念内部核对流程。

## 一手来源与适用范围

下列源码/官方规范均于 2026-09-15 核实。它们提供边界参照，不能替代 CharaMate 的质量证据，也没有要求按脑区增加进程或引入 Agent 框架。

| 来源与版本                                                                                                                                                                                                                                                                                  | 本包借鉴的边界                                           | 不能推导的结论                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------- |
| SQLite [Transactions](https://www.sqlite.org/lang_transaction.html)、[Savepoints](https://www.sqlite.org/lang_savepoint.html)、[JSON](https://www.sqlite.org/json1.html)、[核心函数](https://www.sqlite.org/lang_corefunc.html)，当日文档；实际 SQLite 3.53.3 / better-sqlite3 13.0.1       | 本地事务、来源按 ID 读取与 SQL 先控正文规模              | 不能锁住外部对象或证明语义检索有效                    |
| OpenHands SDK [state.py](https://github.com/OpenHands/software-agent-sdk/blob/b054a2fe99173baee47897e4f3af7a910d3aab1e/openhands-sdk/openhands/sdk/conversation/state.py)，commit b054a2fe99173baee47897e4f3af7a910d3aab1e，2026-09-15 05:11:49 UTC                                         | Action 与真实 Observation/Reject 身份关联                | 没有现成陪伴 freshness 算法可直接复制                 |
| [WebDriver 2 Elements](https://www.w3.org/TR/webdriver2/#elements)，访问页版本 2026-07-02                                                                                                                                                                                                   | stale 与实际文档/节点有效性有关                          | 网页任意变化不等于全部用户意图失效                    |
| Playwright [dom.ts](https://github.com/microsoft/playwright/blob/500c9c822ce7664539a4c8a88810048dfe090c3b/packages/playwright-core/src/server/dom.ts)，commit 500c9c822ce7664539a4c8a88810048dfe090c3b，2026-09-14 19:07:35 UTC；[Actionability](https://playwright.dev/docs/actionability) | 动作边界核对具体目标                                     | CharaMate 未因此升级现有 1.62.0，也未取得语义原子保证 |
| Hindsight 官方 [retain](https://hindsight.vectorize.io/developer/retain)、[Structuring chat logs](https://hindsight.vectorize.io/blog/2026/06/23/structuring-chat-logs)，博客日期 2026-06-23                                                                                                | 原说话人、原文上下文与派生记录分开                       | 不证明本产品已经达到该项目效果                        |
| OpenAI 官方 [Streaming responses](https://developers.openai.com/api/docs/guides/streaming-responses)，当日文档；官方 JS SDK 6.49.0                                                                                                                                                          | created、text delta、completed 与 host commit 是不同阶段 | HTTP 成功不等于合法提交或语义正确                     |
| [ECMA-402 CreateDateTimeFormat](https://tc39.es/ecma402/#sec-createdatetimeformat)，当日在线草案                                                                                                                                                                                            | 当前系统 IANA 时区与当地日历锚点                         | 当前系统时区不证明历史来源作者所在时区                |

生产源版本由各阶段外部 source manifest 固定；Node 24.18.0。模型始终 gpt-6-astra。请求没有覆盖 reasoning；已观测 response.created=medium 是服务当时默认行为，不是代码锁定。完整输入使用保守估计，按用户指定 258,000 Token 与 Provider 较小限额拦截；input count 返回404时，不能保证接近限额处有精确 tokenizer 计数。本记录以此修正旧分记录中“完整输入均经硬上限检查”可能造成的过强解读。

## 分阶段证据，不能相加成一个成功率

| 阶段           | 冻结条件与分母                                         | 实际结果                                                                         | 能说明什么                                                              |
| -------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| v4 手工机制    | 12类×3后续变化，同一个已提交 Attempt 比两 guard；0模型 | 36/36对完成，旧25/36、新36/36符合冻结标签                                        | 精确修复这些过度取消反例；不证明模型会声明正确                          |
| v4 actor 更正  | 不改原36结果，新增4个 agent/system 当前/历史回归       | 原134离线项增加至138；0模型                                                      | 当前对象变化不能只检查user actor                                        |
| v4 真实声明    | 每案1次真实模型，共12；空Pack，仅声明诊断              | 12生成完成/解码，11提交；实际33/36后续分支                                       | 同实际输出运行guard；不证明真正Agent输入范围正确                        |
| Q4领域合同     | typed recollection、所选执行输入、确切Memory资格       | Cognition+Life/机会源179；Memory领域185及integration16                           | 持久状态/输入组装/精确资格的离线正确性；不当模型质量                    |
| Root Q4集成    | 真实SQLite/Run分配/异步生成/表面资格                   | Q4时点完整134 contract+1029 focused+312 integration=1475；后加scope标签2文件16项 | 不同层回归不另累计为质量样本；不是Electron实机验证                      |
| Q4原16真实机会 | 原v4素材12后验+4新题；共享真实Agent                    | 30生成完成、12 Run完成；11 delivered/4quiet/1unknown                             | 实际材料与回复可检查；selected Memory实际仍未覆盖                       |
| 时间/表达后续9 | 5后验+2换题+2真实cue；新的源快照                       | 16生成完成、6 Run完成；6 delivered/3 quiet                                       | 当前偏好/时间有限回归改善，n01表达仍有问题；i01实际规划错误，原16不回写 |

原测试分母的变化另保留：v4首次扩展命令漏Opportunity Repository且Life两fixture缺新增字段，为131/133，修 fixture 后完整134/134，未删除原测试。actor修正新增4；Q4再新增41，179/179。Q4曾有窄命令177项，不冒充完整分母。Memory新增14的初次两失败是不存在的测试辅助方法，改用真实 addSpan 后完整通过。以上是离线开发过程，未用修改输入“修好”真实模型旧结果。

## 机制结果与实际 v4 声明

36对手工机制里，无变化12例两侧均保持；相关失效12例两侧均拒绝；冻结为无关变化12例，旧guard11次误拒绝，新guard均保持。覆盖用户新话语/控制、Intent暂停与接续、Claim及alternative、对象内容/前台、cue取消/修订、迟到sequence。手写basis没有模型能力含义，确定性反例不计算人群置信区间。

真实v4共96,862 input /23,089 output /0 cached tokens；每例生成27.554–43.184秒，中位34.022秒。f08真实角色原话被模型正确写成“曾答应”、未声称效果，但当时reported只接受user utterance，host拒绝。因此三个后续分支没有执行，实际33/36，不补造成功Attempt。其余11例的无变化与相关变化，两guard分别全保持/全拒绝；标为无关的变化，旧guard10拒绝/1保持，新guard1拒绝/10保持。它们是按声明执行的结果，不是33/33语义正确。

f04明确回答旧截图，模型却声明current_object。Root指出后另做零模型诊断：在复制的原提交库中变更同一画布，两guard均拒绝原本仍成立的历史回答。它是过度声明，不该取消真实current_object检查来迁就。f10询问共同提案时也绑定编辑器前台，存在过度声明疑点。所有后验诊断均不回写原分支。Root进一步读源发现Agent仍收到未声明背景Claim/其他Intent，PFC已取Pack又未传入真正Run，因此进入Q4整体收束，未只放宽reported一行。

## Q4确切Memory与真实Run离线证据

Memory公共metadata validation校验准确pair、可见域、归档/删除、current/history和时间资格。current要求当前修订指针及当前有效性，knownAt/validAt/includeSuperseded不能绕过。resolve在同步事务中先验证、再按SQL字节约束读取，返回unavailable/omittedForBudget，不把巨大正文先全载JS，不重新模型召回/embedding，也不记录曝光。

领域用例覆盖实际角色话语、原Memory推断/未知不能升级、禁止伪新授权/完成、读取Attempt身份/幂等、所选Claim支持与矛盾、排除未选画像/Intent、缺失和巨大来源、query coverage回建和完整执行材料预算。Root实际Run测试进一步验证：当前Memory在dispatch前被修订时0模型/无绑定；Provider.resolveContextLimits的真实异步间隙内修订，在allocation.bind拒绝、0Run残留；生成期间修订，history可继续而current被撤回；历史Memory归档或purge不能发布，恢复也不重复发布。用户Voice和Persona变更继续做实际可用性复核。这些测试核对数据库、Run和表面边界，不把mock模型输出当语义证据。

## 原16例真实PFC到Agent

完整实际分母：16/16机会终结，30/30生成完成，其中PFC18、Agent12、selector0；实际Run12完成，Attempt为delivered11、quiet4、unknown1。delivered是实际Surface逻辑接受的headless记录，不是Electron/Android真实触达。两次Memory recall在f07/f08得到真实空候选，没有任何selected Memory revision进入实际Run；n02/n03/n04虽然库中有种子，原话工作集已足够，模型没有被强迫检索。相关Memory basis/历史绑定/Pack缺口要求如实N/A。

总input207,771/output31,845/cache35,930；旧12为22生成，新4为8生成。最大实际input12,268，远低于258,000；最大完整保守估计85,931，unknownKinds0。metadata30×200、count30×404、generation30×200分别保留。全部usage已知，金额因没有可核单价而未知。PFC中位32.8875秒、范围23.861–50.279；Agent中位3.0705秒、范围1.691–5.992。执行窗口13:50:14.983–14:01:04.220 UTC与其他development共享Provider，没有连续新事件流，不能称独占服务率或商业p95。

f04历史图用途改正，PFC实际看到蓝花/黄心；f09当前图红花正确，AX标题不冒充颜色来源。Agent没有再附PNG，仅据所选事实/准确引用回答，不称Agent独立看图。f08角色真实话语已能reported且不假称效果。f02没有花架能力时明确限制，unknown、无气泡，不能当Territory成功。

仍有明确缺口：f03/f06 PFC只有UTC，错误把日期跨界当本地跨日；实际两时间是上海同日上午。f05建议当时正确且允许改口，但依赖旧偏好继续适用，漏掉其currentClaimRef，Root独立判为声明不足；没有实际修正竞态，不能说已观察误答。f11合理quiet却多绑编辑器前台，Root判过度声明；本轮无后继变更，不说实际误拦。n01事实正确，但把“不能当作实际画过或搬动的确认”这类内部核对口吻说给用户，自然度不合格。原新4例的狭义12要求是9pass/0fail/3N/A，不能掩盖自然度问题称整体全通过。

f07/f08缺合法Memory source，是输入覆盖限制，后续另用实际Memory+OpportunityService的两例修补。它们没有覆盖到的真实重要时刻不能在原记录上补记成功。执行者逐来源初评与Root f05/f11独立核对均记录，不称完全隔离盲评。

## 后续 9 例：有限修复回归与真实规划失败

5 个后验素材 f03/f05/f06/f11/n01 的原话及时间与原 16 例完全相同；t01/t02 是换题；i01/i02 由真实 MemoryRepository 和 OpportunityService 生成合法 cue。Root 仅同步 9 个时间/表达源及测试，没有同步随后 GC/DB 包。PFC/selector 使用 scenarioClock + Asia/Shanghai，Text Agent 共用生产时间 helper；历史来源未知时区不被补造。源快照冻结后 123 个输入/适配文件与 546 个生产文件均保持一致，原 16 例的 187/544 文件也未改变。它是多处修复的有限后验回归，不是单变量 A/B。

实际 9/9 机会终结，16/16 生成完成：PFC 10、Agent 6、selector 0；6 个实际 Run completed 并被 headless Surface 接受，3 个 quiet（f11/i01/i02）。一次真实 Recall（i01）0 候选；0 selected Memory、0 encoder、0 formation。离线 i01 脚本 smoke 中出现过 Pack，但不能补作本批实际覆盖。

| 素材组              |              生成请求 | Input / Output / Cache   |
| ------------------- | --------------------: | ------------------------ |
| 5 后验              |    9（PFC5 + Agent4） | 60,151 / 9,680 / 7,506   |
| 2 时间/当前建议新题 |    4（PFC2 + Agent2） | 25,174 / 3,158 / 0       |
| 2 合法重要时刻      | 3（PFC3，均无 Agent） | 27,192 / 5,141 / 0       |
| 合计                |                    16 | 112,517 / 17,979 / 7,506 |

最大实际 input 11,874，最大完整保守估计 60,329，最大 wire 50,425 bytes，unknownKinds=0；metadata/count/generation 分别为 16×200、16×404、16×200。使用量全已知，金额未知。PFC 完成中位 32.4435 秒（23.344–41.806），TTFT 中位 8.414 秒；Agent 完成中位 3.2475 秒（2.746–4.786），TTFT 中位 1.8745 秒。真实请求区间 14:22:17.776–14:28:04.743 UTC，与另一个本地感知实验共享远端 Provider；本包没有本地 encoder，不以此推断隔离服务率。

f03 如实确认当前局部文字，未再用 UTC 跨日误换算；由于仅回答原句，这项不能扩称丰富日期推理成功。f06 保存“今天暂时不想、以后可能改变”的 alternative，建议香菜另放，没有把本地同日上午拆成昨天/今天。新 t01 对北京时间 07:45→08:05 明确判断仍同日，同时限定“按北京时间算”；没有推断薄荷已换盆或创建催促任务。

f05 实际 selectedBasis 及 Agent 输入现在包含 cilantro currentClaimRef，旧原话仍为 history，回复允许这次尝试另装；新 t02 在推荐大字版时也绑定 reading-font 当前 Claim，没有从偏好推出视力问题或假称切换。f11 根据明确等待指令 quiet，currentObjects=[]，不再为了继续等待而要求编辑器始终前台。它们只是本轮实际输出与所选材料的核对，没有注入新修订竞态，不能报告已观察到真正竞态下仍正确。

n01 仍未达到自然表达目标。实际回复前半句已经清楚说明尚未搬杯子，后半句却说“‘画了一下位置’那句想表达的是位置构想，不代表实际画过或搬动过，是我说得不够准确”。这种不必要的撤回或模糊自己的原话，仍像核验说明；不能宣称共用自然表达原则已彻底解决。该判断来自逐段阅读，不是词表判分。

27 个冻结狭义要求按执行者逐来源初评为 24 pass / 1 fail / 2 N/A，未做盲评，不是人群成功率。n01-r3 fail；i01 选中 Pack/用途检查未发生为 N/A；i02 要求的实际 Run 未发生为 N/A，同时其已提交 reported Claim 的说话人范围仍可独立核对。i01 还有下面这项实际规划失败，不能借 quiet 合法或 N/A 隐藏。

### i01：有效未来事件被错误 RecallPlan 排除

原话说明北京时间当天 08:30 演示，实际 Memory/current Revision 有效，真实机会源在 08:00 发 cue。模型第一轮的长 query 文本包含正确的 Memory/Revision 身份，却把 **Memory ID 填入 entityIds**，并设置 **occurredTo=08:00:01** 去查询 08:30 的未来事件。冻结 schema 仅有类型而没有这些字段的语义说明，PFC 的检索指令也没有解释 ID 命名空间和三个时间轴。

实际 SQL 将 entityIds 作为 memory_revision_entities.entity_id 的硬过滤；occurredTo 则要求 COALESCE(semantics.occurred_from,revision.occurs_at) 小于上界。它们作用于词法、实体时间及向量资格，不是可忽略的检索提示。query 文本里的正确 ID 不能抵消这些过滤。实际两个问题各 lexical=0、semantic=0，entity_time=0；fused/candidate/selected 都为 0，没有 selector。PFC 第二阶段据此认定当前修订/近期回应缺口未解决并 quiet。

运行结束后，用原初始 SQLite readonly 和冻结生产 Repository 做四条件零模型诊断：原计划、仅去 entityIds、仅去 occurredTo 均 0；同时去两者后，准确 Revision 在两个 lexical 和 entity_time 各返回 1，exact eligible 亦返回 1。原样 current pair validation 的 unavailable=[]。这证明两个错误条件各自足以排除已知有效来源，不是底层资料缺失；词法返回也不证明“此前没有回应”，本诊断没有重新 selector/生成/提交，不补记真实成功。

完整实际 planner 输入→字段→SQL→quiet 链保留在 `q4-followup-live/I01-PLANNER-DIAGNOSIS.md`、`I01-ACTUAL-PLANNER-CHAIN.json` 和 `I01-CONSTRAINT-DIAGNOSIS.json`。该次诊断结束时提出的后续通用修复方向是：明确 Entity/Memory/Revision 命名空间以及 occurred/knownAt/validAt；已有准确引用可通过同一 RecallPlan 的显式定向请求复用 Memory 的资格/读取端口进入同一证据链，不再靠 UUID 词法猜测。已失效 pair 必须显式不可用，不做宽泛 fallback 或偷偷换新 revision；Chat 最近是否回答应根据真实 Chat/Run 材料，不把 Memory 空结果当全局没有。这些是当时的下一候选方向，未在本批运行途中修改生产；后续检索实现不回写本批结果。

i02 的合法源同时包含一分钟前真实持久的角色开场，模型据此 quiet，避免重复说同样的话；reported Claim 明示角色说过不等于用户已获得陪伴，也不代表演示完成。这是有效的不打扰结果，与 i01 的错误规划不能合并解释。

## 仍然不能宣称的能力

模型可以漏掉当前Claim或多绑对象；host只执行声明，不能凭schema判断所有语义依赖。Q4收窄自主输入减少了未声明背景泄漏，但instruction本身的隐含依赖仍需评价。Run后来主动memory.search的新依据不自动加入原PFC read set，这次只承诺所选PFC材料资格；普通Chat历史仍遵循共享Runtime的既有对话范围。

Intent完整revision和Claim材料比较可能对无关progress或同义改写保守拒绝。Activity当前表面接口不能精确确认已离开前台的任意窗口；当前visual用途可能被保守拒绝。surface/actor不是逐像素原子锁，未让普通帧变化每次杀死只读分析。无能力的工具目标、未接收PNG的Agent和headless表面都诚实保留限制。

一次PFC仍可能数十秒；较少误取消不证明连续content/scroll/frame流的消费率超过到达率。当前对象优先与连续历史水位、情境关闭后的召回续接等另有独立工作，不以本包离线项或少量回复代替持续用户验收。没有新增认知模式、第二Run、模型classifier、关系分数或调参界面。

## 证据与最终清理

外部主集合 cognition-action-freshness：MECHANISM-BUNDLE-FREEZE/HANDOFF、ACTOR-SOURCE-AMENDMENT、LIVE-INPUT-FREEZE-TIME-CORRECTED/LIVE-RESULTS、Q4-HANDOFF；Memory集合memory-evidence-read-q4的handoff。原16 INPUT-FREEZE SHA91828da744b9b1eaed8cd78bd72cb6d1bd59bc82f499708b47a1acb786d38e82，实际结果manifest SHA0ddd88ee685cfd7d6982d4bffafdf07f2537f93ba7c6e78d484bd07644718140。后续9 INPUT-FREEZE SHAbaaf35133dbcf8c6203debd6f05b0ee3ead2fb08f6000d5fb058b8a34cc055ac。用稳定相对证据ID和哈希，最终仓库不加入实际数据库/原流/评测脚本。

本包评测正常结束后，已精确删除 44 个顶层候选条目：旧 guard/projection/repository 副本、旧补丁、机制与实际调用 runner、只读诊断脚本、两个临时 production 源目录及 node_modules 链接；链接目标未动。补充删除本包两个 /tmp 准备/汇总脚本。没有修改或删除 Main、integration、Cognition 工作树及其他 Agent 的包。扫描本证据目录未余留 `.ts/.mjs/.js/.py/.patch` 可执行候选。

`CLEANUP-MANIFEST.json` 保留删除前逐文件 hash、链接目标和目录清单，SHA `7cfceb92eb7645b927c3ea20d52a3669426a76c069920fce62918c7c5d77cba7`。旧16结果116文件与新9结果82文件在删除前后逐一复核不变；新9结果 manifest SHA `2dd83c20ad5af1c230108d4007c128d3c66eb492082fca0b974d476030f0c799`。原始 requests/SSE/实际输出/SQLite/合成 PNG、非敏感摘要、既有冻结及协议均留仓外；源 manifest 中已删文件的 hash 是历史版本标识，不声称完整候选目录仍可直接运行。

生产只保留选中模型 schema、typed 依据/执行投影和普通回归，没有旧 guard/旧 wire 开关。本记录的 Q4 日志证明当时范围，当前 Main 交付状态以上文 v21 说明与 STATUS 为准；后续检索和连续负载结果分别报告。本单份 Decision 留在 Main，分阶段草稿不并列成为生产默认。

## 2026-09-18 原 seats 的最终 Driver 定向复测

固定整合v3源（SOURCE-FREEZE `0cbc46b68b3eb62f10f1e72f8a3acc97b533ee1a171473940955845a5c28f3b0`）对原L7完整Situation/Intent/9 Evidence、前次attempt与两张原PNG执行一次真实gpt-6-astra analyze。实际选择独立只读 `note-current-layout`：提示新图“妈妈在左、我在右、出口仍在右”，联系本次用户条件，保留旧图/旧回答的历史范围，不认定用户改意或购票。所选提示没有绑定广义目标，该目标仍为 `inferred_user/candidate`、completion keep；没有把它激活或完成。此窄路径真实曝光并通过，不能推广为真正依赖的目标也可省略。

首轮在生成前被旧请求全等断言拦下（0生成、1 metadata）：已选Driver目录去重省略了与coverage完全相同的attempt.sourceCoverage。原失败保留，只在新执行副本证明两目录全等后调整expected一处；原fixture、真实request、产品源及其它消息/PNG均未改。适配后唯一真实analyze返回，无纠正轮；完整新提议及当前来源用途、原广义目标和输入差异由Root核读。两轮共2 metadata200、1count404、1生成200，实际27679输入/2461输出/0缓存，精确预计数未知，完整估算174283/258000；51.320秒是重叠宿主观察值，不作性能比较。

原seats被deferred的失败与原评分保持。本次仅Driver schema/引用校验和真实选择，不执行DB/CAS、Agent Run或投递；两图为原捕获的固定回放，不算新鲜桌面验收。原输入SHA `5641abae85e9ccdfb293aeab326408b4f61733abb635ad972a91c1b9d16f9a94`，报告/实际提议/请求差分/回执在仓外 `integration/iv-seats-final-driver-v3-execution-v1`，FREEZE `81bb65bcd659ad94d2e7fce1bfa5af2357b386872f32a8e686349f379fca78b6`；62文件已核，全部PID退出。共享表达句后续变化不回写这次v3结果，最终桌面另验。

## 默认房间观察的无损共享修复（2026-09-18）

最终桌面回归暴露另一种材料问题：默认小屋403个节点、39个行动目标中360块地砖逐个重复同一Definition内容。实际territory.observe完成，但311,087字节的模型结果使下一完整请求在不支持精确计数的Provider上被保守预算拒绝。它不是精确Token已超过258k的证据，也不是原8k局部配额再现；不能通过抬高用户上限或伪造count成功关闭问题。

Root在既有territoryTools内增加单一模型投影，按相邻节点完全相同的共享字段分组；每个实例保留其ID、placement.point和实际layout根、网格点、像素原点，共享字段保留Definition版本/内容、其余placement/layout全部原值。附件parent/anchor/偏移/变换以及不可用引用不补默认值。合并每组shared和node的placement/layout即可精确恢复全部原数组及次序；这是表示层去重，不改变Domain/IPC/DDL、几何或动作执行。PFC沿用真实Tool反馈，没有第二套投影或候选开关。

同一捕获的完整请求只替换观察表达，使用实际inputBudget实现：自主请求392,619→178,484字节，保守估算395,275→181,140；手动动作421,979→207,844字节、430,459→216,324。原258000×0.9估算门不变。以上是原payload的只读重表达测量，非新Provider精确计数或模型质量比较；新descriptor与真实Tool哈希使用实际修复后的运行。

原完整小屋的实际SQLite/Service→Tool结果经字段恢复检查仍为403节点/39目标；附件、不同Definition版本、不可用原因及非相邻节点顺序另有回归。E2E原夹具修正了旧targets.name读取：按共享Definition名称找到真实实例，再匹配targets中的可达性及sleep动作，不硬编码床ID。原两项桌面流程已在修复后的完整E2E中通过（实际观察→行动、自主暂停→重开）；最新完整离线2659项通过。该轮最后一项另遇启动无窗口，原失败及清理缺口保留；修正测试launch失败时的正常关闭与日志收集后，原单项复测通过，生产字节未变。不能把这项夹具修复称原无窗口原因已获证明，安装版仍须实际启动验证。

原失败、真实请求、透明观察入口错误、无损重表达及独立审阅见仓外 `integration/e2e-territory-context-diagnosis-v1`（诊断冻结SHA `3ed53326ac537e26c356811ca046823852817422f5bb2e95d2aca3bc059d278b`）；Main修改与前后字节见 `integration/territory-observation-sharing-main-repair-v1`，原E2E及复测日志见 `integration/final-package-integrated-execution-v1`。没有新增模型实验、条数/分页配额或生产兼容分支。
