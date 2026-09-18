# ACTIVITY-DISTILLATION：Episode、Digest 与候选层级

> 2026-09-17 当前行为边界：以下是原实验及 2026-08-28 产品修订的历史记录。当前 Product §6.9 已选择 Activity 原始观察→Cognition→Memory 的有来源形成，保留 Episode/Daily/Weekly Digest 和 `activity.search`，移除独立跨周待确认候选链。实际检查发现旧生成/替换路径尚未删净，当前正在独立包中修正，验证进度见 [STATUS](../progress/STATUS.md)。已有已接受记忆继续可读，不静默改写；此产品收口不改写旧实验数据，也不是新的算法胜负结论。

## 问题与边界

本 Decision 选择 Activity 从原始事件到 Episode、周期 Digest 和 Memory 候选的唯一生产层级。目标是保留可理解的多日行为，同时避免把一次切换、Agent 自己的动作或低信息事件固化为用户偏好。它不扩展成行为监控、安全审计或对抗评测，也不自动修改 Persona；所有长期写入先成为用户可见候选。

自定阈值只用于比较，不是自动否决线。最终同时考虑 Episode 边界质量、信息覆盖、候选 precision/recall、重复、写入/模型成本、可解释性、延迟与实现复杂度。若机械门槛与综合产品选择不同，保留原结果并写 amendment。

## 来源、环境与冻结数据

- 执行日：2026-08-08；基线 commit `d539dff367a5e8af544d6dcf28e1112e8311d63b`；Apple M4 Pro、24 GiB、macOS/Darwin `25.6.0`、Node `24.18.0`。
- 采集边界以 Electron `43.2.0` 的 `powerMonitor`/`desktopCapturer`、Playwright `1.62.0` 的受管 Page 事件及现有 Run Event 为来源行为；这些只定义可观测事件，不替 CharaMate 选择轮询、合并或蒸馏阈值。
- 冻结行为集 `activity-set-v1.json`：30 天、155 条事件（133 条用户事件），覆盖连续编码、官方文档、周会、午餐网站、短应用切换、一次音乐/游戏/求职页面及 Agent Run；SHA-256 `b0ea066ba95acabdcfecf1a992e54269c5a33f31b556a4da55c17e7d860e1f7f`。每条事件有人工作者、来源、时间、app/domain、人工 Episode 和 topic；稳定/一次性 topic 在生成前冻结。

前 14 天只用于选择 Episode 间隔和跨日证据数，后 16 天确认；同时报告全 30 天，不能用确认集重新调参。

## 预注册设计

### Episode 边界

共同规则：应用/域名变化、Idle、锁屏/休眠和 actor 变化立即切断；相同 app/window 的短间隔才允许合并。只在开发段比较 `2/8/20` 分钟间隔，以人工 Episode 边界的 precision、recall、F1 和过度合并率选一次；确认段冻结。

### Arms

| Arm | 层级 | 长期候选 |
| --- | --- | --- |
| `A0-EVENT` | 每事件直接摘要 | 每个用户事件都可候选；压力基线 |
| `A1-EPISODE` | 规则 Episode | 每 Episode 候选 |
| `A2-DAILY` | Episode → 日 Digest | 每日 topic 候选 |
| `A3-WEEKLY` | Episode → 日 Digest → 周归纳 | 只对跨日稳定 topic 生成候选 |

`A4` 的 Profile/Graph/Territory 自动分流不预先实现：若 A3 已满足长期理解，Phase 3 只输出 `activity_digest` 候选；画像由用户确认后的 Memory 投影，Territory 仍由 Phase 6 拥有。

A3 的跨日证据数只在开发段比较 `2/3/5` 个不同日期；Agent actor 永不计入用户证据。所有 Arm 使用相同 topic 输入，不用不同模型掩盖层级差异。本轮先测试无模型的可解释聚合；若它不能覆盖确认段稳定事实，才触发一次固定 reader/distiller 对照，不默认增加后台模型成本。

## 指标与定案规则

- Episode boundary precision/recall/F1、过切与过度合并；
- 稳定 topic 覆盖（4 个 truth）、一次性 topic 错误候选、候选 precision/recall；
- 候选总数、重复率、原始 event→Episode→Digest 压缩比；
- 每日模型调用/Token、SQLite 写入、从事件到候选的延迟；
- Agent Run 错误归因必须为 0（正确性红线）；
- 层级、表/状态、恢复和 UI 解释成本。

逐事件高召回不构成晋级理由。质量相当优先层级更少、无模型成本、证据更清楚的方案；A3 只有在显著降低一次性候选/重复且保留稳定覆盖时才承担周归纳层。

## 结果

开发段选择了 **8 分钟**相同 app 合并间隔和 **2 个不同日期**的跨期证据。8 分钟在人工 Episode 边界上优于 2 分钟的过切和 20 分钟的过度合并；确认段沿用参数，没有回调。Agent actor 的长期候选为 0。

确认段包含 84 个原始 transition event、其中 72 个用户 candidate-eligible event。结果如下；写入数包含原始 event、所建 Episode/Digest 与候选的逻辑行，不包含日志。

| Arm | 候选正确/总数 | precision / recall | 重复 | 层级产物 | 逻辑写入 | 模型成本 |
| --- | --- | --- | --- | --- | --- | --- |
| `A0-EVENT` | 47/72 | 65.3% / 100% | 43（59.7%） | 无 Episode/Digest | 156 | 0 call / 0 token |
| `A1-EPISODE` | 39/64 | 60.9% / 100% | 35（54.7%） | 76 Episode | 224 | 0 / 0 |
| `A2-DAILY` | 35/60 | 58.3% / 100% | 31（51.7%） | 76 Episode + 12 日 Digest | 232 | 0 / 0 |
| `A3-WEEKLY` | 4/4 | 100% / 100% | 0 | 76 Episode + 12 日 Digest + 3 周归纳 | 179 | 0 / 0 |

A1/A2 的“压缩”没有自动解决长期候选污染：它们仍把每日短查看保留下来，而且减少稳定 topic 的重复次数后，实例 precision 反而略降。A3 要求跨日证据后，四个稳定 topic 全部保留，一次音乐/游戏/求职和每日不同短事件均未进入长期候选；写入比 A0 多 14.7%，但比 A2 少 22.8%，且没有模型调用、Token 或主 Run 延迟。

原始结果 `activity-distillation-raw.json` 的 SHA-256 为 `91e666ef2b3132c2aaea40a1ad27e8510963933477c0d912f1a917571ea5f2b1`，包含边界/证据参数各候选、开发与确认分母及所有 Arms。

## 综合定案

选择 **`A3-WEEKLY` 的无模型实现**：transition event → 8 分钟确定性 Episode → 日 Digest → 按周运行的跨日归纳；只有同一 actor/topic 在至少两个不同日期有证据时才生成 `activity_digest` Memory 候选。这里的 `2` 来自开发段，后续不作为用户设置。

生产不做通用偏好推断，也不把 app 使用自动写成 Profile。候选内容只陈述可证据化的频次/时长事实，用户接受后才成为 Memory；明确聊天表达仍高于行为归纳。A4 不触发，因 A3 已覆盖目标且再加 Profile/Graph/Territory 分流只增加状态。

截图只作为已有 Episode 的视觉证据；探针元数据缺失时建立的最小截图 Episode 不参与跨日长期候选，避免把“存在截图”误归纳成用户偏好。

## 限制

- 冻结集验证的是层级、边界与错误归因，不声称 4 个 topic 覆盖所有现实桌面行为。
- 无模型聚合能稳定陈述 app/domain/时间模式，不能从任意屏幕内容推断复杂意图；本 Decision 有意不把这种能力伪装出来。
- 原始事件是 transition 级而非每秒采样，因此 Episode 压缩率不能外推到高频埋点系统；CharaMate 生产也只持久化变化。

候选 runner 在结果 hash 核验后删除。生产只保留 A3，不保存 A0–A2 mode、阈值设置或候选实现。

## 2026-08-27 产品边界修订：停止软件时长直接进入长期 Memory

本 Decision 的历史实验结果仍证明 `Episode → Daily/Weekly Digest` 比逐事件或逐日候选更能压缩 Activity；它不证明“跨日软件时长”适合长期 Memory。生产数据复核发现，一条已接受的软件使用 Memory 可以累积数百个 Episode 来源，而当前内容只是一句累计时长陈述：来源明细随时间增长，Memory 文本本身又不能回答用户使用该软件的真实目的。用户因此明确选择更窄的产品边界。

从本修订起，生产保留 A3 的确定性 Episode、Daily Digest 与 Weekly Digest，先删除把跨日累计时长及全部 Episode 来源直接写成 `activity_digest Memory candidate` 的实现。Activity 事实仍可用于 Activity 页面、证据充分时的主动对话，以及用户明确选择后的 Territory 来源；它不自动写 active Memory/Profile。已有已接受 `activity_digest` Memory 不自动归档、删除或重写，继续由用户在 Memory 中管理。

这是一项用户确认的产品语义修订，不把旧候选精度结果改写成新实验。生产删除跨日累计时长和 Episode 来源扩张路径，不新增开关或替代算法。

## 2026-08-28 产品语义修订：Activity 可检索事实与跨周期稳定候选

源快照：2026-08-28 复核 CharaMate 基线提交 `f7122f23e1ce3b6cce3008b9e0c59d43343c23f2` 的 `ActivityService`、`MemoryService`、`ToolRegistry` 与 Agent Tool Search 路径，并以本修订后的工作树实现作为验收对象。这里没有新的 Provider 协议硬限制；最多 8 条结果是复用当前 Agent Context 的有界产品投影，不作为可调检索参数或 SOTA 声明。

用户进一步确认：Activity 若只停留在页面和主动对话触发，Agent 无法在用户主动询问“我平时怎么使用软件”时可靠读取；若彻底不再沉淀，跨周期稳定行为也失去长期价值。因此本修订替代 2026-08-27 的“完全删除 Weekly → Memory candidate”边界，但不恢复原来的累计时长方案。

生产增加两条单一职责路径：

1. `activity.search` 由 Activity 领域直接聚合 Episode/Digest，向 Text/Voice Agent 最多投影 8 条 label、活跃日期数、Episode 数、累计分钟与首末时间。它不进入普通 Memory Retrieval，不返回窗口原文、截图、Episode/Digest ID 或逐条来源；模型只能把结果表述为观察行为。
2. 同一 user actor/label 只有在至少两个已完成自然周的 Weekly Digest 都出现时，才提出待确认 `activity_digest`。这里的两个周期是“跨周期”成立的最小产品语义，不是本 Decision 新测出的统计阈值。候选内容不再累计分钟；来源固定为最近两个匹配 Weekly Digest。pending 只刷新不叠加，拒绝后抑制，接受后相同语义不再生成 Revision。新的稳定标签仍可继续形成候选。

旧版已经接受的累计时长 Memory 不由迁移静默改写；同一标签再次跨周稳定时，允许提出一个指向原 Memory 的紧凑替换候选，用户确认后才创建 Revision。完整 Episode evidence 继续由 Weekly Digest 在 Activity 领域持有。该修订是用户确认的产品所有者变更，没有重跑 A0–A3，也不声称新增了偏好推断能力。
