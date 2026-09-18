# CharaMate 当前状态

更新：2026-09-18（下文精确执行时点以注明的 UTC 为准）。

## 当前里程碑与范围

**本地成熟度 Goal 仍在推进，尚未达到全部退出条件。** 当前 Main 已删除旧库迁移链，并合入巩固可选原件、完整领地布局、旧承诺限定修订、形成实体候选范围、等待输入环境续接与局部对话进度修复；文字完成与窄对话绑定的711项受影响检查通过，新增按需文字观察的421项检查及目录去重的162项检查与静态通过。2553项完整离线与构建是这些后续变更前的结果。原独立48故事已按冻结 e05 源运行结束，全部经过独立及Root评阅。原P/R定向复测的真实纠正与F2均已闭合核读；E形成比较8条件已运行关闭，正在按原判据先核语义，X表达比较运行中。E支持完整必要对照分配，Root已选择并将28文件Memory组合合Main；946项关联检查及静态通过，最终同版定向复测、桌面和资源验收仍待完成。原固定版结果不能自动算作当前 Main 或后续候选的同版验收。

用户确认没有已发布用户，直接使用当前新库；旧开发库另存，不保留迁移链，不自动覆写旧库。要求本地可运行，不要求发售、签名、公证。可控时钟和跨日/跨月数据可以代替等待，但模型、4B编码器、数据库与桌面通路仍须实际验证。未来线上社区、海量并发、跨平台服务仅保留方案。

本轮完成路径已固定：原48跑完且版本不变 → 已知问题针对复测/关联回归并统一整合 → 最终版本完整桌面流程和已列容量/资源检查。已知使用问题关闭后交付并结束Goal；不追加研究或新实验，不等待真人跨日。局部修复不重跑全部48，核心链路改变才扩大相关回归。磁盘清理只删除确认无当前/待验依赖的重复模型、依赖及旧构建，结论/版本/实际失败/关键输入输出保留。

权威入口：[产品](../../REFACTOR_PRODUCT_DESIGN.md)、[UI](../../CHARA_MATE_UI_DESIGN.md)、[本地方案](../research/ai-companion-local-implementation-2026-09-15.md)、[退出条件](LOCAL_MATURITY_ACCEPTANCE.md)、[路线与依赖](ROADMAP.md)。root 唯一拥有 Main、共享合同和数据库集成；所有原有改动保留，未提交或推送。

## 当前生产实现

- 行动材料已移除固定8k/32k最终额度。必要原文与模型输入分别分配，完整请求计量；当前16 MiB原始值护栏依据实际App读取代价选择，近15 MiB约212/184 ms，仍有约0.2秒Main等待。完整输入上限取用户258000与较低Provider限制；代理count 404时为保守估计，不能声称精确服务端计数。
- 完整巩固、形成输入变化/并发修订恢复、普通Chat新输入刷新、完整memory.search结果拟合、视觉读取与取消恢复已进入Main。Text明确先自然承接再等待记忆；保留完整Run可能更慢的代价，不称整体提速。
- PFC引用关系进入原有同次纠正，Voice已知本地输入进入发送前完整计量。后者不包含不可知的服务端音频history；两项真实同版验收仍待执行。
- 巩固队列的综合选型保留唯一FIFO，未采用实验性的未来需求排序。该选择不等于已经实现互动时钟预测或按日期遗忘；原负结果与采用缺口保留在[Decision](../benchmarks/MEMORY-ADAPTIVE-CONSOLIDATION.md)。
- 领地观察提供当前 Zone 全部摆放节点、真实 Definition/placement 与 Renderer 共用布局几何，行动目标为其子集；缺引用明确不可用。巩固补齐已选可选原件，保留必要优先、整体移除及真实提交有效性。两项已合入，最终模型采用与实际画面仍待验。
- 数据库只保留当前26 Schema、新库创建和正常重开。22旧迁移模块、13纯迁移单测已删除；三份DDL不变，来源/修订/事件游标与非当前版本拒绝仍有真实SQLite回归。

## 活跃工作包

| 工作包 | 所有者 / 状态 | 下一项验收 |
| --- | --- | --- |
| 重复事件目录去重 | root / cognition，integration-verified | 原it02同一sourceCoverage重复7,295字符，非丢醒证据。Driver与既有测试两文件已合Main，相同目录仅在模型投影留一份，单独目录归位、不同内容均保留；host/CAS不改。162项关联与静态通过；字符节省不冒称Token或延迟收益，c120原失败不改，不新加调度/抢占参数 |
| 按需读取已采集文字 | root 集成 / memory Activity域，integration-verified | 原it01 c300已有新AX时间却仅供旧Cognition，image.inspect因无PNG失败。10文件已合Main：同一activity.observe供普通Chat/Agent/Voice与角色生活使用，读取最新匹配或固定event原文、完整结果分页及真实时间/actor/scope/不可用/暂停状态。实际Main421项受影响检查与静态通过，0新表或新采集路径；原u240真实单回合复测入口准备，最终模型自然选择与桌面待验 |
| 独立连续场景 | root / memory / cognition，integration-verified | 原48全部运行闭合并经Root逐例评阅，固定e05。305外层步骤/2411到达/189观察索引全部存在；185判据槽保留179 pass、4 fail、ic01一项不可判和it04-c60原标签缺项。f02的12索引/8判据不补虚构通过。3181生成中15次usage未知，不能给完整金额或统一成熟率。原错误/真实恢复和暖冷边界保留，实际8个throughput后续问全部暖供给；固定版不等于当前Main验收 |
| 形成必要对照分配 | root，integration-verified | E原4对/8条件完成：A形成0/4、冷答2/4；B形成4/4、冷答4/4，相同18生成、输入增加7.59%。Root选择完整必要材料路径，并按28行前像合并既有Memory修复；实际Main946关联检查与静态通过。原R一次F2完成且14/15不新增，独立分母保留。原E源码/输入不混后续v24/SC，最终同源定向和App待验 |
| 巩固可选原件供给 | root / memory，integration-verified | 一个生产与两个测试文件已合入；旧生产2/2真实请求缺原件失败，修复后101不同SQLite/SDK/领域检查通过。必要优先、完整可选前缀与原目标/片段有效性保留；合并2511 offline/build通过；最终真实采用待验 |
| 旧承诺限定修订 | root / explain_memory，integration-verified | 一个生产与既有测试文件已合入。真实SQLite先建立角色承诺，再以新用户日期修订；原生产两种raw状态均真实拒绝。隔离及实际Main的567领域检查、静态均通过。只沿用未变言语事实，新增限定仍需本次primary；create/support、新承诺、撤回/履行规则不放宽。原ic02真实L12同提案在旧guard拒绝/当前Main一次修订两target，独立PID重开一致；新增模型0，最终接口整合时复用该针对回归 |
| 形成实体候选范围 | root / explain_memory，integration-verified | 原ic05内部F1名字部分解析为用户，自动硬过滤排除具名妹妹；F2新建generic妹妹，原失败保留。三生产/两既有测试已合入Main；真实SQLite复现后577领域与静态通过，已解析实体只补充同次结构候选，显式过滤不变，pending住所仍可取。真实4B/Selector/F2采用针对复测准备中；无自动合并或新检索器 |
| 等待输入时的环境补充 | root，integration-verified | 原im01末点新材料已到，重复开同Chat Turn被拒。31文件修复合入Main：同一Run完整材料/问题/checkpoint/接收回执原子提交，不伪造用户答案；785受影响域、12组件、8合同通过。省略Chat及角色Run实际steer的两项追加边界已修，原im01最终自然复测待执行 |
| 已有承诺的对话进展 | root，integration-verified | 原im02与im04实际建议完整供给却空提案，持久进度滞后。三文件指令与回归已合Main，受影响Memory/来源476通过、独立前态/引文审查完成；真实Service close/open机制通过，原im05已供摘要却未补精确原承诺，v22隔离修复与独立源码审查完成：仅补实际采用摘要的原件并共享完整预算；已随28文件组合合Main，946关联及静态通过；原im02/im05自然形成与后续供给待验 |
| 无旧承诺的实际稿件记忆 | root，integration-verified | 原if01已交付139字两版标签稿，existing为空时形成empty；if03同类217字稿件遗漏保留。v24四文件隔离复用event/episode与现predicate，限定实际primary assistant交付的create，不扩support/revise。真实SQLite旧guard拒绝及初稿扩大旧事件依据的三个RED保留，修后637领域/65依赖与静态通过；四文件已随最终组合合Main；单原if01真实形成/落库/重开待最终源验收 |
| 局部纠正后的情境引用 | root / memory，integration-verified | 原gift更正收礼人后，current保留生日/情绪归属未知却缺详细旧报告引文，首Conso全供仍retain；原旧corrected全文仍在，三次暖答正确不抵消缺口。基于v22的v23仅澄清现有retainedCitations合同，三文件已冻结并经Root完整差异审查；197受影响检查及静态通过，两例持久化只证明合法提案的处理。已随最终组合合Main；原六步/三点复测准备完成，真实模型采用待验 |
| 有限文字任务的完成 | root / cognition，integration-verified | 原isa-dialogue实际回复已满足一行重排目标，PFC却因只准效果/用户报告而挂起。产品及完成Decision已补第三依据completed_reply；7生产/6测试文件已按前像与窄绑定组合合Main，实际Main711受影响检查及静态通过；原keep/set/clear与节选保留，元数据/已回收/零字片段不充当新完成。原六步最终复测准备完成，真实语义待验 |
| 窄对话的目标绑定 | root / explain_memory，integration-verified | 原seats选择当前图差异提示，却绑定未采用的广义选座目标，被既有守卫推迟。产品与行动依据Decision已明确目标是执行依赖、不是话题标签；只澄清Driver两处矛盾文字，不放宽guard或丢真正依赖。两文件已与文字完成组合合Main，711受影响检查及静态通过；原L7完整输入/两PNG的一次PFC定向复测已准备。SQLite/Agent通用机械通过不冒称原seats实际Run；不重跑整故事，不强制开口 |
| 检索选择引用有效性 | root / explain_memory，integration-verified | 原f02一次Selector第三项使用不存在的近似revision且问题映射/coverage为空；同一Recall失败传播给三个reconcile work，末态aggregate仍failed=3。隔离v23基线以本次索引与完整问题映射修复，仅结构错误可同输入纠正一次。627领域、最终102 focused及静态通过，Root/独立review接受；已随最终组合合Main，真实复测待验；不静默猜ID或回写原库 |
| 巩固独立支持判定 | root / memory，integration-verified | 原bounded失败已定位：同一用户原文经普通入口与PFC再处理时，情境标签计数取决于work ID排序，缺标签被用作跨情境硬否决。产品合同已明确原始来源去重与语义独立性分工；三文件隔离候选已冻结，633领域/65依赖及最后80相关检查与静态通过；原13次巩固的1次失败保留。三文件已随最终组合合Main，原model56一次真实巩固定向入口待最终源执行。日期、Chat数或PFC标签不代替完整原始材料中的真实情境判断 |
| 纠正时自然表达 | root / cognition，implementing | 原单句3对已完成12个条件内Run，两臂各5/6且clarification同败；133生成usage齐，Root/独立完整供给审查接受无收益保留baseline，不合候选。全局UUID去重8是跨库复用，不能减分母。仅对澄清意思和明确报告助手旧错的归因歧义作一次原三案窄修复复测；不回填原48/X，不外推Voice |
| 自主日常、到期与竞争 | root，implementing | 独立场景已曝光同Intent跨PID、暂停/恢复、部分真实World/Pet行动；仍需完整执行前台/Automation/角色竞争、到期继续、失败调整等要求。固定PNG不证明图像质量，计划保存不等于行为完成 |
| 普通查询与冷记忆采用 | root / memory，implementing | 原48已分别记录实际搜索、完整Tool供给、暖上下文及来源不足。最终安装App受控冷问入口已冻结、7项机械检查通过，实际源/App尚待绑定：复用最终gift实形成闭库的新副本，仅清八张Cognition状态表，保留Memory/来源/原Chat/Run，以新Chat仅发原问题；首实际请求、自然search、完整后续供给和回答采用均要复核。不是自然遗忘，不强制Tool或补问到成功；已有V5与多次跨PID暖答不当作冷检索 |
| 三域容量与持续到达 | root / cognition，implementing | 100k单域与active依赖SQL对照已完成；真实App维护+Worker/编码器重叠，以及100k前态/2403次到达/10分钟窗口仍待执行。准备包已静态及机械审查；500待形成工作不能被清空当作完成，合成结构不当作自然经历 |
| 领地陈列观察 | root / explain_memory，integration-verified | 七生产/五测试已合入；163 Territory与60 Cognition领域检查通过，独立几何/合同/接点审查完成。只读完整布局与生成回执命名修复；合并2511 offline/build通过；实际Pixi与模型采用待验 |
| 原生桌面与像素理解 | root，implementing | 同源Native执行器已准备：普通Main两PID、AX/新PNG、暂停恢复、普通Chat真实画面理解；当前没有实际运行。既有图片校准不替代本次新画面理解，合成鼠标仅作为OS测试刺激 |
| Voice、图像与领地连续性 | root / platform，implementing | Azure两段Realtime录音→Memory→新PID新Chat、图像→World/Pixi→重启，以及独立实体麦克风/扬声器session已准备。跨PID是否真正冷态以首实际请求判定，不能只凭重开认定。绑定检查模型0/App0；实际设备与真实模型待执行，音频history未知单列 |
| 同次PFC引用纠正 | root / cognition，integration-verified | 2生产/2测试已合入，530领域及当时Main完整离线通过。原ia05一次真实续修已完成并经Root/独立review：新非法关联删除，其余提案及原owner历史链逐值保持，Driver接受；1新generation用量22,526/2,045，原历史不重计。固定aff6/无DB提交或自主动作，最终Main组合仍待验；不放宽提交或加重试链 |
| 新库与本地交付 | root，integration-verified | 默认新库的实际安装App setup已创建schema26及Astra配置，SafeStorage/关闭通过，HTTP0；它不是正常Main运行。新库及材料修复合并后的Main2511离线/构建通过；已安装aff6仍是前一包，最终同版打包、正常Main/文件落点/跨PID/桌面验收待执行 |

原串行评测已关闭并释放资源，48例均已Root核读。最后it04原7点中6个已定义点通过、c60原标签缺项不评分；原重复记忆与未曝光机制保留，不补标签或删分母。既定P/R均已真实闭合核读，E已据实际结果选择完整必要对照并合Main，X原三对已闭合且无收益，保留baseline；针对同一无依据自责的归因澄清另作一次原三案定向复测。Memory整合源已冻结并开始既定小复测，桌面和容量范围不变。离线代码/构建及只读审查可并行，宿主重叠照实记录。现有实验源、输入、失败与已闭结果不原地改写。09:59:56.894–10:00:07.684Z一次隔离测试误筛包含live，已停止；真实Voice请求曝光UNKNOWN，未计通过，未发现该窗口可关联的残留浏览器。默认`npm test`已显式选择四个offline project；真实测试仍单独`test:live`。

用户授权的磁盘清理已完成两批：四处重复构建/旧App，另五份已结束实验的4B副本与9,772个成功闭合的合成派生文件。合计删除逻辑文件约46.72GB；APFS共享及异步回收使它不能直接当物理释放量。第二批结束时`df`可用103,361,948 KiB（约98.6 GiB）。当前安装App、活动e05资源、待验aff6资源、Main依赖、所有原始输入/关键I/O/指标/失败现场，以及待验100k original.sqlite均保留。确切路径、删除前stat/句柄核查和结果在仓外 `integration/artifact-cleanup-20260917-v1`；旧manifest保持历史含义，已删派生目录不再声称可原地完整执行。没有改动运行中的原48源或队列。

## 已知产品影响与未曝光边界

- 原第五故事有一次PFC历史引用提交失败，后续新输入才恢复；四个原点通过不能抵消它。新引用纠正工程已合入，一次原完整输入的真实纠正已被Driver接受，最终Main组合仍待验。
- 原第七故事无先前误解证据却自称“之前我理解错了”；单句表达对照两臂均5/6、同一clarification失败；候选不合入，归因澄清的窄修复另行复测。第八故事正确等待方案原文，后续查询未问旧互动偏好，空选不算旧偏好选择错误。
- 第九故事背景形成重复创建已留历史的旧提议：Recall已找到旧史，却被16k局部fit再次排除，未触发F2。第六/第十故事另有实际对照预算遗漏，未发现错误写入但未做因果反事实；不能由原点通过证明完整供给。
- 原四条生活故事已核真实放置/动作/跨PID，但ordinary search未自然发生的用例仍不算冷Recall。第十故事书挡在普通回答结束后才放置；暂停在已结束动作之后发生，不算执行中止或失败恢复。第十一故事删除另一杯子并未使活动目标失效；两次巩固因可选对照缺span而retain，必要材料完整供给和最终整体计量不因此作废。 第十二故事支持重开后到期观察→创作→休息；没有真实行动失败恢复。生成回执字段被误解为矛盾、未导致重做，命名修复并入领地包。
- 原路线冷查询有已供给北门线索未被采用；旧实体硬过滤与未续查也有漏答。合同修复和更多上下文必须由真实取材/采用证明，不能用离线通过或较大额度代替。
- Text A2适用层3/3提前承接且事实保留，但完整生命周期增加11.84%，个别完整Run更慢。memory.record仍可能等待多次模型串行处理，首正文、Tool时间、Run完成分开计量。
- 100k旧同步清理约198.6秒；分页实现约3.28秒、Main最长约99ms是已接受的局部结果，最终三域合并负载未验证。引用与回执总量仍会增长。
- 真实proxy无精确count；Voice服务端音频history未知。正常App新鲜像素、真实图像质量、实体音频和最终同版安装尚未完成，不由已有静态/机械结果补算。

## 最近绿色验证

2026-09-18（UTC 09-17），全部已接受Memory/Cognition/Activity改动整合后的实际Main完整 `npm run verify:offline` **2658/2658，55.797秒**（138 contract、1813 unit/component、707 integration）。16:50:50–16:51:45 UTC，PID42977退出，631个src/tests前后不变，类型/lint/format/diff通过；两项既有TanStack warning保留。固定源 `final-local-acceptance-source-v3` 共796文件，35.27MB，仅链接既有依赖/资源，未复制模型。该源支持既定Memory定向复测；普通表达窄修复及最终安装、完整桌面/容量仍待验。记录 `integration/final-local-main-verification-v1`。

2026-09-18（UTC 09-17），已选完整比较与原有Memory修复28文件合Main后，实际Memory及App/Agent/Cognition/Voice依赖 **946/946，16.420秒**；typecheck/lint/format退出0。16:29:56–16:30:12 UTC，四PID退出，全部src/tests前后不变；git diff --check通过。8生产/20测试与夹具，保留两份已审Runtime测试合并和Activity、目录去重实现。原X固定版同时执行，时长不是性能对照；完整offline、最终真实复测及安装仍待完成。记录 `integration/final-memory-main-integration-v1`。

2026-09-18（UTC 09-17），重复目录去重两文件合Main后，实际Driver/SourceCatalogue/ReferenceRepair及CognitionRuntime **162/162，13.000秒**；typecheck/lint/format退出0。16:06:04–16:06:17 UTC，四PID退出，两文件hash不变、`git diff --check`通过。未重跑完整offline/build；只读投影不改原48或P/R/E/X绑定。记录 `integration/cognition-source-coverage-main-integration-v1`。

2026-09-17，按需文字观察及共享Runtime接线10文件合Main后，实际Main受影响Activity/Agent/Voice/Cognition集成 **421/421，13.915秒**；typecheck/lint/format退出0。15:47:53–15:48:07 UTC，四PID退出，10文件前后hash不变；`git diff --check`通过。隔离117领域检查及Root304 Runtime/71 Cognition检查保留。未启动真实模型、4B或App，最终真实读取与同版验收待执行；记录 `integration/activity-text-observation-main-integration-v1`。

2026-09-17，文字完成及独立开场绑定13文件合Main后，实际Main受影响Cognition/Journey/Contract/Runtime/MemoryBridge **711/711，15.531秒**；typecheck/lint/format退出0。13:34:06–13:34:22 UTC，四命令PID已退出，628个src/tests文件在检查中未变。此包没有真实模型、4B、App或构建；完整回执 `integration/cognition-completion-and-binding-main-integration-v1`，最终同版全套仍待其余已知修复整合。

2026-09-17，以上两包合入实际 Main 后，`npm run verify:offline` **2553/2553，54.027秒**（138 contract、1715 unit/component、700 integration），`npm run build` **15.281秒**；11:57:53–11:59:02 UTC，两PID退出，628个src/tests前后hash相同。两项既有TanStack warning与chunk提示保留；没有App/真实模型/4B调用。记录 `integration/waiting-and-progress-main-integration-v1`。F仍待真实比较，原im01/im02最终同版复测、桌面与资源验收待执行。

2026-09-17，等待输入修复隔离28文件 **785/785，15.032秒**，另12组件/8合同通过；最终类型/lint通过。对话进度隔离23文件 **476/476，4.344秒**。两包已按精确hash合入Main；其后同版全离线与构建结果见上一条。原 im01/im02 定向真实复测待资源窗口，完整回执分别在 `integration/cognition-waiting-input-continuation-v1` 与 `integration/memory-conversation-progress-fix-v1`。

2026-09-17，旧承诺修订合入后，实际Main受影响Memory 29文件 **567/567，7.856秒**；format、lint、typecheck均通过。10:25:05–10:25:25 UTC，各命令退出、src/tests前后不变，`git diff --check`通过。没有重跑App/模型/4B或构建；上一条2511全离线/build是本次两文件改动前，下一次完整集成再验证最终组合。记录 `integration/memory-retained-commitment-revision-v1/{ROOT-REVIEW.md,ROOT-MERGE.json,root-integration-01/RESULT.json}`。

2026-09-17，实际Main合入两项材料修复后：`npm run verify:offline` **2511/2511，66.126秒**（136 contract、1692 unit/component、683 integration）；`npm run build` **17.691秒**。10:08:02–10:09:26 UTC，两PID退出，628个src/tests前后未变；typecheck/lint/format/diff通过。两个既有TanStack warning和chunk提示保留。本次未启动App/模型/4B；源码集成、准确命令与边界见 `integration/local-material-integration-v1/{MERGE.json,RESULT.json,REVIEW.md}`。默认`npm test`同样只选择offline项目。

2026-09-17，实际Main新库收口后：`npm run verify:offline` **2492/2492，69.167秒**（136 contract、1684 unit/component、672 integration）；`npm run build` **17.652秒**。09:19:47–09:21:14 UTC，两命令PID退出，627个src/tests前后未变；typecheck/lint/format/diff通过。两个既有TanStack warning和构建chunk提示保留。2512→2492来自移除旧迁移专项，不是质量提升。记录 `integration/fresh-schema-single-path-v1/{RESULT.json,REVIEW.md}`。没有启动模型/编码器/App；最终同版包和桌面待验。

形成候选的独立副本2533完整离线/构建于08:55:34–08:56:57Z通过，分别65.86/16.64秒；它仍包含当时的迁移测试，不是当前Main成绩，也没有真实模型语义结论。记录 `integration/formation-comparison-root-verification-v1`。

aff6源的Forge make于08:07:38–08:08:34Z成功55.539秒，DMG及已安装App逐文件/链接对应；这只证明前一包工件。此前Main2512完整离线/构建及更早22项Electron结果保留，不能自动转算当前源。新库真实setup与各执行器绑定见下方归档。

## 详细历史与证据入口

[最终比较前完整集成记录](archive/2026-09-17-before-final-model-comparison.md)保留所有原分母、实际时点、失败、同版边界及准备包；[此前验证](archive/2026-09-17-pre-visual-verification.md)、[v21集成](archive/2026-09-16-maturity-v21-integration.md)、[Phase0–7与Companion](archive/2026-09-02-status.md)。中文Decision仍是每项选型的依据，不以测试数或一次成功声称商业成熟。

2026-09-17，形成实体候选范围五文件合入后，实际Main受影响Memory 29文件 **577/577，6.409秒**；format、lint、typecheck全部通过，10:55:21–10:55:38 UTC；`git diff --check`通过。三生产文件与已审候选逐字节一致，保留旧承诺修订及巩固修复。未重跑完整offline/build/App/真实模型；最终组合统一验收。记录 `integration/memory-formation-entity-candidate-integration-v1`。

- 原44/48运行闭合、44已Root评阅，最后throughput四例执行中。f09组冻结`60196863704c47d76bebee3e4d8b541222aeb4d47a78cfe14faea7fc4a8b8d80`。八点局部通过、194真实生成、252 HTTP；全部usage已知，五个产品PID退出。一个巩固失败、rabbit提前cursor曝光与review工具自身错误如实保留，不称全程盲读，也不变更原分母。其余逐组失败、暖/冷供给与未曝光范围见各原报告，不重复全48。
