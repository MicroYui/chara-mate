# 等待 Run 与用户续接的执行权

2026-09-16。状态：Root 完整审阅并按精确 before/after 合入 Main，确定性依赖回归、构建及受影响桌面问答/审批/领地流程已通过；自然连续语义验收仍待最终版本。对应 Product §1.6，集成 owner：root。原正式 v21 普通追问后 needs_input 及其后续未行动结果完整保留；本包不改变历史分母，也不把所有自主生活停顿归为同一个原因。

普通 Chat 的旧问题或审批会保留同一 Run，供用户稍后回答、追加文字、批准、拒绝或取消。但等待本身不再被投影为全局持续执行占用。实现只把普通 queued/running Run 与实际 Voice 作为原保守执行互斥事实；已绑定角色 Run 的 waiting 集合仍用于恢复、防重复派发和真实取消。

解除错误忙碌事实后，用户续接可能与角色的在途 Tool 相遇，因此四个入口一起复用现有 beforeUserInteraction → yieldToUser → yieldCharacterRun。它们先确认请求有效，写真实用户交互 control，等待其它角色 Run 的协作 Tool 真正退出，再重查原 Run/问题/审批/checkpoint 并继续。continuingRunId 只防精确目标被自己取消；不刷新或豁免旧来源权限。PFC 会因用户交互 abort，旧 action readset 仍失效，已经绑定的 Agent Run 不使用该 PFC AbortSignal。

正在运行的模型可以在让出期间正常推进，因此 running steer 不要求旧 checkpoint 字节永久不变。原等待边界则必须仍是同一问题/审批。已有 approval-first 顺序保留：刚批准而尚未执行的旧 Tool 遇到紧接的新文字，仍应重新考虑并跳过旧动作；不把正常 waiting→running 当成换了目标。若目标实际终结或等待对象被改写，诚实拒绝旧提交，Renderer 原逻辑保留草稿，不自动新建 Run。

结构化用户答案也会撤去角色此前的安静结束许可，与已有文字 steering 一致。安静自主活动仍可正常无文字结束；接到真实用户答案后的空响应不能借旧许可伪称已回答。

本包六份生产文件，一条内部可选参数传递；外部 JSON、表、状态、工具批准规则、调度器及 Provider 不变。未添加超时、并行数、自动重试或第二执行路径。Voice 保留自己的真实 owner。正常角色领地 Run 固定 Chat 与内部免审批工具；额外绑定 Agent approval 回归是内部能力机制，不宣称当前 own-life UI 会出现审批。

2026-09-16 实际验证：本包进入 Main 后完整离线2149/2149，含真实SQLite/领地动作、旧Agent/Voice/Automation依赖。新增queued投影的测试曾误用仅接受running的run.started事件，随后又为同一角色制造多个活动attempt；已用明确的只读queued投影与同一实际工作修正夹具，不改变生产行为。所有原审批抢占断言保留。

桌面实际问答卡片/Composer两入口初跑失败，Provider夹具误把UserInputResolution的answered/cancelled当普通ToolResult失败；按真实合同修正后两例通过。同次实际审批抢占、自动生活、领地动作、协作、记忆复用及Renderer恢复通过。全离线与桌面属于确定性本地通路检查，模型均为自有loopback夹具；不当作模型质量。正式同版自然案例仍需观察真实追问未答→真实新来源或到期→自主选择与实际领地结果→用户续接的全链。

普通前台当前屏幕供给、分配前 start/inline 的 shutdown 所有权是分别审查的后续项，本包不宣称解决。这两项各自保留独立失败与修复记录；实验文件留仓外，生产仅保留这条执行路径及相应回归。

集成记录：`integration/main-run-attention-delivery/DELIVERY.json` SHA `bfdcfa70720aaecf0bf4e1f3a057222c35b3c6d2cd565796c0769c6a3b924530`。6份生产、4份测试；候选 patch SHA `1b11b0b1f81808fc9481ae4ac578de969a4856701bcdaa93cac949bd3649079e`。未改正式 v21 冻结，全离线与桌面增量分母见 `integration/main-first-pair-window/VERIFICATION.json`，不改写原冻结状态。


## 2026-09-17：原 im01 暴露的同 Chat 环境续接缺口

当前状态：已按精确 before/after 合入 Main，受影响域与合同回归通过，最终同版真实复测待执行。原48冻结不变，im01-c5 为失败。原 PFC 已从实际 AX 内容得出条件性的 700 核对，但向原 Chat 无条件分配新 Turn，遭 `CHAT.TURN_ACTIVE`；旧 Run 留在 needs_input。原 image.inspect 不可用是前序独立事实，不能遮盖新文本已到达后的执行失败。当前 Main `cognitionRuntime.ts`、`agentRuntime.ts`、`chatService.ts`、`runRepository.ts` 于 2026-09-17 逐段核查；源码哈希与原 HTTP 时点见仓外 `integration/cognition-waiting-run-dispatch-review-v1.md`，SHA `4adedb8a816bfdc1eeb98d5b97412ba0e878e646b27073fd859f05c80d6cc819`。这是本产品生命周期缺口，不是模型协议硬限制，也不引入新数值门槛。

选择沿原 Run 接收来源明确、与原请求和当前问题匹配的环境材料，并诚实结束本次索取材料的等待；保留同 Chat 一条活动 Turn。新接收只记 context_supplied，不抢旧 Run 执行 owner或计作已交付。原问题/完整情境/checkpoint/接收 receipt 原子提交，用户输入与 Stop 优先，重开不重复副作用。单纯移除同 Chat 占用、另建 Chat、将环境内容冒充用户 steer/answered/cancelled 均不符合当前产品行为。未匹配问题或审批保持等待并 defer。实际修复、受影响回归与原 s08/s09 定向真实结果将在此补记，当前不宣称通过。


修复已于 11:55:51Z 合入 Main。材料续接先验证原实际用户请求、active explicit_user Intent、同一等待问题及新的当前观察；各异步边界复核实际 Run/Item/checkpoint、来源与用户控制。沿原 Provider/模型/工具完成整个请求计量，接受点原子写 context_available、checkpoint 与 Cognition context_supplied 回执；不新开 Turn、不新增用户消息、不夺取原 Run owner。恢复只继续一次；接收和回答完成分别记录。普通问答 UI 诚实显示“相关环境信息已补充，继续核对”。

回归实际再发现两项边界缺口：省略 Chat 仍可能为同一待处理 Intent 新开会话；角色 Run 接受真实用户 steering 后，会被自己的 activeCharacterRunId 阻塞。已按真实用户来源 Run 与精确待续对象修复。完整 Service 快照还暴露 lifecycle schema 缺少 contextContinuation 投影，已修正。原 RED 与原因码断言/夹具错误分开保存，不以修改断言消除产品失败。

候选受影响 Agent/Cognition/Chat/Voice/Automation 共 785/785，28 文件，11:49:33.081–48.114Z（15.032秒）。Renderer 12/12、合同 8/8；最后仅测试 lint 修改后新增 8 项再跑通过，最终 tsc、31 文件 lint 通过。一次误筛为 68 skipped、0 executed 的结果不算通过。完整最终 Main offline/build、实际 Electron 流程以及原 im01 自然续接仍待后续执行；离线注入模型不能证明 PFC 的自然选择。

复现身份：仓外 `integration/cognition-waiting-input-continuation-v1`，31文件补丁 SHA `d99baf491f26fc4e5af889abf575c215316b3a510485f60f36fa20194b064286`，冻结 SHA `279c7c57ec4c78e21ad6fbad7b859d825277dbd8869c8093e7d41c1a76018b62`，精确集成回执 SHA `d19663edbea465651b00ed04de95dbc325eb36b4fdc5a3f4c2852393e2a371eb`。仅此一条生产实现；候选与原始失败留仓外，不增加旧库兼容、表、自动重试或任意预算阈值。

整合后实际 Main 验证：11:57:53–11:59:02Z，完整 offline 2553/2553（54.027秒）与生产 build（15.281秒）通过，628个src/tests前后相同，两PID退出。记录 `integration/waiting-and-progress-main-integration-v1`。原场景自然复测与最终桌面仍待执行，F候选不包含在此组合。
