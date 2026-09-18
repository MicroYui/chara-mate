# 完整行动依据与完整请求的预算裁决

2026-09-17。Decision ID：COGNITION-DYNAMIC-ACTION-BUDGET。已选路径：完整读取、两项 SQL 优化及失败反馈续接。选用 16 MiB 作为初始原始字节护栏；最终候选 2285 项离线验证、构建与受影响 Electron 20/20 均已通过。已合入 Main，实际项目目录的同版 2285 项全离线与生产构建也通过；整体本地成熟度 Goal 尚未完成。

## 产品选择

一份正常领地观察约 13.5 KB JSON，曾超过沿用的 8192 保守 Token 估算额度：PFC 已决定行动，执行者却读不到依据。8k 没有独立选型支持；32k 也只是历史实验坐标。进一步检查发现，取消固定额度以后，读取阶段仍把剩余 Token 估计当字节空间，可能在完整请求获得精确计数机会前拒绝材料。

选中路径是：**PFC 选择必要语义依赖 → 宿主完整读取这一集合 → 编译完整实际请求 → Provider 计数与输入裁决 → 原子分配 Run**。普通对话的可选背景仍按当前请求可用空间选择；自主行动的必要条件、反证、目标与来源不共用这项可选额度。生产没有 8k/32k 模式、候选切换、精确引文替代路径或内部调参 UI。

增加容量并不授权无关材料进入请求。PFC 按当前行动声明准确来源和用途，宿主核验所选 ID、revision、范围和用途；不会把全库正文装入上下文。完整必要集合装不下时明确失败，不能删掉仍必要的条件后沿用原行动声明，也不能以重复观察掩盖失败。

## 三类边界

| 边界 | 含义 |
| --- | --- |
| 完整输入 ≤258000 Token | 用户硬约束，包含实际 instructions、工具声明、当前输入、多模态、材料与历史。较低 Provider 输入上限继续生效；Provider 总窗口须扣除实际输出预留。用户限制不是整个 Run 累计用量，也不是输入加输出合计 258k。 |
| 本地完整读取保护 | 与 Token 分开，按选中 Cog/Memory 原始值总字节设护栏，同时记录行数与实际读取成本；不另设行数或执行时间上限。本次选择 16 MiB 作为初始护栏。该值不是 RSS 上限、SQL 执行时限、模型额度或所有设备的性能保证。 |
| 无精确计数时的估计 | 现有 UTF-8/framing/图像估计与 0.9 余量属于工程启发式，不能冒称 tokenizer 或官方限制。支持精确计数时，保守估计不能提前剥夺完整请求实际计数的机会。 |

2026-09-17 核对本地官方 OpenAI JavaScript SDK **6.49.0** 的 Responses/input-tokens 实现，以及官方 [input token count](https://platform.openai.com/docs/api-reference/responses/input-tokens) 文档。测量和生成共用同一请求体构造路径；只缓存已完成且相同 token-bearing wire 的计数。工具、结构化输出、图像或指令改变时不能复用旧值。适配器仅将计数端点的 404/405/501 记为本 Provider 实例不支持该端点，这是本产品的能力判定，不是这些状态码对所有部署的官方语义保证；400/401/503、取消和其它错误不会被伪装成“不支持”。此处精确计数只裁决相应 Responses 请求；Voice 的 Realtime startup/replay 仍显式使用保守估算，不能由文本摘要的精确计数授权。

当前真实代理 count 返回 **404**，因此仍无法声称获得该部署近 258k 输入的精确服务端计数保证。本轮真实引用修复请求使用 gpt-6-astra，实际输入 55206、输出 1637；这不是近 258k 证明。资源实验在进程内注入计数响应 100，实际网络调用为 0；它仅验证官方 SDK 序列化和计数缓存接线，不能授权同样材料发给真实模型。

## 完整性、恢复与所有权

行动材料在同一同步 SQLite 读取事务内完成身份/资格、成本和正文投影；Memory 回调使用同一连接的嵌套事务。来源已经撤销、历史用途错误、必要片段缺失和资源不足分别报告，不返回“未截断”却缺少引文的集合。事务不跨网络计数等待，也不缓存跨事务的资格许可。

必要材料优先于可替换的旧 Chat 历史；真实摘要服务可整理旧历史，原 UI 消息和持久记录仍保留。准备期间用户补充会进入真正生成的请求；源状态变化在分配前重新校验。准备任务在第一次 await 前登记，Stop/退出先取消，再等待实际准备和执行任务结束，随后关闭依赖；不会把“没有 Run ID”误认为没有需要等待的工作。

同步 SQLite/JSON 只能在前后响应取消，`async` 包装不使它可中断。因此本地原始字节护栏与实际界面响应需要分别检查。这里没有为统计结果新增 Worker、缓存、数据库索引或第二种读取方式。[Node 事件循环说明](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop)与 [better-sqlite3 v13.0.1 事务 API](https://github.com/WiseLibs/better-sqlite3/blob/v13.0.1/docs/api.md)用于确认这一生命周期边界。

读取失败不创建残缺 Run，也不生成新的世界事件或立即重试循环。错误落在原 Attempt，原未完成目标和到期条件保留；相同失败上下文受到原有抑制，相关新输入或另一自然到期事项可以恢复考虑。最新失败的生命周期视图及同次 Recall 续接已完成机械验证：实际 Service 的 Recall 二次读取携带原失败生命周期反馈，二次裁剪保留当前用户，并将连续游标限制在源 snapshot 已证明的连续边界内，不跳过未读资料。canonical 持久化 Attempt 保持原合同；生命周期投影不携入行动授权所需的完整 decision，执行仍读取实际 canonical Attempt，不以 TypeScript 结构类型宣称绝对隔离。这些回归证明反馈进入该实际服务输入链，不代表自然模型一定正确理解或恢复行动。

## 实际资源比较与代价

宿主为 Apple M4 Pro / Mac16,7 / **24 GiB**；Node **24.18.0**、Electron **43.2.0**、better-sqlite3 **13.0.1**、SQLite **3.53.3**。各进程使用对应真实 native ABI。下列重复读不是独立用户或语义任务；资源观察不能代替自然任务成功率。

1. **完整读取原对照**：540 进程条件、3240 次过程内观测全部闭合。原 108 条件中 12 完整、92 旧额度拒绝、4 返回不完整却未标截断；新 432 条件中 192 完整、240 明确资源拒绝、0 不完整。新路径四种读取额度仅在仓外比较，原失败和执行中断后的续跑间隔保留。较小护栏拒绝部分 16 MiB 护栏能完整读取的集合；这只证明本地可读性，不证明真实模型可接受全部集合。
2. **Claim 查询优化**：同库、同请求、唯一查询改变，96 进程／576 次观察，48 对进程／288 组同序号内容、用途、成本与错误等价；其中 48 进程完整读取、48 进程明确拒绝。另有 6 份近上限 fixture 的 12 进程／72 次补充观察全部完整读取，单列且不并入 96／576。选择 CTE 一次展开所选情境的 Claims，再恢复原 ID 次序和重复语义。Electron 多 Claim 1 MiB 约 10.60→5.22 ms，16 MiB 拒绝约 761→8.54 ms；未增加永久索引或状态。
3. **派生 Memory 查询优化**：24 进程／144 次观察，12 对进程、72 组同序号内容和 wire 均相同；其中 16 进程完整读取、8 进程保持资源拒绝。只将子片段的逐项父引用覆盖改为四元组集合差，保留所有其它资格。Electron 混合 1 MiB 12.79→9.93 ms，超限组 638.29→68.06 ms，近 15 MiB 完整组 788.97→166.32 ms；Node 近组 790.11→167.54 ms。同一 reader 进程下一次事件循环机会的等待时间，近组 Electron 831.30→208.02 ms、Node 842.90→218.91 ms；该指标还包含 framing、SDK 序列化和模拟计数/cache。这里 Electron 使用 RUN_AS_NODE，没有 Renderer，不能把它称为实际 GUI 响应时间。
4. **稀疏后验补充**：2 个父记录有 2048 个片段，实际子记录只引用 2 个片段；8 进程／48 次完整读、4 对／24 组结果等价。后五次合并中位数 Node 3.902→5.274 ms、Electron 3.970→5.973 ms；增加约 1–2 ms 与数 MiB RSS。该额外分母单列，不并入原 24 进程，也不隐去回归。

v3/v4b 的后续读取指标先求每个 PID 后五次中位，再对相应 PID 的这些中位值求组中位；稀疏补充使用后五次合并中位。它们不是独立任务样本。

选用集合差的依据是完整性不变、大材料约 620 ms 的实际读取收益，以及稀疏小材料较小的绝对代价。不是所有查询都变快。集合比较采用 `(source_id, span_start, span_end, quote)`；字段非空、BINARY/STRICT，保留大小写、Unicode 组合形式、空白、身份和区间区别。派生父状态、owner/persona、历史更正、有效期和每条链接的实际支持条件不变。[SQLite Compound SELECT](https://sqlite.org/lang_select.html#compound_select_statements) 与 [EQP compound queries](https://sqlite.org/eqp.html#compound_queries)（2026-09-17 核对）说明集合语义及可能的临时 B-tree；没有把诊断查询计划字符串变成产品接口。

内存代价明确保留：近组 Node 的组级 max RSS 约 443.1→619.6 MiB，单进程最高 **686.2 MiB**；Electron 约 582.8→583.4 MiB。RSS 是含进程初始化、六次读取及验证的生命周期高水位，heap 为采样值，不是单次 SQL 净分配或瞬时峰值。原始 16 MiB 保护不能保证进程只增加 16 MiB，更不代表与 4B、Voice 同时运行的总峰值已验证。

真实 GUI 补充独立于上述 reader 分母：同一实际 Electron App／Main／Renderer 在一个闭库副本上串行完成 2 次完整读取，每次 15,734,387 B／5524 行。read 为 211.69／184.40 ms，framing 为 3.18／1.59 ms，从读取开始到下一次 Main 事件循环机会为 215.25／186.37 ms；各有 1 次与读取及 framing 相交的实际 typed IPC，等待 214.4／186.1 ms。相交期间 Renderer 仍有 26／23 次 rAF 回调，相交间隔最大 9.3／8.7 ms；这是实际 canvas/rAF 观察，不是显示器呈现时间，也不能证明 Main 没有阻塞。Main RSS 记录点从首读前 379.55 MiB 到两次读后 452.81／505.97 MiB；这不是整机或所有进程的峰值。

该 GUI v2 的默认 azure/copilot_api Profiles 均无 Key，0 模型、0 Provider count、0 编码器调用；读后 Chats/Settings 可操作，reader 已关闭，App 正常 exit 0、PID 82449 消失，数据库前后 SHA 回执相同。v1 因夹具错误要求默认 Profiles 数组为空而在读取前失败，0 reads，原记录保留；不能从后续成功中删去。

结合完整读取、局部 SQL 比较和这次真实 GUI 观察，本次选用 16 MiB 作为初始原始字节护栏，接受该近上限材料约 0.2 s 的 Main 等待。它不是数学最优点、永久能力限制或按 RAM 比例推导出的保证；两次固定材料读取不证明长期交互质量，也未验证与 4B／Voice 并行时的整机峰值。该 GUI 证据对应同一预算与读取查询，不将它改称后来反馈 v2 的新版 GUI 验证。之后包含反馈修复的最终构建与受影响 Electron 20/20 已通过；Main 已完成相同源码集成和目录内全离线、生产构建复验。

## 验证、旧实验与证据范围

新增 Memory 16 项实际 SQLite 语义回归，旧 SQL 与新 SQL 均通过；受影响 Memory/Cognition 共 73 项通过。前一候选源的 2262 项全离线、类型/lint/format/build 通过仍作为前源结果保留，发生在 EXCEPT 与反馈最终合并前。实际 Electron 原 30k Chats、17 个 Agent 场景、Renderer 恢复通过；基础 API 清单补记 cancelStart 后通过。另六项准备停止/退出/跨 PID 恢复通过，使用本地 HTTP 模型夹具，不是自然模型语义成绩；这些既有 GUI/E2E 结果不替代最终反馈 v2 同版复验。

失败反馈最终共有 7 项新增机械回归。首批 5 例在旧源码为 0/5、v1 为 5/5，其中包含新增投影合同检查，不能把五项都计为已有行为缺陷。扩展到同一批 7 例后，v1 为 5/7；v2 首次为 6/7，实际暴露裁剪游标越过未读来源。Root 将 projection frontier 限制在原 source snapshot 已证明的连续边界后达到 7/7，没有改掉原期望，保留 6/7 的失败记录。实际 Service Recall 续接、当前用户保留及连续游标由这些回归覆盖。

最终 working 的 `verify:offline` 已 exit 0：136 contract + 1571 unit/component + 578 integration = **2285**，并通过 typecheck、lint 与 format 检查。该验证包含上述反馈修正；随后同一运行源码的 `npm run build` 通过（14.59 秒），受影响 Electron 20/20 通过（55.4 秒），覆盖原 30k Chats、17 个 Agent 场景、typed bridge 和 Renderer 恢复。它们使用确定性 Provider；尚不代替最终独立自然语义与实际包验收。 Main 同版 `npm run verify:offline` 2285/2285（52.39 秒）、`npm run build`（14.90 秒）均 exit 0。

历史 W32 完整材料与 Q8 精确引文比较保留：两个场景族、每臂 8 个联合检查点，4/8 对 3/8；分别 229/233 请求、2886566/2711849 输入、131816/131396 输出，最大单次输入 48745/50298。Q8 增加约 390 净行与十文件，仍三次材料拒绝，未证明值得保留第二路径。这个比较不能证明 32k 最优，4/8 不能被称为成熟自主行为。原 common-v11 的 839 项／44 文件检查、Main v21 的 2118/2118 只作为历史版本证据。

仓外证据按稳定文件名与 SHA 定位，不将实验 runner 或候选资产纳入产品：

| 记录 | SHA-256 |
| --- | --- |
| 原动态材料 FREEZE.json | `85cbf15b1988d70e17105bcd4dd5c661bfa36933839f91a76e94e353fb50af0d` |
| RESOURCE-V3-RESULTS.md | `dfdebb48f83bc6339565aedc146e8ac6db954511c905b92ebc1a120d25418105` |
| RESOURCE-V4-RESULTS.md | `b5608ebc08a3ee5ae65d8b2aeeaa29793e2a57547e6b8f342f2720d5a580847c` |
| sparse-parent-independent-results/REVIEW.md | `8d6d0340f49d70f8b05c7dceb2676f1ae80ccd1f4e4cdc541e5eef66a86eadc3` |
| GUI-RESOURCE-SOURCE-BUILD.json（GUI 构建绑定） | `e542cc9f0e7b9018d2dbfa92a57268eec557351f8e3b196915bac0ffada55e34` |
| resource-gui-execution-v2/RESULT.json | `26bdb7ffc45a6ac91729992d696214f09f90ea290294c7db1aeb46942ed9bb4d` |
| ATTEMPT-FRONTIER-AMENDMENT.json | `9e84a1cbbe8edeb7f1028bb03b3e0d98e6584d78abc83914b66e965a58d25a33` |
| verify-offline-final-candidate.log | `edc34af273d04efb349ecb8436a0be019bdfa9f7c58bb3abfe836e37cb10292d` |
| MAIN-FINAL-VERIFICATION.json | `5c82933d8b3f0465e39db9afbdb3c469fe4faa9092d3133a25731a133f85c396` |
| MAIN-FINAL-INTEGRATION.json | `a0b7ea79d9bc403be16efd4e1bb26327ddebb521aa3758482f0bd1147e489c93` |
| FINAL-CANDIDATE-SOURCE-BUILD.json | `18591a1fe7fa47c10856bf70817b2c1a3f9a3dcb71d60992d84882a022466a4f` |
| E2E-FINAL-CANDIDATE.json | `ad1441eaf84b44c2e6a5edc044fa83040180cebcdb566ae5d28c2392befe6869` |
| BUILD-FINAL-CANDIDATE.json | `4b2a9bae30e8cd0316b51c392137101136cbbdc34530b181a665ba5b666958d7` |

原材料生成、首次资源失败、依赖路径修正、稀疏回归以及所有未尝试条件分别保存。生产仅保留获选查询与无 Arm 的回归 fixture。后续继续在最终单一路径统计长期任务成功率、重复观察/决策、实际调用和 Token、时延、恢复、人为介入及最终可用性；不以本轮机械完整性或少调用代替 Goal 的独立语义和安装验收。
