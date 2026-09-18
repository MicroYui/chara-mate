# CHAT-VISUAL-READ：普通对话复用只读图片输入

2026-09-16。集成负责人：root。状态：实现与既有集成回归扩展已进入 Main，受影响SQLite/Runtime回归、完整离线检查及构建通过；正式吞吐使用原冻结，不受该修订影响。

## 问题与产品选择

普通 Chat 已允许幂等只读工具，也能直接理解用户附加的图片。当前 `computer.screenshot` 可在 Chat 取得截图 artifact，但 `AgentRuntime` 在工具供给和执行处均把 `image.inspect` 限制为 Agent。结果是角色知道截图存在，却没有通过同一媒体路径看到像素。要求用户切换执行模式才能解释一张已取得的图片，与本地 AI 陪伴和 Chat 只读能力不一致。

依照产品 §4.4 工具与图片合同，Text Chat 和 Agent 在模型支持视觉、环境有图片解析器且所选 Run 工具范围允许时，共同使用现有 `image.inspect`。普通图片仍按需读取；不自动给每条对话附加桌面，不增加分类器、识别服务或新 Tool。外部应用/文件操作继续由原执行模式和审批控制。自主角色 Run 的显式工具范围没有扩大。

这是现有只读能力的产品一致性修正，没有选择新的检索算法或数值阈值，不设置候选开关。它本身不能解决尚未进入已提交情境的最新桌面正文供给；该问题需沿实际来源和前台取证另行验证。

## 来源核对

2026-09-16 直接读取本机实际安装的 `openai@6.49.0`，`src/resources/responses/responses.ts` 的 `ResponseInputImage` 与工具类型：`input_image` 接受实际图片 URL/base64，`defer_loading` 表示工具供给方式。协议类型不定义 CharaMate 的 Chat/Agent 权限，也不要求图片读取仅限 Agent。[对应版本源码](https://github.com/openai/openai-node/blob/v6.49.0/src/resources/responses/responses.ts)。

当前源码行为分别核对 `approvalPolicy.toolAllowedInExecution`、`registerComputerTools`、`AgentRuntime.#modelRequest/#handleImageInspectCall`、`ElectronImageInputProvider` 与实际 `tests/integration/agentRuntime.test.ts`。图片继续由 Main 使用锁定 Electron 43.2.0 解码，Provider 多模态 message 使用同一路径；没有改变缩放、模型选择或图像 Token 假设。完整请求继续执行 [COMPANION-CONTEXT-BUDGET](COMPANION-CONTEXT-BUDGET.md) 的实际输入检查，未知能力不能因 Chat 放宽而自动绕过。

## 改动和验收

仅移除图片 Schema 供给、已加载工具集合和执行入口的 Chat 排除条件。读取失败、视觉不支持、显式工具范围、checkpoint 中的图片引用、压缩后的实际像素重新物化、Provider 请求预算均复用原实现。

把原实际 SQLite/Runtime 图片读取与压缩集成用例扩展为 Chat/Agent 两种模式，核对下一请求实际包含图片内容且压缩后仍保留；增加 Chat 视觉不支持和显式范围排除，核对模型不能通过直接发出调用越过这两个边界。没有新增数据库、共享 Schema、依赖、后台任务或 UI 设置。

2026-09-16，该 Runtime 集成文件及受影响静态检查进入全离线2149/2149；实际Electron的图片Composer与Agent读取既有流程通过。最终真实像素/桌面场景和打包版本另计；此文件不把受控 Provider 的多模态结构断言当作模型理解图片的证据。
