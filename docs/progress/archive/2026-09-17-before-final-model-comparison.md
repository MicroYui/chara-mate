# 2026-09-17 进入最终模型比较前的集成记录

更新：2026-09-17。

## 当前里程碑

**本地成熟度 Goal 仍在推进。动态行动材料、完整巩固、Text提前承接、普通Chat画面读取及取消恢复已进入 Main。语音已知本地输入与PFC实体引用纠正已合入；最新Main删除旧库迁移链后2492项完整离线及构建通过。已安装aff6包尚未包含这次启动简化；最终同版Electron、打包及实际运行待验。完整独立语义、吞吐、合并资源与安装验收尚未完成。** 用户允许可控时钟和跨日/跨月模拟，要求实际模型、数据库与产品通路；不要求正式发售、签名和公证。用户于2026-09-17确认尚无用户，直接起当前新库，旧开发库兼容与迁移不纳入验收。未来线上社区、海量并发与跨平台服务不在本轮实现范围。

当前 Main 已移除固定 8k/32k 行动材料额度，并将原始字节读取与模型输入 Token 分开。必要材料完整读取后由实际请求构造器计数；本地选择 16 MiB 初始原始字节护栏，真实 App 近 15 MiB 读取约 212/184 ms，接受约 0.2 秒 Main 等待。完整输入仍遵守用户 258000 与较低 Provider 限制，真实代理 count 404 时保留保守判断。最新反馈在同次 Recall 中保留，提前读到当前用户不跳过中间未读来源。行动预算此前精确合入95个运行/测试文件；随后另集成22文件的必要修正，两组有重叠，不将数量相加作为唯一文件数。原有改动保留，未提交或推送。

产品行为以 Product/UI 和已接受 Decision 为准。研究与实现入口：[本地方案](../research/ai-companion-local-implementation-2026-09-15.md)；退出条件：[本地成熟度验收](LOCAL_MATURITY_ACCEPTANCE.md)。各阶段详细结果、旧失败和原分母见 [v21 集成归档](archive/2026-09-16-maturity-v21-integration.md)及各 Decision。

## 活跃工作与退出条件

| 工作包 | 所有者 / 状态 | 下一项验收 |
| --- | --- | --- |
| 持续事件中的选择性注意 | cognition / implementing | 4家族×2条件已完成8/8；最后room baseline于22:13:09Z自然关闭，全部运行/编码器进程退出后交还资源。原源、顺序、条件间隔和失败保留。已综合四类质量/成本选择目录路径，22文件合入，首轮504/518的旧夹具按真实读取适配，现组合2399完整离线通过。路线两侧冷查询均保留台阶/预约条件，基线明确采用北门未发布线索，目录侧未具体采用同样已供给的线索；后者不是编码器召回失败或8k裁剪，继续作为实际采用缺口 |
| 接收边界与行动材料 | root / integration-verified | 已进入 Main；候选同版2285全离线及20 Electron通过。完整集合与请求分别裁决；Claim/Memory查询对照内容等价，近上限约620ms收益，稀疏约1–2ms回归保留。16MiB按实际GUI代价选定，后续独立自然任务另计 |
| 记忆形成、召回与巩固恢复 | memory / root，integration-verified | 生成期间输入变化恢复的4生产/1测试增量已合入Main；该版2445完整离线、生产构建与3项MemoryActivity/Journey桌面流程通过；最终同版另检验自然采用与冷检索 |
| Activity 形成路径收口 | root / explain_memory，integration-verified | 已依据 Product §6.9 删除旧跨周待确认候选链，保留摘要/检索、已接受记忆及来源。三周重复/服务重建与历史保留回归通过，纳入当前2304全离线 |
| 模型用量的缺失与实际统计 | root / memory / explain_memory，integration-verified | Main 已保留 Provider 未报告字段，分别展示已知用量与字段覆盖；Run/Voice/校准边界回归纳入2304全离线。仓外HTTP记账机械首轮14/15，按锁定SDK取消迭代语义修正测试后15/15通过；真实取消与未知用量断言保留，未改产品/observer/summarizer或旧正式用量 |
| 互动时钟与未来需求效用 | memory / root，focused-verified | 原6家族36回访及新轻目录三族24回访均闭合、逐答和HTTP复核完成。Root综合质量、供给归因、原待办完成量、等待与复杂度保留唯一FIFO；M真实5/6、三个目录6/6的差异保留，已定位实体硬范围及未续查，不将其归为预测收益。三个目录未进入Main；完整决定见[巩固选型](../benchmarks/MEMORY-ADAPTIVE-CONSOLIDATION.md)。长期停用、低频旧事和新查询合同的最终同版效果继续验收 |
| 自主日常、到期与竞争 | root / implementing | 使用实际 Runtime 验证前台、Automation、角色生活的竞争、恢复、安静结束和后续到期执行 |
| 等待中的对话与用户续接 | root / explain_memory，implementing | 已合入6生产/4测试文件；全离线及真实问答续接、审批抢占、领地动作通过，仍需最终自然语义链；正式吞吐保持原源 |
| 回应阶段与记忆等待体验 | root / explain_memory / memory，implementing | A1原6对/24回答、206生成及0/3提前正文负结果已收口，保留A0。明确次序A2的同源双构建、3项映射、双PID空库dry与独立静态审查完成；原六案A0/A2新真实对照于03:41:14Z全部闭合：6共同前缀、12目标/12新PID回访、30子PID正常退出。208生成的输入1626182、输出86377及cached667787均已报告；独立逐案复核完成，适用层提前正文A0 0/3、A2 3/3，实际保存及回访核心事实保留。Root已采用A2唯一Text段落；保留N03完整Run更慢及全臂生命周期增加11.84%，不称整体提速，同版2474完整离线/构建与3项Electron通过 |
| 普通对话情境供给与续接 | root / explain_memory，focused-verified | 第6条件192267 Token补充空间下仍出现已有rev7断言空投影，同Run新输入也未刷新。18文件已按用途读取当前语义、在新输入处刷新并重计；688受影响检查与typecheck通过，两个夹具构造失败及修正保留。完整同版检查与实际采用另计，原正式源不改 |
| 普通记忆工具的完整结果分配 | root / memory / explain_memory，implementing | 删除8192最终额度，按完整ToolResult及实际请求计量，候选32k未改。v4原始160→164副本对齐及3SQLite/6JSON/2Persona机械通过；03:00:24Z实际启动dry仍failed：三个旧Cognition Attempt缺receivedThroughSequence，初始与最终快照均报错。原request可精确对应6/10/12，V5精确三ID适配已执行；首轮测试漏构造config的2/3保留，修正后3/3及原6/6机械通过，新原库副本physical/三JSON后实际dry completed且无wire。原始库未SQLite打开，三个旧ID已真实Repo只读复核、所有文件关闭且原SHA未变，Root已接受；V5实际1prefix/2cold于04:04:53Z自然闭合，3子PID退出且无错误；两replay均未出现实际completed search工作集而未曝光，不补造检索。独立复核完成：首个完整请求与实际HTTP两侧相同，既有Cognition已供给事实，memory.search开放但0/2调用；两答有依据，不能证明容量收益。14HTTP含8生成，input95674/output4736/cached33543、24/24字段已报告；旧失败保留。Voice完整服务端占用仍未知 |
| 查询范围与缺口续查 | root / memory，integration-verified | Product与Schema/Tool/Agent三文件已明确全局过滤必须对全部问题必要；不改SQL、字段、预算或引入自动放宽。已纳入同版2487完整离线、构建和22项桌面流程。d01原漏答不回填，新合同的实际取材与采用待最终独立场景 |
| 形成期间的并发修订 | root / memory，integration-verified | 三文件v2已进入Main，只有真实外部活动版本接替才在同工作重取材料；初次及Recall合并后均保证完整新目标，保留已提交片段，不把删除/归档/提案内冲突当外部更新。隔离229项实际SQLite检查及Main2487完整离线、构建、22桌面通过；原d02两次失败、RED及v1第二次分配缺口保留，最终自然竞争另计 |
| 服务过载后的记忆恢复 | root / integration-verified | 实际 HTTP503 暴露不可重试误分类；SDK/SQLite 恢复回归及400/503桌面展示通过，原正式503失败保留 |
| 准备阶段的取消与退出 | root / integration-verified | 已进入 Main；实际Electron metadata/count停止与退出、input/approval跨PID恢复六例通过，原失败保留；最终候选20受影响Electron一次全绿 |
| 小窗口与精确输入计数 | memory / root，integration-verified | 已进入 Main；原30k窗口正常生成和重启恢复通过，支持精确计数时不先被保守估算拒绝。真实代理count 404仍非精确计数保证 |
| 独立连续验收 | root / memory，implementing | 原37故事、F02、F09、反馈和吞吐合计48故事、305外层步骤、2411到达、189检查点、41次计划重启；6个arrival窗口含27个窗口检查点。823文件完整源e05dd7b0…已构建同源API。首dry的ready互等与清理失败保留；仓外host修复后同例旧4/5、新5/5，独立复核通过。新actual dry于06:44:27–29Z完成：两个Electron PID 85835→85840正常关闭/重开，0模型调用。十组原输入正式串行执行于06:45:29Z启动，使用gpt-6-astra与实际4B。当前前十故事独立逐点复核40/40通过，实际HTTP供给、形成比较及最终采用分层保留；第五故事另有1次PFC引用关系提交失败，不能被四点通过抵消，后续新输入才恢复；第六故事实际停止条件持续生效但并非运行中abort/崩溃恢复；第七故事另有无先前误解证据却自称“之前我理解错了”的表达缺口，第八故事正确等待方案原文，后续搜索未找到新方案内容；因查询未问旧互动偏好，不能把空结果认定为偏好选择错误，也未证明该次前台长期偏好采用。第九故事已核3次角色行动Run、同Intent跨2PID恢复、一次画册放置与3次Pet观察；使用固定图片且未调用普通search，不算真实图像或冷检索。末段后台重复创建已留历史的旧提议，正独立修复。第十故事验证同Intent暂停在两PID重开后保持、用户明确许可后恢复及后续书挡放置；普通回答先于新物件，两个时点分开。其L35/L57仍有形成预算遗漏，未发现错误写入但没有反事实验证；无ordinary search、执行中取消或失败恢复曝光。均非整组/完整48结论，普通Cognition采用不计为未发生的memory.search |
| 三域存储与持续写入 | root / cognition，implementing | Memory单域1k/10k/100k已完成。pending物化后再独立比较active依赖物化：同原库18配对/156查询有序保护集合一致，全量后5中位1815→37.5ms、分页总和1840→40.8ms、每轮最慢页中位188.6→4.28ms。两臂各89项及typecheck通过；首轮3例非法夹具失败保留。[查询决策](../benchmarks/COGNITION-RETENTION-QUERY.md)接受该两文件增量，已合入Main且2448完整离线/构建通过。100k App维护+Worker/编码器重叠尚未运行。既有组合仅两次写入、两次编码和有限API；补充容量重放已完成Root及Memory静态复核，沿原公开poster的2403次到达、10分钟窗口和真实PFC/Agent，准备保留500待形成任务并以实际4B建立索引；16入口语法检查与6项进程/窗口关闭机械已通过，实际100k准备/重放尚未运行。合成Memory源不是Activity语义经历，原独立48故事不改，不把局部SQL或观测器全库读取称完整App时延 |
| 原生桌面与像素理解 | platform / root，implementing | 原生72文件所有权验收有条件复用；5幅既有真实PNG已绑定最终语义计划，但不能代替本次新鲜画面的理解。普通Main双PID真实AX/PNG与暂停恢复执行器已准备；另补一次普通Chat，追踪本次新PNG经PFC或Chat实际请求、有效依据至回答的完整链。普通Chat的Activity定位/精确引用/当前画面及取消恢复已集成且工程通过，新增真实理解步骤尚未实测。Native v2已完成当前aff6源/App/API/fixture重绑及3项离线构建，保留真实旧P0来源；Root复核58文件及1依赖链接一致，正常执行尚未启动；观察上界执行前选定600000ms，非采集SLO。当前机器无人输入时沿现fixture合成鼠标作为测试环境刺激，准备在原两Main内记录真实OS idle及来源，不替换产品idle函数 |
| 语音、图像与领地连续性 | platform / root / explain_memory，implementing | 同源Azure API与新隔离库已准备，原两段Realtime录音→Memory→冷Chat、图像→World/Pixi→重启待执行。静态复核发现转录后普通情境、试听、欢迎语及普通Tool结果缺少发送前完整已知本地输入检查；五生产/三测试文件已由Root逐差异审查并精确合入Main，实际协议构造与计量共用，最终超限保留成功Tool且不发续答；隔离88项及静态通过；Main受影响Voice/Chat/Territory/契约11文件126项于07:52:52–57Z通过，4.903秒，PID5533退出；Main2512完整离线/构建通过，aff6新源/App已构建安装；Azure同源API及输入绑定检查通过，真实设备补充复用既有新库种子的独立文件副本，避免混入两段录音链。两个绑定检查模型0/App0，实际运行待释放资源。服务端音频history UNKNOWN分列，不用转录或usage反推。新增1个实体声音session执行器已完成独立审查，麦克风准备owner修正的3语法/5机械通过；真实设备仍未运行，原录音注入分母不变 |
| 历史情境关系的同次纠正 | root / explain_memory，focused-verified | Final48 ia05第3次PFC在新Situation中引用ID已曝光但当前snapshot没有实体视图的closed历史，提交正确拒绝却等下次用户输入恢复；保留原失败。实体关系输入校验已补入原Driver一次纠正，2生产/2既有测试已精确合入Main；实际SQLite默认/partial读取前态复现、530本域及静态通过，Root与独立reviewer完整审查通过。不放宽提交、不自动删关系、不新增重试；Main2512完整离线/构建通过，真实模型纠正与新版桌面另验 |
| 形成必要对照的上下文分配 | root / explain_memory，implementing | 已完成23文件源码调查及必要/可选集合设计，在aff6仓外副本实施完整请求分配；不将16k换成另一固定最终额度。真实SQLite的70条同源记录（数量截断与fit共同影响）和8条较大记录（fit）均复现尾部遗漏及重复写入，修复后两例保持原身份。Root审查另复现intake current引用在count等待中到期仍被沿用，已保留原用途重验，history/同源过去记录不受误伤；最终29文件810项领域/依赖回归及静态通过，Root已通读全部生产与测试差异；独立副本2533项完整离线及构建于08:55:34–08:56:57Z通过，分别65.86/16.64秒；未运行App或真实模型。ia06原两次只省略context关联项、无错误写入，不能充当本RED；il01已定位为Recall选中旧史后再次被16k局部fit排除、未触发F2，语义修复仍待实测。实际il01前态的受控回归已精确复现旧完整请求：原8项不触发F2并提交重复，新路径10→11项完整携带旧史/当前修订；完整请求估计72830/74588，假F2零输出只证明接线。已准备单次真实F2及两条开发链的形成→冷Chat配对比较，均尚未实测；Main尚未改变 |
| 纠正时的自然表达 | root / cognition，contract-ready | 已准备三对、12计划普通Run的单句开发比较：无旧错依据、实际旧错、用户报告旧错及各自后继；不改原Final48。两份aff6各823文件仅共用表达规则一句不同，两构建及5项真实SQLite/注入Provider机械通过，Root核51绑定文件、5依赖链接与两份全源一致。实际模型、4B与表达结果均未运行；不得把历史助手消息算成新生成，不能由本Text比较外推Voice听感 |
| 新库初始化与事件游标 | root，integration-verified | 按最新用户范围停止旧库兼容与迁移修复；已移除22条旧迁移分派/模块及13个纯迁移单测，当前26 Schema字节不变；10项新库建库/正常重开/来源/事件游标及非当前版本拒绝通过，typecheck与两文件lint通过，当前Main2492项完整离线/构建于09:19:47–09:21:14Z通过，69.17/17.65秒；旧迁移专项删除使总数减少20，正常App另验；旧实验目录已改名保留，冷副本及历史失败不改写。07:11:01–19Z已安装App真实创建默认schema 26数据库及本机Astra配置，生产SafeStorage保存凭据；初始0/最终1 Profile、外键检查与关闭通过，HTTP 0。配置PID92275及父92272均退出；这不是正常Main运行验收。当前normal配置已绑定真实setup回执，原两PID/三Run继续待验 |
| 模型恢复与本地交付 | platform / root，implementing | 当前823文件源aff6的Forge make成功55.539秒，DMG已生成；新版App已安装，633文件及37链接与包逐项一致。包内864构建文件/345项目来源映射及资源检查通过；Native API/owner/fixture均同源构建。旧e05安装包与正式48输入不改。新库setup已实际通过，10入口语法、9模块import与2前置拒绝也通过。Azure首次seed在打开DB前因验收helper整读2.5GB文件失败；仓外两处改分块校验，共享17项及实际2.5GB摘要通过，生产源码及App不变。修复后Azure新隔离库于07:28:35–38Z成功初始化，07:29:03–05Z输入绑定检查通过，两个PID已退出、模型0；实际普通Main、Azure与文件/重启验收继续 |
| 首次安装默认工作目录 | platform / root，implementing | 已合入2生产文件及2既有测试的修改；实际默认目录与设置回归、基础Electron启动通过；实际包审批写入相对路径、退出后新PID读取执行器就绪，最终包另计 |
| 普通对话的视觉读取 | root / integration-verified | 已扩Product/UI与shared合同；已为image.inspect接入Activity定位、精确旧图及当前画面，按完整请求分配目录，保留操作者/捕获时间。2433项完整离线、生产构建和24项Electron流程通过；覆盖真实PNG接线、计量中steering、停止/退出等待、完成Tool重启以及同图/多图跨记忆记录的压缩。真实新鲜桌面理解另计 |

root独占Main、共享合同和数据库集成。原v21八条件均自然关闭，最后基线于2026-09-16T22:13:09.110Z结束；全部运行及编码器退出后交还资源。原输入、原冻结、调用失败及条件间隔保留，后续修复不回填原成绩。详细分母见[目录决策](../benchmarks/COGNITION-SOURCE-CATALOGUE.md)。确定性回归、真实模型与安装结果分别记录。

## 最近绿色验证

2026-09-17，按用户新库范围移除旧迁移链后的实际Main `npm run verify:offline` **2492/2492，69.167秒**（136 contract、1684 unit/component、672 integration）；生产构建 **17.652秒**，diff检查通过。仅删除22个旧迁移模块/13个纯迁移单测、简化database入口和重写现有数据库测试，三份当前DDL及schema26不变。两条既有TanStack警告、构建chunk提示保留；627个src/tests前后未变，两命令PID均退出。原2512→2492来自取消旧迁移专项，不称质量提高。记录 `integration/fresh-schema-single-path-v1/{RESULT.json,REVIEW.md}`。本次没有启动模型/编码器/App；最终同版包与桌面流程继续待验。

2026-09-17，语音完整已知本地输入检查与Cognition实体引用同次纠正合入后的实际Main `npm run verify:offline` **2512/2512，59.192秒**（136 contract、1700 unit/component、676 integration）；生产构建 **15.917秒**，diff检查通过。两条既有TanStack警告与构建chunk体积提示保留。08:04:57–08:06:13 UTC，三命令PID均退出，前后662个src/tests文件未变化。同期原独立Final48继续，宿主CPU/构建重叠已记录；未主动加载另一个模型/编码器。记录 `integration/final-main-voice-reference-verification-v1/VERIFICATION.json`，SHA `43fc8ac545f93b635df6c558b9bb1257a44c0d0cc4f07805c439049cf99b6ef6`。本版Forge make及安装已完成；受影响Electron、普通新App实际运行及真实模型纠正待原串行评测释放资源后执行；此前e05的22项Electron通过不转算本版。此前2487完整离线/22项Electron记录仍保留在 `integration/final-main-query-formation-migration-verification-v1`。

2026-09-17，完整巩固分配九文件及Text回应段落合入后，实际Main `npm run verify:offline` **2474/2474，52.177秒**（136 contract、1676 unit/component、662 integration）；构建 **15.142秒**，受影响 MemoryActivity/Journey Electron **3/3，9.473秒**，diff检查通过。两条既有TanStack警告保留。运行03:58:32–03:59:49 UTC，同期隔离目录离线检查，不作为性能对照。记录 `integration/consolidation-context-implementation-v1/VERIFICATION.json`，SHA `7f2c4df2973b758edc5ad5446892be89c1b912b24e53f5bfd84bdbfe1e83630a`。自然模型、组合100k、最终安装继续单独验收。

2026-09-17，活跃依赖SQL优化合入后的实际 Main `npm run verify:offline` **2448/2448，50.094秒**：136 contract、1673 unit/component、639 integration。生产构建 **13.756秒**，格式与diff检查通过；两个既有TanStack警告保留。运行02:49:35.730–02:50:39.719 UTC，无正式模型条件重叠。记录 `integration/cognition-capacity-active-implementation-v1/VERIFICATION.json`，SHA `51765505bd766df00b0206262bb70f438b38de555c1b76798923b6447184ef2b`。本次私有SQL优化未重复桌面E2E，最终同版原生、安装与独立体验仍待执行。

2026-09-17，生成期间输入变化恢复合入后的实际 Main `npm run verify:offline` **2445/2445，49.153秒**：136 contract、1670 unit/component、639 integration，静态检查通过。同版生产构建 **13.602秒**，受影响 MemoryActivity/Journey Electron **3/3，8.646秒**。实际运行 02:22:19.797–02:24:21.004 UTC，处于第6家族共同构造期；该宿主负载保留，未改变正式比较源。记录 `integration/consolidation-input-change-implementation-v1/VERIFICATION.json`，SHA `33d27ec64bc5e2a3516878efabfed8f72c2046236b239ff687c425669906aaed`。本次覆盖新增12项恢复边界，不将同进程重开同库称跨PID，也不替代最终真实连续体验。

2026-09-17，普通Chat视觉读取及多图压缩集成后的实际 Main `npm run verify:offline` **2433/2433，49.507秒**：136 contract、1670 unit/component、627 integration；typecheck/lint/format通过，两个既有TanStack警告保留。同版 `npm run build` **13.873秒**，Agent/Chats/Foundation/MemoryActivity/Journey/Territory Electron **24/24，66.789秒**。工程运行均在未来需求第5家族共同构造期，最后结束2026-09-17T01:47:39.194Z，未与条件窗口重叠；共同构造包含宿主负载。记录 `integration/ordinary-chat-activity-visual-implementation-v1/VERIFICATION.json`，含原失败、实际源码摘要与各命令回执。新鲜原生模型理解、最终安装与独立语义尚未完成。

此前SQL、Memory容量、回应阶段及动态行动材料各版本的实际验证与原失败见[验证归档](archive/2026-09-17-pre-visual-verification.md)。它们不补算当前未执行项。

## 已知产品影响与边界

- 已闭合未来需求第4家族出现生成期间依赖变化。提交校验正确拒绝旧输出，但旧实现把该工作记为failed，普通wake/同处理器重启不会自动重排。新实现沿原owner回pending/接替新版本，已合入Main且2445完整离线通过；历史失败保留，不把其它工作产出称为本任务恢复。

- 原吞吐v20为2 attempted/6 unattempted；v21完成4家族×2条件。已选目录减少总处理墙钟66.79%、已报告输入69.97%，但前台不全面更快，路线冷查询漏用已供给北门线索，当次海报也未精读最新稿。普通情境供给与工具分配修复须由最终独立语义验收证明；双项目基线40分15秒到PFC包含runner窗口后串行排空，不能全算产品FIFO延迟。旧错误及原分母不改写。
- 双项目一次普通回应首正文在输入后81.910秒出现，期间已有Tool/Run界面反馈；memory.record等待71.803秒，四次串行生成占99.36%。第二次形成利用新召回的旧许可分离重复支持与新限制，不能直接删掉。Text已能在Tool前流出自然回应；跨Run丢失assistant phase已修复并通过回归。初轮允许式提示未触发提前正文，原负结果保留；明确顺序A2在新同源六案中适用层3/3提前承接，已选择该Text段落；仍继续解决完整等待，不把该负结果或完成drain后的回访称为即时新Chat/取消恢复已通过。
- 旧独立连续场景暴露过形成遗漏、限定条件缺失和不必要自责；定向修复与选型不能代替最终独立验证。自主生活后续到期、并发接管仍需完整执行。
- 原普通待答/待批 Run 会通过全局可用性投影持续阻挡领地动作。Main 已修正占用投影和真实用户续接前的异步让出；实际领地动作、旧审批抢占和追问两种续接的回归通过；最终自然语义场景另计。
- 正式 v21 基线一次 HTTP503 被旧公共错误映射为不可重试 REQUEST_FAILED，不能因 SSE 错误事件数为零称 Provider 无失败。修复另行集成，正式原结果保留；Run 分配前准备在退出/Stop 中的所有权已独立六例复现并修复，已合入；原失败继续保留。
- 四段目录页面校准暴露巩固最终输入仍共用16,384形成预算：必要旧依赖可被预算门阻止供给。旧校准分母保留，完整请求计量与必要原文读取已合入Main，2474项完整回归、构建和3项受影响Electron通过；最终记忆工作验收仍未闭合。
- 未来需求两轮比较已完成，所选唯一准备路径仍为FIFO；这不表示预测或UTC日期机制已经实现。最终48故事继续验证长期停用、低频旧事、取消及重提；原M一次漏答与新查询合同效果保持独立判定。
- 旧局部排序只比较FIFO前部正文，新轻目录已扩展候选读取并完成与Main的三族自然比较；没有额外排序收益可归因，未保留候选机制。有限页不是全队列精读，原局部失败、完整巩固预算修复及后续结果分别保留在Decision。
- 100k普通清理曾出现约198.6秒同步阻塞，选定分页实现约3.28秒、Main最长约99毫秒；最终三域合并负载尚未验证。原文可按实际消费者释放，引用和回执总量仍可增长。
- 真实代理没有可用的精确input-token count。完整请求守门和保守估计已实现；支持计数的小窗口启动预检已修复，原30k桌面流程通过；不能声称已获得该代理近258k时的精确服务端计数保证。
- 新安装未保存工作目录时，旧默认跟随进程cwd，可落入安装包；修复已进入 Main，基础启动已验证owned目录创建；包内cwd启动后的实际文件落点待验证，不影响已有保存的其它目录。
- 原实验数据库与Provider配置已改名保留，冷副本不删除；未继续旧库迁移。实际安装App已在默认目录创建新库及gpt-6-astra配置，正常Main运行、语音图像与实体声音设备仍待验。签名、公证与Firebase/FID不补算本轮本地验收。

## 历史入口

[本轮v21集成归档](archive/2026-09-16-maturity-v21-integration.md)；[Phase 0–7与Android Companion](archive/2026-09-02-status.md)；[原型阶段](archive/2026-09-15-companion-first-pass-status.md)。详细选型保留在中文Decision，不将测试数量、少调用或一次成功直接称为商业化成熟。
