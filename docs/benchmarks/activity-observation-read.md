# 已采集文字的按需读取

2026-09-17，原 Final48 it01 已自然关闭后定位的产品修复，尚未完成真实复测。它补齐已在范围内的细粒度感知，不启动新的研究比较。

原固定源 e05dd7b0 的 it01 中，新工作坊时间在 PFC L13（14:44:32.820 UTC）已供给，原始 Activity event e3cb431d-5547-4e39-add8-0f44a47e74b3 的观察时间为 02:03:25，接收时间为 02:03:26.015。普通 Run 6701d030-5d6c-47b2-adf4-bd44b7400af3 的 model39/41/45 仍使用同一旧 Cognition 投影。image.inspect 返回 IMAGE.INPUT_UNAVAILABLE，因为该场景只有 AX 文本；最终未说出四点半。原 c300 失败保留，后续 PFC 改正不回填为那次对话成功。

问题不是模型请求容量不足：普通请求约 18k input，材料已经存在。原 Activity.search 只供 Episode/Digest 聚合；image.inspect 只供像素；普通对话没有直接读取保留文字的能力。让所有对话等待 PFC 或无选择地注入积压原文都会扩大改动，并使当前对话依赖后台耗时。

选择在现有 ActivityService/Repository 和 ToolRegistry 增加单一 activity.observe。查询语义是最新匹配的保留观察，定位条件只作用于对象位置元数据；随后读取和分页固定实际 eventId。它不替代 PFC 决策、不推断用户理解或偏好，不读其它领域的表，不新建缓存、表、后台任务、模式或设置。无法读取、新状态不可用、暂停和取消按实际情况表达。已保存文本读完与采集时页面是否完整分开表示。

完整 ToolResult 沿现有 Text/Voice measureResult 量测，不另设 8k/32k 文字上限。局部源读取沿现有 16 MiB 量级，以实际来源和完整请求空间确定正文窗口；窗口不足时提供同一来源的续读位置，不借分页变成新来源或暗中跳过文字。“最新一项”是本次请求的排序语义，不是检索 topK 实验结果；16 MiB 是既有本地资源约束，不能称为协议硬限制或 SOTA。

核对的当前源：根锁定 better-sqlite3 13.0.1、TypeBox 0.34.52、OpenAI SDK 6.49.0；Main Activity 保留原 details_json、created_at、started_at/id 索引，ToolExecutionContext.measureResult 已由普通 Runtime 和 Voice 提供。SQLite 官方 [SELECT](https://www.sqlite.org/lang_select.html) 与 [标量函数](https://www.sqlite.org/lang_corefunc.html) 于 2026-09-17 查阅；实现须明确排序和字符偏移单位，不能把 SQL 字符数、UTF-8 字节和 JavaScript UTF-16 长度混用。

2026-09-17 同时核对官方 [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs/) 的根对象要求与当前 supportsStrictToolSchema：严格输出不接受根 anyOf。新 Tool 采用与当前 image.inspect 相同的根 object、恰一字段结构，不为尚未发布的接口保留两种输入格式。包含可选定位字段的参数沿现有非严格 Tool 路径，AJV 仍验证完整输入；实际 Provider 接收情况随针对复测记录。

验收沿同一个实际失败：真实 SQLite 保存旧/新页面；新不可用不回退；明确 past/paused/actor/局部覆盖；完整请求量测和含 emoji 的固定来源续页；等待期间清理或取消不返回失效正文。普通非视觉 Chat 的实际 Run 应能直接读取该能力并把真实结果送入下一模型请求。真实 gpt-6-astra 定向复测与最终安装版桌面仍待执行，机械检查不能预先替代语义结果。

没有候选算法、替代 Provider、兼容数据库或待保留的失败 Arm；原始失败及开发修复回执位于隔离 activity-text-observation-v1 包，最终只合入一条产品路径。
