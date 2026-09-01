# PROACTIVE-POLICY：主动时机、安静时段与有界反馈退避

> 状态：已选择并实现 P2，生产验收完成
>
> 日期：2026-08-31
> Decision ID：`PROACTIVE-POLICY`

## 问题

CharaMate 已有 Activity 事实观察、模型语义门、单气泡真源、最近 3 条语义去重和成功展示后的 5 分钟保护，但用户不能关闭或调低主动程度，也不能设置安静时段；关闭或让邀请自然到期后，宿主也没有确定性的频率退避。

本 Decision 只选择“是否允许一次 Activity 主动机会进入既有模型语义门”的宿主策略。它不改变话术生成、Persona、Journey 路由、20 秒 provisional Chat 生命周期，也不拦截用户明确约定的 Automation/Journey 跟进。

## 参考来源

- [Towards Human-centered Proactive Conversational Agents](https://arxiv.org/abs/2404.12670)（SIGIR 2024）：主动系统除智能外，还需要按上下文调节时机/节奏并尊重用户边界。
- [Need Help? Designing Proactive AI Assistants for Programming](https://arxiv.org/abs/2410.04596)（CHI 2025）：建议应容易判断、采用与关闭，用户希望能改变频率；持续建议容易被认为过频，但强迫每次显式评分也会增加负担。
- [ProactiveEval](https://aclanthology.org/2026.acl-long.1906/)（ACL 2026）：把目标规划与对话引导分开；过密目标和过强开场会损伤主动对话质量。
- [GUIDE](https://research.google/pubs/guide-a-benchmark-for-user-context-understanding-and-assistance-in-gui-workflow-videos/)（CVPR 2026）：开放 GUI 工作流中的帮助时机仍然困难，结构化行为/意图上下文可以改善判断。CharaMate 当前只有应用与窗口标题事实，因此继续由模型做语义判断，不把宿主频率规则伪装成意图理解。

这些来源给出设计维度，不给出 CharaMate 的分钟数。下面的频率和退避均是产品启发式，并通过本地场景验证其一致性。

## 方法

基线为 `main@5be8e28b12b5a563eb339456b8e10685992cabc2`。在独立 `codex/proactive-policy-experiment` worktree 中冻结 48 个原创场景，覆盖关闭、跨午夜安静时段、三个等级的间隔边界、一次/连续关闭或到期、回复后的恢复、应用中断，以及“少一点”的逐档变化。

| Arm | 唯一变化 |
| --- | --- |
| `P0-CURRENT` | 只有现有 5 分钟全局冷却 |
| `P1-EXPLICIT` | P0 加 `off/quiet/balanced/lively`、本地安静时段和等级最小间隔 |
| `P2-FEEDBACK` | P1 加最近 3 条连续 `dismissed/expired` 的线性退避，以及气泡“少一点”逐档降低 |

实验固定 `quiet=240`、`balanced=60`、`lively=15` 分钟，保留 5 分钟绝对下限；默认 `balanced` 与本地 `22:00–08:00` 安静时段。P2 的所需间隔为 `base × (1 + consecutiveNegativeCount)`，计数最多 3；`replied` 和 `interrupted` 都停止向更早记录追溯，后者不被解释为用户反感。“少一点”只执行 `lively → balanced → quiet`，不会把含糊反馈直接变成完全关闭。

每例固定当前时刻、设置、最近记录和期望 `eligible/reason`。上游语义机会视为同一个已批准输入，因此比较中唯一变化是宿主资格策略。模型语义门与话术没有变化，故未调用真实 Provider；这避免把模型波动混入一个纯确定性策略问题。

环境为 Apple arm64、macOS 26.6.2、Node 24.18.0、npm 11.16.0。`node:test` 协议回归 3/3 通过。

## 结果

| Arm | 全部场景 | 用户关闭 | 安静时段 | 等级间隔 | 单次负反馈 | 连续负反馈 | 回复恢复 | 中断中性 | 少一点 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| P0 | 18/48 | 0/6 | 2/6 | 6/12 | 0/6 | 0/6 | 4/4 | 4/4 | 2/4 |
| P1 | 34/48 | 6/6 | 6/6 | 12/12 | 0/6 | 0/6 | 4/4 | 4/4 | 2/4 |
| P2 | 48/48 | 6/6 | 6/6 | 12/12 | 6/6 | 6/6 | 4/4 | 4/4 | 4/4 |

P1 已解决显式开关、安静时段和固定间隔，但关闭或到期后的下一次机会仍与回复后的机会完全等价，也没有直接“少一点”。P2 在不增加历史长度、后台学习或新模型调用的前提下补齐这两处；回复后不会附加惩罚，应用中断也不会被误判为拒绝。

## 决定

选择 **P2：显式控制 + 最近结果的有界反馈退避**。

生产路径固定为：

1. 一个持久化的 Companion Initiative 设置保存主动程度和本地安静时段；普通默认是 `balanced` 与 `22:00–08:00`。
2. 一个纯宿主策略在调用既有模型语义门前检查 `off`、安静时段、等级间隔及最近 3 条连续负结果。
3. 模型仍独自负责事实是否足以自然搭话、是否语义重复，以及新 Chat/既有 Journey 的选择；宿主不增加标题关键词、情绪或意图规则。
4. 主动气泡增加“少一点”，只把主动程度下调一档并关闭当前气泡；完全关闭仍由 Settings 明确选择。
5. 用户明确约定的 Automation/Journey 跟进不属于未经请求的 Activity 主动开场，不经过该抑制策略。
6. 不保留 P0/P1 feature flag、实验 runner、可调分钟数、退避倍数、学习型画像或普通 UI 中的开发指标。

## 产物标识

- 场景 SHA-256：`c462bafaa59fa7049bf80ad3f065c50cca4850a8c6fcf2690ea0d5b985ddb287`
- Arms SHA-256：`4f9aa39b3ff00170a3bc6790e5afd22b1406a0a8279a778cc99c8bc0396fe0d6`
- Runner SHA-256：`fb7bf7f7cd50b00bed633265ba075f468a013b0b1bdf0fb46b23d46af4a2fcbd`
- 仓库外 raw SHA-256：`7204a58f49e6632dea305bf670ab6987d28bfcae8425cb3fa7f2e9214954d884`

## 限制

- 48 个场景验证的是规则一致性，不是真实用户研究；不能证明 `15/60/240` 分钟或默认安静时段对所有人最优。
- 本次没有重新评估模型的主动话术质量，因为三组共享同一个语义门、Persona 和 opener。真实误打扰、帮助价值与长期接受度仍需在产品使用中观察。
- 当前生产触发只把 Activity 前台观察接入本策略。时间、Digest、专注和 Territory 候选尚未各自形成真实 owner，不能用本 Decision 声称所有来源已经统一调度。
- 最近 3 条记录只支持短期有界退避，不形成长期偏好模型。用户长期想要更少或完全关闭时，以显式设置为准。

## 失败 Arm 删除与单路径审计

P0/P1 及场景 runner 留在 disposable worktree，不进入生产分支。生产实现只保留 P2 的纯策略、设置合同、迁移、UI 和回归；完成集成后检查不存在 Arm 名、候选开关、可编辑算法参数或第二套主动 Runtime。

## 生产验收

- `npm run check:fast`：通过，contract 108/108；仅保留 2 条既有 TanStack Virtual lint warning。
- `npm run test:focused`：97 files、424/424 tests 通过。
- `npm run test:integration`：21 files、198/198 tests 通过。
- `npm run build`：通过；仅保留既有大型懒加载 chunk 提示。
- `npx playwright test --workers=1 tests/e2e/foundation.spec.ts tests/e2e/pet.spec.ts`：2/2 通过，覆盖 typed bridge、Character Settings 保存和持久化。
- `npm run package && npm run smoke:package`：arm64 打包与 packaged smoke 通过；`databaseRoundTrip=true`、`rendererReady=true`、`characterRendererReady=true`、`singleInstance=true`、`visibleWindowCount=0`、`wakeAssetsReady=true`。
- 未运行新的 Provider Live：本 Decision 不改变语义门或话术，真实调用不能增加对确定性频率策略的因果证据。
