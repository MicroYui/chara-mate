# 语音工具完成事件的重复接收

2026-09-16；Root 集成所有，关联 Product §8.3–8.5。已合隔离集成源并通过受影响验证，最终同版交付待完成；不宣称本次进行了真实 Realtime 验收。

## 来源与问题

当天读取 OpenAI [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations/)：应用负责执行工具，function_call_output 通过 call_id 关联原调用。实际锁定 openai JavaScript SDK 6.49.0 的 `src/resources/realtime/realtime.ts` 第4772–4813行区分 call_id、event_id、item_id 与 response_id；arguments.done 也可能随 interrupted/incomplete/cancelled response 出现。该来源没有承诺应用接入只收到一次，所以不能把可靠有序媒体通道当作业务幂等证明。

当前源码 VoiceService 对每个 tool.call 独立开始执行。执行中重复到达会生成另一条失败结果，执行结束后重复则再次调用工具；审批中重复也会发出多余结果。这会影响非幂等动作及新的记忆定向恢复。Text Agent 对已持久化 Tool 结果的恢复已复用原 Item，不改该路径。

## 产品选择和边界

Main 在有效 Run/generation 检查后，以 Run ID 和协议 call_id 接受一次调用；接入键属于已有 ActiveVoice 生命周期，进入审批或执行之前登记。重复事件不产生第二个执行、审批、function output 或 response.create。不同真实调用仍可执行；已打断、终结或不能映射到当前 Turn 的事件先拒绝。只有 Main 拥有这一实现，不在 Renderer 再加一套。

不增加表、持久队列、重试次数、设置或外部幂等协议。Voice 断线原本就打断当前 Run，冷重连清理协议映射并从 Chat 历史开始新输入；应用进程启动不会恢复旧的 Realtime Transport 或重放旧动作。Run/Item 仍保存唯一实际结果。该修复不承诺第三方服务的 exactly-once，也不对已发生副作用作回滚。

验收使用真实本地数据库、临时文件写入、现有 Tool Registry/审批/Voice Run，通过规范化协议事件覆盖执行中与完成后重复、失败后重复/真正新调用、审批拒绝、plan 原始参数形态、旧 generation 与新 Turn。同版全域结果在实施后补入。原始证据与源码 SHA 在仓外 `integration/voice-tool-replay-20260916`，协议冻结保存本地 SDK 哈希。

## 实际结果

旧源码在新增5项检查中4项失败、1项generation/跨Run控制通过；原失败保留。改动后5项全部通过，包含真实临时文件效果、数据库Item及原审批流程。完整Voice/Territory来源和WebRTC Driver受影响3文件共51项通过，完整类型检查与两文件ESLint通过。生产只改Main VoiceService，测试沿用既有Voice集成fixture；Renderer、shared、DDL未变。

source/fixture冻结及red/green、51项日志和静态结果保存在仓外对应目录的SELECTION.json。此次确定性协议验收不产生新的Provider请求，不替代实际音频质量、原生媒体或最终包验收。
