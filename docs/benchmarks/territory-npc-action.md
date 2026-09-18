# TERRITORY-NPC-ACTION：按需观察与类型化角色行动

## 研究问题

本次研究开始时，CharaMate 已有可编辑 Territory World、类型化物件能力、寻路/碰撞和桌宠状态，但角色只能被 UI 右键移动，Agent 尚不能先读取当前环境、选择动作并依据真实执行结果回答。本 Decision 比较三种上下文与规划方式，目标是在不增加常驻模拟、需求值、经济或第二套 Runtime 的前提下形成一条可落地的 NPC 行动闭环。

## 研究开始时的源码事实

2026-08-31 复核 `main@5be8e28b12b5a563eb339456b8e10685992cabc2`：

- `TerritoryDefinition.capabilities` 已有 `seatable`、`sleepable`、`light`、`ambient-animation`、`inspectable`、`memory-reveal`；
- `TerritoryWorldService.movePet` 已校验活动 Zone、起点、碰撞与路径，并能保存 `idle/sitting/sleeping/observing`；
- 物件交互的最终行为目前按 capability 优先级隐式推断，同一个同时 `seatable + sleepable` 的物件不能显式区分“坐”和“睡”；
- Renderer 的移动路径只来自 Territory 页面自己的 IPC 调用；Agent 从 Main 发起动作时没有路径事件可驱动画布；
- Agent 侧只注册 `territory.generate_item`，没有只读环境 observation 或角色 action Tool。

这些是上述2026-08-31基线的实现缺口，不代表需要完整游戏模拟。下文选中路径已实现；当前 Main v21 实际注册 territory.observe/act，并包含后续[工具身份与范围修复](TOOL-DISCOVERY-IDENTITY-SCOPE.md)。工具存在与能返回真实结果，不等于长期自主活动已经成熟。

## 一手来源

- [SayCan v2](https://arxiv.org/abs/2204.01691v2)（2022-08-16）：语言模型选择高层动作，真实 embodiment 的技能/可行性负责落地。CharaMate 采用同样的责任分离，但以现有 deterministic capability、Revision、路径与碰撞代替学习型 value function。
- [Voyager v2](https://arxiv.org/abs/2305.16291v2)（2023-10-19）：把环境反馈、执行错误和自校验送回后续模型 step。CharaMate 只复用 Tool Result 闭环，不生成代码、不建立自动 curriculum 或永久技能库。
- [Generative Agents](https://doi.org/10.1145/3586183.3606763)（UIST 2023）：观察、记忆、反思与规划能增强可信行为，但长程一致性仍有成本。CharaMate 继续复用既有 Persona、Memory、Journey 和 Chat summary，不增加模拟时钟或周期反思。
- [Efficient Tool-Calling Multi-Expert NPC Agent](https://arxiv.org/abs/2511.01720v1)（2025-11-03）：NPC 对话与环境动作可以统一评测；其多 specialist 路径提示额外规划可能改善部分调用，但必须与复杂度和延迟一起验证。

## 固定行动合同

三组共用同一宿主合同：

| Action | 允许目标 | 宿主校验 |
| --- | --- | --- |
| `move` | Zone 坐标或当前实例 | Revision、边界、碰撞、路径 |
| `observe` | 当前实例 | `inspectable` 或 `memory-reveal` |
| `sit` | 当前实例 | `seatable` |
| `sleep` | 当前实例 | `sleepable` |
| `react` | 当前实例 | `light`、`ambient-animation` 或 `memory-reveal` |

模型不提交路径、最终坐标、碰撞结论、Pixi animation、World mutation 或用户事实。宿主返回真实 success、歧义、能力不匹配、Revision 冲突或不可达结果；最终回答必须以该结果为准。

## Arms

| Arm | World 上下文 | 规划路径 |
| --- | --- | --- |
| `T0-INJECTED-AFFORDANCE` | 每轮预注入紧凑活动 Zone snapshot | 当前 Agent 直接调用 `act` |
| `T1-OBSERVE-ACT` | 相关请求按需调用只读 `observe` | 同一 Agent 随后调用 `act` |
| `T2-PLANNER-ACT` | 与 T1 相同 | `observe` 后额外调用一次无 Tool planner，再由当前 Agent 执行 |

三组使用同一 Persona、用户输入、目标模型、action schema 和宿主执行器。既有 Tool Discovery 是共同前置条件，不在本 Decision 重测。

## 数据集与环境

- 9 个原创场景：坐下、睡觉、观察记忆物件、回应光源、坐标移动、重名歧义、不可达、stale Revision 恢复、拒绝饥饿/金币模拟；
- `copilot_api / gpt-5.6-sol`；Responses function calling；`parallel_tool_calls=false`；
- Apple M4 Pro，macOS 26.6.2，arm64，Node v24.18.0；
- 基线 commit：`5be8e28b12b5a563eb339456b8e10685992cabc2`；
- `package-lock.json`：`fb5c4ab9229d64da5bba3575ce9f2e643fb6a135f8eef5e91ce5003d747a3fbf`；
- 有效 Pilot：27 个样本、79 次 Provider 请求，无自动重试；另有 2 次 Responses Tool 格式探针和 3 次单样本链路 smoke，不进入质量分母；
- 协议测试：4/4。

## 可复现标识

原始逐步响应、Tool 参数、Tool Result、Token 与延迟仅保存在仓库外：

- result SHA-256：`ec29ba72e29140bcb9129ad846ebc084d6e3b2457f682dcebeb04e19d9984e18`
- derived analysis SHA-256：`cbddb005a253c13abc00876739130de00373c2532fd86ca4152618c07284de56`
- cases：`70189093ccaf876d6036de138f4c6e2e629ee243b958dd37285b9a1ca7dac0cf`
- prompts：`c9bd3819e0fdcfd352390662b816af4f938ec90d75cc284f29635db5f942df7f`
- protocol：`bd096005ce37da442110e42a80d6285484c303652ccea863b1810a0f563fed5d`
- runner：`314c8304473412112b2da4ea4784d26666884753cf525d704568d8ea2623368e`
- manual review：`ea35c4fb7d47d3b3d680fed17917a1fad1589da7b73d518cf30ec125cb34f6b6`
- analysis script：`67688ac5a2fbe4bc7f8d57754a26b1dd7ccbc7206e1d575cb9fa3883cd9de82b`

raw output 不进入生产仓库。

## 结果

| Arm | 场景正确 | 虚报成功 | Provider 请求 | Input Token | Output Token | 总延迟 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| T0 | 9/9 | 0 | 19 | 14,829 | 991 | 46.200 s |
| T1 | 9/9 | 0 | 27 | 20,768 | 1,271 | 64.075 s |
| T2 | 9/9 | 0 | 33 | 23,477 | 2,121 | 80.413 s |

T0 在这组以动作请求为主的数据上最省请求；普通无行动案例中，它仍把 7,327 bytes 的九份动态 snapshot 分摊注入各 case，该例 input 为 708 Token，而 T1 为 491 Token。T0 的 stale 场景虽然最终成功，但连续进行了 4 次 action，其中包含一次没有 target 的 observe-shaped action；T1 通过 `observe → conflict → observe → act` 清楚恢复。

T1 有一例先 `move` 再 `react`，说明生产 Tool 描述需要明确“目标互动已经包含走近”，但宿主结果始终合法，最终回答也没有虚报。T2 在该例避免了冗余移动，也在已知不可达时直接克制；但 stale 场景的 planner 先建议了 `observe` action，仍未避免冲突。

逐例产品评审：

- T1 对 T0：T1 胜 1、T0 胜 1、平 7；自然度与最终结果没有稳定差异；
- T2 对 T1：T2 胜 2、T1 胜 1、平 6；收益只出现在两个局部调用选择，不构成稳定提升；
- T2 相对 T1 多 6 次请求、约多 13.0% input Token、约多 66.9% output Token、总延迟约高 25.5%。

## 产品决定

选择 **T1-OBSERVE-ACT**。

原因不是它在九个 case 上击败 T0——两者最终质量相当——而是它符合整个产品的实际调用分布和领域边界：Territory 行动是普通对话的按需能力，不应让 Text、Voice、Automation 和主动对话的每个 Run 都依赖动态 World snapshot。T1 复用现有 Tool Discovery/Harness，只在相关请求中读取当前 Revision；发生并发编辑时可以重新观察后继续，并避免建立 Context Compiler → Territory Repository 的常驻跨域依赖。

T2 不进入生产。其 planner 没有稳定质量收益，却增加一次模型调用、更多 Token、延迟和一套生命周期。T0 不进入生产，不保留全局 World 注入或隐藏 fallback。

生产只实现：

1. 一个只读 `territory.observe` Tool，返回活动 Zone、pet 和紧凑 typed affordance；
2. 一个 `territory.act` Tool，显式选择 `move/observe/sit/sleep/react`，并携带 observation 的 Revision；
3. 一个 Territory-owned 执行器复用现有路径/碰撞并校验 capability；
4. 一个 typed Renderer event，在 Territory 页面可见时播放真实路径并投影最终行为；页面关闭时只保留同一份持久 pet state。

不增加数据库表、planner、tick、需求/经济状态、NPC 日程、多角色编排、用户设置或实验开关。

## 不能声称什么

- 9 个原创 case 不能证明长期开放世界自治、所有语言表达或真实用户偏好；
- 这是单角色、单活动 Zone、离散 typed action 的结果，不证明多 NPC 协作或完整游戏 AI；
- `gpt-5.6-sol` 的本次行为不能自动外推到所有 Provider；宿主 schema/validation 才是正确性边界；
- 当前 pet atlas 没有独立的睡眠行，本 Decision 只能让状态与可用现有动画一致投影，不能声称新增了完整睡眠动画资产。

## 失败 Arm 删除与单路径审计

实验 runner 只存在于 `codex/territory-npc-action-experiment` worktree，原始输出只保存在仓库外。生产重写完成后：

- `src/shared/schemas/territoryWorld.ts` 与 `src/shared/contracts/territoryWorld.ts` 定义唯一 observation、显式 action、执行结果和 Renderer event；
- `src/main/territory/territoryWorldService.ts` 是唯一执行器，统一负责 Revision、capability、精确目标、碰撞与路径裁决；
- `src/main/territory/territoryTools.ts` 只暴露 `territory.observe` 和 `territory.act`，后者的失败结果明确要求重新观察或选择可达目标；
- Main 广播已持久化的 typed action event，Preload 校验后交给 Territory 页面播放同一路径，最终状态仍来自持久 World snapshot；
- `sit/sleep/observe/react` 直接包含走近目标，不要求模型先调用 `move`；现有 atlas 没有睡眠行时只把 `sleeping` 投影为 idle，不伪造新素材。

单路径搜索确认生产源码没有 T0/T1/T2 flag、全局 Territory context slot、planner adapter、候选设置、额外数据库表或第二套行动执行器。失败 Arms、实验 prompt、runner 和评审脚本均未进入生产 worktree。

本次决策当时的工程验收：`npm run verify:offline` 通过（contract 112/112、focused/component 430/430、integration 200/200）；`npm run test:e2e` 在串行 Electron 生命周期下通过 25/25；`npm run package` 与 `npm run smoke:package` 通过，packaged smoke 确认数据库、Browser、主 Renderer、Character Renderer、单实例、Tray 与 wake assets 均就绪；`npm run test:benchmark` 按实验生命周期返回 `not-applicable`。构建仍只有既有大型 chunk 提示，lint 仍只有两条既有 TanStack Virtual warning。未运行 `make`、签名或公证，这些不属于本 Decision。该旧版验证不代替当前共同v21的同版构建、E2E、打包与本地运行验收；当前进度见 [STATUS](../progress/STATUS.md)。

## 2026-09-17：当前陈列观察的完整布局

原 il03 的实际观察将同一墙上不同锚点的附件都描述为墙根网格点，无法表达真实陈列位置。Product §10.7 因此补全现有只读观察合同：当前 ZoneView 的全部摆放实例进入 nodes，包括无互动 capability 的装饰与承载物；targets 只引用真实可行动子集。实例保留精确 Definition Revision、canonical placement、锚点与声明视觉尺寸。collection、别区与历史不进入观察，没有新增件数阈值或自动改造权限。

此变更直接提取 2026-09-17 实际 Renderer 的 transformedOrigin，保留 grid×24、父/子 anchor 各自 flip/quarter-turn、offset 的原计算；共享函数同时供给观察、画布 outer position、depth 和旋转后矩形 hitArea。读取时的 Canvas SHA `d6b48bfdf17795c85fd2540536521c6ffd9ed90ad446dcea71f5c740b412fb2f`，锁定 PixiJS 8.19.0。24 是已有 World scale，未新增或调选比例。rootGridPoint 与 Zone 世界像素 originPx/sizePx 分别命名；后者是声明布局矩形，不能充当截图、非透明轮廓、遮挡判断或实际寻路终点。缺定义、父节点、锚点等返回明确不可用，不补零坐标；真实行动仍使用原路径、碰撞与 Revision 检查。

生成回执的一个布尔同步更名为 worldRevisionChangedSinceCreation，两个生产写入/读取接点一起修改。计算仍是当前 Revision 是否已经偏离该次 appliedRevision，false 不是“创建没有改变 World”。此命名修复来自 il04 的一次真实误读；原误读没有导致重做，不能把它扩写为行动失败。没有保留旧名 alias 或旧库兼容。

Root 与独立审查全文核对七个生产差异，生产只有一个几何实现、一个观察合同。隔离 Territory 19 文件 163 项通过，完整 Cognition integration 60 项另验通过，类型/lint/格式通过；共享几何覆盖八个展开例，真实 SQLite 覆盖同墙不同 anchor、完整 Zone、嵌套变换、Definition/实例合法提交后重读和旧 action Revision 拒绝。两个缺引用 Service 回归是在合法 SQLite 源上注入不完整读投影，不声称持久化产生非法图。组件测试 mock Canvas，不能替代实际 Pixi 验收。最终冻结标识 `aeb2689b88e1a5f3d634851b184e3d50b58c69a04fea5b67d4cc7da13de45d32`；Root 仅合入七生产与五测试文件，仓外 runner 不进入产品。

一次隔离验证误筛包含 live project，09:59:56.894–10:00:07.684 UTC 被停止，exit130；实际 Voice 请求曝光 UNKNOWN，原日志和停止回执保留，不算通过。后续明确四个 offline project 的 163 项是独立正常退出的结果。当前 Main 的默认 npm test 也已明确限定四个 offline project，test:live 单独保留。最终同版画面、模型采用、陈列判断和自主行为效果仍须实际验收；上述修复没有重新选择 T0/T1/T2，也不由测试数量推出行为收益。

两项材料修复合并后，Main于2026-09-17 10:08:02–10:09:26 UTC通过完整离线2511项（136 contract、1692 unit/component、683 integration）及生产构建，分别66.126/17.691秒；628个src/tests前后不变。实际模型、App与Pixi未在此阶段运行，同宿主原e05场景执行重叠不作为排他性能对照。
