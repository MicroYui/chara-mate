# 助手回应阶段的持久连续性

日期：2026-09-17。状态：**integration-verified，已进入 Main 并通过受影响桌面回归**。Owner：Root；候选实现：explain_memory。对应 Product §4.4–4.6 及既有跨Run Context Recipe。

## 问题与事实

修复前Provider已返回assistant消息的阶段信息。同Run的原输出与checkpoint保留phase，但下一Run从Chat历史重新组装时仅使用role/content/type，丢失阶段。模型可能先自然接话、随后调用工具；历史必须区分这类中间回应和最终答复，而不是从显示文本猜测。

2026-09-17重新读取[OpenAI官方部署说明](https://developers.openai.com/api/docs/guides/deployment-checklist#set-up-the-assistant-phase-parameter)。官方建议在手工维护历史时保留assistant阶段，以帮助后续模型区分进度和最终答复，减少过早结束。当前锁定SDK为OpenAI JavaScript 6.49.0，ResponseOutputMessage.phase可缺省，也可为commentary、final_answer或null。

这是原消息语义的完整传递要求，不是API长度硬限，也不提供固定续调次数、自动Run结束或质量提升幅度的结论。CharaMate仍按实际工具、待输入与最终结果管理Run，阶段本身不能证明文件已写、记忆已提交或角色活动已完成。

对五个已闭库v21条件的静态读取得到63条Text Runtime stream记录、25条assistant输出，其中24条final_answer、1条commentary。后续74次assistant输入的字符串正文精确匹配已保存的final_answer输出，却没有phase；这是重复使用的出现次数，不是74条独立消息。唯一commentary伴随request_user_input，其后同Run三个请求保留了该阶段。没有观察到仅commentary且无client Tool时错误结束的真实例子。

这些计数不作为HTTP成本、故事分母或质量成功率。原五条件、原错误和未完成的正式条件不改动。仓外静态证据 `assistant-phase-source-observations-v1`：OBSERVATIONS SHA `fd048d98cafe3765fc5355e52763697677f4f90191234279ae5427b555b8adc0`，精确正文配对 SHA `03816f240e6a13fd3f07d716590f40fda2d054c2b26384b6c703e02655afe74a`。

## 唯一实现路径

1. Adapter保留完成响应中有序的原assistant消息，包括原phase、content与annotations。完成数组和Tool参数遵循同一协议正常化接点，不把先前事件的参数拼到不同的最终输出上。
2. 在现有assistant_message Run Item结果保存这组原消息；普通Chat.content继续负责现有文本和可点击引用显示。历史投影从Run领域的窄接口读取，逐条重放原消息。不增加Chat列、迁移、索引、模型调用或产品设置。
3. 可见Message完成和模型步结果在现有本地事务边界一起提交，提交后才发布事件。失败回滚不留下只有一边完成的历史，重复事件不重复投影。
4. 同一响应的多条消息分别保留阶段；缺省/null保持原样。无delta但完整响应实际提供正文时仍建立可见消息；流中断没有完成事件时仍按原错误/取消合同处理。真实refusal正文也属于SDK的消息内容，不凭空变成空回答。
5. 跨Run、重开和未压缩历史沿同一路径；已覆盖部分仍作为developer摘要使用。摘要输入保留原阶段，摘要指令区分中间回应与完成事实，不重放已覆盖消息，不给旧消息或Voice补造phase。

原对象直接重放已是同Run路径的现有行为，复用它比为phase另增Chat状态简单。没有把多个候选列、兼容分支或抽取分类器留在产品中。当前原Run终止策略不在本包改动；自然回应顺序是另一个待比较的提示问题，不能混入本修复后宣称因果收益。

## 验收与边界

已通过的受影响回归：原完成顺序与多消息阶段；缺省/null；无delta完整文本和refusal；现有引用；完成输出的Tool引用正常化；同/跨Run与实际SQLite重开；摘要覆盖；取消和提交失败回滚；提交后事件发布。共享依赖需通过受影响Agent/Chat/Voice集成和完整离线检查、构建；影响的桌面回放在最终同版包验证。

Root 逐项核对 13 个原文件并保存 before 后，将 9 个生产文件及 4 个测试文件合入 Main。受影响四文件 233 项首先通过；首轮完整检查在三处新增测试 lint 停止，第二轮仍有一处同步数组异步迭代 lint。仅修正取消 fixture 的 Error reason 和真实 SDK 收集所在的异步 generator，原两次失败与候选冻结保留；生产逻辑未因此改变。

修正后实际 Main `npm run verify:offline` 2315/2315，通过 typecheck/lint/format、136 contract、1580 unit/component、599 integration（总 54.699 秒；15/175/38 文件）。`npm run build` 15.528 秒通过；实际同版 `playwright test tests/e2e/agent.spec.ts tests/e2e/chats.spec.ts tests/e2e/foundation.spec.ts` 19/19、57.695 秒通过，含普通问答续接、审批、记忆、领地、图片和 Electron 重启。两个原 TanStack lint 警告与构建大 chunk 提示保留。上述 E2E 为受控 Provider 的真实 Electron 流程，并非新的真实模型质量比较。未执行 package、最终安装或完整 Goal 验收。

仓外记录 `integration/assistant-phase-validation-v1`，验证 SHA `b3a9cbc09e51bde482b0be3b9f310064ea7dcf847d8968016ad121952517dd10`，集成源清单 SHA `8f8409ff6a1b6eed0aa6999cf9ce972e72c0c77b1e4c102723d62996d365947d`。原 v21 继续使用原冻结源；后续表达顺序对照须两臂使用相同的已验证阶段底座。

即使上述正确性全部通过，也不单独证明模型更理解用户、记忆形成更快或最终陪伴体验达到成熟度要求；这些仍由正在推进的独立连续情境和实际产品通路验收。
