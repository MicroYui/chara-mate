# MEMORY-CONSOLIDATION-CONTEXT：按完整请求分配巩固材料

2026-09-17。选择修正最终材料分配和依赖有效性；不改变 Formation、Recall 查询、候选、Selector 或排序算法。对应 Product §6.4 与完整输入预算要求。Root 为集成 owner。

## 问题与依据

旧实现将形成与检索的 16384 局部额度继续用于最终巩固输入。目录页面校准 p02 的两轮执行中，4 组内 5 项工作因此直接完成为 retain_originals，尚未让实际巩固模型看到完整必要材料。这能证明旧门槛阻止供给，不能证明模型判断原文更合适，也不能证明某个更大的固定数字最优。旧校准结果保留。

2026-09-17 03:08 UTC 复核[官方 TypeScript 输入计数接口](https://developers.openai.com/api/reference/typescript/resources/responses/subresources/input_tokens)，并检查锁定 SDK openai 6.49.0 的 input-tokens.ts。接口接受 input、instructions、tools 和输出格式等完整请求字段，没有 CharaMate 的局部 16k 规定。安装 SDK 文件 SHA 为 `2c2b6d84e33e264c34f88b0c168e3e59e7af6a199df86ff69760562201e01843`。

完整输入 258000 是用户指定约束，再取较低的实际 Provider 输入限制与输出预留。原始投影累计 16 MiB 是此前[动态材料决定](COGNITION-DYNAMIC-ACTION-BUDGET.md)所选本地读取保护，不是 Token、整个任务 RSS 或总读取上界。现有 Recall 局部工作集继续是独立的工程选择，本次不替换其数值。

## 唯一生产路径

一次工作 attempt 绑定一个实际 Provider，取得其限制，以同一请求构造器测量和生成。该绑定只存活于现有任务 Promise；不新增全局缓存、队列、进程或设置。实际生成仍经过原 Provider 完整输入检查，最后一次相同请求的有效计数可复用。

先完整读取 anchor、可用的已有摘要及其全部有效原始依赖。两个读取批次共用累计 raw-value 额度，重复 Revision 正文只读取一次，原有来源、片段、条件和引用用途仍分别校验。只有自身时间条件及全部派生依赖可用的摘要才能作为替换目标；失效旧摘要继续不可检索，新有效原件沿已有形成链自然产生新摘要，不承诺原位重建失效摘要全部内容。

纯历史依赖保留历史用途。同一 Revision 若在旧摘要中同时具有 current 与 history 依赖，新摘要保留 current 约束；合法换版后旧事实仍可作为历史依据，但不能继续支持要求它当前成立的摘要。该规则保留既有条件的交集，不将纯历史依赖升级。

再以现有 Evidence resolver 完整读取本轮 Recall 已选择的可选原始 Revision，保留其顺序和检索提示，不重新检索或扩展候选。必要和可选读取共用累计 raw-value 额度，按 Revision 去重；不同 Revision 共用同一 Source 时仍分别计入其完整投影成本。容量不足只接纳完整可选前缀，尾项整体移除，不留下缺少原文片段的陈述。完整实际请求不合适时，继续逐项移除可选尾部并重新计量，必要项不裁剪。两类材料遗漏分别记录在 Conso 本地 coverage.materialOmissions，原 Recall coverage 保持原义，不把消费端删减伪装成检索未找到。

全部必要项仍不合适，明确记录 consolidation_input_limit；累计必要原始读取不足，或资源删减后不足两份事实，记录 consolidation_resource_limit。原本只有一份事实仍允许正常 no-op retain；不能将资源导致材料不足冒充模型主动 retain。稳定失败不会在输入不变时循环重试。原 selected memory IDs 仍参与目标竞争校验，包括后来因容量移除的项；补全的所有精确片段进入同一有效性快照。

首次有效输入在异步绑定前固定；metadata、count、生成成功或拒绝后都检查同一份有效性，提交前再核验。取消优先并等待真实 owner 退出；已有效材料发生变化沿原 attempt CAS 回到 pending。没有证据表明材料变化的异常保留原错误。若请求拒绝同时发生真实变化，持久原因仍保留该 Provider 错误与实际模型身份。沿用[既有恢复路径](MEMORY-CONSOLIDATION-RECOVERY.md)，不新增重试状态或定时器。

稳定派生格式仍为 grounded-consolidation-v1；执行处理器更新为 grounded-consolidation-processing-v3。已有失败可沿原处理器变化规则获得恢复机会；旧 complete-retain 不因本次修正自动重排。

## 验证与边界

隔离候选的 Learning/App/EvidenceRead 42 项、Recovery/Foreground/实际 SDK loopback 55 项先通过；随后新增混合依赖回归在旧折叠规则上真实失败，修正后 Recovery 45/45 通过。独立检查共 98 项，重复运行不加分母。全 TypeScript、9 文件 lint/format 和补丁检查通过。首轮类型检查的测试 import 大小写错误及原失败保留。

实际 SDK 的 7 项 loopback 检查覆盖完整 instructions/schema/input 与生成一致、较低 Provider 窗口及输出预留、精确输入恰好可容纳、404/405/501 保守处理、400/503 原错误和取消 join。这些是实际 HTTP/SDK 的离线验证，不是线上模型理解质量。SQLite 回归覆盖完整旧依赖、累计读取、时间/来源变化、目标竞争、稳定容量失败和恢复。

新增成本包括完整材料读取、重复计量、有效性检查及 JSON 构造。支持精确计数时会产生真实计数请求；当前真实代理计数端点不可用，仍沿已知保守估计，不能声称接近 258k 时获得精确服务端保证。移除局部门槛只解决必要材料缺失，不自动证明摘要更好或更便宜；自然 M/D0/D1/D2 必须共用修正后的源，并比较实际采用、首个提交、前台等待、总用量和失败。

Root 按九文件 before/after 精确合入 Main，并合入已独立选择的 Text 回应段落。2026-09-17 03:58:32–03:59:49 UTC，实际 Main 完整离线 **2474/2474**（136 contract、1676 unit/component、662 integration）通过，52.177秒；生产构建15.142秒，MemoryActivity/Journey Electron **3/3**、9.473秒，git diff --check通过。两个既有TanStack警告保留。同期有隔离目录离线验证，这不是性能对照。集成回执SHA `7f2c4df2973b758edc5ad5446892be89c1b912b24e53f5bfd84bdbfe1e83630a`；最终同版自然模型验证仍待执行。候选源码、运行器和逐项日志留仓外；仓内仅保留这条实现与其回归，不保留旧最终预算分支、Arm 或候选设置。

## 2026-09-17：已选可选原件的供给修复

原独立生活故事 il03 有两次真实巩固请求：Recall 已选中的对照存在原始片段，但消费端只拿到稀疏陈述。模型因此诚实保留原件，不能据此推断完整材料没有综合价值。此次依照上面的同一完整请求合同补读已选原件；SDK/Provider、Recall/Selector、排序、处理器版本和提示均不变。继续采用 03:08 UTC 核过的 SDK 6.49.0 完整计数接口，不引入新数值或实验算法。

两个新真实 SQLite→实际 ModelMemoryConsolidation 请求用例在旧生产均因缺少原件而失败，修复后 Recovery/SDK 59 项与 Learning/EvidenceRead/App 42 项通过，合计 101 个不同检查；类型、lint、格式通过。七个新增 Recovery 例覆盖稀疏材料补齐、完整跨 Revision 成本、资源前缀/不足两份事实、原被移除目标在计量等待中出现合法派生摘要，以及补全片段被修改后的真实延期。大原文资源例注入宽松模型计量，只隔离物理读取分配，不声称真实 Provider 能容纳该文本。

Root 全文审查一个生产文件与两个既有测试文件，按准确前像合入 Main；仓外冻结标识 `ee42184a0d7897ab8fc0e0dcc9e019fd26aca8b4983f682fb1679cf0f62f8ac4`。候选只修复供给，未证明每次都应综合、摘要质量提升或总费用降低；原 il03 保留结果和所有分母不改。新增读取与 Token 成本、最终同版模型自然采用仍由本地成熟度验收覆盖。仓内仅保留唯一生产路径及其直接回归，没有新增 runner、开关、SQL 或共享 schema。

两项材料修复合并后，Main于2026-09-17 10:08:02–10:09:26 UTC通过完整离线2511项（136 contract、1692 unit/component、683 integration）及生产构建，分别66.126/17.691秒；628个src/tests前后不变。实际模型、App与Pixi未在此阶段运行，同宿主原e05场景执行重叠不作为排他性能对照。


2026-09-18补充：上述03时段为处理器v3的历史执行；当前原始来源支持修复已随28文件组合合Main，执行版本为`grounded-consolidation-processing-v4`，稳定派生格式仍v1，见[独立支持修复](MEMORY-ADAPTIVE-CONSOLIDATION.md)。946项组合关联和静态通过；这不改写当时结果，也不提前证明最终同源原model56真实综合结果。
