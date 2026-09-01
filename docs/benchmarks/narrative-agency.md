# NARRATIVE-AGENCY：保留现有摘要，只补角色控制权边界

> 状态：已选择 N0-RULES，生产实现与受影响验收完成
>
> 日期：2026-08-31
> Decision ID：`NARRATIVE-AGENCY`

## 问题

CharaMate 已有版本化 Persona、Journey/Together Session、长期 Memory、近期原文与持久 Chat Context Snapshot。当前缺口不是“完全无法演绎”，而是没有显式写明：用户在角色扮演中独占自己的角色，虚构事实不得进入现实 Memory，用户出戏后必须立即停止。

本 Decision 比较是否还需要独立 Narrative Projection 或边界型 director。目标覆盖生活中的共同创作/复盘/长期事项续接，以及用户明确发起的虚构角色扮演；不新增第三种 Composer 模式、第二套 Runtime、常驻导演或多 NPC 社会模拟。

## 参考来源

- [Towards Enhanced Immersion and Agency for LLM-based Interactive Drama](https://aclanthology.org/2025.acl-long.546/)（ACL 2025）：区分 immersion 与 agency；bounded plot reflection 能调整角色反应，但 director-actor 路径增加推理调用与架构复杂度。
- [“Naked and on Fire”](https://dl.acm.org/doi/10.1145/3411764.3445540)（CHI 2021）：玩家感知到的 agency 是多因素体验，不能用分支数或状态更新次数替代。
- [Drama Llama](https://arxiv.org/abs/2501.09099) 与 [Dramamancer](https://doi.org/10.1145/3746058.3758995)（2025）：用 scene/storylet 连接作者边界与开放输入，并把玩家角色的行动和对白留给玩家输入。
- [Can LLM Agents Stick to the Script?](https://arxiv.org/abs/2608.08160)（2026-08 预印本）：长程叙事需要维护事实和用户输入一致性；“忽略或重写玩家输入”是独立冲突类型，强模型仍会在长交互中失守。
- [Generative Agents](https://doi.org/10.1145/3586183.3606763)（UIST 2023）：观察、检索、反思与规划可形成可信持续行为，但论文也明确长程规划与连贯性仍是挑战。

这些来源用于定义 agency、事实连续性和复杂度维度；没有复制论文的固定剧情链、反思周期、多 Agent 架构或评测阈值。

## 方法

实验基线为 `main@5be8e28b12b5a563eb339456b8e10685992cabc2`，目标模型为当日重新发现的 `copilot_api / gpt-5.6-sol`。在独立 `codex/narrative-agency-experiment` worktree 中使用 8 个原创回答场景和 4 个长上下文压缩样本。

| Arm | 唯一增加 |
| --- | --- |
| `N0-CURRENT` | 无；当前任务型 Chat summary + Persona/Journey |
| `N0-RULES` | 只增加玩家角色所有权、虚构事实边界、自然退出和生活不游戏化规则 |
| `N1-SAME-AGENT-PROJECTION` | N0-RULES 再增加手工提供的结构化 Narrative continuity |
| `N2-BOUNDARY-DIRECTOR` | N1 前再运行一次无 Tool 的结构化 director |

8 个场景覆盖共同写作、隔天复盘、旅行取舍、故事事实冲突、侦探调查、拒绝剧情提议、角色视角知识边界和显式出戏。N0/N0-RULES/N1 各 8 次回答；N2 为 8 次 director + 8 次回答。另以 4 组原始对话分别调用当前自由文本摘要和候选结构化摘要，共 8 次；有效 Pilot 合计 48 次请求，无自动重试。

首轮预跑在完成 8 次请求后，由实验脚本自设的 `max_output_tokens=500` 造成明确 `incomplete`，未产生结果文件且全部排除。该上限没有产品依据，移除后重新执行；因此本任务实际发送 56 次 Provider 请求，其中 48 次属于有效 Pilot。

产品评审由 Codex 逐例完成，不是独立人类盲评。评审观察输入是否被承认、是否替用户行动、事实/视角连续、选择后果、开放空间、自然退出、Persona 一致性、无意义戏剧化和简洁度。自动字符串仅用于提示显式缺项或禁项，不作为自然度分数。

## 结果

### 回答成本

| Arm | 有效请求 | input tokens | output tokens | 总耗时 |
| --- | ---: | ---: | ---: | ---: |
| N0-CURRENT | 8 | 3,076 | 1,578 | 30.799 s |
| N0-RULES | 8 | 4,700 | 1,660 | 32.663 s |
| N1-SAME-AGENT-PROJECTION | 8 | 6,014 | 2,398 | 41.436 s |
| N2-BOUNDARY-DIRECTOR | 16 | 11,184 | 4,760 | 74.376 s |

实验中的 N0-RULES 使用了便于审查的长规则块；生产实现压缩为一段共享规则，因此上表不能直接当作生产逐轮 Token 增量。

### 配对产品评审

| 比较 | 左侧胜 | 右侧胜 | 平 |
| --- | ---: | ---: | ---: |
| N0-RULES 对 N0-CURRENT | 2 | 2 | 4 |
| N1 对 N0-RULES | 3 | 2 | 3 |
| N2 对 N1 | 6 | 1 | 1 |
| N2 对 N0-CURRENT | 3 | 4 | 1 |

当前路径在大多数样本中已经能承认用户选择、维持事实并自然结束。N0 唯一明确的硬缺陷出现在隐藏身份场景：它用女性代词提前泄露了玩家角色尚不知道的信息。N0-RULES 消除了该视角泄露，同时没有引入新状态或额外调用；它在总体偏好上与 N0 持平。

N1 的手工 projection 在个别拒绝/视角案例更明确，但也漏掉“只练十分钟”和“戴手套”等当前输入细节，并在旅行建议中重新提及用户已排除的地点。更关键的是，候选结构化摘要在 4 个样本中只有 3 个正确分类，把普通共同写短剧误判成正在进行的虚构角色扮演；当前自由文本摘要 4/4 都保住了角色分工、场景事实、开放问题和已出戏边界。

| 摘要路径 | 语义正确 | input tokens | output tokens | 总耗时 |
| --- | ---: | ---: | ---: | ---: |
| 当前自由文本摘要 | 4/4 | 833 | 600 | 12.381 s |
| 结构化 projection 摘要 | 3/4 | 1,769 | 1,219 | 27.425 s |

N2 相对 N1 能修复部分静态 projection 的遗漏，但相对当前 N0 只有 3 胜、4 负、1 平；它还把回答路径从 8 次调用变成 16 次，总耗时约为 N0 的 2.4 倍，并在直接改稿案例中过度展开三个后续选项。该结果不足以证明 scene-boundary 检测、额外状态和第二次模型调用值得进入产品。

## 决定

选择 **N0-RULES：现有 Chat summary/Journey + 同一 Agent 的最小角色扮演边界**。

生产路径固定为：

1. 仍使用当前完整 Chat 消息、持久滚动摘要、Journey/Together Session、Memory 和 Persona revision，不新增 Narrative Projection 表、delta Tool 或 director 服务。
2. Text 与 Voice 共用一段简短规则：只有用户明确进入虚构角色扮演时才应用；用户独占玩家角色的动作、对白、决定与感受；系统承认输入、给出局部后果并留下下一步空间。
3. 用户明确出戏后立即停止演绎。虚构事件只属于当前 Chat，不通过 `memory.record` 变成用户现实事实，也不冒充 Journey、Activity、Tool 或现实观察。
4. 普通共同写作仍可按用户要求起草、续写或修改角色动作；不会因角色扮演边界而退化成只提问不创作。
5. 不保留 N1/N2 的 Schema、表、设置、候选 prompt、director 或运行开关。

## 产物标识

- Cases SHA-256：`8156cffa6f3272b23aa0e5f9dabcd938527fd287b94eed12dc64514dacfa78f3`
- Prompts SHA-256：`5f1d784ee5ed9da34841e54b38d14f338aad117ca88fe1589977044d2fd3a325`
- Runner SHA-256：`99d3699429956d990442e9b8f0cafbc42698781c8b4b8e8cf741377f2d668dcd`
- Review SHA-256：`cecdf8b55c6e6095111348d19cc2833d4b186ccadaae45a3096f017a48c7aed4`
- 仓库外 raw SHA-256：`7dbab762e1839f23b4eb2ea9007cc6df9ff32366476767c04e074bf2af2f7f84`

## 限制

- 只有 8 个回答场景、4 个压缩样本、一个模型和一次生成，不能外推到所有题材、长达数周的连续角色扮演或真实用户偏好。
- 逐例评审由 Codex 完成，未做独立人类盲评；agency 本身具有主观性，真实体验仍需要用户测试。
- 本 Decision 证明的是“当前产品不值得新增 projection/director”，不证明自由文本摘要在任意长度下永不丢失叙事事实。
- 没有评估多 NPC 自治、世界模拟或 Territory 动作；这些属于后续 `TERRITORY-NPC-ACTION`。

## 失败 Arm 删除与单路径审计

N1/N2 的结构化 projection、director、runner、样本和逐例 review 只存在于 disposable experiment worktree；生产分支只加入共享 Agent 规则、产品设计说明、回归测试和本 Decision Record。生产代码中不存在 `NarrativeProjection` Schema/表、director 调用、第三种 Composer 模式或候选开关。

## 生产验收

- `npm run check:fast`：通过，contract 108/108；仅有 2 条既有 TanStack Virtual lint warning。
- `npm run test:focused`：98 files、426/426 tests 通过。
- `npm run test:integration`：21 files、198/198 tests 通过。
- `npm run build`：通过；仅有既有大型懒加载 chunk 提示。
- `npx playwright test --workers=1 tests/e2e/agent.spec.ts`：首次与 build 并行运行时 11/12 通过，首个持久审批用例只发生 60 秒超时；该用例单独复跑 1/1、2.6 秒通过，无功能断言失败。
- 本次 48 次有效 Provider Pilot 已单独记录，不运行额外 Live 套件；最终里程碑仍会在 `TERRITORY-NPC-ACTION` 后执行完整 offline/build/E2E/package 验收。
