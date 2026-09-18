# STRUCTURED-OUTPUT-COMPACT：内部结构化输出采用紧凑 JSON

日期：2026-09-15。状态：已选定并接入唯一 Memory/Cognition 结构化生成路径；2026-09-15 的 1,223 项离线验证通过。连续场景验收仍在进行。本记录不宣布结构化输出已达到商业稳定率，也不把格式要求当超时修复。

## 问题与决定

Memory 与 Cognition 的两次历史真实调用在 JSON 尚未闭合时持续输出空白，约 630 秒收到 socket 文案错误。已确认两次使用 `json_schema + strict:true`，且已有明确 JSON 指令。为区分生成格式退化、字段协议矛盾和流中断，使用同两份 development 输入做一次 AB/BA 单变量诊断。

选定：在 Memory/Cognition 内部结构化生成的 instructions 末尾统一追加 `Emit compact JSON without formatting whitespace outside strings.`。保留原模型、strict schema、推理设置和正常完成判定，不增加 provider fallback、自动重试、运行时开关或任意超时。它是一个改善输出格式的小改动，不能保证所有请求终止或内容正确。

独立的正确性修复不归功于此实验：Memory 把模型可见的 optional 说明统一为 wire 上输出 null、host 恢复 domain optional；Cognition 用模型边界明确 keep/set/clear 表达注意力三态。此次 4 请求均冻结旧 wire，没有混入这些改动。

## 依据与版本

| 来源 | 版本/日期 | 与本决定有关的事实 |
| --- | --- | --- |
| [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) | 2026-09-15 阅读 | strict 要求所有属性 required；optional 可由 nullable 模拟；nested anyOf 受支持。JSON mode 的缺少 JSON 指令警告不能直接解释本案。 |
| [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra) | 2026-09-15 阅读 | 支持 Responses、streaming、Structured Outputs。用户单请求 258,000 输入 token 上限独立适用。 |
| 官方 openai JavaScript SDK | 6.49.0；已安装 `src/client.ts` SHA256 `05bed6f1cc832d108c84857173cca0efd227b3b440420d22c7ce7eadcb4bf245` | `fetchWithTimeout` 的 600,000 ms 默认 timer 在 Response headers 返回后清除；不等于已开始 SSE 的总截止时间。实验 maxRetries=0。 |
| [copilot-api](https://github.com/caozhiyuan/copilot-api/tree/0534c01f7d9e066e7d34751dd380a7fa6122916b) | v2.5.3；commit `0534c01f7d9e066e7d34751dd380a7fa6122916b`；Bun 1.3.14 | 当前 localhost:4141 的实际 Docker 服务，native Responses HTTP 路径直接转发 text.format；Astra 没有模型别名、额外 prompt 或 reasoning 覆盖。 |
| 代理运行镜像 | `sha256:46e4d423669cbd447dd66ca17d4dc9cf6ff1dd8fd42b543e741a25994f472732`，2026-09-08 构建，MIT | headers timeout=300,000 ms；逐次 read 的 inactivity timeout=300,000 ms；Bun server idleTimeout=0。没有找到 630 秒固定计时器。 |
| CharaMate wire | `openaiModelProvider.ts` 生成 `text.format={name,schema,strict:true,type:json_schema}` | 四条实际提交的 body 与预先冻结 body 一致；无工具、无 reasoning/max_output_tokens 覆盖。 |

代理源码来自实际镜像 source map，未取私有凭据。`create-responses.ts:133–161` 直接转发 payload；`upstream-http.ts:145–188` 每读到一个 chunk 就取消此次 inactivity timer；`responses-websocket-helpers.ts:19–33,56–73` 把异常转成 code/param=null、sequence_number=0 的 SSE error。官方支持不能证明兼容网关上游 constrained decoder 的内部实现。

历史 Memory call75：输入保守估算14,979 tokens，4.529s 收到 HTTP 200，630.251s 失败，115,622 文本 bytes 中113,829为尾空白。历史 Cognition：630.340s失败，89,551 bytes中84,589为尾空白。前者真实 wire 已留存；后者只有 ModelRequest，本轮按 adapter 规则重建，不能声称具有历史 raw HTTP wire。

## 预注册与执行

外部证据 ID：`structured-stream-diagnostic/compact-pair`。请求前冻结的 `manifest.json` SHA256：`7082d3c67fc02397dcb9155679db2d17c187a279d41b6b477f013e84e1853164`。其中包括 protocol、4 个请求、运行代码和 production inputBudget 快照。

A 为原请求；B 只在 instructions 末尾追加同一条紧凑格式句。固定顺序 Memory A→Memory B→Cognition B→Cognition A，各一次、不自动重试。模型全部 gpt-6-astra，官方 SDK 6.49.0，Node 24.18.0，经同一已配置代理。完整 payload 保守输入估算分别14,979、15,045、30,180、30,114，均无 unknownKinds，低于用户258k上限。

保存原始 SSE 和 request/headers/created/delta/terminal 时间，不只保存拼接文本。通过判定为 `response.completed` 加 JSON 可解析、冻结 wire schema Ajv 通过；缺终态或 failed/incomplete/error 即失败，不能因局部 JSON 可解析计成功。业务正确性另验。

## 结果

| 请求 | 完成 + wire 校验 | 流总时长 | 文本 / 尾空白 bytes | 实际输入 / 输出 tokens |
| --- | --- | ---: | ---: | ---: |
| Memory A | 失败，SSE error | 532.836s | 94,086 / 92,311 | unknown |
| Memory B | 通过 | 26.064s | 3,029 / 0 | 3,346 / 1,142 |
| Cognition B | 通过 | 26.562s | 4,536 / 0 | 4,841 / 1,450 |
| Cognition A | 通过 | 36.664s | 7,506 / 0 | 4,832 / 2,079 |

4/4 `response.created` 回显 strict=true，schema 规范化后与冻结请求完全一致。3 个完成请求的已知用量合计13,019输入、4,671输出、0 cached输入；另1个失败请求无usage，所以总用量和实际费用不完整。代理实际计费未知，不把官方价格当实际账单，也不把缺失用量计为零。

Memory A 的原始 SSE 时间线：8.274s headers，8.279s首个非空白delta，16.999s最后非空白delta，532.832s error，532.836s流结束。之后的输出一直停在同一 citation.quote 后、occurrence 前，共40,127个text delta、25,127,738 SSE bytes。error事件的code/param=null、sequence_number=0和Bun socket文案与实际代理SafeStream包装一致。空白来自网络上的模型文本delta，不是CharaMate拼接加入；错误以流内error到达客户端。上游为何结束仍UNKNOWN，新的532.8s结果不支持固定630s计时器结论。

Memory A失败、B通过支持这条格式约束有实用价值。Cognition A这次也通过，不能说compact必然修复它。其原始7,506 bytes去格式化后为5,112，B为4,536；输出内容仍有差异，不能把所有token/延迟差异都归因于缩进。两份输入、每组一次、零cache命中，不足以估计总体稳定率；模型生成随机性和上游负载仍是混杂。

## 领域离线复核

原始输出保持不变，使用冻结请求中的实际source/snapshot进行离线复核，没有Provider调用、数据库写入或补造canonical来源。当前实际Main源码bundle的14个文件hash见`compact-pair/replay-source-manifest.json`，结果为`offline-replay.json`。

Memory B通过当前`ModelMemoryFormation`解析（复核时已是并行owner的`source-evidence-formation-v5`），返回3 units、4 entities。3个quote各自只有一个精确source位置，但模型输出occurrence=1。旧v3按索引取位置会越界；v4/v5 `quoteStart` 对唯一精确quote直接取唯一位置，仅重复quote用occurrence消歧。因此这个冗余数字违反冻结提示的索引意图，却不是当前v4/v5必然失败。冻结输入只有既有记忆excerpt，没有精确历史canonical DB；没有执行或声称完整Memory apply成功。

两份Cognition输出通过当前领域schema及`resolveCognitionAnalysis`对冻结snapshot的证据投射，各2 situations、1 intent，最终remain_quiet。当前模型边界已改wire v2显式keep/set/clear；旧v1输出直接送入当前driver会因attention形状被拒绝，这是预期版本差异。没有修复旧输出、没有保留旧wire兼容分支，也没有把纯领域投射当数据库commit或真实桌面体验验收。

## 取舍与后续验证

选紧凑格式句，是因为它成本与维护复杂度很低，此小样本显示有利且不改变领域协议；不是因为四次调用已经证明稳定。保留严格完成判定、领域校验、原始失败证据与来源引用。拒绝降为JSON mode、放松schema、切换Provider或以无限自动重试遮盖问题。

Memory optional/null 文案和Cognition注意力三态修复有独立正确性依据。完成它们后应在同一最终生产路径继续连续场景/holdout验收；若再次出现长空白，记录终态与真实SSE，再按失败位置设计单变量诊断。本轮不增加固定token/时间杀死或“空白阈值”作为未验证的新产品策略。

本子包未写生产候选实现，runner、原始SSE、输出与源码快照都保留在仓外。生产只保留该中文Decision与统一格式要求；无Arm参数、Settings选项、代理fallback或新依赖。根任务负责接线及最终回归；本记录本身不替代集成验收。
