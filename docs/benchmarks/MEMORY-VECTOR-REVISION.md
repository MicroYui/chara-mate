# MEMORY-VECTOR-REVISION：按记忆 Revision 的最佳文本块排名

状态更新：按 Revision 最佳文本块排名已集成 Main v21，原 2026-09-15 主树核验保留在文末。本决策只改变向量候选单位，不选择新的 encoder、维度、候选数量、当时的 RRF 或 ANN；当前融合见 MEMORY-RANK-FUSION。

原来的向量 heap 先取 K 个 chunk，再把 chunk 映射为 Revision 去重。一条长记忆的高分重复块可以占满 K 个位置，去重后却只剩一条记忆，低一名的独立记忆完全没有机会进入 selector。采用 Revision 为单位的精确排名：`score(revision)=max(cosine(query, chunk))`；K 表示不同 Revision 的容量。

## 来源与实现

2026-09-15 读取 [Milvus 官方 Grouping Search](https://milvus.io/docs/grouping-search.md)：文档说明分组检索可避免多个文本块挤占同一文档的结果，limit 是组数，每组默认返回最相似项。该页为滚动文档，未标精确发行版；这里借鉴结果单位，没有引入 Milvus、ANN 或其性能承诺。[SQLite SELECT 文档](https://www.sqlite.org/lang_select.html)支持取关联行的 Revision ID，未要求 SQL 聚合或全库物化。实际仓库锁定 better-sqlite3 13.0.1 / SQLite 3.53.3，Node 24.18.0。

候选实现保留原 worst-root heap，增加堆内 Revision ID 到位置的 Map。新块属于已保留 Revision 时，仅提高该项最大分并下沉；新 Revision 优于堆顶时替换。Map 随堆成员同步换位/删除，最多 K 项。淘汰项无需额外历史 Map：截断分数只会上升，旧最大值已不能入选，后续更高块仍可重新进入。

SQL 仅将 `c.id` 改成 `c.revision_id AS id`，资格条件和逐行向量读取不变。Pipeline 直接消费返回的 Revision ID，删除 `revisionsForChunks`。平局按 Revision ID 确定排序；这与原先按 chunk ID 平局排序的结果单位不同，属于明确的新语义。没有模型模式、兼容分支或全库 GROUP BY。

## 冻结与结果

外部证据目录标识 `memory-recall-candidates`。原代码的逐文件 SHA-256 在 `source-freeze.json`；方案在 `VECTOR-REVISION-preregistration.md` 先于候选实现冻结。A 是 chunk topK 后去重，B 是 Revision 最大块分数 topK，使用相同向量、过滤、容量与查询。

- 100 个固定种子生成的重复组数据，每个正/反顺序与完整 max-per-Revision 排序 oracle 比较，200/200 排名一致；包括负分、平局、堆内提升、淘汰重入、最大值在不同位置。完整 oracle 仅存在测试中。
- 真实 SQLite：A 有 125 个相同高分块，B 有一个 0.8 分块；旧实现去重后仅一条 Revision，新实现返回两条。该数值夹具证明候选覆盖，不是中文语义质量评测。
- 真实 Worker 对 126 块/2 Revision 返回两条，与直接 SQL 扫描一致。100k 扫描中发出取消，317.4ms 后以 AbortError 结束；下一次扫描成功，关闭后拒绝新请求。取消每行检查共享标志，不宣称可即时中断 SQLite 首次 step/排序阶段。
- 一套 100k × 512 外部合成向量、已保存的 Qwen 查询向量、K=125，AB/BA/AB 六次真实 Worker 请求，6/6 返回相同 125 个 Revision 及分数。没有重新加载模型。

| 指标 | 原实现 A | Revision 实现 B |
| --- | ---: | ---: |
| 首次 Worker 初始化加查询 | 771.7ms | 842.5ms |
| 两次 warm 查询 | 730.4 / 719.5ms | 769.8 / 725.2ms |
| warm 均值，仅本次样本描述 | 725.0ms | 747.5ms |
| warm Main 最大事件循环延迟 | 2.48ms | 1.43ms |

仅每 Arm 两次 warm，同一 corpus/query，不计算会误导的稳定置信区间。约 +22.5ms / +3.1% 的点估计不代表统计上稳定的减速；这里选择 B 是修正候选单位，不主张扫描加速。直接新 SQL 扫描耗时743.9ms，扫描仍随总块数增长。两 Worker 同进程先后初始化，进程 RSS 从128.6MiB逐步升到296.8MiB，峰值303904KiB；这是含两个 Worker 与分配累积的进程测量，不能当作 B 独立驻留内存。算法新增 Map 的容量由代码约束为 K；未增加与数据库规模相同的分组缓存。

## 决策与边界

采用 B：重复块的数量不再改变另一条 Revision 能否进入向量候选池。没有声称回答质量、语言检索、长上下文理解、RRF 或 100k 语义召回已通过商业验收。长记忆仍需读取全部合格向量并取其最大块分，多个问题仍有多次扫描成本。

生产补丁只含六个文件的必要差异，`vector-production.patch` 与 `vector-handoff.json` 冻结；Repository/Pipeline 必须按 hunk 集成，保护并行队列改动。原实现/完整 oracle/实验 runner 仅在外部证据中；正式测试保留固定数值排序和真实 SQLite 多块回归，测试无 Arm 开关或候选配置。Worker 生命周期实现不变，仅测试返回值命名改为 Revision。

验证：修改树的 VectorSearch/Worker/Pipeline focused 35/35 通过，其中还含独立扩展候选回归；本补丁不含扩展策略。集成者需再跑生产相关领域与静态检查。未运行 Provider、App、E2E 或打包。

## 一致主树验证

2026-09-15 19:33，root 按必要差异集成本项与并行队列/来源改动；`npm run verify:offline` 通过1,280项（134 contract、860 unit/component、286 integration），typecheck、lint、format通过。向量交换函数两处多余非空断言在首次lint失败后删除，不改变算法或已测结果；原失败日志保留。最终桌面、打包和真实长期质量仍由里程碑验收负责。
