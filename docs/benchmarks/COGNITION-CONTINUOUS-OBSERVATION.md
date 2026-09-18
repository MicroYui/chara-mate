# 连续观察：保留重访与活动恢复

日期：2026-09-16。Root 唯一实现和集成 owner。预注册 `PROTOCOL.md` SHA `19b6c4d578fb2d9eaa89d76edf52ada4a99aad1e847148ecf1464e2dae210045`，问题依据 Product §1.5–1.6。

用户从酒店页面切到报销表格，再回到同一酒店页时，原实现因为正文没有变化而丢弃重访。原 v3 holdout s05:c12 的实际 journal 缺少 e10，前台焦点仍为 Spreadsheet；PFC 与普通 Agent 都没有收到当时青岛 1080 的页面，所以转而比较北京报价。不能把这项失败归因于 embedding 漏召回，也不能判作模型看到了重访后忽略。

选择按同 Persona/actor 最新一条观察判断是否是连续重复，替换“目标对象上次观察”的查法。来源类型/epoch、语义边界、对象、正文、可访问范围和画面共同判重；携带操作计数、控制、效果或机会的事件不走纯观察消重。用户事件还必须符合当前物理焦点，才能被合并：迟到的旧观察可以进入历史，但不会把焦点拉回去，也不会阻挡下一次真实返回。原始 source identity 的幂等、键鼠缓冲、分析预算与批量调度不变。

普通连续相同画面仍可合并。idle、对象切换或一段操作后再出现相同正文可以形成新观察；这会比旧历史去重保留更多来源，是获得正确连续情境的必要成本。本修复没有增加固定 TTL、阈值、模型调用循环、状态表、索引或内部设置；不保证每一种操作轨迹的生成成本都不变。

来源：2026-09-16 核对 Apple 官方 [应用激活通知](https://developer.apple.com/documentation/appkit/nsworkspace/didactivateapplicationnotification) 与 [AX 焦点通知](https://developer.apple.com/documentation/applicationservices/kaxfocuseduielementchangednotification)。在线正文依赖 JavaScript，具体常量及调用以当前本机 macOS SDK 26.5 的 NSWorkspace.h 和本项目 native observer 为准；header SHA 保存在 RESULT.json。OS 通知没有规定相同内容的跨对象重访可以丢弃；这里是 CharaMate 的正确性修正，不称为协议硬限制、脑科学定律或 SOTA 算法。

原 v3 是同一份 627 文件冻结，三文件变更外的 624 文件 hash 均未变。8 个新增回归在原实现全部失败；修复后全 Cognition 13 文件 249 项通过（1.86s），相关 app integration 2 文件 30 项通过（1.71s），完整 typecheck、受影响 lint/format 通过。验证实际 journal、attention 与 driver 收到的输入，另保留已有连续重复、1000 次键盘聚合与 actor/时序回归；没有写死模型应答或人为注入正确记忆。结果 `RESULT.json` SHA `e7be28e478a95e4e5de04acffca11d02d27340e1877d51ca89da953ef41074dd`。

原 holdout 的冻结 source、输入、数据库和分母保持原样。以上只证明来源供给和焦点修正，没有新增真实模型质量样本；若后续以同一 s05 做实际回归，须标注为已知问题回归，不能重算原 holdout 或冷召回成绩。原 fixture 的对象身份为 provisional surface:Browser，真实 native 对象代次变化可能规避部分旧问题；未把该失败泛化为所有桌面平台必现。

独立审阅随后发现基线与第一候选共同存在时钟丢失：A@10 → 相同 A@20 被合并 → 迟到 B@15，旧逻辑只能看到 A@10，错误接受 B。补充协议先于修改记录为 `PROTOCOL-CLOCK-AMENDMENT.md`，SHA `fbb33a6d5317ddb340a309af026f0636126122705ee0909ce5a3c3c0e3320d84`。最终在既有 Attention payload 增加宿主拥有的 `foregroundObservationClock`，正常与合并观察共用同一时序检查，结合 journal 已知 epoch 序列与当前合并时钟。模型 delta 不得修改它；合并不改历史 Evidence 的身份、时间和正文，不增加 journal 水位、focusRevision 或模型唤醒，也不建立新表或迁移。

补充的 5 项回归在第一候选全部失败；最终全 Cognition **254/254、13 文件、2.22s**，相关 app integration 与全部 contract **164/164、17 文件、1.45s**，typecheck、受影响 lint/format 均通过。首次 contract 检查仅因隔离副本没有 AGENTS.md 失败（其余 163 项通过），复制当前 Main 文档后通过，原失败日志保留。`CLOCK-RESULT.json` SHA `7411bf493e820342332ddea78fdeb9e8d2b5652183a7031bf9311f256c881921`。独立复核另外执行 5 项回归及真实内存 SQLite 时序案例，确认无 sequence、跨来源和 agent 观察边界。

同毫秒不可比的来源仍按到达顺序；单一当前时钟不保存每个旧 epoch 全部被合并的高水位，不声称解决任意跨源时钟漂移或永久乱序。最终四文件（Service、Repository、focused test、共享 Attention schema）已由 Root 晋级 Main；原 627 冻结中其余 623 文件保持不变。原 holdout 未修改。合并后的 Main 全量验证与候选清理另记；原始失败、第一次候选和补充结果保存在仓外 `evidence/cognition-observation-revisit`。

2026-09-16，Root 已按 `formation-contract-cleanup-20260916/MANIFEST.json` 归档并清理三个已结束包的 20 个精确根（1,923 个普通文件、4 个软链接），逐项核验 140 个保留文件未变。归档 SHA-256 `9243d4b31e68707ca1f31c19fccd509bfd99ca9001e0a4e396ff1e2ce740d695`；执行记录 `RECEIPT.json` SHA-256 `6f5babedd747884757ced5625993301ab17fa8ac4fcf2c0e65a5fed1d1d13dbc`。原始请求、SSE、数据库、补丁、结果和冻结记录仍在原仓外路径；依赖软链接仅 unlink，共享依赖、Main 和活动候选未删除。
