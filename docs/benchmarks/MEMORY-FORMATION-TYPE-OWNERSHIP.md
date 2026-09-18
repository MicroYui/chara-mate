# Memory 形成更新的类型字段归属

状态：v13 已通过领域离线验证、两次真实生成与记录输出的实际 Service 持久化重放；Root 已审核并晋级三文件至 Main；合并版本 1,681 项离线通过，后续 Electron/build/package 检查见 STATUS。日期：2026-09-16。原 holdout 的失败、输入与分母不变，本记录不是新的 holdout 成绩。

## 问题与产品合同

已知 s21:c12 的原 formation-v11 call 24 读懂“我还没决定型号，不要替我记成已经选C。”，尝试纠正旧记忆把选购要求记录成 `purchased_phone` 的完成状态。但它同时把原 Memory 的 `type:event` 改为 `project`，触发既有 Service 的 `Formation cannot change a memory's existing type or slot`。这使整个形成事务回滚，连同另一个用户纠正偏好也未保存。原请求正常终态，有 usage；这不是 JSON、超时或引用定位失败。

当前产品的 `type` 属于 Memory 身份，Revision 保存正文及语义变化；类型影响列表筛选、画像投影和事件时间资格，并非无意义标签。`event` 也不等于“行动已经完成”。本例可以保留原事件记忆身份，通过新 Revision 将正文和 semantics 改为尚未决定的选购要求，同时保留旧报告和来源。本改动不重分初始类型，不把可能存在的类型分类质量问题隐藏为已修复。跨 Memory 的 `supersedes` 只是证据关系，不会让另一条 Memory 自动退出 current，也不能代替重分类生命周期。

原 v12 wire 让 create/revise/support 都重填 type，却又在领域层禁止更新 type。这把宿主已确定的不可变值交给模型重复生成。候选将字段所有权写进同一 wire 合同，而非接收非法值后覆盖它。

## 来源和实现边界

2026-09-16 实际查阅 [OpenAI Structured Outputs 官方指南](https://developers.openai.com/api/docs/guides/structured-outputs)：根为 object；嵌套 anyOf 可用；严格结构中字段 required，未知 optional 以 null 表示。这些是 Provider 协议约束，官方并不要求更新操作重复生成宿主不可变类型。实现使用已固定 OpenAI SDK 6.49.0、TypeBox 0.34.52、Ajv 8.20.0；Node 24.18.0 和独立 Node ABI SQLite 依赖。产品类型含义依据当前 `REFACTOR_PRODUCT_DESIGN.md` §6，具体不可变行为依据当前 `memoryFormationService.ts`，不是从官方文档推导产品语义。

生产差异只有 `memoryModels.ts`：

- create 分支提供 type，targetRevisionId 为 null；revise/support 分支必须提供目标，schema 中根本没有 type。
- Adapter 发请求前冻结实际已供应的 Revision→type 映射。更新从同一快照继承类型；未知目标拒绝。旧输出即使重复的是正确 type，也因多余属性被拒绝，未设置旧 wire 兼容分支。
- 先解析 operation，再按明确分支恢复 nullable 并校验；没有修改通用 structured-output helper。领域 batch 仍含 type，Service 的类型/slot、来源、Persona、当前 Revision、取消与事务 guard 保持原样。
- 形成处理器升为唯一 v13；现有失败任务恢复与版本迁移继续由原生命周期管理。

没有新增表、依赖、后台进程、用户设置或算法开关。nested union 在 wire 中重复共同字段，因此有实际 schema 成本。

## 冻结与真实生成

两个请求使用同一实际 s21 call 24 材料：9 个真实来源、1 个新主材、原有 8 条比较 Revision、同一时间与实体 index 投影。不添加标签、gold 目标、额外用户提示或强制搜索。A 为当前 v12，B 为候选 v13；除类型归属 instructions 段和 units schema 外，实际 SDK wire 深比较相同，input 相同。A/B 不是原 v11 请求与 v13 的混合对照。

Root 逐项核对请求后批准固定 A→B 各一次。发送前冻结 `RUN-FREEZE.json`，SHA-256 `441efd455417ea5fc82a0303eb0c193953a045e5f47e042de6761d55f675b87b`。实际请求再次验证 frozen payload hash，SDK generation `maxRetries:0`，未重试、未追加模型调用、未启动 encoder。真实 input_tokens 端点均返回 404，保守估算是完整请求的本地估算，并非远端 tokenizer 计数；两次 completed usage 均完整取得。

| 项目                          |   A：v12 |   B：v13 |
| ----------------------------- | -------: | -------: |
| 完整 wire bytes               |   28,298 |   32,883 |
| 发送前保守估算 tokens         |   30,474 |   36,435 |
| 实际 input tokens             |    7,650 |    8,620 |
| 实际 output tokens            |      999 |      894 |
| cached input tokens           |        0 |        0 |
| 端口完整耗时                  | 19.805 s | 18.590 s |
| 正常模型终态                  |      1/1 |      1/1 |
| Adapter 接收                  |      1/1 |      1/1 |
| 记录输出通过实际 Service 写入 |      0/1 |      1/1 |

两次合计 16,270 input、1,893 output tokens；每请求均低于用户 258k 上限。未取得代理金额单价，故不编造金额。B schema 增加 4,585 bytes，本例实际 input 增加 970 tokens；该变更服务于正确性，并非成本优化。单对的输出长度与延迟受生成随机性、顺序和代理状态影响，不据此声称总体提速或稳定率提升。

实际 ModelRequest 起始时间分别为 02:17:35.603Z、02:17:55.418Z；ModelEvent 正常终态到达分别为 02:17:55.394Z、02:18:13.823Z，均为 2026-09-16 UTC。上表端口耗时另含 Adapter 解码与校验，结果写入时间分别为 02:17:55.409Z、02:18:14.008Z。原始 SSE、ModelEvents、请求、usage 与失败全部留存。

## 输出语义与持久化

A 仍将同一目标 Revision `b1286c16-0cfd-4925-8bf7-08257cfcfd42` 的 type 输出为 project。正文正确区分用户和爸爸，保留拍照/轻便及预算比较，说明尚未选定 C、未完成购买；但合法 JSON 和 Adapter 接收不能代替领域成功。实际 Service 重放再次触发原 type/slot 错误，Memory 和 Revision 数量增量均为 0。

B 的 update wire 没有 type。Adapter 从已供应目标继承 event；正文纠正了当前已购机解释，semantics 从 episode/purchased_phone 改为 claim/own_phone_selection_requirements_and_status，明确型号未定，并把保留的拍照、轻便与预算比较标为原上下文、未新确认。它没有把“没选定 C”改成排除 C、取消计划或已购买，也没有把爸爸的购机对象并入用户。另一个 create preference 限定当前角色、本次选购协助，未泛化到全部角色。

零模型持久化核对使用原 `s21-c12.sqlite` 的 A/B 副本，实际 `MemoryFormationService`、Repository 与 SQL 事务均未改。由真实仓储重新读取的全部 episode、9 条 source、primary、时间、sourceWindows 和 coverage 与冻结生成材料逐项相等；目标 Revision 的身份、类型、正文和 semantics 也未变。实际批次不修字、不换引用。

该库是 checkpoint 结束快照，比 call 24 当时多一条已形成比较 Revision `40c651b1-c486-4571-a498-1c2b488ca177`。重放保留这条真实状态，并将 recall 端口固定为原请求已供应的比较材料，未伪造 canonical source，也未再次执行检索/模型。两臂各一次记录 batch 交付，实际 Service 均未要求第二轮；这是领域持久化边界验证，不是完整形成流水线重跑。副本调用既有 retryFailed 后只运行确切原 workId；原数据库 hash 未变。

B 实际写入结果：

- 原 Memory `685c8811-541c-4532-a2bb-a06504fc3ba5` 的 currentRevision 更新为 `57e17d04-1bca-42ec-92ac-7fd2a55528c6`，Memory type 仍为 event。
- 旧 Revision `b1286c16-0cfd-4925-8bf7-08257cfcfd42` 和来源仍可读，旧正文未变化。
- 新 Revision 的来源 span 精确保存“我还没决定型号，不要替我记成已经选C。”，并保留原选购要求的引用。
- 另创建 1 条当前角色的记录偏好；总增量为 1 Memory、2 Revision。数量只是事务账本，不能作为质量分。
- 原失败处理器 v11 到本候选 v13 的迁移由已有记录保留，并非删除失败重新造任务。

## 离线验收与裁定

同一个候选源通过 Memory 15 个测试文件共 272 项、typecheck、3 个拥有文件的 lint。新增普通回归覆盖：create 类型、revise/support 继承、禁止旧 type 字段、未知目标、请求期间快照稳定性、nullable；真实 Adapter→Service→SQLite 的新旧版本/精确来源；support 不改正文；错误来源、取消、归档、删除、目标已被手动改写时拒绝。测试使用自写通用相机借用故事，未写入 holdout 标签。早期 optional spans 和 unused 参数的静态失败日志保留，修正后最终检查通过。没有运行无关全仓/E2E，交由 Root 最终集成验收。

已选择 v13 单一路径：它在结构上删除更新不可变类型这一无效选择，已知实例的真实输出也能合法纠正并保存。一个已知失败的两次生成不能量化总体形成质量、初始类型正确率或未来稳定率。未验证后续 Agent 自然召回/采用，不回填原 holdout 分数；原 v11 与本次 A 的失败均保留。若产品需要改变已有 Memory 分类，应另行定义明确历史语义，不能借本修复自动改类型。

仓外 `memory-formation-type-candidate/` 的 `HANDOFF.json` / `LIVE-HANDOFF.json` 保存精确源差异与日志索引；后者 SHA `1782c5fb9de32eebf262b1f5fde5851d4faf7d508a26556245e4d662040dc02f`。唯一生产文件 SHA-256 `23ed791c0cd1f8cb0bd3ea9f37e2fa15aeed04bcc7498b9fbcd585f2b6be9486`；三文件补丁 SHA-256 `8866ab07e49d8eca7788f08e36724ffe026d70a22cf3541a17e12f604b65eabc`。候选 source、runner 和 bundle 已归档清理，原始请求/SSE/DB/结果和本记录保留。

Root 于 2026-09-16 02:23 UTC 核对三文件及实际新旧 Revision/quote 后晋级 Main；记录 `ROOT-PROMOTION.json` 的 SHA-256 为 `6c99b9494c9bea46c3c4ed52c055bfcb4f46f12a625eb4e75d5466ce9afa0069`。这次源晋级不改变上述验证边界。

2026-09-16，Root 已按 `formation-contract-cleanup-20260916/MANIFEST.json` 归档并清理三个已结束包的 20 个精确根（1,923 个普通文件、4 个软链接），逐项核验 140 个保留文件未变。归档 SHA-256 `9243d4b31e68707ca1f31c19fccd509bfd99ca9001e0a4e396ff1e2ce740d695`；执行记录 `RECEIPT.json` SHA-256 `6f5babedd747884757ced5625993301ab17fa8ac4fcf2c0e65a5fed1d1d13dbc`。原始请求、SSE、数据库、补丁、结果和冻结记录仍在原仓外路径；依赖软链接仅 unlink，共享依赖、Main 和活动候选未删除。
