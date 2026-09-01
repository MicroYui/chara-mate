# CHARACTER-DIALOGUE：版本化 Persona 与角色上下文

> 状态：已选择 A1，生产实现与验收完成
>
> 日期：2026-08-31
> Decision ID：`CHARACTER-DIALOGUE`

## 问题

在 CharaMate 已有的单一 Run/Item Runtime、Memory、Journey、Voice 与 Tool/Approval 边界内，稳定 Persona Core 是否足以改善智能 NPC 式的长期角色一致性和开放域对话；是否还需要一套动态 Character State。

本 Decision 只处理真实生活中的长期个人角色。显式虚构角色扮演、导演式叙事和 Territory NPC 行动不在本次范围。

## 参考来源

- [PersonaForge](https://aclanthology.org/2026.findings-acl.386/)：将稳定人格与动态状态分层讨论。
- [Memory-Driven Role-Playing](https://aclanthology.org/2026.findings-acl.1175/)：以 Anchoring、Selecting、Bounding、Enacting 检查角色知识使用。
- [PersonaGym](https://aclanthology.org/2025.findings-emnlp.368/)：分别观察 Expected Action、Linguistic Habits 与 Persona Consistency。
- [LD-Agent](https://aclanthology.org/2025.naacl-long.272/) 与 [LoCoMo-Plus](https://aclanthology.org/2026.acl-long.1150/)：长期互动需要区分稳定角色、用户事实和当前情境。

论文只用于组织候选与评审维度；没有复制其字段、对话长度、Judge 配置，也没有引入第二套 Agent 或 Memory 框架。

## 方法

基线为 `main@5be8e28b12b5a563eb339456b8e10685992cabc2`。使用 4 个原创 Persona、12 个案例，覆盖情绪支持、技术问答、创作协作、语言切换、事实纠正、知识边界、Agent 操作边界、长上下文与共同活动。

| Arm | 唯一变化 |
| --- | --- |
| `A0-CURRENT` | 当前通用 Agent instructions |
| `A1-PERSONA-CORE` | A0 加结构化稳定 Persona Core |
| `A2-SELECTIVE-STATE` | A1 再加当前 Chat/Journey 的动态状态与可选 delta |

三组使用相同的 `copilot_api / gpt-5.6-sol`、Memory、Journey、Chat summary、近期消息和 Tool scope。离线协议测试 16/16 通过。真实 Pilot 的 36 个样本全部成功；A2 有一个案例产生 continuation，因此实际共 37 次 Provider 请求，无自动重试和失败请求。

评审采用自动正确性检查加逐例产品评审。自动规则只用于发现协议非法、禁用表达和明确操作边界；它依赖精确短语，不能代替自然度判断。逐例评审由 Codex 完成，不是独立人类盲评或用户研究。

## 结果

### 正确性与成本

| Arm | 协议合法 | 禁用表达干净 | Provider 请求 | input tokens | output tokens | 状态写入 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A0 | 12/12 | 12/12 | 12 | 22,389 | 1,473 | 0 |
| A1 | 12/12 | 12/12 | 12 | 25,806 | 1,506 | 0 |
| A2 | 12/12 | 12/12 | 13 | 30,712 | 1,463 | 1 |

A1 相对 A0 增加 3,417 input tokens，约 15.3%，即每例约 285 tokens。A2 相对 A1 再增加 4,906 input tokens，约 19.0%，即每例约 409 tokens，并增加一次 continuation。

### 配对产品评审

| 比较 | 前者胜 | 后者胜 | 平 |
| --- | ---: | ---: | ---: |
| A1 对 A0 | 6 | 3 | 3 |
| A1 对 A2 | 7 | 1 | 4 |

A1 对 A0 的主要收益出现在：

- 创作卡顿时更自然地提供一个可继续的具体镜头；
- 解释陪伴方式时更像稳定角色，而不是产品说明；
- 用户纠正事实时不轻易承诺“已经永久记住”；
- 在没有屏幕或 Activity 证据时，知识边界表达更自然；
- 共同调整场景时能维持克制、具体的审美语言。

A2 唯一明确使用状态的案例是“用户常听古典乐而不是爵士”。这条信息属于用户长期偏好，现有 `memory.record` 和稳定画像已经拥有正确真源；把它再写入 Character State 会形成重复状态。情绪支持、创作推进和共同场景等原本预期可能受益的案例，A2 没有稳定写入状态，也没有比 A1 形成持续可见的回答优势。

严格字符串 scorer 的通过数为 A0 1/12、A1 1/12、A2 0/12，主要因为自然改写没有逐字包含参考短语，例如“我陪着”未命中“我陪你”。该数字不用于选择。

## 决定

选择 **A1：版本化 Persona Core**。

生产路径固定为：

1. Persona 以 revision 保存身份、背景、动机、价值、说话风格、称呼方式、主动方式、知识边界、禁用表达、默认音色和 Voice instructions。
2. 每个 Text Run 和 Voice Session 在开始时保存完整 Persona snapshot；Automation 与主动对话启动的新 Run 使用同一解析路径。
3. 唯一 `CharacterContextCompiler` 将该 snapshot 编译为 Text 与 Voice 共用的角色上下文；它不改变 Tool、Approval、Memory、Journey 或任务终局语义。
4. 切换或编辑 Persona 只影响之后创建的回答；历史 Run、消息和 Voice Session 保持原 revision。
5. 不实现 Character State 表、delta Tool、关系分数、隐藏开关或按模型 fallback。用户事实归 Memory，共同活动归 Journey/Together Session。

实验 Arm 与 runner 只存在于 disposable experiment worktree，不合入生产分支。生产完成并验证后可直接移除该 worktree；仓库只保留本记录和胜者回归测试。

## 产物标识

- Pilot manifest SHA-256：`c29f0b2ff69e89fdd497df55c2528b5a3fb253fa01db8a002d28147ce3309ac9`
- Live ledger SHA-256：`14ccf603aa79c917f50202c75dacd6500697e5080ccbe94a8146ff5e7820aadc`
- Live summary SHA-256：`8d4837d4356ebe83e7515a6edadfd7f5d4e9b0c34e61f4a5be6b844b55d6932f`
- Pair packet SHA-256：`031b4c9ef809bcf732d602f7eca6d52d7cba9836caf2543d8dc2dbceb4d1238f`

## 限制

- 只有 12 个产品案例、4 个原创 Persona 和一个目标模型，不能外推为所有模型或所有角色类型的普遍结论。
- 逐例评审由 Codex 完成，不是独立人类盲评；生产后的真实使用反馈仍比本次小样本更重要。
- Pilot 主要验证单轮与已有上下文下的角色表现。跨多周漂移、Persona 编辑后的实际体验和不同入口一致性由生产集成测试与后续真实使用继续验证。
- 本 Decision 不证明显式虚构叙事、多人 NPC 社会模拟或 Territory 自主行动已经完成。
