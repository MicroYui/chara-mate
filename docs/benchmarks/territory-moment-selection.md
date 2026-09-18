# `TERRITORY-MOMENT-SELECTION` 决策记录

## 当前结论与适用版本

2026-09-16 按当前用户要求及产品设计 §10.4、§10.6、§10.10 更新。唯一判断位置仍为处理当前消息的普通 Agent Run：模型结合真实经历判断是否调用 `territory.propose_moment`，不额外启动一个事后 Reviewer。用户已经允许领地惊喜时，同一 Run 等待单物件生成；来源、取消状态、用户最新意图与 World Revision 均有效才原子应用，有空位放置、没有空位进入收藏。失败时按真实结果继续陪伴，不声称已经完成，也不自动重试。

原 2026-09-01 记录的“Run 完成后准备候选、必须用户手动应用、仅做最小验证”已被新的自主陪伴要求取代。该历史选择没有真实对照结果，不能作为当前成熟度证明。这里没有宣称 M1 在质量上击败 M2；保留 M1 是当前产品所需的同一 Run 行为及单一生成路径。历史原文已在仓库外按内容 hash 保存，复现标识见下方。

## 选择与表达

- 模型根据显著经历、对话意图、Persona、相关 Memory 与 Territory Style 决定是否创作、名称、简短故事和视觉表达；不设固定纪念品、拍立得、奖杯或频率模板。
- 惊喜许可与重要时刻主动联系仍独立；已经关闭或拒绝的许可不自动升级。同一轮最多自然询问一个许可。
- 自动路径最多新增一个可编辑物件，不能扩建、移动、删除或重绘已接受内容。用户编辑和大范围创作继续使用原有预览路径。
- 同一宿主 `momentKey` 的重复调用取得原候选及其真实状态；正在生成则等待同一任务，不复制图片请求或物件。用户在领地明确“换一种表达”时，由既有候选编辑入口复用该候选生成新预览；它不是重复 Tool Call 隐含的重试。取消该时刻后不再次自动提出，不推断为关系变化。

## 实际来源与提交边界

模型只提出内容，不提供内部来源 ID。宿主从实际 Run Item 顺序绑定用户消息、附件摘要、Persona Revision，以及产生该 Tool 的当次模型请求真正供应的 Memory 引用：

1. 文本从 Tool 之前最近的完成模型 Item 读取宿主供应集，并匹配该 Item 返回的 callId；后续才执行的同批 `memory.search` 不属于本次供应，历史请求也不能填补缺失记录。
2. Voice 使用对应 response 的 Tool Item 上保存的供应快照。明确的空集有效；没有绑定记录与空集不同，不能猜测最近一次检索。
3. Memory 引用保留 `current/history` 用途。供应集只证明模型有机会读取，不证明它实际使用、理解正确或得到用户认可。
4. 新创作开始、图像返回与预览应用前共用 Memory 的证据有效性检查，包括派生记忆的父事实与来源。历史用途只允许确实曾成立的历史 Revision；corrected/unresolved 只能带标注回看，不能继续生成真实经历。改变请求用途不能把已失效的 current 父依赖变成有效历史。
5. 图像生成期间用户新消息接管同一 Run，或原消息/附件删除、Persona 变化、许可撤销、取消、World 前进，旧创作不能自动落地。用户消息顺序使用实际 Run receipt，不能因客户端时间较早而漏掉改口。
6. 生成和资产 I/O 在数据库事务外。最后一次同步检查与候选/World 原子提交之间不再等待外部操作；失败按已有资产 rollback 清理。已接受物件保留独立历史，原 Chat 删除后来源入口不可用，不额外保留原附件。

本次直接复核的源码是 2026-09-16 的 AgentRuntime、RunRepository、TerritoryMomentService、TerritoryWorldCandidateService、TerritoryWorldRepository 以及 Memory 引用资格路径。沿用产品 §10.8 已复核的 SQLite 同步事务契约，没有新增模型阈值、检索算法、后台 Reviewer、表或迁移。

## 验收状态与证据

本轮来源一致性实现已随共同 v21 集成 Main；该次 v21 完整离线验证通过，真实组合语义与最终同版桌面/图像验收仍待完成。以下原阶段冻结 manifest 为 `c11f59e08c00d7cdedb1961ea0bf8666ffa70dc719e93c9e1abd4e9aeb702511`。

- 实际 SQLite Run 供应归因 6/6：涵盖尚未重新供应的搜索、压缩后的空供应集、后续追加、不完整或错误 callId、Voice Tool 自身快照和用户消息 receipt。
- 真实 Agent/Memory.search 多步骤集成选择运行 1/1：第一次模型没有读到刚执行的搜索，下一次请求才记录对应引用。该测试文件共有 67 例，本项不表示全文件重跑。
- 真实 SQLite、Territory Candidate、AssetStore 与 World 的生成集成 25/25：包含生成前失效、生成中修改/删除、预览后纠正、历史用途继续有效、当前用途改口、同 Run 较早客户端时间的新消息使旧生成失败，以及既有生成、取消、stale、回收路径。图像 Provider 受控，证明状态和资产时序，不证明图像审美。
- 初轮供应测试 28/33，5 例因新增测试误写已有 Run.source 枚举而失败，修正后通过；记录原失败，不把它当成产品质量差异。静态检查已对隔离改动运行。

2026-09-16 后续组合已验证 Memory 派生父源变化与 Voice 实际 response。15 个派生依赖用例经真实 SQLite 和 PNG AssetStore 检查生成前/中/应用前纠错、删除、回收、真历史继续有效与原文释放；5 个 Voice 用例经真实 VoiceService/Run/Tool 验证原响应、已接收检索的新响应、迟到原响应及缺失/不匹配 metadata。图像适配器和 Realtime 事件受控，不称真实网络/图像质量验证。首次未合 Voice adapter 的 5 个失败及旧历史夹具失败保留，具体边界见 [Memory 修订合同](MEMORY-REVISION-LIFECYCLE.md)。

Voice 的 requestId 放在官方 response.metadata，仅匹配实际 response.created 回传的标识；已发送请求保存当时供应快照，之后的搜索不回填旧响应。依据为 2026-09-16 查阅的 [Realtime response.create](https://developers.openai.com/api/reference/resources/realtime/client-events#response.create)、[response.created](https://developers.openai.com/api/reference/resources/realtime/server-events#response.created)，以及本地官方 OpenAI SDK 6.49.0 的对应 metadata 类型。响应开始证明请求已被接收，不证明理解或用户认可；缺失回传继续正常语音，来源为空，不猜测。适配器 source freeze 为 `b7739c5544baf980e34b7f7a848fa3985328e7973c54678f5f3bbbc1dd352ce6`。

仍须在同一最终源码上完成：Main 与桌宠的用户接管 E2E；独立连续陪伴场景中的真实 gpt-6-astra 选择、少打扰与来源忠实性；最终选定版本的完整回归、打包与桌面验收；v21 晋级时的 Main 已有完整离线通过记录，见 [STATUS](../progress/STATUS.md)。此前图像管线的真实生成记录不能替代这些组合验收，也不能单凭测试数宣布本 Decision 达到商业质量。

## 证据保留与单一路径

历史记录 SHA-256：c573cb88da5ad1569149b03de1423cf513fab49e6553136b21ae02d0c5fef5f8。完整日志和冻结候选放在仓库外，最终本文件只保留紧凑结果、限制与复现标识。生产不包含 M0/M2 模式、事后 Reviewer、Arm prompt、实验 runner 或另一套资产生成器；当前已合入同一 Run 判断及既有 Candidate/Asset/World 执行路径；最终组合交付继续核对这一单路径边界。
