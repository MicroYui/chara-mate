# `TERRITORY-MOMENT-SELECTION` 决策记录

## 结论

选择唯一生产路径 `M1-IN-RUN`：处理当前消息的普通 Chat Agent 在同一 Run 内，只有在独立的“偶尔为重要时刻准备领地惊喜”许可已开启、当前经历确实显著且有真实消息或附件证据时，才调用一次 `territory.propose_moment`。不调用就是 `no_candidate`，不额外运行 Review。

Run 完成后由宿主绑定真实 Run、用户消息、附件摘要、Memory Revision 与 Persona Revision，再通过既有 Territory Candidate/Preview/Apply 路径准备一个可取消候选。模型不提交任何内部来源 ID；用户应用前不改变 World。

## 为什么选择同一 Run

2026-09-01 用户明确要求这个增量不做大量实验，直接按下一步路线推进。研究设计已经规定：只有 `M2-POST-RUN-REVIEW` 相对 M1 明确改善重要时刻召回且不增加误生成或越界时才值得保留，质量相当选择 M1。在没有获准进行真实 Provider/Image Pilot 的情况下，M1 是满足当前产品方向的最小实现：

- 直接复用模型已经读取的消息、真实图片像素或文档正文、相关 Memory 与 Persona，不为同一时刻增加第二次判断请求；
- `territory.propose_moment` 只记录开放式名称、经历描述和视觉意图，候选生成仍复用现有单一 Image/Compiler/Preview 路径；
- 缺少许可、普通对话或证据不足时没有 Tool Call，因此不会建立隐藏的后台 review 队列；
- 宿主只在 Run `completed` 后接纳成功提议，失败、取消、中断和恢复不会绕过对话结果边界。

## 生产边界

- 领地惊喜许可与“重要时刻主动联系我”是两个独立开关；同一轮最多自然询问一个许可。
- 每个宿主计算的 `momentKey` 最多对应一个候选。重复 Tool Call、重启恢复和“换一种表达”沿用同一候选与来源，不创建多个开放候选；用户“这次不要”后同一时刻不再出现。
- 候选最多新增一个普通物件或附件预览。它不能自动扩建、移动或删除既有内容，也不能直接应用 World Revision。
- 表达形态由当前经历、Persona 与 Territory Style 自主决定，不固定拍立得、奖杯、纪念品、稀有度或任何视觉模板。
- 图片引用只在生成时作为瞬时输入使用；持久来源只保存附件 ID、展示名、媒体类型与 SHA-256，不复制手机 URI、PC 路径、Relay URL 或原始字节。文档只在已实际读取正文时进入判断；PDF 和其他未解析格式只作为附件事实存在。
- 原 Chat 后续被删除时，已经生成并应用的 Territory 资产仍属于 World；来源入口变为不可打开，不保留一份隐蔽的原附件副本。

## 最小验证

本 Decision 不运行真实 Provider Pilot，也不把确定性测试解释为候选质量或真实用户满意度。生产合入前只要求回归覆盖：

1. 许可关闭时提议被拒绝；许可开启时，成功 Tool Item 只在 Run 完成后形成候选。
2. 相同消息与附件摘要产生稳定 `momentKey`；重复观察、崩溃恢复、“换一种表达”和拒绝后重启均不复制候选。
3. 来源快照准确绑定 Run、Chat、用户消息、附件摘要、Memory Revision 和 Persona Revision，不含路径、URL 或附件字节。
4. 准备、失败、取消、stale 和桌宠提示不修改 World；只有“放进领地”产生一个原子 Revision。
5. 图片使用经摘要校验的真实像素；UTF-8 文本/Markdown 使用实际正文；未解析文件不声称已理解。
6. 候选 UI 提供“换一种表达 / 放进领地 / 这次不要”，桌宠只显示待查看提示并打开同一 Territory 候选。

## 未能声称

本 Decision 不能证明 M1 在所有用户与内容类型上达到理想 precision/recall，也不能证明用户一定喜欢某次候选。它只在当前已确认的稀疏自主提案方向、用户选择的复杂度和未授权真实 Pilot 的边界下，给出一个请求更少、状态更少、可恢复的生产起点。真实使用若持续漏掉重要经历，应先收集经同意的实际反馈，再判断是否值得重开 M2 比较。

## 删除证明

生产不包含 `M0/M2` 运行时模式、post-run reviewer、Arm prompt、实验 runner、候选开关、第二套生成器或固定物件模板。唯一判断位置是同一 Chat Run 的 `territory.propose_moment`；唯一资产生成与应用路径仍是现有 Territory Candidate service。
