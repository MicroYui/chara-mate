# Memory 形成实体引用：限定当前实体索引

日期：2026-09-16。选择 `source-evidence-formation-v12`，Root 已核对源码、原失败与实际新请求，将四文件正确性修复晋级 Main；最终集成验证另记。

## 问题与选择

一次真实形成把会话 Persona UUID 写进了 Memory existingId。实际实体池为空，旧 wire 允许任意 string/null，宿主正确拒绝不存在的实体。因此选择修正模型输出引用合同，保留宿主合法 ID、原文引用、语义和事务校验。

候选只有一条路径：模型输出当前 input.entities 的 `existingEntityIndex`（零基整数或 null），adapter 使用请求开始时捕获的实体映射还原 domain existingId；实体池为空只允许 null。不得用 Persona ID 自动合并或创建已有实体，也不截断实体列表。Root 统一 wire 转换器保留 minimum/maximum，Memory 不另作转换后 schema 补丁。

现有 domain Batch、数据库身份及服务生命周期不变。v12 版本进入现有固定 Provider snapshot/expectedProcessorVersion/工作 attempt 校验。旧 complete receipt 不重形成；failed 不因版本升级自动重试。本次只在新诊断副本把失败工作改为 pending，并由实际服务记录处理器转移，原实验数据库仍保留失败。

## 来源与实现边界

基线为冻结于 2026-09-15T18:03:51.315Z 的 `final-validation-source-v3` 627 文件；Memory 两文件的 before/after SHA 在 `MEMORY-HANDOFF.json`。实际 Node 24.18.0、官方 OpenAI SDK 6.49.0。官方 schema 子集和 enum 限制按 2026-09-16 的 [Structured Outputs 文档](https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas) 核对，具体比较保留于 `DIAGNOSIS.md`。

UUID enum 会碰到官方总量及字符串长度上限；没有证据允许把当前实体列表固定截为 416 或 1,000。本次选 integer 边界不需要 enum。非 fine-tuned 模型的 schema 支持 minimum/maximum，fine-tuned 生成模型不支持这些属性；未找到产品已明确承诺其兼容能力的证据，不新增 fallback。本次真实空池请求仅验证 null 分支，不能推断非空数值边界的服务端成功率。

每次形成的动态 schema 只使用现有 `parseSchemaWithoutCodeGeneration`，避免全局 Ajv 内部 cache 长期持有每个新 schema。最终固定 domain Batch 仍使用原 Ajv。该选择限于动态边界，不增加新校验模块或依赖。

## 离线验证

新增 10 个必要形成模型回归，加原 2 项共 12：空池仅 null、首项/末项/null 解码、非法范围/小数/字符串、Persona 身份拒绝、await 期间实体映射固定。旧 Memory 源在同组中 6 fail/6 pass，新候选 12/12。与原 FormationService 和 Root structuredOutput 测试合计 3 文件 85 项通过；完整 typecheck、两文件 ESLint/Prettier、补丁对原冻结源检查通过。保留初次 fixture 缺 evidenceSourceIds 的 typecheck 失败及最终修正日志，不将准备错误算模型结果。

原 call 3 对应 `http-6.response.txt`。同一原 SSE 经 SDK 读取 823 events/1 completed，原文本逐字相等。两个实际 ModelMemoryFormation adapter 离线重放：v11 接受坏 batch，v12 拒绝缺少新字段/保留旧字段的原对象。原 v11 宿主的 unavailable entity 拒绝仍以原实际运行记录为准；没有修改旧响应或把它自动变成 null。该离线重放是 adapter 边界验证，不冒称重复执行了完整旧 host。

## 单请求实际验证

协议 `LIVE-PROTOCOL.md` 和 `LIVE-FREEZE.json` 在实际调用前冻结，原材料/Persona/时间/预算不变。副本实际 FormationService 生成的材料与原 call 3 deepEqual。原 checkpoint 是失败后态：复制初始 SHA 为 `603cb67e26faeabd64b262d5e68bcb87daaf6466c0b6992efdcf9a357906208b`；只把其唯一 failed work.status 改为 pending。原始失败数据库没有改变。

| 层次          | 实测结果                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 实际请求      | gpt-6-astra，1 个 formation generation，0 额外形成/selector 请求，0 自动重试                                           |
| 时段          | 2026-09-15T18:33:12.173Z 启动；18:33:19.845Z generation HTTP 200；18:33:35.320Z model completed                        |
| 完整 wire     | 14,420 bytes；宿主保守估计 16,564 tokens，无 unknownKinds；实际 wire 与离线捕获 deepEqual                              |
| 实际 usage    | input 2,924 / output 1,184 / cached input 0；模型步骤 23.140 s                                                         |
| 新实体        | 4 个 existingEntityIndex 都为 null；宿主生成 4 个 Memory Entity ID，均不同于 Persona UUID                              |
| 宿主提交      | 3 个真实 Revision、4 条 exact source spans；work complete、attempt 2；保留 v11→v12 在 cursor 0 的 processorTransitions |
| 实体/来源资格 | FK 检查为空；4 条引文逐项等于原 source 的 UTF-16 窗口，source ID/type/reference/time/speaker 保持原始身份              |
| 后续工作      | 3 个 embedding pending；0 encoder 调用、0 向量扫描，未运行后台索引/GC                                                  |
| 原始证据      | 原数据库结束后 SHA 不变；原 v3 holdout 失败不回写、不重标                                                              |

实际内容分为：用户报告过去一起找路的经历；等母亲腿养好后重走山脊的条件性意愿；要求当前角色为该次计划保留最缓路线的限定要求。原文“上次”没有被编造为确定日期，条件性计划没有被写成已完成。前两类及限定要求分别沿真实主体/owner 保存；这只是本例原文核对，不读取或重写 holdout oracle。

旧坏请求原实际 usage 为 input 2,892 / output 1,045 / cache 2,419、23.944 s。两次发生于不同时间且输出、缓存不同，不能据此声称延迟改善、成本稳定或 paired 性能胜出。新例多形成一条限定要求也不能用条数增加替代质量判断。

## 当前裁定与不能声称的结论

可以确认：新 wire 在本次实际 endpoint 被接受；实际 adapter 和宿主成功处理这一份此前因命名空间误用而失败的材料；数据库真实保存了实体、Revision 和原始来源映射。Root 据此选择该协议正确性修正为单一路径；最终集成验证仍由 Root 执行。

不能确认：稳定失败率下降幅度、所有非空实体集合的真实选择质量、同名实体消歧、全部模型兼容性、整体形成质量或端到端商业成熟度。合法 index 仍可能选错实体；宿主来源/当前 Revision/归属校验继续需要。单个修后新请求不能替换独立 holdout 的原错误分母。

## 交付与保留

Memory 自有只交 `src/main/memory/memoryModels.ts`、`src/main/memory/memoryModels.unit.test.ts`，精确补丁 `MEMORY.patch`；Root 两个 structuredOutput 文件单独由 Root 所有。子包交付时未写 Main、integration 或原冻结源；Root 此后只向 Main 晋级这四文件，无新包、实验模式或 DDL。

`LIVE-VALIDATION.json`、live 目录 SDK wire/SSE/域输出/诊断数据库、旧失败 SSE 引用、全部初始化失败日志和 frozen manifests 保留。候选源码、replay/live runner 和 bundle 已归档清理。

2026-09-16，Root 已按 `formation-contract-cleanup-20260916/MANIFEST.json` 归档并清理三个已结束包的 20 个精确根（1,923 个普通文件、4 个软链接），逐项核验 140 个保留文件未变。归档 SHA-256 `9243d4b31e68707ca1f31c19fccd509bfd99ca9001e0a4e396ff1e2ce740d695`；执行记录 `RECEIPT.json` SHA-256 `6f5babedd747884757ced5625993301ab17fa8ac4fcf2c0e65a5fed1d1d13dbc`。原始请求、SSE、数据库、补丁、结果和冻结记录仍在原仓外路径；依赖软链接仅 unlink，共享依赖、Main 和活动候选未删除。
