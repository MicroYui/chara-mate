# 记忆工具按实际消费上下文分配结果

2026-09-17，完整结果分配合同已进入 Main；真实比较已闭合但本题未曝光容量差异，最终连续验收仍在进行。用户要求解除未经比较的固定8k行动材料限制；检查发现普通memory.search仍独立固定8192，并且只计Evidence items，工具包装与缺口说明在最后追加。本记录负责修正完整交付合同；不选择新的编码器、召回池或排序算法，不宣称更长记忆必然改善回答。

## 来源与边界

2026-09-17核对官方openai-node 6.49.0的[Responses input tokens](https://github.com/openai/openai-node/blob/v6.49.0/src/resources/responses/input-tokens.ts)及[Realtime协议类型](https://github.com/openai/openai-node/blob/v6.49.0/src/resources/realtime/realtime.ts)。前者提供实际Responses输入计数，不能给Realtime历史音频计数；后者的response.done usage是该次用量，不是会话剩余空间。实际代理原8个条件的count探测均404，继续如实保留unknown与保守估算。

本产品完整输入上限258000来自用户明确要求，与较低Provider输入限额及适用输出预留取交集。估算路径0.9沿用现输入守门，精确结果不会再被估算二次否决。原Tool实际候选池32000暂保持，隔离最终交付变化；这些内部工程参数不冒充协议硬限或独立最优结论。[gpt-realtime-2.1型号页](https://developers.openai.com/api/docs/models/gpt-realtime-2.1)在核对日为128000上下文/32000最大输出；配置名匹配只沿用既有名称规则，不证明Azure自定义部署的底层型号。

## 单一生产合同

- Registry统一schema校验、秘密字段清除和evidenceHash，再把同一完整ToolResult交给消费端计量。试装和最终执行使用相同序列化，不另造第二份供给结果。
- Text计量真实当前指令、工具、原始assistant phase、已完成结果、当前用户及本次真实call_id/output；同响应后续尚未执行的raw calls保持原样，不伪造输出。未提交Tool期间不压缩或写成model阶段。新输入使旧ordinary情境失效并重新计量，实际Tool提交后再按剩余空间刷新ordinary，最终模型步骤仍执行完整请求守门。
- Memory先检验明确的未检索说明能否放入，再运行原候选召回和Selector。最终先尝试全部已选合法证据，装不下时复用完整statement/首来源身份优先、随后补来源的顺序；每次计量包含全部coverage、gaps、incompleteReasons与wrapper。不能装入不表示没有记忆。
- 异步计量不持有SQLite事务。返回前在同步事务内复读原选Revision的当前资格、可见来源及派生依赖；变化后重新分配，不重跑Selector或偷换新Revision。后续试装看到更紧空间时，曾成功的子集也要重新计量。仅最终交付项记一次usage，usage表示供给而非实际采用。
- Stop/退出/语音新generation由原执行owner取消和等待。已提交Tool Item后中断，恢复复用实际保存的输出，不重新执行或重新搜索。工具空间错误走既有Tool失败路径；不保证随后压缩一定成功。
- Voice复用同一requestId及实际function_call_output/response.create对象，只测本次本地提交、当前工具与指令。完整服务端占用明确unknown；不将先前usage相减，不新增音频历史副本，不改变原生truncation。两次网络发送并非原子送达。

不增加表、迁移、用户设置、第二Provider或固定8k fallback。非Tool内部消费者保持各自已有数值分配和同一证据选择顺序；本记录不以它们证明普通工具结果容量。

## 公平比较与当前验证

候选设计冻结`8696b3ec307ee14fc4ee8b902396fac9b5230b76ca28ee3d12550b7bd5a77d2a`；Runtime冻结`1f77269d151b927c7eb42c8ebe03855f40dcf3cedf9a6f55f4b52bdd4611f397`，Memory冻结`bc0e6765c08131fad42bd5b7f750583af2cd92a40f25a4c704bae7dab8c7fd4a`，Voice冻结`e18c6f0612401cb8783fe480dbc339b1e63d5fd7d59a076c3a92d9c706c47353`。Root逐文件审查并合入18个生产/测试文件（含注册接点）；格式、实际回归修正及最终源另行绑定。候选只在仓外保存，生产仅当前路径。

比较先复用已经发生的真实Selector选集，区分最后裁剪与自然重新选择，再用共同闭库前缀的独立副本做普通冷消费。两侧保持同样候选32k、模型和问题；动态contextBudget给Selector的参考变化须单列。若旧开发资料并未暴露8k丢掉必要证据，则报告未暴露，不堆重复文字制造自然收益。保留无压力条件，比较限定条件/反证、实际采用、无关回忆、重复检索、压缩、首正文/结束墙钟和全部已知/未知用量；不能只比较返回条数。

当前Main组合完整离线 **2399/2399**通过（57.388秒）：136 contract、1647 unit/component、616 integration，类型/lint/format通过，两个既有TanStack警告保留。首轮301/305的4个夹具失败、一次类型失败及首次全检查的lint失败均保留；修正未放宽生产资格。相同运行源码冻结`c62d0fab56b8c5c7fafffb67483c413bc83c3fc0e74b5d21bed097e9b54c4d5e`，生产构建通过（15.753秒），受影响Electron24/24通过（77.683秒），真实模型结果另计。

Voice实际Azure长会话、完整SDK多call计数、普通回答质量、最终48独立故事与资源检查仍待执行。局部本地fits、mock计数及类型正确都不能升级为真实tokenizer或长期语音历史保持证明。


## 普通冷消费的实际闭合结果

2026-09-17 04:02:58–04:04:53 UTC，V5保持原一道公开开发题、一个共享闭库前缀、两次普通cold及两条条件replay。共同源仍是上述c62d版本，仅普通memoryTool最终8192与动态分配不同，不混入后来Main的巩固和Text回应修复。此前夹具接收边界缺失等失败保留；V5只在隔离副本按原始request精确恢复三个旧Attempt的6/10/12，未打开或修改来源用户库。实际prefix及两个cold全部完成，三个子PID自然退出。

**本题没有曝光最终8192容量差异。** 两个首个规范ModelRequest及实际HTTP body逐值相等，都已含当前简历Situation/Intent和原始依据。memory.search真实开放但0/2调用；两次回答都识别了跨窗口的简历主线、区分角色辅助查阅与用户事项，并保留中文保存未知、英文暂停。新Chat/新PID不等于语义空白，已有Cognition可直接供给必要材料。两个条件replay均为unexposed_no_actual_completed_search_workset，没有补触发或补样。后置PFC和Formation不能算搜索，也不能把全请求大于8192误报为Memory items突破最终额度。

| 实际观察 | 原固定结果分配 | 动态完整结果分配 |
| --- | ---: | ---: |
| 首段非空正文 | 2.410 s | 2.862 s |
| 普通Run完成 | 4.680 s | 6.173 s |
| 子进程含后置PFC/Formation全部收尾 | 60.105 s | 54.027 s |
| 生成次数 | 4 | 4 |
| 已报告input / output | 47,776 / 2,342 | 47,898 / 2,394 |

这不是性能因果结果：唯一候选变更未执行、仅一次固定顺序，普通请求缓存input为0对14,546。合计14个raw HTTP＝4 metadata（200）、2 input_tokens（404）及8 generation（全部200/completed）。逐条原始SSE终态usage核对后，input95,674、output4,736、cached input33,543；input/output/cached字段24/24已报告，缺失/非终态0。cached包含于input，不重复相加。最大实际generation input23,017，普通回答均14,614，不能证明近258000边界；两个计数端点都返回404，精确计数仍未知。没有价格和账单，不推算金额。

本轮保留完整请求分配作为唯一交付合同：它修复局部items门与真实完整请求脱节，不以本题宣称更高语义质量或更快响应。旧开发selected items3693/6270也未超过8192，没有最后裁剪损失。自然情况下无需再次检索本身可以是正确行为；不能为制造容量收益向Agent追加搜索提示。后续48故事仍按原普通问题检查实际检索、材料供给与最终使用，不改变其标签。

独立复核记录`memory/search-context-budget-v5-independent-review-v1/REPORT.md`，SHA `fea3fc67df1a2dafa2cd2445d512462d37201ee3a1f6b84ff0ec6be884dd4a03`；机器逐请求汇总`AGGREGATE.json`，SHA `3ca0b47ec339f379d558d521ed92e16494ed2ba8b398c83f2e241486a8e7cf39`。闭合结果位于`integration/search-context-budget-execution-v5`。这些是仓外复现标识，原始输出和失败未进入生产路径。

后续Main的完整巩固分配和Text承接集成后，完整离线2474/2474、生产构建及受影响Electron3/3已通过，见[当前验证](../progress/STATUS.md)。该工程结果不补算本轮未曝光的搜索容量或尚未执行的最终语义、原生、Voice验收。
