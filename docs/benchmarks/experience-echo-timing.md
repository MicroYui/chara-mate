# `EXPERIENCE-ECHO-TIMING` 决策记录

## 结论

MVP 选择唯一生产路径 `E1-FIXED-SINGLE`：在用户已经允许“重要时刻主动联系我”、并直接说明一个时间明确且尚未发生的重要 `event/commitment` 后，为该 Memory Revision 创建一个 `occursAt - 30 分钟` 的一次性 `ProactiveOpportunity`。

如果形成该 Revision 时距离事件已经不足 30 分钟，或事件已经发生，本版不创建即时机会。到达 `evaluateAt` 只代表可以重新判断，P2 主动策略、当前气泡/Run 状态和模型语义门仍可选择沉默；它不是闹钟，也不是隐藏 Automation。

## 为什么直接选择固定时机

2026-09-01 用户明确要求这一增量不要做太多实验、按下一步路线直接推进。固定提前 30 分钟与已确认的核心故事（15:00 presentation，14:30 主动关心）一致，并且：

- 不增加一次用于选择时机的 Provider 请求；
- 没有模型时间窗口、实验 Arm、运行时开关或 Settings 数值控件；
- `occursAt` 与派生 `evaluateAt` 边界清楚，容易在 fake clock、重启和系统恢复场景复现；
- 后续如果真实使用证明固定时机持续不合适，可以基于实际反馈另立 Decision，而不预先引入语义调度复杂度。

## 来源与边界

- 源码基线：`main@885706c`，当前 Automation 已采用数据库状态为真源、timer 只唤醒、启动与系统恢复重查；当前 Activity 主动对话已有 P2 主动程度、安静时段、最近三次结果与单一气泡约束。
- `occursAt` 是用户事实，持久化在 Memory Revision；`timeZone` 保留用户表达的解释上下文。`evaluateAt` 是 CharaMate 的 MVP 启发式，不是外部协议限制。
- 只从用户直接陈述的明确时间形成机会；模糊日期、纯推断、已发生事件、未授权类别和普通 Journey 不形成机会。
- 每个有效 Revision 至多一个开放机会。改期、取消、删除、关闭许可或 Revision 失效都会立即取消旧机会；如果只是关闭后重新开启类别许可，或归档后恢复同一个仍未到点的 Revision，则可以幂等重开这一机会，而不是复制一条新机会。
- PC 睡眠或应用退出期间不执行；恢复或下次启动后重新读取数据库并尝试一次。没有网络或 Provider 失败时不得声称已经发送。

## 最小验证

不运行真实 Provider Pilot，不把 fixture 结果解释为真实用户满意度。生产合入前只要求确定性验证覆盖：

1. 明确未来事件形成唯一机会；不足 30 分钟、已发生、未授权或缺少成对 `occursAt/timeZone` 时不形成。
2. 相同 Revision 幂等，改期只让新 Revision 有效，取消、删除和关闭许可立即失效；重新开启许可或恢复仍在未来的同 Revision 时只重开原机会。
3. 启动、系统恢复和重复 scheduler 唤醒不会重复 claim 或重复消息。
4. 到点仍可因 P2、气泡占用、近期等价交流或语义门选择沉默。
5. 发送时使用形成 Revision 的精确正式 Chat 和当前 Persona，先持久化唯一 Run/Assistant Message，再投影一次气泡；不进入 Automation 列表。

## 未能声称

本 Decision 不能证明 30 分钟适合所有事件类型，也不能证明用户一定喜欢主动联系。它只是在当前明确故事和用户的复杂度选择下，给出一个可运行、可撤销、可测量的 MVP 起点。

## 删除证明

生产不包含 `E0/E2` Arm、语义时机 prompt、候选 runner、窗口参数配置、事件提前量 Settings 或隐藏 Automation 兼容路径。
