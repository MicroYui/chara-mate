# MEMORY-PROCESSOR-RECOVERY：形成处理器变更、接续与配置恢复

2026-09-15。候选基于已冻结队列改动；初次 v8 真实评测不含本包，后续 v9 两臂共同采用本包，分母见 [形成队列记录](COMPANION-MEMORY-FORMATION-QUEUE.md)。改动为生命周期正确性，模型提示、形成 JSON wire、来源窗口算法、嵌入与检索算法不变，没有增加付费实验、运行时算法开关或用户管理记忆的设置。

## 实际问题

原路径把任何未完成工作的 processor 不一致都拒绝。配置变化虽会 `retryFailedFormationWork()`，但仅改回 pending，下一次仍因相同版本检查失败；从未请求模型的工作也不能升级。部分完成工作已经保存准确 source cursor，原实现却只提示 explicit reconciliation，没有可执行接续入口。

另一处实际时序是配置事件发生在模型 await 中：即时 retry 只处理那一刻的 failed；当前请求随后才失败，就错过该事件。只比较可变 version getter 的调用前后值也无法证明请求所用真实模型，Profile A→B→A 尤其如此。Main 固定实际 Profile/runtime 的修复由根集成负责人所有，本包提供必须传入的 expectedProcessorVersion 合同与段提交的执行归属核对。

## 源码与官方约束

研究基线与补丁逐文件 hash 见 `q3b-before/manifest.json` 和最终 handoff manifest。实际本机 Node 24.18、better-sqlite3 13.0.1、SQLite 3.53.3、OpenAI SDK 6.49.0；本包不更换依赖。2026-09-15 复核 [SQLite RETURNING](https://sqlite.org/lang_returning.html) 与 [SQLite transaction](https://sqlite.org/lang_transaction.html)：UPDATE 可以对直接更新行返回结果；RETURNING 自身不是外层事务已提交的证明。此处以一个同步 UPDATE 原子改变 processor/attempt/progress，并在现有同连接事务中原子提交事实和 cursor，不跨 await 保持 SQL 语句或事务。

这不是模型协议的固有版本规则，而是 CharaMate 依据真实源码缺陷选择的执行生命周期。既有实际恢复触发是 `ProviderService.changed → MemoryMaintenance.retry()`；Data 页面没有 Memory retry 接线，也不新增逐条审批/修复 UI。未发布 v26 的内部工作表直接沿用，没有旧库迁移、新表或 alias。

## 选定行为

- complete 工作始终回放原完成回执，当前已被修改、归档或删除的 revision 继续按既有规则列入 unavailableChanges，不重新形成。processorTransitions 随领域和 Tool 回执保留，不把混合处理器的前后片段都归为最后模型。
- pending 工作在 start 的同一 UPDATE 绑定当前处理器、保存已校验进度并递增 attempt。从未尝试且无进度的工作没有虚构的旧执行历史。
- 已尝试且处理器发生变化的已知 `source-windows-v1` 进度，保留原 workId、不可变 source refs、segmentBudget、cursor、changes 和先前选中 revision IDs。只从未提交片段继续，不能重读已完成前缀制造被用户删除的记忆。每次实际交接在 progress/完成回执追加 from/to、atCursor、priorAttempt、priorErrorCode 和 recordedAt。
- 未知进度协议、非法 cursor、cursor 落在 context-only source 内、缺少 canonical 来源均不得猜测或静默从头再来。已有进度和原错误保留，失败可见，无模型调用。同一处理器版本下，普通 wake 或单纯重启不循环重试 failed；后续已加入的版本就绪恢复见下方当前边界。
- `MemoryFormationModel.form(input, {expectedProcessorVersion}, signal)` 要求具体调用的执行版本。固定 ModelMemoryFormation 实例在 generation 前核对自身版本；宿主外层的 profileId/apiStyle/modelId 绑定由 Main 同一 runtime factory 负责。第二次形成也必须使用该 work 的原期望版本。
- 实际提交归属为现有 `{workId, processorVersion, attempt}`。事实写入前在同一事务核对该 work 仍 running 且属于此次执行；save/finish/fail/suspend 同样限定归属。迟到结果既不能写事实，也不能把较新执行改成失败。
- 配置 retry 只将既有 `uncovered` 谓词判为仍未处理的 failed 工作重排。单个同 persona/situation 的 complete 工作若已覆盖全部相同 canonical sources 和 primary/context 用途，旧失败行、错误、attempt 与统计原样保留，不因配置事件再收费；部分覆盖、多个分散 complete 工作或用途不符不能豁免。
- 配置 retry 立即把当时符合恢复条件的失败工作持久置 pending。在途工作只记一个内存 deferred retry 请求；当前 work 终态后即消费一次并返回 lane 边界，不等后续长工作，不因同一事件反复重试后续失败。没有定时器、指数重试循环或新增后台 owner。

## 恢复边界

当前 Main v21 的启动恢复保留 interrupted running→pending，并在真实处理器版本就绪时把未被覆盖的旧版 failed 重新排队；同版 failed 不因纯重启循环付费。配置事件已经把任务持久置 pending 后，下一次启动继续处理；关闭中的形成保存为 pending，异常退出仍由 running 恢复。新的 memory.record 执行可定向恢复其真实来源工作，普通文本 Run 的首个真实完成响应还可恢复匹配当前处理器的三类已有连接失败，分别见[形成恢复](MEMORY-FORMATION-RECOVERY.md)与[巩固恢复](MEMORY-CONSOLIDATION-RECOVERY.md)。

deferred 配置通知本身仍只存在内存中。若进程恰在工作持久写 failed 后、lane 消费 deferred 标记前异常退出，该通知不保证重放。当前版本与失败版本相同时，仍需后续适用的实际恢复事件；处理器已更新的失败则可由版本就绪路径恢复。没有为这个间隙新增持久通知表，也不冒称所有配置通知跨崩溃恰好执行一次。source/progress 已持久；本包原普通停止/关闭检查与尚未实测的 OS 强杀间隙保持原边界。

## 验证与局限

最终候选受影响 Memory 单元与真实 SQLite integration 共 **13 suites / 182 tests 通过，1.40 秒**；包含既有 CRUD、来源、修订/删除回执、检索、索引和工作队列检查。新增/改写的关键检查包括：未尝试升级只请求新版本一次；完成回执不重做；旧模型提交首片段后失败，新模型只读余下片段并保持准确全局引文偏移；删除旧前缀后不复活；unknown cursor 保留结果/原错误且零请求；running 必须先 startup recover；旧返回结果不能覆盖新 attempt；比较期间版本变化不能发第二次形成；固定 Model 实例拒绝不匹配期望；普通 wake/restart 不触发失败重试；配置事件发生在 await 中只接续一次，后续无关失败不跟着重试；完整来源覆盖不重排、部分覆盖/分散完成/仅 context 覆盖仍重排。

焦点文件 ESLint 和 Prettier 通过。detached 全量 tsc 的旧 Main/UI/跨域 fixture 与当前共享合同存在先前漂移；Memory 源码、Memory fixture 和 Memory integration 无 type error。根负责人仍需将同版 factory/Provider snapshot 修复与本包一起做整仓验证，不能把领域通过写成 Main 全量通过。

本包无需通过真实模型证明 SQL 原子性或取消行为。Q3A 的六故事真实形成比较在独立冻结 v8 bundle 运行，其结果和失败分母不会因本包而回写。处理器切换后抽取质量仍由实际选择的模型决定；接续保证来源范围与执行归属，并不保证所有可记事实被提取。没有宣称未来价值预测、自动全库重建或无条件自愈。

## 删除与交付

生产保留一个形成路径，删除原“processor 不同永久失败”分支和无归属的运行结果写入方式。无输家模型、库、候选 API/Settings 残留；候选 runner、离线原始日志、Q3A 两臂均在仓库外。公开 MemoryService 方法不变，仅内部 Model 和 Repository 的形成执行参数收紧。共享 schema/DDL/Main 不由本包改写，根负责人是唯一集成 owner。

## Root 集成补充

集成状态更新：所选处理器接续与实际 runtime 绑定已进入 Main v21；当前构建与最终桌面验收见 [STATUS](../progress/STATUS.md)。Root 接入 memoryFormationRuntime，每次形成绑定实际 Provider 配置快照，异步准备不改变请求归属。下文集成结果对应当时的 processor v10 及作用域修订；当前形成处理器已到 v18，不能把当前实现或离线通过倒写成旧 v8/v9 的实测结果。

包含 Main factory、Provider 和本包的隔离全量离线在 21:31 通过 1,475 项：134 contract、1,029 unit/component、312 integration。对应时间为 1.12、5.79、9.39 秒；这次还含 Q4，不是本包单独效果。原领域报告中 detached Main type error 的边界已由同版集成解决。当时的 canonical 原文回收沿用同一完成覆盖规则，并删除了无产品调用者的单工作 retry 方法。此后[形成恢复](MEMORY-FORMATION-RECOVERY.md)为实际新执行的 memory.record 接入同一来源 work 的定向恢复；它复用既有服务与游标，没有恢复用户管理内部任务的界面或第二套队列。

本包补丁 SHA256 为 `6e5e29e15de673f8bbb864e2198c14dbfe3dcdf870aa019514ae5bcad0ff74c5`。基线、逐文件结果与原始检查日志归档于仓外 `memory-queue-candidates`，不保留候选实现或运行开关。正式调用后配置改变时的模型质量不由生命周期检查保证，仍由连续场景验收承担。
