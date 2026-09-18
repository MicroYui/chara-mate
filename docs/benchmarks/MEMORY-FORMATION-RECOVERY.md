# 记忆形成失败后的定向恢复

2026-09-16。状态：所选形成恢复已进入 Main v21，域与 Run 边界的原验证结果保留；最终同版桌面及独立语义验收待完成。对应 Product §6.3.1，集成 owner：root。

形成模型或连接失败后，已有分段不能重做，尚未处理的来源也不能永远滞留。这次实现沿用唯一 `memory_work`、来源游标、形成服务和 Maintenance，没有第二份队列或后台付费轮询。

## 来源与选择

本日核对 SQLite 3.53.3 的 [UPDATE](https://www.sqlite.org/lang_update.html) 与[事务](https://www.sqlite.org/lang_transaction.html)说明，以及当前 `RunEventService`、`AgentRuntime`、`RunRepository`、`memoryFormationRuntime` 源码。SQL 只修改被选中工作的状态和更新时间；领取任务、增加尝试次数及提交游标仍由既有事务执行。Run 事件只在实际插入后发布，回放不发布；模型实际 response ID 写入 assistant Item，打断保存为 interrupted Item。这些是实现事实，以下恢复事件是 CharaMate 产品选择，不是协议规定的重试算法。

1. 启动时，当前实际处理器版本可以恢复旧版本失败且未被其他完成任务覆盖的来源；已完成工作不变。没有配置模型时不伪造版本，也不把配置缺失变成启动失败；存储和未知错误仍暴露。
2. 新执行的 `memory.record` 可以定向恢复它解析出的同一来源工作。其他失败任务不受影响；完整回执重放和已提交前段继续保持幂等。
3. 普通文字 Run 首次完成的实际模型响应触发同一当前 Provider、协议、模型及处理器版本的连接恢复。只选择当时已经失败、未被覆盖且错误为 timeout、unreachable、rate-limited 或 unavailable 的工作。语音、自主生活、工具结果、无 response ID、打断、同 Run 后续模型响应和事件重放不触发。

当前追加的 unavailable 来自正式连续事件中实际 HTTP503 暴露的分类缺口。Main 已补源码，所列历史验证分母不包含该追加；真实 SDK 与 SQLite 回归待运行，见 [服务过载恢复](PROVIDER-SERVICE-RECOVERY.md)。旧 REQUEST_FAILED 记录不按错误文字猜测重分类。

第三种事件不保存给尚在执行或以后才失败的任务；一次恢复后再次失败，等待新的明确事件。认证、上下文、语义和存储失败不伪装成连接故障。没有新增持久表、Schema、索引、配置项、计时器或模型调用路径。

## 实际旧库恢复

从 L 原形成实验 w6 数据库复制得到的 72 个唯一来源工作中，原先 67 个完成、5 个失败。使用实际 v16 形成、gpt-6-astra、Qwen3-Embedding-4B-Q4_K_M/512 和向量 Worker，由正常 `maintenance.start()` 启动恢复；没有提前执行 retry SQL 或提供正确答案。

- 原 5 个失败全部进入新尝试：4 个完成，1 个仍失败。原 67 个完成工作保持原值，同版再次启动新增尝试为 0。
- 共 19 个实际模型请求，19 个均有 usage；输入 186,349、输出 15,326、缓存输入 46,520 Token，单请求最大实际输入 11,245。
- 唯一剩余失败在一个包含 4 个 support 提案的片段中：用户重申约定，不能单凭用户这次原话补充角色此前实际发言的直接观察依据。整个片段在准备阶段拒绝，其他三个合法补充没有部分提交；它们原有事实仍在。该问题另作诊断修正研究，未放宽依据规则。
- 原 L 数据与失败分母不修改。恢复使用 8 月 13 日模拟时间，原库终点为 8 月 11 日；这是处理器更新后的开发恢复验证，不是同一时刻成对收益实验，也不计入最终独立质量分母。

数据库输入 SHA `f98e2b8dff9640265f47d988189d1cabedee1d9b4336fd89fdafa81f2b79ad4f`；协议 SHA `3f2da35b9f5865f22d47ce101f9e924ac47272bcc73ee131f6befec4b9bdafd3`；结果 `formation-recovery-v1/result.json` SHA `0dce2b0492e6da76dbcdd5e3e27301f03b2d04846df5dca174e1bbadc34a047c`。原输入、输出及工作前后状态保存在仓外证据目录。

## 正确性与边界

Root 将未配置启动和定向 record 两次修复依次合并，305 个 Memory 单元及 74 个受影响跨域检查通过。随后域连接恢复与实际 Run 接入的 31 个集成检查通过，完整 TypeScript 与受影响 lint 通过：使用真实磁盘 SQLite、RunEventService/Writer、MemoryMaintenance 及持久状态；网络和模型错误为确定性注入，没有声称真实中断过网络。

覆盖了重复事件与回放、执行中失败不承接旧恢复信号、同 Run 后续响应不能循环触发、另一 Run 新成功可重试、不同实际 Provider/模型/协议不可串用、完整来源覆盖、部分游标重启、配置缺失及存储异常。旧版本恢复和新的重试保留原提交，不把错误片段标成 complete。

域冻结 `FORMATION-PROVIDER-RECOVERY-FREEZE.json` SHA `eeb715177d249c2e10782623bd5b9b34391ee46c8e54ebc37b94a788869586e1`；Root 宿主选择 `formation-provider-recovery-20260916/HOST-SELECTION.json` SHA `285deac8b0960d02c6d05d61e1cb6166206e975475fcb629dab21845582cccf5`。验证只说明本次恢复机制和列明边界，不能代替形成质量、连续陪伴或网络服务可靠性的最终验收。

实验装配与原始请求保留仓外；发布源只保留唯一恢复实现与领域回归，不引入候选选择开关。

## 2026-09-17：活动 Revision 并发更新（已集成，最终同版待验收）

已闭合的自然目录比较 d02 中，D1/D2 各有一个后台形成任务在生成期间遇到前台有效修订。D1 提案的两个 revise 指向不同目标；另一来源任务已于 05:02:11.758/760 UTC 提交新 Revision，后台于 05:02:24.336 拒绝旧目标。D2 仅有一个 revise 目标，另一来源任务于 05:08:45.993 提交新 Revision，后台于 05:08:56.588 拒绝旧目标。实际提案与提交顺序排除了这两例由同一 batch 自己先改目标而造成冲突的解释。

比较所用旧版 `MemoryFormationService` 将目标变化作为普通错误抛出，外层持久化为 `formation_failed`。同处理器启动只恢复 running 或明确的 Provider 错误，普通 wake 只读取 pending，因此这些正常并发更新不会自行恢复。提交拒绝本身正确，缺口在后续处理；两个失败均保留在原实验，不用其他已完成任务或回答正确掩盖。独立 d02 报告 SHA `7ef64f064feba07749e9f07c52a6e17118fdd80c4b2d08249468c6c567697364`，原生成、变更和 work 状态留在仓外同族目录。

2026-09-17 重新核对 SQLite 官方 [Isolation](https://www.sqlite.org/isolation.html)（页面标示更新 2022-04-18）与 [Transaction](https://www.sqlite.org/lang_transaction.html)（页面标示更新 2026-02-18）。同连接能够看到此前已经完成的写入；事务原子性不能使事务外模型生成所使用的旧语义快照继续有效。CharaMate 仍在事务外等待模型，提交事务重新检查实际版本；不会通过长时间占有数据库写事务来等待模型。这些文档没有规定本产品的恢复次数或调度算法。

Product §6.3.1 已明确：同一活动记忆被另一有效 Revision 接替时，拒绝旧提案，保留工作身份、已提交片段和未处理位置，以真实版本变化为依据重新取材后继续。删除、归档、类型/语义错误和同一提案内部冲突保持独立处理，不据通用错误文字自动恢复。三文件修复于 2026-09-17 06:17:14 UTC 合入 Main；隔离实际 SQLite 回归通过，最终同版的自然模型和桌面验收仍待执行。

所选实现沿同一 form Promise、工作身份与未提交片段处理实际输入变化。每次生成前记录真实活动目标，提交前一次检查全部目标和保留来源；有确切外部接替版本才重新取材，不依赖通用错误字符串。接替版本按 Memory ID 直接读取，在初次分配和 Recall 合并后两次分配中都必须完整保留；若容量不足，在再次生成或写入前明确失败。已提交片段不重做，后续取消继续由原 Owner 保存与重开。没有新队列、持久状态、计时器、重试次数或 Provider 路径。

同一 batch 内 revise/revise 或 revise/support 冲突仍走原提案校验，合法的重复 support 可以继续。模型最初就指定历史版本，或刷新后仍坚持旧历史目标，不被当作新外部更新而无限付费重试；原 F2 与一次校验反馈后保留错误。旧比较里已经 failed 的工作不按错误文字重分类，也不回填为成功。

验证保留所有首轮结果：纠正独立第二目标的夹具后，原 Main 的两项检查确实因 Revision 变化失败；第一版恢复在第二次分配丢掉接替版本的用例中错误返回空变化，v2 在写入及下一次生成前拒绝，证明了这次补修的必要性。最终四个 Memory 单元文件 **201/201**、Formation Processor 磁盘恢复集成 **28/28** 通过，新增 **8 个单元与 3 个集成**检查；TypeScript、受影响 lint 和格式通过。初次夹具/旧期望失败以及格式修正均保留；集成绿色发生在只移除未使用绑定与格式整理之前，未把后者写成重新执行的集成结果。检查使用真实 SQLite、Recall、工作持久化和可控模型，不宣称真实网络竞争或新 PID 原生验收已经通过。

最终冻结 SHA `9f1dd3e6aa3933cf3da2ffff2bd3799ed44f945556c131d8cbd8f74ea8ca7ff0`，原始验证回执 SHA `c69170445700220e40b582e2c98054f7d61cb6fba314832a0247a8aafa13066a`；Main 变更文件为 `memoryFormationService.ts`、同域单元测试及 `memoryFormationProcessorRecovery.test.ts`。生产只保留这一恢复路径；候选、首次失败、模型夹具和完整运行日志留在仓外 `integration/formation-concurrent-revision-validation-v1`，其后的 Main 全组合结果单列。
