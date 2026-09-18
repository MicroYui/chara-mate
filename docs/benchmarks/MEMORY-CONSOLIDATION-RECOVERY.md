# MEMORY-CONSOLIDATION-RECOVERY：实际模型事件驱动的后台恢复

2026-09-16。本包修复后台巩固的失败恢复，不改变 Coverage/G 所选理解、来源或检索算法，不追加它们的语义成功分母。所选实现先进入隔离共同 v16，现已合入 Main v21；最终同版独立场景与本地安装验收仍待完成。

## 问题和选择

原来的 reconcile 工作在取消/进程中断后能够继续，成功保存 Provider 配置也会经 Main listener 调用 `MemoryMaintenance.retry()`；这些能力原本就存在。但普通文本模型恢复可用以后只唤醒 Formation，巩固仍 failed；新处理器启动也不恢复旧版失败。巩固还把错误消息写进 error_code，没有可靠保存实际模型身份，前置 Selector 的失败可能被误认为最终巩固模型的失败。

选择复用现有 durable work 和同一个已提交 Run 事件。只在条件实际改变时重排失败：旧执行版本在当前版本就绪时得到一次机会；同版仅对已发生的 TIMEOUT/UNREACHABLE/RATE_LIMITED/UNAVAILABLE，且失败调用和成功 Run 的 profile/api/model 全部相同，才恢复。成功在失败之前、任务仍运行、后台自身成功、不同模型、无真实 responseId 或重复事件，均不给未来重试额度。语义、来源和普通请求错误不会因为一次普通对话成功而被重复付费处理。

UNAVAILABLE 为正式连续事件实际 HTTP503 后补的明确类别；Main 源码已更新，下列历史三类错误验证不据此改写分母。追加的实际 SDK/SQLite 回归仍待运行，见 [服务过载恢复](PROVIDER-SERVICE-RECOVERY.md)。旧 REQUEST_FAILED 不按文字推断成新类别。

稳定派生格式 `grounded-consolidation-v1` 不变。新的执行常量为 `grounded-consolidation-processing-v2`，由 Main 加入真实 profile/api/model；每次领取工作保存准确执行版本，模型绑定前后重验 expectedProcessorVersion。旧总结不会仅因算法版本升级而丧失来源资格。

`memory_work` 仍是唯一任务记录，保持原 ID、sourceVersion、attempt CAS 和分组内已提交前缀。只恢复仍对应当前来源版本的失败；已完成或已替换来源不重复处理。processorTransitions 保存必要的跨版本原因，lastFailure 保存最近失败类别、实际请求身份和原因，二者使用已有 redaction 边界。没有新增 DDL、表、队列、定时器、模型、用户开关或独立检索路径。

成功保存配置时，现有 retry 继续重排已失败工作，并取消当前巩固 controller；未完成部分通过原 pending 路径重新绑定凭据，已提交部分不回滚。这也覆盖 profile/model 字符串未变而凭据已经替换的情况，无需增加延期重试状态。

## 来源与实现边界

基于 common-v14-frozen；执行合同在 `CONSOLIDATION-RECOVERY-DESIGN.md` 预先提出，经 root 串行冻结。2026-09-16 复核 [OpenAI 错误说明](https://developers.openai.com/api/docs/guides/error-codes#api-errors) 和锁定官方 SDK **openai 6.49.0**。SDK 默认重试次数不是应用工作队列的硬要求；当前共同源 stream/输入计数明确 maxRetries:0，metadata 可能沿用 SDK 默认。

ProviderError.requestIdentity 由 root 的实际 adapter 产生，覆盖 metadata、输入计数和生成调用，以本次请求 modelId 而非默认模型标注；无 profile ID 不猜测，abort 保留原语义。当前 429 分类仍包含限流与额度错误；后续同模型实际成功是重新尝试的条件，不代表任何 RATE_LIMITED 都必然可恢复，也不承诺一次恢复一定成功。

root 拥有九个 Provider/App/Main/宿主测试文件；Memory 本包拥有四个生产文件、两个受影响测试和一个新的集成测试。最终独立 runner 应复用新的 App 绑定和唯一 MemoryProviderRecovery 对象，不能继续使用旧常量或将第二个 consolidate 参数当 signal。

## 实际验证

最终共同候选 **22 文件、438 检查全部通过，4.04 秒**；全量 TypeScript、受影响 ESLint、Prettier 全通过。新恢复集成文件包含 16 个确定性案例，使用真实磁盘 SQLite、实际 Formation/Recall/巩固服务以及 RunEventWriter/MemoryMaintenance，不调用真实模型。

实际证明的路径包括：

- 旧错误持久形状（人类 error_code、null result_json）真关闭重开，经新处理器恢复；保留旧原因但不把文字猜成 Provider code。该形状由 fixture 明确构造，不冒称运行过旧模型。
- 三代处理器转换、失败后同版重启不循环、已完成内容不重复执行。
- 三类暂时错误精确匹配；前置共享 Selector 的不同模型/缺失身份不能由当前模型成功误恢复；成功先于失败没有后续效力。
- 真实已提交普通 Run 回执经宿主 helper 使同库 reconcile failed 实际进入下一次执行；重放及后续模型 Item 不追加重试。
- 保存配置时实际取消后项，保留第一项已提交的派生和原始来源，恢复后无重复原事实；执行版本变化不影响派生格式资格。
- 被新 sourceVersion 替代的失败不被网络/版本恢复捞回；未配置保持不动，未知存储错误正常暴露。
- 实际调用前 expectedProcessorVersion 不符时零请求；Provider 异常对象及 code 不被转换成语义错误。

root 九文件还提供官方 SDK + 本地 loopback HTTP 的 39 个检查，已包含在本次组合中；它们验证真实 adapter 错误与身份边界，不是线上模型或网络可用性验收。本包没有故意制造真实付费网络故障，也没有重跑 L/G/Coverage 或读取独立验收标签。

保留的失败证据：新增 lastFailure 起初未过持久 redaction 边界，假凭据 SQLite 回归在修复前实际失败 1 项；`consolidation-recovery-redaction-before.txt` 保留原记录，之后以已有边界修复。初轮静态问题均为受影响参数/测试类型，已修复；不能把这些机械正确性结果计为理解或召回质量提升。

## Root 组合复核

Root 将九个宿主文件和七个 Memory 文件按 common-v15 的逐文件 before hash 合并，没有改动其余共同源。受影响 Memory、Provider、Run、前台让出、Cognition–Memory 边界共 **25 文件、471 检查通过，4.48 秒**；全 TypeScript 7.21 秒，受影响 ESLint 3.273 秒、Prettier 0.359 秒，退出码均 0。这些结果验证恢复正确性，不是长期理解质量分母。

实际 SDK 的同一组 39 项检查在旧 adapter 上为 **35 通过、4 失败**，新实现 39/39；新增错误身份来自实际 HTTP 调用，不从默认模型反推。稳定派生格式与执行版本分开，App 在异步创建前绑定、创建后核对实际配置；用户在等待中更换默认模型不会把已经开始的请求改名。

统一外部运行器也已使用同一个 App factory 与新恢复对象。观察器在任何请求之前用实际 ProviderService 保存的 profile 重新构造 adapter，避免实验 draft 缺少身份；真实 SDK/自有 loopback 的 completed、incomplete、429 与构造失败四项通过。两次独立 Node 进程共享同一 SQLite 的装配检查通过、零模型请求，尚不能替代实际前台竞争或冷检索验收。

共同 v16 包含 768 个明确源码文件，冻结 SHA `23721f502ea22a8b8e9d6feb5f5d1b412b9c3c4e95f34a220f7c958ad1f304dc`；本次 16 文件集成冻结 SHA `0e569e70fd4636f21a45cf798f4338e0f3c690efba98477dbfc5124d5f412713`。构建产物不混入源码清单。

## 交付和单路径证明

只交付 `consolidation-recovery-source/` 七文件及其精确 common-v14 before/after patch。全候选源差异核对为 **我方七文件 + root 九文件**，没有其他源漂移；root 九文件 after hash 全部再次匹配。旧入口被新对象合同替换，没有双恢复算法、运行时 Arm 或按失败消息猜测的分支；依赖、Schema、DDL 不变。原始结果、候选和本草案留仓外，主仓只应保留所选实现、归属明确的回归和精简中文 Decision。

| 证据 | SHA-256 |
| --- | --- |
| 七文件 freeze | `7ba734b27d320906e910d7e37ac05dc90da40c9a680fe363ed04f04715848507` |
| 相对 common-v14 的领域 patch | `a2783a4a0ea44f183fb38fab737fcd0d7f837f91090e32b53563b71f953327bd` |

具体逐文件 SHA、root 宿主依赖 SHA、438 项日志 SHA 及静态命令/退出码均在 freeze JSON。没有在本包运行完整 Electron E2E、打包或新的独立模型验收；这属于后台可靠性正确性修复，不替代最终同版伴随体验和长期语义验收。

## 2026-09-17：生成期间输入变化的恢复

闭合的未来需求第4家族暴露了具体失败：模型生成时父记忆新增支持，提交检查正确拒绝旧结果，但原 work 被记为 failed，普通 wake 和同处理器重启均不再处理。其它 anchor 随后产出不能算该工作恢复，原运行保留。

本次基于 2026-09-17 01:51:56 UTC 的 Main 实际实现修正正确性合同。首次 Recall 保留实际供给 Pack 的来源版本、有效引用和引文资格；后续成员生成前、生成返回后的写入或 retain 判断前都复核这些材料。await Recall 前固定 anchor 版本，避免把旧正文错误绑定到新版本。已有有效材料随后变化属于 typed input change，沿既有 attempt CAS 回到 pending，或完成旧 sourceVersion 并接替最新 anchor；最初就非法的 Pack、稳定非法模型提案仍为 failed。

下一轮仍由原 Maintenance owner 调度，foreground 和关闭继续阻止执行。同一次 drain 用 work ID 记录已尝试成员，即使时钟不前进也不会反复付费。没有新表、状态、定时重试、模型、参数开关或批量重排历史 failed。额外开销是当前已供给材料的版本/引用检查及本轮短生命周期集合，性能代价尚未单独测量。

最终隔离源四生产文件、一个既有集成测试变更。原源首组 8/9 RED（另1项本来正确），追加边界3/3 RED；最终实际磁盘 SQLite、Formation/Recall/Memory/Maintenance 的 Recovery 29/29，加 Learning/Maintenance 48/48，tsc/lint/format 通过。新 owner 重开同库仍在同一进程，不宣称跨 PID，也不是自然模型长期成功率。所有检查在第6家族共同构造期运行，未修改正在运行的正式源。

最终源 freeze `1be4edce801efa81a85be1f49371257cd7ca9337bdf1b5e186805d392d8e6f76`，完整 patch `7e29c970e46b8e6440be3c1743f7cbbc82f88d9996900ccd7d8becbc18515142`，验证记录 `3f6497a551e404e6f818a20a58959939f880feaf17db6cde73ddbd6a180695ad`。Root 已按五文件 before/after 精确合入 Main；集成后完整离线、构建及受影响桌面流程另列实际回执。仓内仅保留修复后的单一路径及其回归，隔离源和原始日志留仓外。

Root 合入后实际 Main 完整离线2445项通过（136 contract、1670 unit/component、639 integration），49.153秒；生产构建13.602秒、受影响 MemoryActivity/Journey Electron 3/3、8.646秒。运行 2026-09-17 02:22:19.797–02:24:21.004 UTC；源码和真实命令回执记录 SHA `33d27ec64bc5e2a3516878efabfed8f72c2046236b239ff687c425669906aaed`。这是恢复机制的集成验收，实际长期语义与最终安装另计。
