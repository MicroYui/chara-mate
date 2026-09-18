# Astra reasoning effort：同一 v2 结构输出的六组开发对照

日期：2026-09-15。Decision ID：COGNITION-ASTRA-REASONING-EFFORT。结论：**本轮不将 low 晋级为生产认知模型设置**。已完成的五对中 low 较快、输出较短；但第六对的 low 在未闭合 JSON 尾部持续生成空白，630.258 秒后连接关闭，没有可提交结果。样本不足以判定 low 的失败率总体更高，也不能把成功条件下的平均加速当成可用性已解决。生产不增加 effort 模式、自动降级或第二条模型路径。

## 冻结条件与实际执行

六个独立中文 development case，每组两次真实 Astra 调用；未读取 holdout。每组先创建真实 SQLite Evidence/Attempt 再序列化，两臂从同一副本开始，Attempt UUID、原始 evidence、Persona、完整 v2 输出 schema 和输入图像完全相同。三组 medium→low，三组 low→medium。原始 Responses body 已逐对比较，六对唯一差异都是显式 `reasoning.effort`。全部12次真实响应的 `response.created.reasoning.effort` 与请求吻合。

此处 v2 是已单独完成正确性修复的 attention `keep/set/clear` wire，领域语义仍是一套状态。旧 exact-splice 十二次调用采用旧 nullable attention wire，不能拿来充当这里的 baseline。两组报告的分母、协议和结论保持独立。

当前 ModelRequest/生产 OpenAI adapter 不发送 reasoning；此前实际响应报 medium，是响应观察，不是产品已经显式固定 medium。本次只在仓外 fetch 包装注入 effort，没有修改生产模型设置或 ModelRequest。模型 `gpt-6-astra`、endpoint `http://localhost:4141/v1`、官方 SDK 6.49.0，运行机 M4 Pro/24 GiB/macOS 26.6.2。真实驱动、schema 校验、Repository 提交；Memory 显式空 EvidencePack，未运行真实 recall/formation、对话 Run 或世界操作。

全部输入远低于用户 258,000 Token 上限：最大完整保守估计 75,315 Token（含真实 PNG），最大返回的实际 input usage 为 7,344。失败请求没有终态 usage，其 input 可参考同输入 medium 为 7,175，但不能记作服务端实测。每个图像条件只提供一张最新 400×300、2,065 byte PNG；两臂像素相同。没有把历史图像 reference 冒充实际已接收像素，也没有独立 image token 分项可报告。

六例共有18项冻结事实/来源标准。评审是实现者离线核对，不是独立盲评，不是商业验收，也没有能力证明质量非劣。full-replacement 的第三项原是 splice 边界标准，在 effort 对照中缺少区分力；因冻结要求仍保留，不能结果后悄悄换题。

来源和版本：实际 SDK 6.49.0 [Responses 类型](https://github.com/openai/openai-node/blob/v6.49.0/src/resources/responses/responses.ts)、[共享 Reasoning 类型](https://github.com/openai/openai-node/blob/v6.49.0/src/resources/shared.ts)支持 reasoning.effort；访问日 2026-09-15 的 [Astra 官方模型页](https://developers.openai.com/api/docs/models/gpt-6-astra)列明 low/medium。协议默认值以本轮实际 wire/response 为准，不从记忆中推测。SDK adapter 两个请求路径明示 maxRetries:0，没有人为12步限制、重试覆盖或 wall-clock kill。

## 十二次完整分母

| 开发场景              | medium：耗时 / output tokens | low：耗时 / output tokens | 实际提交 |
| --------------------- | ---------------------------- | ------------------------- | -------- |
| 中途安排出现后删除    | 38.827s / 2347               | 28.600s / 1817            | 两臂提交 |
| 模拟台词否定和改口    | 38.044s / 2260               | 26.694s / 1654            | 两臂提交 |
| 同 App 两个对象与返回 | 51.032s / 2892               | 36.368s / 2298            | 两臂提交 |
| Unicode 删除与替换    | 33.811s / 2112               | 29.970s / 1768            | 两臂提交 |
| 正文两次完整替换      | 36.243s / 2139               | **630.258s / usage 未知** | low 失败 |
| 同文字的不同画面      | 31.459s / 1959               | 24.623s / 1549            | 两臂提交 |

medium 6/6 提交，low 5/6。medium 六次总耗时 229.416 秒，low 含失败为 776.513 秒。失败没有终态 usage，不能把部分空白折成零 Token 或以成功请求推算总收费。medium 已报告 input/output 为 42,605/13,709；low 五次成功已报告 35,430/9,086，另一次未知。全部成功响应 cached_tokens=0，均报告 cache_write_tokens；不能说没有缓存写入。medium reasoning_tokens 合计 794；low 成功均为0，失败未知。

仅在两臂均完成的五对上，medium/low 总时间193.173/146.255秒（low少24.3%），output tokens 11,570/9,086（少21.5%）；这严格是**条件于成功的子集**。五个配对时延差均为负，但不足以用它覆盖失败或决定长期默认值。包含失败的全部六对平均时延差为 low 多 91.183 秒；逐案例描述性配对 bootstrap（穷举6⁶次）95%区间为 [-11.529, 292.784] 秒。此区间只展示该小型开发集合的不确定性，不推断真实用户总体。成功输出首文本时间：medium4.92–10.41秒，low1.81–2.48秒；接收到第一个 Token 不表示状态已经可用，必须等完整解析及提交。

## 失败与语义质量

失败是全替换场景 low 第10次调用。原始流显示已收到文本，输出在第一条 claim 的 `contradictingEvidenceIds: []` 后逗号处停住，并继续生成空白：213,262 个输出字符中末尾连续空白211,691个，JSON未闭合；原始 SSE 30,927,693 bytes。最终 adapter 报 socket connection closed，耗时630.258秒。不能把这简单归因网络，因为连接结束前真实模型文本已退化；也不能证明具体根因为 effort，单次样本不足。此轮12次 instructions **均不包含**后来另一个实验选中的 `Emit compact JSON without formatting whitespace outside strings.`，所以不是 compact 条件的失败。失败原样保留，无重复请求填补。

同时如实记录宿主并发：call10 进入尾空白后，外部曾执行约22秒的 SQLite 查询实验；其开始晚于空白症状，因此不能解释症状起点，但也不能宣称所有端到端时间来自完全空闲宿主。

已完成输出中，medium18/18冻结事实标准通过，low15/15可评标准通过，余下3项因生成失败不可评、不得算通过。输出正确区分模拟台词和真实反馈、被删除文字和当前版本、两个对象、组合字符与 emoji，并为已见画面保留来源和时间边界。没有新发现虚构发信/保存/世界效果或猜测未收到的历史红色像素。完整评审记录见 semantic-review.json。

行为选择并不完全等价：前三个文本场景 medium 选择回应现有用户请求，low 选择安静；low 理由把“不可主动开新话题”更广地用于已有请求。两臂 Unicode 均回应，图像均安静。被冻结事实标准没有充分评价这种“漏回应与适当安静”的差别；不能以18条事实检查替代陪伴体验和注意力决策质量。

## 下一步和清理

保持一个生产协议。低 effort 是尚未晋级的候选，不留下 Settings、fallback 或永久臂切换代码。下一研究应先量化完整 updateSituation/Intent 输出中重复旧字段及引用所占比例，再预注册专用稀疏 typed wire 单变量；不得把领域本身拆成第二套状态。4B 本地模型仍是外部研究提案，未下载、未增加服务；若还要生成2k Token，较小模型并不自动消除几十秒输出延迟。

若以后复核 effort，应在已选定的同一 compact/v2 协议下重新冻结更长连续状态轨迹，覆盖回应/安静、过时依赖、恢复和信息需求，而不是将本轮失败从分母删除后晋级。未获得明确提升前，不改变用户模型或保留两种运行时策略。

原始记录位于 `run-2026-09-15T10-27-33.887Z`；case hash `8114c24cd57631363b9aad9517b74b3442921fc499874c2b7971386b94efdcbf`，冻结代码 hash `8226ba8dc90ae4ae3a0c017cd1ab34d0561e15de831b9dacf31122550fce3606`。SHA256SUMS 覆盖 raw wire/HTTP/SSE/usage/输入/实际输出/提交状态/PNG和评审。候选 runner 删除记录在 cleanup.json；本报告没有把外部 runner 当生产实现。
