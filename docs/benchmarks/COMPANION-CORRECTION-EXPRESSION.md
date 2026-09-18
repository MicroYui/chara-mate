# 纠正表达：区分含义澄清与有依据的旧错

当前生产选择为下文的归因修复句。先前配对实验拒绝长句的结论与原始失败保留，不用修复后的结果回填原比较。

## 原配对比较：长句无收益

2026-09-17，Root复核并接受本次无收益保留原句的选择。执行标识为 `companion-correction-expression-comparison-v1/live-v1`，原冻结证据和独立首判永久保留。

问题是：面对用户纠正，能否既自然接受、在有真实依据时承认错误，又不单凭纠正语气补造自己的先前误解。比较唯一变量为 shared agent instructions 的 `Accept corrections.` 与预注册的较长解释句。两份 823 文件源来自 aff6，固定 gpt-6-astra、Persona、输入、原算法与资源装配；三对公开开发材料各两个新回合。不是 holdout，不是原 Final48 补分，不是最终 App 或 Voice 验收。

结果选择 **baseline `Accept corrections.`**。两边各六个新回合均 5 pass / 1 fail，三对结果相同。无旧错依据的 clarification 中，baseline 说“刚才理解错了，抱歉”，candidate 说“是我理解错了”，核心缺陷均未消失。确有旧错的 supported_mistake，两边均能承认多说的内容且不防御/索证；用户报告旧错的 user_report，两边均接受报告并道歉，不要求举证。全部后继均按用户节奏接话或安静陪伴。没有把少说“抱歉”当质量收益。

首判先于 REVEAL/wire/费用冻结（SHA `f31074d01e1156588dce4c32478ca4b1968bd36b4f118d4d0cca61a712181aa5`），但 reviewer 已读协议顺序，只称去臂名首判。解盲后，三个首 target 的实际完整 HTTP body 仅替换指定单句就完全相等；22 次普通 Run generation 都确实使用所属规则，无接线遗漏。

实际是六条件内十二个新 Run：12 start、0 steer、12 completed。原 collect 将跨独立库的确定性 UUID 复用合并为全局 distinct 8，保留原值但纠正含义，不能减少实际分母。十个真实 ToolResult 均按 callId 完整进入后续 HTTP；六个 followup 首 HTTP 均包含前轮实际回答。它们是暖连续性，未验证普通冷检索。

| 指标 | baseline | candidate |
|---|---:|---:|
| 新回合 pass / fail | 5 / 1 | 5 / 1 |
| raw generation | 60 | 73 |
| 其中普通 Run generation | 11 | 11 |
| 完整终态 input / output / cachedInput | 415,128 / 23,641 / 161,581 | 480,106 / 27,047 / 185,413 |
| 三条件子进程墙钟合计 | 680.217 s | 816.039 s |

全部 133 次 generation 的终态 usage 齐全，无 unknown；39 次 metadata 与六次 input_tokens 404 单列，计数端点未提供精确 count。总 input 895,234、output 50,688、cachedInput 346,994；缓存部分不与 input 再相加，货币账单未测。两臂各有11次普通 Run生成，额外十三次生成来自自然 Formation/Selector/Consolidation 轨迹。候选句由19字符变253字符，但不能把全部成本差归因于句长，也不把 request duration 相加当墙钟。

候选没有显示语义优势，不足以增加长期提示复杂度；成本和等待观察也未提供选择候选的理由。按预注册无收益保留 baseline，生产只保留原单一路径，不留候选 flag、Settings 或双提示。候选未合 Main，因此本包不执行生产删除或迁移；仓外复现材料按既有归档/清理范围处理。

这个选择不表示 baseline 已修复 clarification，也不表示三对小样本证明统计等价。原“凭语气补造旧错”的失败仍作为已知问题保留；后续针对性修正不得回填本次成绩。结果仅涉及这条 Text 路径和公开开发材料，不能外推 Voice、PFC 自身提示、完整桌面行为或普适成熟度。

实际全部 owner 自然关闭、父子 PID 已退出；独立报告保留六次 count404，未把 exit0 代替质量。详细原点、时延、错误、source/bundle/输入与证据 SHA 见仓外 `integration/companion-correction-expression-comparison-v1/review-v1`；独立冻结 SHA `d0747ec51ad406336bcee00fe46b52def58529cd2884934a216c5de8d9e1eff7`，Root核6个审阅文件及233个直接证据引用未变。本次审阅未启动新模型、App、数据库或编码器，未重跑至通过。

## 针对已知归因缺陷的修复与复测

2026-09-18，接受以下单句替换 `Accept corrections.`：

> Accept corrections by following the clarified meaning; treat them as a report of your past mistake only when the user actually attributes that mistake to you or the supplied conversation shows it.

原三案的历史、两步和时钟均保持，只跑修复版一次：6 个新普通 Run 全完成，6/6 原归因判据通过；含义澄清不再补造旧错，确有对话依据或用户明确报告旧错时仍能承认，后续尊重用户节奏。三个首实际 HTTP 相对原 baseline 完整 body 仅上述句子不同；11 次普通生成和 5 个完整 Tool 结果的后继请求接线已核。

后台调用一并计入：69 次实际生成（普通11、Formation22、Selector22、Cognition6、Conso8），输入457,005、输出27,842、缓存输入子集175,678，69/69终态usage齐；另有metadata20次、计数端点3次404，估算不能称精确计数。三个phase自然关闭并exit0。第三案入口路径笔误导致的首次 MODULE_NOT_FOUND 原样保留，发生于产品import前，0 Run、0模型；纠正入口后的执行是该案首次实际运行，不是补采样。

这是原已知缺陷的定向复测，不是重新进行配对统计或新holdout；同Chat后继是暖连续性，固定逻辑时间下Chat排序也不总等于旧Run Item顺序。重叠工作使墙钟不适用于独占性能比较。本包使用原baseline源加唯一修复句，不能外推Voice、最终安装App或普遍稳定性。

Root于2026-09-17 17:21:51 UTC将唯一修复句整合到Main，保留已有activity.observe指令；整合后完整离线2658项通过。没有新增模式、过滤器、依赖或数据库结构。生产仅一个提示路径，原长句候选继续不进入生产。

证据为 `integration/companion-correction-attribution-retest-v1/review-v1` 与 `independent-review`；原输入SHA `f45305e372b0fa94996820a7152c8e3f8b95dc585adcf55804f9875d1856c575`，修复源冻结SHA `603861fc279c7b01c733b4df8b79d202c0b6c78985caa9707739832e0aaf2898`，完整审阅冻结SHA `94a9d0455a6d8e7b5f84e614135be357d6b30a42deaf74d9837da1c344676080`。Main实际整合与离线记录见 `integration/correction-attribution-main-integration-v1`。
