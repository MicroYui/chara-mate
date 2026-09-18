# MEMORY-EXPANSION-REPLACEMENT：满候选池的关联证据替换

状态更新：所选关联扩展替换已集成 Main v21，原 2026-09-15 集成核验保留在文末。本决策当时只改变一次关联扩展的候选排布，不改该比较的第一轮检索、向量、RRF、linked SQL、预算或提示词；当前融合另由 MEMORY-RANK-FUSION 选定。

第一轮 selector 表示缺少证据时，旧路径把所有已看过的候选放在前面，再用剩余名额和字节追加关联记录；只有数组变长才重新选择。因此候选池已满时，即使关系查询找到了确切的改期原因或旧约定，这条证据也无法进入模型。

选择的单一路径是：完整保留首轮已选的正文和来源投影；其余空间由新增 linked 与首轮未选候选按各自原顺序逐条交替使用，同一位次先放未看过的 linked。按原总容量与字节预算装入后，只有至少一条新 Revision 实际进入候选，才替换原候选并执行原有的一次第二轮选择，数量相同也生效。若超长新增记录未能装入，保留原候选和首轮结果，不因剩下的旧候选数量减少而重选。保留首轮已选指保留第二轮输入，不强制模型再次选择；模型可以在新证据到来后移除旧的无关项。被预算排除的候选标记 truncated 并说明关联证据尚未穷尽。

## 来源、冻结与唯一变量

原行为的代码来源为 `source-freeze.json`，算法协议 `EXPANSION-REPLACEMENT-preregistration.md` 在实现前登记。此前已接受的 LOCAL-MEMORY-ENCODER、MEMORY-VECTOR-EXECUTION、COMPANION-CONTEXT-BUDGET 只提供当前编码、执行和预算边界，不替本次排布选择背书。交替排布是本次明确测试的产品启发式，未声称官方协议或学术最优。

真实模型阶段使用已有官方 Qwen4B/512 编码实验的自写中文开发材料、原文与元数据。为隔离满池问题，固定可见 anchor，把待关联材料从初始池移出，再沿原有 query 排序和其余开发材料填满32k候选预算。没有读取 holdout，没有重新编码；这是候选排布实验，不能当作端到端语义检索质量。

使用冻结的当前生产 ModelMemoryEvidenceSelector / OpenAIResponsesModelProvider、官方 openai-node 6.49.0、`gpt-6-astra`。四组完全相同的 compact JSON 指令与 strict JSON Schema，没有新增 reasoning/温度/修复器/重试。2026-09-15 核对 [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) 与 [GPT-6 Astra 模型文档](https://developers.openai.com/api/docs/models/gpt-6-astra)；本实验只将真实完成终态加 Schema 解析成功算完成，不将仅收到部分 JSON 算成功。

四组各运行一次共享的真实首轮选择，再用同一个首轮结果离线派生 A/B 二轮输入。A 保持原候选，B 按新策略替换；每组两份完整输入与 hash 写入外部证据后再按 AB/BA 交替串行请求。这样唯一变化是候选集合/排布，而不是首轮模型随机性。A 的额外同池重放属于实验控制；旧生产路径通常不会发这次调用。

## 离线机制验证

13个冻结诊断，其中12个正常数据场景、1个非法选择引用。数值/确定性 selector 只验证可达性与边界：四个满池场景必要证据由不可见变可见；同数量95→95也触发二选；首轮已选完整投影保留；无新增集或完整长句不能放入时不额外调用；无关、深rank关联仍可保持missing，最终fit不把剩余片段伪装成完整supported。

保留实验错误而不改写历史：第一次runner有一个括号SyntaxError，未执行任何案例；冻结“最终预算移除支持”预测partial，实际A/B都missing，因为任一条完整正文已超过最终1600预算，冻结数据与标签没有按结果调小。第一次自写来源fixture还错误地把quote/start/end直接放在sourceRef上；随后仅将它规范为现行spans[]、保持文本/ID/标签/预算，另存wire-correction.json并重新执行26个对照，所有输入和正常输出均通过实际Schema。正式结论使用合法合同版本，原版本仍保留，不混算两轮样本数。

正式回归使用真实SQLite的关系扩展、独立Revision/来源，以及无Arm的来源保留、过长证据、非法首轮引用测试。曾有一个测试把125条记录都挂到同一来源，导致关联目标本身位于装不下的深rank；该失败说明本策略不承诺全关系覆盖。回归改为明确的一条直接因果关系，深rank缺口仍保留在冻结外部案例中，未修改策略来迎合测试。

集成前代码复核发现一个边界：交替队列先按数量节选，超长关联记录可能占掉旧候选的数量名额、随后又被字节预算全部排除。候选只剩旧子集时，原候选实现仍因数组变短触发二选。真实SQLite回归先复现了2次调用而不是预期1次；修正为至少实际装入一个新Revision才晋级，否则保留原池和首轮结果、仍标truncated。此修正没有改变交替顺序、预算或选择器：另建F离线bundle重放原4组场景，12份完整ModelRequest与冻结请求逐字相同，4个B二轮候选池和4个最终EvidencePack均完全相同，网络调用0。原E实现和所有真实请求/输出保留，未用修改后的代码重新冒充原实验。详见post-review-replay.json。

## 真实 Astra 配对结果

4组、共享首轮4请求加配对8请求，共12/12有 `response.created → response.completed` 原始SSE终态，12/12生产Schema解析成功，没有自动重试。8份配对真实输出再通过实际 Pipeline 离线重放与 EvidencePackSchema，8/8成功，最终coverage与装入证据一致。

| 固定开发场景 | A旧池二选 | B替换池二选 | 候选数 A→B |
| --- | --- | --- | ---: |
| 取消旧租房后确认实际住址 | 取消原因supported，最终地址missing；必要证据1/2 | 两问supported；2/2 | 45→45 |
| 忌日当天延续很久以前的约定 | 当天请求supported，旧约定missing；1/2 | 两问supported；2/2 | 45→45 |
| 用户与表妹的摄影兴趣纠正 | partial；关键纠正0/1，并选入5条无关兴趣 | supported；1/1，只选准确纠正 | 45→45 |
| 只补入无关的角色经历/小说/通知 | 不知道用户阳台植物，0项，missing | 仍0项，missing | 46→45 |

三组有可补入答案的场景，必要证据覆盖从2/5到5/5；不是五名用户或五个独立线上样本。仅无关信息的对照1/1保持missing，没有因“存在关联”就声称答案充分。B四组均保留首轮已选输入；摄影案例二轮移除了首轮已选但不回答问题的其他兴趣，说明保留输入没有变成强制保留输出。四个B结果均如实truncated，表示候选未穷尽，即便当前问题已经supported也不抹去该边界。

全部12请求实际输入129353 tokens（其中cached43144）、输出2448 tokens。最大单次实际输入10806，最大完整wire34615 UTF8 bytes，最大保守输入估算35239，均远低用户258k上限。串行模型调用合计69.5秒，无未知usage，不换算未经核实的代理金额。

| 配对8请求的消耗 | A同池重放4次 | B新池选择4次 |
| --- | ---: | ---: |
| input tokens | 43156 | 43041 |
| cached input tokens | 43144 | 0 |
| output tokens | 989 | 489 |
| 总模型调用耗时 | 26.5s | 16.0s |

A几乎全部命中共享首轮缓存，B候选变化没有命中同等缓存，输出长度也不同。不能把上述耗时当成稳定速度收益；产品实际成本是原路径缺口时通常停止，新路径新增一次选择。本例B额外消耗43041输入/489输出，换得三组必要证据补全，同时一个无关关联组仍付出了无收益的调用。最多一次扩展保持不变，未增加循环或多层模型决策器。

## 决策、局限与交付

采用保留首选加交替替换：修复了“满池永远补不进来”的确定性问题，并在四组真实选择器对照中得到与缺口相符的结果，没有加入新的调参面板、权重或阈值。没有依据本样本宣称线上准确率或SOTA，也不计算不适用于这组固定便利样本的总体置信区间。未覆盖真实长期用户分布、错误关联占满前排、大规模多跳或数百个首轮已选；这些仍需后续连续场景/holdout验证。

现有linked结果按ID排列，而非问题相关性；本次未同时改变它。预算不足时仍可能丢弃旧未选信息或深rank关键关系；所有首选已经占满时不能追加。长证据不会被自动切碎成似是而非的完整事实。没有实际装入新 Revision 则保留原池、不做二选，有新 Revision 则仅执行一次；进一步搜索由同一Run根据新的具体缺口发起。

生产改动仅 `memoryRecallPipeline.ts` 与其focused test，`expansion-production.patch` 对已集成Revision版本生成，未修改Repository/队列/Main/共享合同。新增retained前缀只由内部扩展调用，完整fit预算不足时拒绝，不是运行时Arm或用户选项。旧追加策略、oracle、API runner均不进入生产树；原始结果/请求/来源/候选实现归档在外部证据标识 `memory-recall-candidates`。

验证：相关focused 36/36、owned文件ESLint/Prettier及独立同编译选项focused TypeScript均通过；整棵旧detached工作树的typecheck因未同步Main/preload/旧integration合同失败，不冒称全树绿，完整集成回归由root执行。未运行App/E2E/打包。实验不会把模型调用成功替代这些产品验收。

复现标识：`live-selector/freeze.json`、`request-freeze.json`、每组pair-freeze、`live-summary.json`、`post-review-replay.json`和`expansion-handoff.json`；完整原文、SSE与结果位于外部目录，最终仓库只保留此中文Decision及无Arm回归。


## Main 集成核验

2026-09-15 root 已核查源码与冻结真实结果后集成唯一生产路径。主树 `npm run verify:offline` **1,307/1,307**（134 contract、887 unit/component、286 integration），typecheck/lint/format通过。相关桌面Provider fixture已更新为当前wire；本次尚未重跑Electron E2E与最终包，不用离线通过代替可见体验验收。
