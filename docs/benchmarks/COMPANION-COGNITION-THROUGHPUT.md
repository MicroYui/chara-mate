# 持续事件吞吐：开发回放与计数段改动

2026-09-15。没有真实模型、桌面采集或外部动作。本节报告评价当时冻结的Service调度/日志投射结构，不能评价真实情境理解质量。

## 问题、当前输入规则与决定

此前 100,000 来源测量只证明分页读取有界，不能证明模型追得上。当前 native 使用 1,000ms 本地批次合并键鼠计数和 AX 内容回调；若有内容变化，批次为content并带counts，否则为interaction。激活/窗口边界会刷新批次，actor切换前flush保留采集归属。Managed Browser 的真实DOM文字变化进入content。CharaMate Cognition自身batchWindowMs也为1,000，均为工程启发式，不是神经科学常数或协议限额。纯input不取key值。

在修复前，空文本interaction只缓冲/写日志，不schedule；但是它们仍逐条占页。下一条真实内容到来后，最老连续读取必须穿过所有计数，结果出现只有counts的模型页。模型输出已经足够慢，不能接受这种纯机制浪费。

本次选择：只把kind=observation、空text、无visual/effect/opportunity/control的interaction或idle识别为无需语义解释的来源；同actor/object/source-kind/source-epoch/boundary的连续段在SQLite取实际SUM与首末来源、时间、receipt范围。没有固定时间TTL或topK，也没有删除原始日志。passiveSpans是coverage上下文，不能当用户偏好或情绪事实。当前prefix若全为这些来源可由本地推进消费水位；遇到任何内容停下。原字段analyzedThroughSequence在此表示已完成必要处理的消费水位，不表示每条都由模型解释过。

当前既有原始来源维持不变。不是把最后一个计数Evidence改成累计数冒充它的原文；范围与累计数另在owned coverage中展示。已消费的最新连续段可从同一journal恢复，不新增工作队列。前台prepareTurn只flush已存在计数，不强制唤醒后台模型。

native interaction也可能附有真实AX文本。这些非空内容不折叠。另补服务正确性：非空text或visual的interaction不能进入只处理计数的buffer；它是真实可见变化候选，按来源内容去重与调度。这个补充用独立回归验证；以下12轨迹是空count/content分开输入，不将该边界测试冒充真实AX负载结果。

## 事前协议与环境

每次执行前的JSON保留。四个30分钟确定性轨迹 × 40/60/90秒固定模型步骤耗时，共12种；先运行改动前，再对相同输入安排运行当前改动。执行实际CognitionService、Repository、Schema；fake clock按1秒投送合成native批次，单一延迟driver只在指定时刻回空delta/quiet，通过真实commit。无Memory recall，无模型token/输出负载，固定耗时来自先前真实40–90秒观察的敏感性假设，不是实际模型重跑。

- counts_then_change：初始内容，之后每秒8个按键计数，30分钟结束另一次真正内容变化。
- reading_scroll：每秒6次滚动计数，每10秒真实内容变化，每60秒其中一次窗口boundary。
- typing_content：每秒真实新内容，批次同时有8个按键计数。每版是完整合成可见文本。
- identical_content：每秒重复相同可见内容，无interaction，结束改内容。

每页32,768bytes来自既有工作集分配，没有用本次结果选阈值。合成文本、对象、source epoch/sequence稳定，UUID随机身份不影响文本和排序。相同轨迹没有真实语义标注；没有统计显著性或商业验收宣称。Node v24.18.0 / darwin arm64 / M4 Pro、24GiB / SQLite :memory:。

## 结果

“结束积压”是30分钟输入窗口结束时仍未消费的journal来源；“追赶秒数”是随后无输入时，到末条真实内容被空delta提交的模拟时间。真正模型可能更慢或失败；此处最多是当前输入机制的服务率敏感性。

| 轨迹               | 模拟每步秒 | 总调用 前→后 | 无新语义页 前→后 | 结束积压 前→后 | 追赶秒 前→后 |
| ------------------ | ---------: | -----------: | ---------------: | -------------: | -----------: |
| counts_then_change |         40 |       39 → 2 |           37 → 0 |       1800 → 1 |    1559 → 42 |
| counts_then_change |         60 |       39 → 2 |           37 → 0 |       1800 → 1 |    2319 → 62 |
| counts_then_change |         90 |       39 → 2 |           37 → 0 |       1800 → 1 |    3459 → 92 |
| reading_scroll     |         40 |      46 → 46 |            0 → 0 |        88 → 79 |      41 → 41 |
| reading_scroll     |         60 |      46 → 31 |            0 → 0 |      739 → 123 |     976 → 61 |
| reading_scroll     |         90 |      46 → 21 |            0 → 0 |     1179 → 189 |    2366 → 91 |
| typing_content     |         40 |      71 → 71 |            0 → 0 |      682 → 682 |  1066 → 1066 |
| typing_content     |         60 |      71 → 71 |            0 → 0 |    1072 → 1072 |  2501 → 2501 |
| typing_content     |         90 |      71 → 71 |            0 → 0 |    1332 → 1332 |  4641 → 4641 |
| identical_content  |         40 |        2 → 2 |            0 → 0 |          1 → 1 |      42 → 42 |
| identical_content  |         60 |        2 → 2 |            0 → 0 |          1 → 1 |      62 → 62 |
| identical_content  |         90 |        2 → 2 |            0 → 0 |          1 → 1 |      92 → 92 |

12/12两次执行都没有Service异常；每个轨迹最终消费完实际保留的journal。相同文本轨迹在两者都去重到2条，其余全部保留提交的native批次数。source sums和边界由专门unit检查，包含1,800条计数、不同actor/epoch、遇到非空文本停止、完整source ranges和100,000语义来源的既有连续水位回归。

在60秒/step情形：纯counts场景39→2调用（37个无意义页归零），约1.237MB→8.7KB核心context输入；reading_scroll 46→31调用，结束积压739→123、后续追赶976→61秒。实际输入JSON仍包含Schema、Persona和其他固定开销；这里统计的只是snapshot+coverage bytes，不声称等于完整模型请求或tokens。

typing_content没有改善：仍71次调用；60秒/step结束仍积1,072条，最旧滞后约17.85分钟，之后还要2,501秒。本地计数聚合没有解决持续新内容语义吞吐。这个商业可用性问题不能用“已分页/已限流”遮掩。

## 连续正文 exact-splice：真实配对后不晋级

随后在仓外实现了候选：同对象/actor/source epoch的完整首版与逐版UTF-16 offset/deleteCount/insert，保留每版真实来源和时间；它不改变原始journal或把最新内容冒充完整历史。机械回放显示重复长文能覆盖更多版本，但六个预先冻结的中文开发场景、12次真实gpt-6-astra请求未带来实际延迟收益。

两臂12/12均完成解码、领域验证和真实SQLite提交，实施者非盲核对各18/18事实与来源标准通过。完整快照→exact-splice：输入42,252→40,821 tokens（-3.39%），输出13,406→14,779（+10.24%），累计耗时232.32→262.13秒（+12.83%），中位完成37.68→43.01秒；6对仅1对略快。按case配对差值的描述性bootstrap95%区间为增加[1.70,8.60]秒，小合成样本不能外推用户总体。两例quiet/respond行为也不同，未实际发言，不能声称体验等价。

请求均用旧attention nullable wire，没有显式reasoning字段，12个completed回显medium；缓存输入命中为0，cache_write_tokens不为零。旧wire后续keep/set/clear修复不混入本成绩。图像案例只实际给最新绿色400×300 PNG，未给先前红色像素；输入最大保守估算74,652，最大实际输入7,292，均低于用户258k要求。这不是大型diff链、持续半小时真实模型流或Memory后二轮验证。

选择：不引入exact-splice生产模块。候选代码已在仓外删除，无Arm开关或保留备用实现。原始数据与人工核对保留，外部caseHash `8114c24cd57631363b9aad9517b74b3442921fc499874c2b7971386b94efdcbf`，candidate/runner codeHash `f5cc6f1d5decb1d87533f3780ee65fc180079e66db1e7786e9415393ad8ce17e`；完整报告为仓外`cognition-content-splice/QUALITY-REPORT.md`。一手来源为2026-09-15读取的[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)及[官方SDK 6.49.0](https://github.com/openai/openai-node/tree/v6.49.0)，代理行为以实际wire/SSE为准。

当前生产仍区分最新视图与历史消费水位：当前用户Run不因历史追赶串行等待，最新真实来源纳入决策依赖；未解释的中间来源继续保留。持续内容的语义吞吐仍待解决。推理effort与本地4B语义模型分别研究，不能以多添一个classifier或降低reasoning选项掩盖完整状态与实际行为质量问题。

## 复现与清理

两次全部事前协议、结果JSONL、完整调用页轨迹summary与hash留此外部目录。首轮codeHash 41cd70c9615ed134191d223c9a395fe1726ed35cb196986dd89bfa7c796e5bce；当前计数改动轮codeHash 1b6d6fa51a5656a54216415312d62f69f5dca60d4db5b66aac3cf2dba7ae06bd，该字段连接当时四个核心文件，runner bundle hash另见SHA256SUMS，包含新增passive模块。生成耗时是模拟而非paid usage，实际paid calls=0。runner.ts、runner.mjs和node_modules symlink结果记录后删除。生产只留获选本地处理路径与回归，没有Arm开关。

一次输入窗口的页不是独立重复样本；固定延迟、空delta和没有长期增长Situation/Memory/多模态的设置都偏乐观。没有根据小样本宣称SOTA或商业级注意力已完成。

## 2026-09-15 交付补记

本文件由 root 集成为当前工程 Decision；商业质量仍未验收。上述结果对应明确执行时的代码快照；后续加入了当前视图预留、开放 Claim 形成回调、host-owned historyEvidenceIds 和视觉 resolver，不能把旧数值冒充最终 bundle 的重测。相关 unit 回归验证边界，不替代质量/吞吐评测。

当时覆盖基线使用 user/agent/system 三类 actor；当前 Main v21 另保留 unknown 归属，无法归因的原生操作不补造为 user 或 system。同 App 正文变化单独进入内容事件；AX/DOM/画面均仅所声明的局部可见范围。键鼠只取类别、频次、滚动，不保存键值或粘贴板；计数段不会逐击模型。用户输入/Persona generation、实体 revision、时钟/重要 cue 和真实 Tool 回执是执行校验依据。

当前图像以真实 PNG 的 input_image 输入，完整预算包含系统、工具/输出 Schema、Persona、Memory 和图像。32 KiB 本地工作集不等于模型输入上限；258,000 Token 是用户硬要求，不能因工作集很小漏算固定和多模态开销。普通同对象像素变化只留下后续分析 dirty 信号，不每帧杀模型。Activity final source guard 校验当前 surface id/epoch/metadata/actor；不是像素级原子操作保证。

原始来源保留尚有跨域生命周期工作：Activity distilled_at 只是 timeline 形成，不能作为 Cognition/Memory 已消费。Cognition 候选 IDs 保留接口覆盖未消费/活跃引用/未结束执行/最新图；活跃 Claim 的中性 history 可以长期存在。Cognition 的局部 text 不等于 canonical ActivityEvent JSON，不足以声称退休/闭合来源删除后可重新形成同一 version。Main 已接入独立 canonical source snapshot 与形成完成后的释放规则：已接管的历史文本来源可释放 raw 资产，未消费、未完成 Attempt 和当前图像仍需保护。形成失败仍保留，不能宣称无限容量或多年重启全覆盖已经验收。

连续正文 exact-splice 已完成上述开发配对并拒绝晋级。小本地模型语义理解需独立主源、部署成本与端到端证据；尚未增加服务。

## 2026-09-16：目录候选原比较暂停，修复共同接收边界

原计划四家族×两臂。首家族的两条件均自然结束，各实际接收2400条Activity和3条用户消息；其余6条件尚未尝试。运行期间发现两臂共用的行动检查把正文消费前缀误作快照接收边界，已承接的消息仍反复作废决策，因而在第二条件结束后通过原运行器的暂停机制停止。原冻结、全部输入、失败、DB与请求保留，不将分母改成两条件，不据此选赢家。

| 指标                                       |          正文页基线 |        目录候选 |
| ------------------------------------------ | ------------------: | --------------: |
| 请求 / 有完成usage                         |           134 / 131 |       148 / 145 |
| 输入 / 输出Token                           |     1714316 / 66085 | 1764335 / 78047 |
| 最大实际输入Token                          |               51379 |           55100 |
| 完整墙钟秒，含准备、到达、排空与跨日消费者 |            1019.855 |        1232.262 |
| PFC供给的不同正文来源                      |                 557 |              50 |
| settled时收到 / 正文前缀 / 目录审阅        | 2417 / 474 / 不适用 | 2423 / 6 / 2423 |

每侧3次请求没有完成usage，不能视为零费用。目录被审阅不代表正文已读；正文被供给也不代表理解或成功采用。目录降低了该Cognition表的正文payload，但不是全产品资源收益。原共同缺陷导致过期唤醒保留，运行器进入settled不代表所有语义消费完成。

用户再次邀请一句意见时，基线要求贴新版内容，目录侧给了泛化的邀请写法建议；后者没有证明精读当时海报。下一日新Chat两侧均真实memory.search，并根据Activity来源正确提醒桌脚不挡北侧坡道；这是一个家族的真实冷采用，不能推广为所有一过性信息已保留。

目录侧另有1次巩固因生成期间父来源变化被拒绝；原触发记忆本身未换版，失败记录仍保留。闭库逐项核查确认，随后另一正常巩固已提交涵盖相同4个父revision和5段原引文的总结，因此这一组事实没有独有的剩余巩固需求。不能把它改计成功，也不能据此保证所有冲突都会恢复；本次没有为了清空失败计数添加重试。

接收边界修复见[独立Decision](COGNITION-ACTION-RECEIPT-BOUNDARY.md)，已随共同v21进入Main，该次v21完整离线通过。新正式比较已于2026-09-16 13:24 UTC启动，两臂以相同修复基础、全新profile执行原完整4×2；截至本文状态核对仍在运行，尚未选定目录候选，新结果不覆盖这里的失败。原正式冻结 SHA `9b47b168180970cdd9b78e03edd7babd9877645157bcf17bd7e5bd43a45cd94e`；两条件聚合 SHA `82426d1997a11f523f11c528fa605dafc02e6ec147e552dec86d6218538d6a6d`；闭库巩固核查 SHA `4ea9ee8f672783b63114b852d847a5f5d92a4a81dcd7eca388cf4a9bae56de12`。无候选或运行开关进入Main。
