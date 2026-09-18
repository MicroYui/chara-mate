# MEMORY-CANONICAL-RETENTION：形成原文按实际消费者释放

状态更新：所选原文回收已进入 Main v21；原隔离集成与离线验证保留，最终同版桌面验收见 [STATUS](../progress/STATUS.md)。2026-09-15 的本记录选择中间原文生命周期，不改长期记忆的重要性、检索排名或自然遗忘策略。

## 问题与选定行为

唯一 canonical 原文解决了同来源在多个形成工作里重复保存的问题，但完整正文仍会无限累计，零条记忆形成的事件也一样。直接在一次形成成功后删正文又会破坏其他角色、未完成工作、活跃情境和待交接材料。因此采用来源单位回收：所有实际消费者结束后释放完整正文，保留来源身份、准确引文、Revision、工作引用和完成回执。

同一个来源的身份与全文可用性分开。注册保存脱敏后的真实 UTF16LE 文本块、speaker、长度、JSON 成本和 SHA256；同一事务最后标记完整。摘要仅用于恢复时核对同一原文，不是新增证据体系。释放在同一同步事务中删除这个来源的全部正文块并标记 unavailable，不能留下可被读取的半段正文。当前/历史 Memory 的精确引文和证据读取不变。

Memory 先排除 pending、running、未被单个完整工作确切覆盖的 failed；覆盖必须同角色/情境、来源和主材/语境用途匹配。Main 对候选做真实源身份映射：Activity ID、Tool RunItem，或 Message ID 及其实际 RunItem。Message 到 RunItem 只读定向元数据，不遍历整个 Chat/Run 正文。映射缺失时保留，并报告 unknown_mapping。

Cognition 对所有 Persona 的同一原文表示检查六类消费者：尚未分析事件、未终态决策、未消费记忆交接、未闭合 Episode、非 superseded Claim、未完成 Intent（含实际行动结果依据）。候选、源映射、消费者查询和 Memory 释放前复查在同一个 SQLite 同步事务里完成，没有 await 间隙。一个来源处理后让出事件循环；不持有跨 yield 游标、不新设任意批量阈值。

Activity 清理与 Memory 释放共用同一消费者投影。Activity 的文本副本在完整 canonical 仍存在时，可依原合同满足部分文本消费者；Memory 在释放最后一份 canonical 正文时不能用自己作为保留依据而绕过检查。当前画面的像素保留仍由独立视觉条件负责。

## 已处理回执与重新形成

重复提交同一已完成工作，先检查 episode 元数据、完整有序来源和 primary 用途，再返回原回执；不为取得回执重读已释放正文，也不再调用模型。新工作或未完成工作需要同一来源时，必须向真实 owner 取回完整原文并核对身份和内容。缺失、变更或只剩片段时明确失败，不能拿记忆引文、另一来源或 Cognition 摘要重建并冒充原文。

回收挂在既有 MemoryMaintenance 事件 owner 上。入队、形成结束（包含零 changes）、显式 memory.record 完成、交接 ack、Cognition 消费者状态更新会唤醒同一合并回收过程。后台后续的慢形成不阻塞已经可释放的原文；关闭取消并等待回收结束。错误报告后等待后续真实 wake，不创建定时重试。移除没有产品调用者的单工作 retry 方法，保留配置变化驱动的既有恢复合同。

## 验证与实际查询计划

最终隔离 `npm run verify:offline` 于 21:51 通过 **1,505 项**：134 contract / 1,053 unit+component / 318 integration，分层耗时 1.20 / 5.97 / 9.80 秒；typecheck、lint、format 通过，两个既有 TanStack 警告。`npm run build` 同轮通过，包含 Main、向量 Worker、Preload、Renderer 和视觉 native addon。该全量还包含形成队列、恢复和 Q4，不能把所有增量测试归为本包效果。

本包新增 Memory 生命周期 15 项、Maintenance 4 项、Cognition 消费者 3 项、Main 跨域释放 6 项；另扩展实际 Dev metrics 和旧库 schema 回归。覆盖同原文在其他 Persona/多个 Cognition 表示中仍被使用、精确 Message/RunItem 映射、已完成来源被新工作继续使用、待交接/开放情节/未完成行动保护、外层事务回滚、来源之间取消、缺失映射保留、相同原文恢复、不同内容拒绝、跨块 UTF16/NUL/代理字符串、零变化回执重放以及释放后精确 Memory 内容不变。测试中的 Scripted formation 只证明生命周期，不计为模型质量。

第一次 Main 回归 fixture 跳过了真实 item.started，6 项失败；补成实际 Run 事件链后通过。第一次全量中的旧 schema fixture 删除了 raw 列却残留新 partial index，1 项失败；恢复成真实旧 schema 后重跑完整链全部通过。两处是新测试准备错误，未通过放宽产品校验处理。

实际 SQLite **3.53.3** 上的生产 SQL 查询计划已核对：canonical keyset 使用仅 raw_present=1 的 partial index，Cognition 来源映射使用 kind/id/fragment/persona 索引。RunItem 初版索引缺少排序列，计划仍扫描整个 Run 范围；将同一个索引扩为 `(run_id, COALESCE(output.messageId,input.messageId), sequence)` 后，实际选择 run_id 与 Message 表达式精确查找。原计划保留，没有加第二套查询或另一个索引 fallback。计划取自空合成库，仅证明实际 SQL/索引匹配，不代表大库吞吐或独占延迟。

## 来源、成本与不能声称的部分

Node 24.18.0、better-sqlite3 13.0.1、SQLite 3.53.3。2026-09-15 核对官方 [事务](https://www.sqlite.org/lang_transaction.html)、[VACUUM](https://www.sqlite.org/lang_vacuum.html)、[partial index](https://www.sqlite.org/partialindex.html)、[表达式索引](https://www.sqlite.org/expridx.html) 与 [EXPLAIN QUERY PLAN](https://www.sqlite.org/eqp.html)。它们提供同步事务、索引匹配与空间复用行为，不规定 CharaMate 的 TTL、批量或记忆衰减阈值；本包没有引入这些数值。

原文释放让 SQLite 可复用页面，不承诺文件立即缩小，不自动 VACUUM。引用、旧 Revision、实体和完成回执仍会增长；没有证明整个数据库有界。保持活跃的 Claim、缺失源映射或未处理失败可以使原文长期保留。每次回收扫描依然会检查仍有正文的候选；当前 Persona 的 Claim/Intent JSON 检查仍有随状态规模增加的成本，不能宣称 O(1)。长期资源压力另需实测。

Dev Dashboard 分开显示实际原文 UTF16 BLOB 字节、长期精确引文 UTF8 字节和完整/已释放来源数；不会把两种编码、字符数和事实数混为存储量。没有普通用户开关、逐条审批或记忆管理负担。保持一个形成/读取/回收路径，无新进程、依赖、定时器或状态表。

未运行真实模型、独占资源基准或真实桌面验收；当时本地感知正式实验占用 native 资源窗。模型质量、超长期自然遗忘与多年容量都不由本包证明。

## 复现与清理

领域补丁 SHA256 `8d946836e4a054b4c2d54dcdfc54eeb31f22ff1d0e9e7a68297cbdc7e8cdac14`；最终实际查询计划 SHA256 `b669b5e44e900dd629ccb3c0fb2f3ed362a28375661a050d4a3c29603b3af191`。逐文件 before/after、共享冻结、原失败/最终日志保存在仓外 `memory-raw-lifecycle` 与 `memory-canonical-lifecycle-review`。Root 是共享/DDL/跨域唯一集成 owner，Memory agent 提交领域补丁并只读独立复核 Root 接线。

实验脚本、数据库和计划输出均在仓外；生产仅保留单一路径和所属确定性回归。没有把实验 runner、未选 Arm 或候选开关合入仓库。
