# 当前用户原话与同 Run 已完成回复共同供给

2026-09-16。结论：将当前尚未消费的真实用户原话与该 Run 已有的助手回复、终态来源放进同一读取分配，可以修复已复现的重复确认触发条件。候选只有一条生产路径，不增加模式、表、参数或调度器。Root已逐项审阅并合入5文件，当前随共同 v21 保留于 Main；v21 晋级时的完整离线已通过，最终同版连续语义与桌面验收见 [STATUS](../progress/STATUS.md)。

## 真实问题与责任边界

冻结六对持续供给实验的s06-A中，用户70秒的要求是“请区分本地保存和对外发送”。同一个前台Run在74秒已完成答复，助手话语与terminal经实际CognitionRuntime.observeRun回投为receipt78/79。165秒PFC页已带用户73，但78/79仍在FIFO页外。PFC随后明确以“未见已答复记录”为由再次respond，实际触发同Chat第二个Run。该回投与Main相同，不是fixture忘接消息回执。

当前用户优先本身只解决用户原话延后，不能保证助手的已完成回答一起可读。扩大至128KiB能减少这个具体样本触发，但不能替代语义相关来源共同分配。本包以原32KiB页边界做诊断；生产128KiB选择沿独立六对Decision，不在这里重选。

`completed`助手消息只证明已经记录了该话语；`terminal`只证明Run生命周期到达终态，可能是失败。它们不证明surface投递、用户阅读、Tool成功或对外世界变化。需要这些结论时仍须各自真实回执。

## 单一路径与来源版本

共同基础是Root integration实际源码633文件，`BASE-FREEZE.json` SHA `40b7e1f9d098a9303e902e0b2f3e18058eb0a65058ed9ef058fced6a0a090276`，冻结2026-09-16。不能用detached仓库HEAD替代这些实际文件。五必读文档与已完整阅读版本相同。外部实验A在bundle时替换唯一Reader为基线，B使用候选；任何A/B开关都没有进入产品源码。

Reader仍先保留最旧未读来源身份，再保留最新真实user utterance身份。若用户来源是Run，只匹配同Persona、同source.id、且在用户receipt之后的已完成agent utterance和system terminal observation。按顺序保留预算内回复身份，然后扩展用户原话、已完成回复与terminal正文；全文读不下时走原有精确节选及coverage。普通FIFO遇到已经在视图中的同一ID时去重，依旧只沿连续已表示的原始序列推进。

内部coverage.currentUserSource.runResponse记录runId、replyObserved、terminalObserved、预算内evidenceIds和omittedForBudget。缺响应只表示本域未观察到；observed不意味着全文已供给，全文质量仍看excerptedEvidenceIds。检索完成的二次分配深拷贝coverage，若后来漏掉回复则明确omitted，不谎称已供给完整文本。用户已消费后，不因前次曝光而继续携带其回复；真实后续状态选择的来源仍沿既有规则。

无新增共享合同、数据库表、索引或Main接线。Root独占集成；修改Reader、内部Types、Projection的coverage透传、新11项回归，以及原当前用户测试对新增coverage结构的断言适配。

## 查询证据

SQLite3.53.3，Node24.18.0，better-sqlite3 13.0.1。SQLite sourceid为`2026-06-26 20:14:12 d4c0e51e4aeb96955b99185ab9cde75c339e2c29c3f3f12428d364a10d782c62`。一手文档：[SQLite EQP](https://www.sqlite.org/eqp.html)、[查询规划](https://www.sqlite.org/queryplanner.html)，访问2026-09-16。

首次查询把receipt范围放WHERE，SQLite选择persona_cursor；103003条背景/目标行的旧游标诊断为13.878–16.138ms。最终使用既有UNIQUE身份索引的persona/source_kind/source_id前三列定位Run，序号边界在同Run元数据聚合及iterate内判断，输出完全相同，三次0.00808–0.0142ms。原始结果和后续形状修正各自保留；没有强制INDEXED BY或新增DDL。

这是固定合成数据的查询诊断，非总体p95。SQL仍可能扫描/排序一个很长Run内的回复metadata；不能宣称任意长Run恒定CPU。正文与JS来源ID产物受同一字节预算约束。

## 两请求实际验证

没有165秒前的现成数据库备份。以原120秒完整状态、其后两个原始成功delta做有限重建，真实host commit结果两次均deepEqual；再以原冻结Reader读取，完整snapshot与coverage都deepEqual原165.593秒输入。124条canonical来源按原ID/序号/正文复制；不以终态Situation倒推，不加入目标之后的新Intent或重复Run。前两次离线脚本的活跃Attempt终态遗漏与日志时钟4ms差异各自保留，第三次使用实际commit.result.updatedAt准确恢复。

最终数据库SHA `d1f2f93fdb9331c8628bb1d0798063ced6d45b5e79314d647a7076e2a782ae76`。A/B同一Persona、availability、原时点、32KiB分配；同一65秒PNG，SHA `cb10df8e9e943bd752e084755530210c933d557cc80102b6f34a682f1b68947c`。完整SDK wire先离线冻结，实际发送hash严格相等。RUN-FREEZE SHA `fc09a783b63cfac7d625eae160dfe9b6037c519b7e35ea39c5c7e1cc4bb83ae0`。

| 指标                       | A：当前用户优先 | B：同Run回复共同供给 |
| -------------------------- | --------------: | -------------------: |
| 分配页字节                 |           32537 |                32224 |
| FIFO through               |              74 |                   73 |
| user73全文                 |              有 |                   有 |
| assistant78/terminal79全文 |              无 |                   有 |
| Provider完成 / 请求        |             1/1 |                  1/1 |
| 实际host提交 / 请求        |             1/1 |                  1/1 |
| 所选决定                   |         respond |         remain_quiet |
| 输入token                  |           19021 |                19022 |
| 输出token                  |            1876 |                 2106 |
| 端到端该请求秒数           |           39.61 |                37.73 |

A再次提出确认，明确理由为“未见已答复记录”。B明确引用真实助手78，记录前台已回应并选择quiet，不重复确认。两者均正确把用户要求作为reported事实，新explicit_user Intent都保留用户73作为依据，effectEvidenceIds为空；65秒截图的1260/本地已保存/上传失败均被限定为历史，不推出当前送达。两边actionFreshness为current，但本诊断没有dispatch新Run，故只证明实际决定和状态，不能声称本轮新增surface行为已经执行。

真实窗口2026-09-15T17:07:17.778Z–17:08:35.140Z，A→B固定各一次，无重试、无Recall补调用、无native。总输入38043、输出3982，缓存读0、未知usage0。服务另报cache_write 38037、reasoning output 506，分别属于输入/输出明细，不再累加。实际response.model均为gpt-6-astra；请求未显式设置reasoning，代理未暴露权重修订版本。完整wire分别108801/108554字节，保守估计118833/118586；代理input_tokens端点两次404，不能把估算写成精确数学计数。实际Provider输入均约19k，低于用户258000上限。没有核定本地代理价格，不报推算美元。两次使用共享代理，耗时不是独占p95或性能胜出证据。

这两个请求不改写原六对105请求的分母，也不估计重复率。样本原后续还有explicit_user Intent局部更新只增加截图依据而遭host拒绝的独立错误。补查发现当时Intent是partial、可见evidenceIds为空，持久旧用户依据按局部合并合同应保留；当时校验先检查可见合并值，尚未利用保留的canonical依据，因此不能简单裁定为模型删除完整已见支持。本pair前态尚无那个Intent，本次仅正确创建用户依据，不能称后续partial修订缺口已被修复。具体输入、分配与源码顺序另附S06-PARTIAL-INTENT-ADDENDUM；后续独立[partial Intent修复](COGNITION-PARTIAL-INTENT.md)已进入 Main，不改本 pair 或原 host 失败分母。

## 验证、复杂度与交付

12个Cognition focused文件222项通过，其中新增11项覆盖真实s06类页边界、跨Run/Persona、streaming排除、Tool effect排除、多个完成回复、失败terminal、未完成Run、长Unicode与低预算缺口、FIFO去重、已消费来源退出、二次投影与实际Service recall completion。另两套相关CognitionRuntime/MemoryBridge integration 30项通过；typecheck、五文件ESLint和Prettier通过。最初新测试fixture漏传Repository必需options，修正后执行，未触及产品行为。没有运行新native、完整桌面E2E或全仓验证；由Root在集成版本统一执行。

源码5文件patch SHA `25f19647def2590a5a12faa6e9e213470b4c7f953f7c0b423faca3001c630a95`；逐文件before/after见SOURCE-HANDOFF.json，SHA `9e13348eb013b03d414820eebd2cf504ae9f3f2f206849e215fd32b4a4bfb131`。Cognition owner独立只读核对3生产文件与Service completion，没有发现新增阻塞问题；真实pair独立质量复核另附，不替代原始输出。

当前只持有明确用户来源的同Run关联，没有扩展全历史对话注入或通用反重复框架。返回source身份不是动作成功证据，超大回复仍可能只有节选，需要模型沿coverage保留未知。未匹配的跨Run答复不在本次规则范围。

## 当时清理计划

Root已要求暂时保留以完成统一验证；此处不提前删除。确认后删除自有current-user-response detached树（含其node_modules符号链接，绝不跟随删除共享目标）、仓外临时query脚本、bundle和生成/重建runner。保留协议、来源/输入/代码hash、原始wire/SSE/结果/DB数据、patch、独立复核与本Decision；实验源快照及losing A bundle不进入生产仓库。清理时另出精确删除清单与保留文件hash，不改旧六对或s01原证据。

## Root 集成验证

Root 已阅读完整实现、11项回归、重建前态和两臂实际决定及提交，把5文件按hash合入同一候选。2026-09-16 01:12 的完整 `npm run verify:offline` 通过1,596项：134合同、1,134单元/组件、328集成，typecheck/lint/format通过，保留两个既有TanStack警告。该时点的版本尚未晋级Main或完成最终Electron验收；当前集成状态见本文开头，另发现的partial Intent保留依据缺口单独修正，不以本包成功覆盖。

独立复核直接确认两份actual wire与预登记相等、原始SSE completed、host ready，以及user73/reply78/terminal79的同Run关系。复核SHA `f56fb429c6f526c22af41166672bfb0eb1fedb1023640b752bb555f7d12758ba`，对应JSON SHA `0aaa9e7fc4a536ae9aad465118f7db921c3a82f86e1759a96e973bb5252390c7`；Root完整阅读后确认与原分母一致。

随后执行精确清理：19个候选代码文件、Root四份集成preimage、合成query.sqlite及独占detached已移除，不跟随符号链接删除共享依赖。本包仓外目录不再有可执行候选；保留7个真实/重建SQLite、2份原始SSE及全部输出、失败、归因补注、patch和复核共77文件。清理回执SHA `9a8f809e02173db1c6b583cdc6160a0be1ca37fd20b1b39c76a503b1788ecad7`，最终结果清单SHA `7c831e85520bbc5baa89cf313e1a70b9bd8bd1404509f205346d1cfce0a56871`。原始结果不改写。
