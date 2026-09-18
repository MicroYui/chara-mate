# 当前真实能力与临时方法的区分

2026-09-16，选择 C1。产品问题是旧自主 Run 一次选择的只读方式和不准确的能力检索结论被保存在计划文字中，后续 PFC 将其当成长期不能行动的限制。恢复系统和经过一个月都没有提供当下工具事实，因而角色永久等待。本决定不改变执行审批、领地对象资格或已选 Wake 生命周期。

## 来源、合同与实现

源为 common-v19，770 文件，冻结清单 `067ceb0902e92b8cec972fc06113a7778787f3ea3cd019307a60d32ef72e70a3`。原产品代码中 CHARACTER_TOOLS 是自主 Run 的唯一工具范围，CognitionRuntime 已持有 ToolRegistry；其 dispatch 使用 chat，实际 toolAllowedInExecution 已允许 territory.act 和 companion.life 等内部写操作。chat 并不意味着所有内部工具只能读。Tool identity 和 scope 正确性修复两臂共有，不能归因于 C1。

C1 将当下 CHARACTER_TOOLS ∩ 实际 Registry ∩ 同一 chat 执行策略的 name、summary、description、effect 作为 PFC availability 的输入。与 mayActInTerritory、sleeping、engaged 等当次行为可用条件分开。Driver 明确：某次角色选择的只读方法、休息和 companion.life 计划文字不成为用户禁令或永久能力缺失；计划保存成功仅证明保存了计划。持续 blockers 仍需有效依据。具体对象、动作和结果仍由真实观察/工具执行验证，工具 metadata 不证明它们存在或成功。

只有三个生产文件变化：CognitionTypes、CognitionRuntime、CognitionDriver。无新增持久状态、表、进程、后台任务、用户配置或单独模型调用；不复制第二份工具列表。10 个受影响测试文件完成 required 类型与实际输入/Registry/Runtime 回归。当前路径保持一份实现。

## 预注册与实际执行

协议为 `COGNITION-CURRENT-CAPABILITY-PROTOCOL.md`，实际冻结 `CURRENT-CAPABILITY-LIVE-FREEZE.json` SHA `bab5b9c07524a939d985378ed4750d996ecfcee433acf2cf115ba671eebe7a7c`。两个独立历史失败家族、每家族每臂一个恢复检查点，共 4 次完整新 Node 运行。map C0→C1，lamp C1→C0；复制各自原关闭 SQLite/资源，用同一真实 runtime.control(wake) 系统恢复入口，不改旧语义状态，不重写或重放原前缀。两臂共用真实三来源 Scheduler、ModelConsolidation/前台让出、Activity、Memory 4B、Agent/Tool/World。原 Life3 前缀曾省略 Opportunity/Automation/Consolidation；本次两臂共同完整装配，旧范围缺口仍保留。

模型均为 gpt-6-astra。完整 actual SDK 记录与模型归一记录均保存；所有 53 次模型请求均有最终 usage，无 Provider/PFC 错误或关闭错误。对照家族并行使用共享机器，墙钟只作为现场记录，不用于因果性能判断。全部完成后检查自有 encoder/runner 已退出。

## 结果与成本

| 家族/臂 | 新 Run | 实际工具与结果 | 下次安排 | 请求 | 输入 Token | 输出 Token | 缓存输入 | 最大单次输入 |
|---|---:|---|---|---:|---:|---:|---:|---:|
| map C0 | 0 | 延续“只读、不移动限制”，仍等待合适能力 | 无 | 5 | 29,669 | 2,357 | 0 | 17,823 |
| map C1 | 1 | territory.observe 1次；territory.act observe 1次 performed，角色真实从(28,27)到(32,25)；companion.life 1次 | 1小时后重评写作桌 | 24 | 219,706 | 13,022 | 50,394 | 25,084 |
| lamp C0 | 0 | 仍等待读取能力/新布局，未查询当前实际可用工具 | 无 | 6 | 59,273 | 4,632 | 10,452 | 26,779 |
| lamp C1 | 1 | territory.observe 1次刷新实际布局；companion.life 1次；没有编造修灯/照明验证 | 1小时后重评边桌书堆 | 18 | 194,804 | 12,809 | 34,968 | 33,356 |

只统计原 prefix Run ID 之外的新 Run。原实现合计 11 次请求、88,942 输入和 6,989 输出；C1 合计 42 次、414,510 输入和 25,831 输出。C1 成本明显增加，包含实际自主 Run 及后续形成、巩固、决策；这不是“相同效果更便宜”的结果。原实现两例没有恢复可执行进展，不能以永久等待换取低成本。

map C1 最终移除失效限制，保留完成动作的实际回执；明确地图路线、文字和书页内容未返回，后续写作桌仅为计划，不重复观察来编造细节。lamp C1 移除未能读取布局的过期障碍，仍保留书堆内容、实际照明和阅读舒适度缺乏依据；只查看一次后安排下一阶段，没有虚构修灯能力、持续坐着或离线活动。两者均保持自己的活动而不向用户索取新指令。

这是 2 个历史家族的有界产品错误恢复，不是 2 个独立用户的总体可靠率估计。恢复可执行进展 0/2→2/2；两例既有行为约束归属错误消除，但 lamp 此次没有领地动作，后续安排尚未实际到期执行，不能称完整阅读体验、长期自主性或商业成熟已证明。无单独大样本区间推断。原 Life3 故障仍完整保留。

## 验证、交付与删除

正式冻结前 432/432 受影响机械检查、typecheck、affected lint/format 通过；4 个实际原 DB 初始化/系统入口/关闭 dry 均通过，模型调用 0。实际比较 4/4 正常结束，无新 PFC/Provider 错误，最大单次实际输入 33,356，低于用户 258,000 上限。研究汇总 `evidence/CURRENT-CAPABILITY-V19-RESULT.json` 只聚合真实轨迹，没有补发问题或重跑以制造胜出。

交付 `current-capability-v19-selected-source` 的 13 文件精确 before/after 与 SOURCE.patch；Root 作为唯一 owner 逐块集成。候选、比较开关、runner、DB、原始 wire 均留仓外，不进入生产。拒绝的 C0 是比较基线，不新增运行时开关；产品直接使用当下真实工具事实这一个路径。候选作者在本包内未直接修改 Main，也未提交；后续 Root 集成状态见下。

Root 集成复核：完整阅读 13 文件差异，并独立读取四份 prefix/final 的真实 Run、Tool modelContent、World 前后位置、Intent/计划与原始模型 usage。合入共同 v20 后 415 项/19 文件、3.264 秒通过，全类型与受影响 lint/format 通过；共同 770 文件冻结 SHA `557e2826853d897cfd1374812b3894cd13506fab04ac2008c6ac387637aa37b2`，仓外集成记录 SHA `b7913bb92d21eec4466b563c3c75cf97058a6a6558dd4dc9560c62707be5fcdc`。与作者 432 项的测试范围不同，未把两者相加。该单一路径随后已随共同 v21 集成 Main；该次 v21 完整离线验证通过；最终同版连续行为、桌面与安装验收仍待完成，见 [STATUS](../progress/STATUS.md)。
