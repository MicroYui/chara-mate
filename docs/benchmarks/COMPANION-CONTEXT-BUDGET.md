# COMPANION-CONTEXT-BUDGET：完整请求输入预算与首次压缩

日期：2026-09-15。状态：实现、受影响验证及主工作区完整离线回归完成，桌面与打包结果见 [STATUS](../progress/STATUS.md)；当前代理缺少精确计数，绝对 Token 上限的部署验证仍未完成，见第 7 节。集成负责人：当前主任务。实验工作区基线：`fc81239304c03648ee3f39ca178f3695ce474ffc`。

## 1. 决策与不能宣称的结果

用户明确要求：**单次请求的完整输入不得超过 258,000 Token**，包含系统指令、历史、Memory、Tool 定义、结构化输出约束和多模态输入，以避免进入不希望使用的长输入价格档。本决策把 `258,000` 作为用户指定的产品约束，不把它称为某模型的官方物理窗口或已核实的价格分界。累计任务 Token、Run 时长和磁盘历史容量不是这个限制。

选定一条发送路径：在 OpenAI/Azure Responses Adapter 完成 wire payload 组装后、发送生成请求前统一检查预算。当前 Provider 支持标准 input-token count 时，用同一份输入的真实计数判断；Provider 明确不支持时，普通小文本采用有余量的保守估算，无法估计的附件/不透明上下文和接近边界的请求明确停止。不会因当前代理缺失 count 端点而让所有普通对话失效。

**精确能力缺口仍然存在。** 当前本机代理没有标准 `/responses/input_tokens` 端点，也未找到可配置的 Responses 输入硬上限。字节估算加余量不是模型 tokenizer，更不是数学证明；因此本次实现不能证明当前代理的每一次生成都绝对不超过 258,000 个真实输入 Token。完整证明需要代理提供忠实的服务端计数或服务端强制上限。本轮没有修改代理，也没有把它的 Anthropic count 兼容端点伪装成精确 Responses 计数。

## 2. 一手来源与实际版本

| 来源                                                                                                                                                     | 核对版本/日期                                                                                 | 可以支持的结论                                                                                                                              | 不能据此推出                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [OpenAI Responses input token count](https://developers.openai.com/api/reference/typescript/resources/responses/subresources/input_tokens/methods/count) | 官方文档，2026-09-15 核对                                                                     | 标准 `POST /responses/input_tokens` 返回 `object=response.input_tokens` 与 `input_tokens`；接收 input、instructions、tools、text 等输入配置 | 任意 OpenAI-compatible 代理均实现了该端点                                              |
| [OpenAI JavaScript SDK input-tokens 源码](https://github.com/openai/openai-node/blob/v6.49.0/src/resources/responses/input-tokens.ts)                    | 本项目实际安装 `openai@6.49.0`，同时直接读取安装包 `src/resources/responses/input-tokens.ts`  | `client.responses.inputTokens.count` 的路径、请求字段与返回类型；无须新增依赖或自造计数协议                                                 | SDK 的存在等于后端已支持；SDK 自身会替应用检查 258,000 上限                            |
| [OpenAI images and vision](https://developers.openai.com/api/docs/guides/images-vision)                                                                  | 官方文档，2026-09-15 核对                                                                     | 文档所列 patch 图像模型对接受的单张图像最多 30,000 个 patch；Astra 等已核对型号使用 1.2 倍换算，舍入可能相差 1 Token                        | URL/base64 长度等于图像 Token；未知部署别名具有相同处理方式；超大图像一定被接受        |
| [GPT-Realtime-2.1 模型页](https://developers.openai.com/api/docs/models/gpt-realtime-2.1)                                                                | 官方文档，2026-09-15 核对                                                                     | 精确型号 `gpt-realtime-2.1` 的原生 context 为 128000、最大输出为 32000；支持 Realtime endpoint                                              | Azure 任意 deployment alias 都等于该型号；Responses count 能计量实际 Realtime 音频会话 |
| [copilot-api 源码](https://github.com/caozhiyuan/copilot-api/tree/0534c01f7d9e066e7d34751dd380a7fa6122916b)                                              | 本机 `@jeffreycao/copilot-api@2.5.3`；OCI revision `0534c01f7d9e066e7d34751dd380a7fa6122916b` | 以已安装 dist source map 的实际实现为准，核对 Responses route、messages count、tokenizer 和 context-management 代码                         | 仓库其他分支、后续镜像或上游服务具有相同能力                                           |

代理镜像 digest：`sha256:46e4d423669cbd447dd66ca17d4dc9cf6ff1dd8fd42b543e741a25994f472732`。调查只读，未读取/输出用户密钥、未修改代理、未发送生成请求。主任务使用已配置鉴权观察到标准 count 路径返回 404；本子任务的未鉴权探测返回 401，因此不把未鉴权探测当成端点支持性证明。

实际安装源码的证据如下：

- `src/routes/responses/route.ts` 注册生成入口，没有 `/input_tokens`。
- `src/routes/messages/count-tokens-handler.ts`、`src/routes/provider/messages/count-tokens-handler.ts`、`src/lib/tokenizer.ts` 的 GPT 路径使用本地 `gpt-tokenizer` 和手写开销估算；默认编码、图像加值、文件/base64 与 opaque reasoning 处理均不能当成当前 Responses 完整请求的精确计数。
- `src/routes/responses/utils.ts` 的 `applyResponsesApiContextManagement` 对较新 GPT 路径直接不应用此管理逻辑；本次扫描没有找到可供 CharaMate 设置的最大 Responses 输入 Token 拒绝参数。
- 模型列表中的窗口/输出元数据表示声明的容量。它既不是这次请求的计数，也不是“已设置用户 258,000 上限”的证据。

文档与部署均可能漂移。更新 SDK、代理、模型命名或图像预处理后，应重新核对这些能力；本决策不将 2026-09-15 的观察外推到所有 Provider。

## 3. 预算公式与完整 wire 守门

令 `U = 258000`，Provider 归一化后给出的限制为 `effectiveInputTokens`、`maxPromptTokens`、`maxContextTokens`、`maxOutputTokens`。本次输入预算为所有可用限制的交集：

```text
B = min(
  U,
  effectiveInputTokens（若存在）,
  maxPromptTokens（若存在）,
  max(0, maxContextTokens - requestedOutputReserve)（若存在 context 限制）
)

requestedOutputReserve = 本次 max_output_tokens
                         或 Provider 声明的 maxOutputTokens
                         或 0（两者均未知）
```

`effectiveInputTokens` 不覆盖更低的 prompt/context 限制。相同语义的多个有效元数据别名，以及顶层/嵌套字段同时存在时取最小值；确实进行模型详情查询时，也保留已读列表中的更低限制。未知 Provider 限制不会取消已知的用户上限。缺少 Provider 输出限制时，不能宣称同时证明了其物理 context 余量。

守门发生在 namespace 映射、Tool Search schema、原生工具声明、structured-output schema、instructions、input 和生成参数都组装完成之后。计数请求从最终 payload 拷贝当前使用的全部 token-bearing 字段：`model`、`instructions`、`input`、`parallel_tool_calls`、`tools`、`tool_choice`、`text`。`max_output_tokens` 用于 reserve；`store`、`stream`、cache 控制不伪装成 count schema 字段。以后 Adapter 增加输入配置时，必须同步检查计数投影。

真实计数返回值必须具有正确 object 标记和非负安全整数。`input_tokens > B` 在生成前拒绝，恰好等于 `B` 可以发送。cached input 仍是输入工作集的一部分，不能通过减去 cached tokens 放宽限制。

## 4. 当前不支持精确计数时的最小规则

只把标准的 `404/405/501` 作为当前端点明确不支持，结果缓存到 **Provider 实例**，不在不同 Provider 之间共享。`400` 不被猜测成“不支持”，鉴权错误、权限错误、限流和网络错误保持各自含义，均不继续发送生成请求。取消也沿原 AbortSignal 传播。

保守估算针对完整 wire payload，而不只数最后一条用户文本：

```text
E = UTF8Bytes(完整 payload 的可见文本 JSON 投影)
    + 已核对模型的图像预留
    + 256
    + 16 × 投影遍历的对象数

只有没有 unknown content 且 E < floor(0.9 × B) 时，才按估算放行。
```

UTF-8 字节避免直接套用英语四字符一 Token、中文比例或上一次请求的压缩比；`256` 和对象开销 `16` 是本次实现的 framing reserve。**这些数值是 CharaMate 保守工程启发式，没有被称为官方 tokenizer 公式或脑科学常数。** `0.9` 延续已选 Context Recipe 的整理水位，保留 10% 余量也不能把估算变为精确保证。它会更早拒绝/整理某些实际上可以装下的文本，这是当前能力缺口下的代价。整体验证还观察到：声明30k输入窗口但没有count端点的Provider，其固定指令/工具JSON即可超出保守包络，即使用户消息很短也可能被拒绝；该问题不能靠缩短一句用户消息解决，应使用支持真实计数的Provider或较大可用窗口。Chats UI fixture因此明确实现与其固定usage一致的标准count，缺失count的限制继续由Provider集成回归覆盖，没有提高该fixture模型限额来隐藏问题。

多模态的处理如下：

| 输入                                                                                                                            | 无精确计数时的行为                                                          |
| ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 普通文本、instructions、Memory、工具/schema、明文 reasoning summary                                                             | 完整计入可见文本投影                                                        |
| 文档明确列出处理边界的 patch 图像模型                                                                                           | 每张按 `30000 × 1.2 + 1 = 36001` Token 预留；不从压缩文件大小推导图像 Token |
| 未核对的模型/部署别名中的图像                                                                                                   | 必须取得真实 count；否则拒绝                                                |
| PDF/文件、音频、视频、item reference、compaction、不透明 encrypted/opaque reasoning、服务端 conversation/previous response 引用 | 必须取得真实 count；否则拒绝                                                |

已核对的精确模型 ID 保存在 Adapter 的纯预算模块中，当前用户选择 `gpt-6-astra` 在其中。这个图像预留只预算**官方会接受**的图像；超出图像接收限制仍可能由 Provider 拒绝。一次请求的多张图片相加，不因每张分别满足而绕过总预算。正常单张桌面截图可以保持可用。

Tool 参数和 structured-output schema 中的 `conversation`、`encrypted_content` 或 `input_image` 字段名/示例属于文本描述，不被误判成真实不透明内容或图像；仍按完整字节数计入。可见的 `reasoning.summary` 也不会误触发 opaque 拒绝。

计数是独立的协议能力查询，生成请求只发送一次。本次在 count 和 Responses generation 两处设置 SDK `maxRetries: 0`，避免 SDK 在网络失败时自动重发可能已被服务端执行的同一生成。没有引入第二个 Provider、算法模式或 Settings 开关。计数服务本身的定价不由本决策作保证；本轮验证没有调用付费模型。

## 5. 首次输入与跨 Run 摘要

旧行为依赖上一次 usage/bytes 比例，首次超大输入缺少历史测量时不能主动发现压力；摘要在没有历史测量时也可能把单个超大段落直接提交。修正如下：

1. `ContextCompiler` 和 `ChatContextService` 从第一次输入开始计算本次工作集。历史 usage 比例只能与本次估算取较大值，帮助提前整理，不能降低本次估算。
2. ContextCompiler 保留已有单一路径：当前/最新用户输入、Memory evidence、Chat summary、最新 Plan 与最新必要普通 Tool call/output 成对保留。完整 instructions/tools 仍由最终 Provider guard 再检查。
3. Chat 摘要按完整已结束 Run 的消息分段，从可容纳的完整分段前缀中选批次；摘要指令、上一版摘要、本批原始内容一起参与批次预算。
4. 每批成功后才推进 `ChatContextSnapshot` generation 和覆盖边界。原始 Chat UI 消息不删除。下一批使用刚完成的摘要，generation 竞争仍通过现有 repository CAS 检查。
5. 单个完整 Run 过大、当前新增输入自身过大，或模型返回的新摘要自身过大时，明确拒绝并提示缩短/分段。不会拆散 Tool 边界来硬塞，也不会用同一过大摘要无限重试。
6. 摘要生成同样走 Provider 的完整 wire 守门。此前已成功推进的批次仍是有效持久化状态；失败批次不推进 Snapshot。

这是 working-set 管理，不是长期记忆删除。海量精细 Activity 仍先聚合为 episode/digest；不能把磁盘历史、全部 Activity、全部 Memory 或整个检索候选池推满模型窗口。查询工作集上限与长期持久化容量必须分开核算。

### 5.1 Voice 启动的首次历史与可选文本 Provider

集成只读复查发现，`VoiceService` 的旧调用方在缺少 `lastInputTokens/lastRequestBytes/lastModelId` 时直接返回历史，绕过共享服务的新首次检查。用现有 Voice fixture 和真实 SQLite 复现：无 Snapshot 的已完成语音历史原样进入 `VoiceConnection.history`，文本 runtime 与摘要调用均为 0；同一历史直接调用新 `ChatContextService.prepare` 会按预算拒绝。

最小修复在 Voice 配置准备阶段计入启动指令、Tool schema、已有摘要和完整重放历史。精确型号 `gpt-realtime-2.1` 使用已核对的原生容量，预留其最大输出后，与用户上限取交集：`min(258000, 128000 - 32000) = 96000`，再应用同一 90% 保守估算水位。这个数值来自该型号的协议容量和输出预留，不是另选的算法常数。

没有旧文本 usage 的短 Voice 历史通过本地预检后可直接启动，仍不依赖可选 Chat/title Provider 的凭据。需要整理时才创建文本 runtime，摘要批次预算进一步与该文本 Provider 更低的限制取交集；启动指令和工具占用作为额外工作集传给共享 ChatContextService，不能仅看 history 恰好低于水位就放行。单独过大的启动指令/工具在申请 Realtime 会话之前拒绝，完整重放工作集在摘要后再次检查。这个最终检查只检查静态启动内容，不声称覆盖后续音频流。

未知 Azure deployment alias 无法由名称可靠映射到官方型号，所以不套用 128000/32000；本地只应用已知用户上限，原生容量未知的限制明确保留。实际 Realtime 音频、服务端对话状态及运行期间的工具续接仍由 Realtime 协议处理，**Responses input-token count 没有被用于声称这些输入已得到精确计数**。对已核对型号而言，128000 原生窗口本身小于用户上限；这也不等于本次已验证真实 Azure 音频会话的所有边界行为。

## 6. 验证、分母与复杂度

环境：macOS arm64；Node `v24.18.0`；OpenAI SDK `6.49.0`；Vitest `4.1.10`。本轮全部为 deterministic offline 验证：真实本机 HTTP fixture 驱动官方 SDK，真实 SQLite repository 驱动 Chat Snapshot；不是对付费模型质量的试验，也不是实际代理的端到端精确计数验收。

最终受影响验证 **7 个文件、119/119 tests 通过**，Vitest wall time `1.28s`；`npm run typecheck`、受影响文件 ESLint、Prettier 和 `git diff --check` 通过。覆盖范围：

- 用户边界 258000/258001、较低 Provider 输入限制、实际输出 reserve、冲突元数据别名/嵌套值。
- 最终 count 请求与 generation wire 的 input/instructions/tools/text 等字段逐项一致，包括映射后的 namespace。
- count 404/405/501 可用性；Provider 实例隔离；400/401/403/429/500、连接断开、错误格式的计数；生成 500 不自动重发。
- 超大 instructions、用户输入、Tool 描述、structured-output schema 均在生成前拒绝；已知单张截图和明文 reasoning 可用，PDF/opaque 无 count 拒绝，有 count 时按实际计数处理。
- 首次长历史无需旧 usage 即可整理；完整 Run 分批；超大单段及过大摘要明确失败；UI 原文、Snapshot generation、跨 Run/restart、Plan 和 Tool 配对边界保持。
- Provider/Phase 2 受影响契约及原有 Agent Runtime 集成用例回归。

Voice 增补包另跑 Voice Runtime、ChatContextBudget 和 Voice 契约 **3 个文件、36/36 tests 通过**（`1.28s`），以及 typecheck、受影响 ESLint/Prettier、diff-check。新增回归覆盖：没有旧 usage 的 Voice-only 长历史整理；不可分的过大首历史在会话申请前拒绝；短历史不依赖可选文本凭据；过大的启动指令/工具拒绝；未知 deployment alias 不猜原生窗口。测试用官方型号的 96000 输入预留预算验证低于用户 258000 的约束，未发起真实 Realtime 音频或付费文本生成。

回归代码由获胜生产路径拥有，不保留 candidate switch。没有新表、迁移、依赖、后台进程、Provider 配置项或算法设置。新增纯预算模块由 Provider 域维护，Compiler/Chat 复用相同预算定义。新增成本是：支持精确计数的 Provider 每次多一个计数往返；不支持时每实例首次探测一次，以及线性遍历完整请求。Chat 按完整 Run 尝试批次沿用现有分段结构，极大量分段下存在多次序列化成本，本轮未宣称有新的吞吐或延迟收益。

未在本包运行完整应用 build/package/Electron E2E；由集成负责人执行主工作区最终层级回归。没有付费生成调用、计费实验或真实长附件发送。

## 7. 拒绝项与后续验收边界

- 拒绝“bytes 除以上一次比例”作为可以跨过边界的依据，也不把本机代理的估算型 `/messages/count_tokens` 接入成精确 Responses 计数。
- 拒绝 count 端点 404 就使所有小文本请求不可用；同时拒绝缺少可信多模态/opaque 计数时仅按 URL、base64 长度乐观放行。
- 拒绝把用户 258000 当成模型物理窗口、Codex 的 258400、所有 Provider 的统一价格档或累计 Run 成本限制。
- 不新增可选算法、预留 clock 表、TTL 或检索规则。此包不改变 Memory 的曝光中立排序，也不实现未来价值预测。
- 当前 guard 覆盖应用**实际提交**的完整 payload。Provider 原生工具在服务端继续加入的结果、Provider 私有隐藏指令和内部多步执行没有在本机可核对的计数接口；不能声称本次实现控制了这些内部扩展。

用户请求的是硬上限，当前部署缺少可证明该硬上限的服务端能力，这是待补能力而不是已经通过的验收项。后续应在提供忠实 count 或服务端最大输入参数的部署上，验证相同输入的计数与实际 usage、附件边界、cached/opaque 续接和服务端工具路径；本次不以更多合成测试代替那项真实协议能力。

实现文件：[inputBudget](../../src/main/providers/inputBudget.ts)、[OpenAI Responses Adapter](../../src/main/providers/openaiModelProvider.ts)、[ContextCompiler](../../src/main/agent/contextCompiler.ts)、[ChatContextService](../../src/main/agent/chatContextService.ts)、[VoiceService](../../src/main/voice/voiceService.ts)。此记录保留一个选定实现，没有仓库内实验 runner 或候选资产需要保留。

## 8. 2026-09-16 当前部署边界补验

在当前已配置 `gpt-6-astra` 部署上，用产品真实 OpenAI Adapter 读取模型元数据并探测 count 能力，随后提交七类完整请求给 Adapter：超大当前文本、超大 instructions、超大 Tool schema、超大 response schema、不透明续接、未知文档、七张已核对的 patch 图像。七类全部在生成前返回 `PROVIDER.CONTEXT_LIMIT_EXCEEDED`；实际网络记录为 **1 次 count 请求、0 次生成请求**。该 Provider 实例的 count 返回 404，后续按已记录的不支持能力处理。

这证明当前部署连接与产品完整 wire 守门共同拒绝了这些边界输入，不是仅用 mock 返回超限。没有发送接近 258000 的付费生成请求，也没有取得该部署不存在的精确计数，因此不把这七项改称为绝对 Token 计数验收。原始结果中的提示仍写有“窗口更大”；隔离集成候选已修正这个文案，避免暗示更大的模型窗口可以覆盖用户的 258000 上限。原始观察记录保留原文。

同期普通冷入口的 40 个真实消费 Run 使用同一个 `gpt-6-astra`，77 次模型请求有 usage；最大单次输入为 **18110 Token**。这个已观察值包含 Provider 返回的 cached input，累计输入不与单次上限混算。它只能说明已运行请求的余量，不能证明所有未来输入或 Provider 私有的内部扩展。完整部署能力边界仍以第 7 节为准。

## 9. 2026-09-17 Voice 每次发送的已知本地输入

最终源码审查发现，先前静态启动检查不能覆盖全部入口：转录后 `prepareTurn` 把整个 Realtime 输入额度当补充情境空间，拼接基础指令后没有最终检查；试听、唤醒欢迎语及不主动调用 `measureResult` 的普通 Tool 结果也可能直接发送。这是已知请求材料的实现缺口，与无法读取服务端音频历史占用分别处理。

Root 已将 5 个生产文件和 3 个既有测试的单一修正合入 Main。原 Azure issuer 的 session JSON、Renderer 的历史/试听/欢迎语/刷新事件分别抽到其现有域与共享 Voice 合同；计量和发送共用相同构造。没有新增模块、模型、Schema、数据库、用户参数或计数端点。启动及重连检查实际 session 与重放事件；试听计同一固定文本及两个实际事件；普通转录先量本轮 response envelope 和有效 Tool schema，再用剩余空间准备补充情境，返回后完整重计。本次 requestId 和 generation 在计量与发送之间保持一致，取消或换轮后不会发布旧准备结果。

Tool 执行成功先按原 Runtime 保存完整 Item，再对实际 `function_call_output` 与续答 `response.create`、有效工具检查；超限保留成功结果、令本轮失败并停止发送，不自动重做 Tool，也不删除必要内容来放行。测量中旧的额外 `effectiveInstructions` 与实际 response.instructions 重复，已去掉这个重复计量副本，实际指令仍完整发送。

2026-09-17 重新核对 [gpt-realtime-2.1 型号页](https://developers.openai.com/api/docs/models/gpt-realtime-2.1)、[Realtime 自定义输入](https://developers.openai.com/api/docs/guides/realtime-conversations#create-responses-outside-the-default-conversation)、[Voice latency and cost](https://developers.openai.com/api/docs/guides/voice-latency-cost?api=realtime) 和项目实际 SDK 6.49.0。型号页仍为 128000 context / 32000 最大输出，因此本地已知输入预留仍为 96000。`conversation:none` 单独只控制输出归属；欢迎语同时具有显式纯文本 input 和 tools[]，才不依赖默认 conversation 输入。本实现只在该确定构造上去掉通用估计器的 conversation unknown 标记，完整事件字节仍计量。普通 conversation/audio history 仍 UNKNOWN，不使用转录、上次 usage 或 Responses count 假装得到了实际剩余空间。当前查阅来源未给出该型号独立的 instructions+tools 上限；`post_instructions` 是会话项预算字段，不是指令限额，也没有套用旧型号的数字。

隔离最终验证 **88/88**，实际临时 SQLite、现有 Driver/issuer 和注入的 Provider/音轨覆盖完整构造、96k 与未知部署别名、超过原 8k 的完整情境、最终超限、新一轮恢复、Chat owner 等待中的结束、同步状态回调取消及完成 Tool 的保留。typecheck、8 文件 lint/format 通过，进程已退出。首轮新增测试的类型缩窄错误及修正前日志保留；不是产品类型错误。仓外候选冻结 `55209667fa542befb8154dd930539886fdf72350546ed9bdf541183376e85f49`，补丁 `0d6cd700af4aff6daaad67eda8bd75a4d2c45e18440d175a58b2c07f9c963ae4`，Root 实际集成回执 `23630e536695747c5fc6500f1a12833af8b916d0d6d394aa3e5145db8f097c0f`。Main 完整回归、新包及实际 Azure/硬件链另行验收，不把原 e05 包或在途非 Voice 故事改称本修正版本的结果。


2026-09-17 当前 Main 复核：五个语音生产文件、三个既有测试与Cognition引用修正共同通过完整离线 **2512/2512**（59.192秒）及生产构建（15.917秒），两个既有TanStack警告保留。08:04:57–08:06:13 UTC，三命令自然退出，源代码前后不变；记录 `integration/final-main-voice-reference-verification-v1/VERIFICATION.json`，SHA `43fc8ac545f93b635df6c558b9bb1257a44c0d0cc4f07805c439049cf99b6ef6`。受影响Electron和实际语音/图像/实体设备仍待本版执行，不能由这些确定性检查代替。Formation的16,384分段和同来源比较额度另有未完成调查：已知两次裁剪不构成错误写入证据，但不据此把局部数字当最优配额。

## 10. 2026-09-18 PFC 读取与完整请求的衔接修复

v4最终自主流程在2026-09-17 18:03:58–18:04:25 UTC暴露了具体缺口。普通Run的observe、sit、life计划均已完成并实际进入后续请求；随后两个PFC在首次生成前失败。原来源页已按131072本地字节预算节选，但加上指令、输出Schema、Persona、能力说明及JSON转义后，最小Persona的完整估算分别为232568、232609，比现有估算线232200多368、409。count仍404，没有精确Token；这不是已证实超过用户258000，也不是模型语义失败。两个产品PID正常退出，冲突后的调整、到期行动与Stop未曝光，不能以supervisor completed判通过。原件见仓外 `local-autonomy-final-continuation-v1/execution-live-v1`，独立复核 `review-live-v1/FAILURE-REVIEW.md`；6次实际生成用量252414输入、304输出，125184缓存为输入子集。

修复复用本页已核的Provider计量合同与当前Cognition reader/Service源码（2026-09-17），不调整258000、0.9、本地读取上限或Memory检索额度。Driver只在首次生成前反馈专用预算错误；Service在同Attempt用实测比例指导缩小候选读取，再由原SQLite reader取得真实连续节选、原投影器编译覆盖信息。比例不是字节到Token的换算，最终仍由完整请求measure和原fits判定。候选配额与实际投影必须严格减少；未知内容、无可缩材料或底座无法装入明确失败，没有新重试次数或后台轮询。

实际供给的snapshot、allocation、sourceCoverage、依赖、正文消费前缀和executionMaterial同步保存；首次received边界不推进，后到来源不能被算入已读。保留此前实际供给的失败反馈，不让新建的自身Attempt挤掉错误。Completion只在原Recall/接管后重新编译，保持同Pack、sourceRead计划及完成状态；不重复检索或接管。已经生成的提案若纠正请求超额，仍直接失败，不进入生成前循环。取消、用户控制与Persona变化沿原生命周期终止。

隔离实现为3个生产文件和2个既有测试，无新表、Schema、依赖、参数或备用路径。真实SQLite+生产Driver/注入离线Provider先复现原RangeError，再覆盖首轮与Recall/sourceRead完成阶段、实际供给/提交一致、原文不变、晚到事件、失败反馈、取消和生成后不重发。23个Cognition文件497项通过，2026-09-17 18:27:31–18:27:34 UTC，2.842秒；类型、相关lint/format通过。首个夹具source.kind错误与后续期望字段拼写错误保留，只有合法前提下的RangeError复现算原缺陷证据。仓外 `pfc-complete-request-fit-repair-v1` 保存精确差异。Main完整离线2663项通过，安装v5后实际PFC计量从233203、232592在同Attempt缩至231934并成功生成；后续暴露的Executor问题单独记录如下，不回填原失败。

## 11. 2026-09-18 执行时共享重复观察正文

原自主故事实际到期接续 Run `6dba8250-5be0-4c4b-a73f-c49fcf3bff91` 遇到目标被移除，获得真实 `TERRITORY.REVISION_CONFLICT` 后成功重新观察。旧选定依据174602 UTF-8 JSON bytes与新Tool结果135859 bytes重复，大请求估算349434而被当前232200守门拒绝；随后压缩未取得进展，还丢掉了真实失败pair。原两次生成前拒绝、失败Run和两个正常退出的Main保留，不能称该故事已经通过。

2026-09-17读取本项目当前ContextCompiler、Cognition行动材料与Territory观察源；沿本记录已核的Provider协议和计量实现修复，不新增协议限额、预算参数或候选运行模式。选择在每次模型物化时共享完全相等的历史节点组：仅合法的宿主选定performed/unchanged effect、与当前成功空参数territory.observe相同Zone、完整domain观察且run/item/call身份一致时生效。历史时间、Revision、目标、约束、Claim、反证和不同组保持原样；当前真实Tool字节不改，checkpoint始终完整原文。引用明确callId和零基组索引，逐字段展开精确还原旧材料。同时保留最近真实失败pair；实际物化内容不变时不重复压缩/重发，不产生虚假的整理Item。用户新inputRevision仍沿既有恢复路径处理。

3生产和2既有测试已由Root核对前后像集成，无新模块、Schema、持久副本、参数或依赖。真实SQLite Run及既有模型注入的原缺陷RED与修复后200/200检查（12新例）保留，2026-09-17 19:11:34–19:11:39 UTC，4.737秒。用原实际完整request经同一生产Provider离线估算，恢复真实失败pair后350972，共享后195725（wire193597）；43组402节点精确还原。不是精确Token或新模型语义结果，后者由原故事定向复测验收。完整Main静态与2675项离线回归于19:23:17–19:24:12 UTC通过，55.253秒；随后完成v6安装及下述原故事定向执行。原候选源码仅仓外暂留至交付，生产一个物化路径，无Arm开关。证据 `agent-observation-context-sharing-v1`，补丁SHA `d87be52b52533757faab668dacfdd4f3a2650f9386a88d346353b6854473bfc2`。


### 11.1 最终 v6 原到期故事的实际结果

2026-09-17 19:28:09–19:32:33 UTC，原已闭opening的同库续行完成既定existing_due/restart/reopen，未重新生成开场或增加抽样。真实旧目标在行动开始后被删除，实际act返回版本冲突；重新observe后，下一真实模型选择墙上地图并执行成功，保存01:50。PFC沿实际保存时间再次唤醒，角色观察吊饰并保存02:20；新PID重开保持Run、World、Intent和nextWake，未把计划中的休息当已发生。

model6的43个sameAsObservation引用逐字段还原后的完整selected JSON，与本轮原完整selected JSON相等；旧被删目标及历史Revision仍保留，新observe完整402节点/38目标与真实失败pair进入同一次HTTP。完整请求保守估算200130，实际wire197490 bytes，生成返回替代行动；Provider报告该次input55284/output92。全部7个真实Tool回执完整进入后续模型，没有实际超限或无进展compaction。该结果关闭原Executor无法跨过冲突恢复的使用问题，不是把离线估算当真实Token，也不是成本配对胜出。

本次18生成（12 Agent、6 PFC）均有终态usage：873211输入、10114输出、272010缓存输入；38 HTTP另含19元数据与1 count404。实际发送估算最大232198，Provider返回单次输入最大55967；137本地计量不计成生成。父90013与两Main90014/91078均正常退出，263.878秒总墙钟。原v5失败与6次生成318863/1923另账保留。

两个新角色Run依照PFC要求保持安静，没有非空公开正文，因此在途Stop及取消后重开未曝光，不据此判断Stop成败。后台四条this.model.bind错误来自外部旧Formation观察包装，Main实际装配原有当前bind/prepare；已在新runner副本修复，原错误不删除，此故事不计记忆形成通过。上述局部使用修复与这些边界分别报告，不为自然静默追加故事。证据 `local-autonomy-initial-due-observer-fix-v1/{V6-LIVE-REVIEW.md,V6-LIVE-RESULT.json,accounting-live-v6.json}`，报告SHA `d9cc80b0` 前缀、完整逐文件标识见结果JSON。

## 12. 2026-09-18 当前整合状态

第9节“Formation的16,384仍待调查”是当时状态。后继4对实际比较已选择按完整请求分配必要旧记忆原件：形成和冷答分别由0/4、2/4变为4/4、4/4，同为18次生成，输入增加7.59%；选择及小样本边界见[形成必要对照材料](MEMORY-FORMATION-COMPARISON-CONTEXT.md)。当前不以更大的固定局部数字替换16,384，也不把这项比较并入原48分母。

最终v8通过2682项离线检查、29项Electron E2E和实际安装。真实两段语音已完成记忆修订、关闭重开及新Chat按需检索，物理麦克风和扬声器完成原完整问句；实际结果与原外部声源失败分别见[语音决定](voice-architecture.md)。这些补齐了已列入本轮的实际调用链，不能证明不存在精确计数接口的代理取得了精确预计数。第7节的协议能力边界继续保留；有限交付的剩余容量与原检索问题定向复验，以[本地验收](../progress/LOCAL_MATURITY_ACCEPTANCE.md)为准。
