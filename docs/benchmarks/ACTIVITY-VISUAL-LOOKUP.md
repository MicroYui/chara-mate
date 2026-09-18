# 普通对话的 Activity 画面定位与读取

2026-09-17。状态：**integration-verified，完整离线、同版构建及桌面流程通过，真实理解验收待执行**。这是 Product §5.2、§6.8、§6.9 的能力与生命周期补齐，不是检索算法已经取得质量胜出的声明。Root 为 shared 合同、Main 接线与集成 owner。

原普通对话只能用 `image.inspect({path})` 读取已知图片。Cognition 可能供给完整视觉引用，但引用不是路径；`activity.search` 只提供行为聚合，未形成 Claim 或 Episode 的截图没有普通查询入口。原读图 await 后也缺少 Run owner 复核，且未保存可恢复的执行中图片 Tool 边界。

选定一条路径：`image.inspect` 通过 Activity 域定位真实观察，再读取完整引用；明确读当前画面时消费同一个 native/latest 工作集。Activity 保持原始事件与PNG真源，图片仍由同一个 Electron 图片输入 owner 解码、规范化。行为聚合、PFC理解与普通按需读图各有明确用途，不新增采集 owner、模型、后台任务、表或设置。

## 来源与边界

| 来源，2026-09-17复核 | 能支持的事实 | CharaMate实现选择 |
| --- | --- | --- |
| [Node 文件读取](https://nodejs.org/api/fs.html#fspromisesreadfilepath-options)，当前文档 v26.9.0；实际运行 Node 24.18.0，AbortSignal 是既有 API | `readFile` 可接 AbortSignal；取消停止内部缓冲，不保证取消每个OS请求 | 本地图片用异步读取，同一signal贯穿路径解析、读取、图片物化与完整请求计量；不使用文档中较新的buffer选项 |
| [Electron nativeImage](https://www.electronjs.org/docs/latest/api/native-image)，实际锁定 Electron 43.2.0 | `createFromBuffer` 读取PNG/JPEG；`toPNG`输出规范PNG，解码/编码接口同步 | 本地文件和已校验Activity字节共用解码；仅在同步调用前后检查取消，不伪称抢占 |
| [OpenAI视觉输入](https://developers.openai.com/api/docs/guides/images-vision)，实际SDK 6.49.0 | 图片可作为真实input_image，视觉输入参与用量 | 图片必须进入实际生成请求；普通目录定位、OCR或Tool完成均不单独证明模型已看到像素 |
| 当前 `ActivityVisualEvidence.resolve` 与 `consume`，源码版本见本次集成差异 | 已核事件、完整引用、资产、内容版本，真实native事件startedAt取capturedAt | 复用该owner，查询只返回紧凑来源元信息，不读取其它域表或把当前图替代旧图 |

258,000 是用户约束，最终请求继续取Provider更低限制。定位目录的本地原始读取沿当前16MiB工作集资源护栏；它不是Token数、质量最优值或查询时延证明。目录供给另按带工具与历史的完整请求选择可容纳前缀，返回实际续读位置；不新增固定张数、保留时长或工具Token上限。查询按捕获时间与事件ID降序，使用现有时间索引；分页是可重新校验的保留数据查询，不是跨页数据库快照。匹配为真实app/title/OCR字面子串，不宣称语义搜索或用户理解。

## 实现与验收范围

- Activity Repository/Service拥有定位SQL与范围；Shared仅补来源目标、查询及结果合同。查询省略时间下界时不擅自添加TTL，默认上界固定为本次时钟并回传。未返回行由续读覆盖，查到引用还没有加载像素。
- Runtime保存真实pending Tool边界；已完成结果带可恢复来源，不保存base64副本。恢复时通过Activity核事件/资产/修订；取消、steering与计量各await后复核当前owner。当前图和历史图保留实际时间、操作者与覆盖，不能推断用户读过或喜欢。
- 上下文压缩保留当前 checkpoint 中已成功读图的 Tool 配对及真实图片引用，同源只保留最近一份、不同来源都保留，与最后其它 Tool 按原顺序合并，同时保留最新用户输入。图片不冒充新的用户要求，也不因补充要求而丢失必要像素。
- 必须完成：实际SQLite中未成Claim/Episode的多窗口、多修订定位；真实Activity到普通Runtime的图像输入接线；范围与预算续读；来源改变/回收；取消、steering、完成Tool的重启和压缩；既有本地图片/附件/工具范围回归。
- 实际产品验收另用本次自有窗口的新画面，从捕获、实际请求、支持依据到普通回答逐项复核。PFC看图后形成有效Claim再供普通对话，与普通对话直接读像素分别记录。确定性接线检查不等于语义质量通过。

当前实际 Main 完整 `npm run verify:offline` **2433/2433，49.507秒**：136 contract、1670 unit/component、627 integration；typecheck、lint与format通过，保留两个既有TanStack警告。包括真实SQLite/PNG的历史定位与当前staged画面消费、120条目录按完整请求分配、计量中steering、取消等待、完成Tool重启恢复，以及同源重读、跨memory.record、两异图和两图间记录后的实际Runtime强制压缩。确定性接线不等于真实语义理解。

独立复核发现并关闭两个边界问题：同图去重原先把引用留在旧Tool处；单个最新Tool选择原先丢掉较早图片。后者两条真实Runtime修正前回归均失败，修正后完整回归通过。当前同图消息移动至最近成功读取处；编译器保留所有现存成功读图配对、一份同源引用和最后其它Tool配对，按原顺序交付。首次持久Chat摘要的保留与计量复用同一选择；正常读图序列不进入该首次分支，不将其写成已复现故障。必要材料仍超限时，Provider在真实generation之前拒绝，不通过静默丢图求fit，也不会无限重编。

首轮typecheck的可选属性声明、测试Memory构造和错误表名，以及测试lint问题均已修正并实际复验。原失败保留在 `integration/ordinary-chat-activity-visual-implementation-v1/verification-first`、`verification-domain`、`verification-working-set-red` 和 `verification-full`；最后全绿为 `verification-full-second`，结束于2026-09-17T01:45:31.175Z。这些功能检查在第4或第5家族共同构造期执行，原条件窗口不重叠，共同构造墙钟保留宿主负载。运行中的未来需求F/C/I保持原冻结代码，不回填本包修复。

同版生产构建通过（13.873秒）；受影响Electron 24/24通过（66.789秒），含附件/本地读图、Run、Memory/Activity、Journey及Territory。源码与回执统一见 `VERIFICATION.json`。新鲜像素的真实模型理解、最终安装分别验收；工程通过不替代这些结果。
