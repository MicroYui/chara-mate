# MEMORY-GRAPH：个人记忆是否需要图关系

> 2026-09-16 当前状态：以下 G0 NONE 是早期 R0/top8 基线的原实验结论和当时删除证明，不再描述 Main v21 的完整 schema。当前同一 Memory 域已有具备来源的实体/修订关系，并在必要时做一次受预算约束的关系扩展，另见 MEMORY-EXPANSION-REPLACEMENT、MEMORY-REVISION-LIFECYCLE。没有新增独立图数据库、图产品界面或运行时 Arm；当前选择不改写本记录六题的历史结果。

## 问题与边界

本 Decision 只回答：在已选 Retrieval/Context Pipeline 上，SQLite 内嵌的一跳关系是否带来足够的最终回答收益。图不是默认架构；若收益不能覆盖实体、边、Revision evidence、索引和 UI 状态，产品不创建图表、图检索分支或空图谱入口。

所有边必须指向 Memory Revision evidence。实验只涉及人物、项目、地点、偏好、事件和作品，不建设通用知识图谱，也不加入独立图数据库。自定数值门槛只作证据，定案综合回答质量、无关扩展、延迟、写入/维护成本和用户理解，不机械以单项门槛否决整体结果。

## 来源、环境与冻结数据

- 执行日、基线、硬件、Provider 与 `MEMORY-RETRIEVAL`/`CONTEXT-RECIPE` 相同。
- 冻结中文产品集含 6 个显式 graph 问题及跨 Memory/时间/更新对照；公开确认集补充多会话组合问答。产品集 SHA-256 复用 `MEMORY-RETRIEVAL`。
- 五条双向关系在运行前按 6 个产品 graph probe 的已知 Memory 关系人工标注为独立冻结文件 `graph-edges-v1.json`，SHA-256 `de6b0ab48437beef34eeb5b550554e19da2989be3cce831cc4e3d252779794a4`。它是 oracle-quality 能力上界，不代表生产实体抽取精度；确认问题不用于回调关系或扩展规则。

## Arms

| Arm | 图状态 | 在线行为 |
| --- | --- | --- |
| `G0-NONE` | 无 | 只用已选 Retrieval topK |
| `G1-EXPAND` | SQLite 实体/边/evidence | topK 命中实体后有界一跳补充关联 Revision |
| `G2-FEATURE` | 同 G1 | 图邻接只作为融合排序特征，不额外扩展 |

先离线比较 evidence Recall/precision 与无关事实；只有 G1/G2 在 graph 类产生可见增益才进入同一 reader 的最终 QA。G1/G2 相当时选择状态更少、在线行为更直观者；二者都不改善最终答案则选择 G0。

## 指标与综合选择

- graph 与非 graph 类最终 QA、required evidence Recall@8、MRR/nDCG；
- 无关/冲突/过期事实增量和引用一致性；
- 实体/边 precision、每 Revision 边数、写入放大；
- 查询 p50/p95、主库体积、重建/删除/Revision 更新；
- 数据表、索引、在线分支、Memory UI 和维护复杂度。

图只提高候选 evidence 数量不算产品收益。若 final answer 无可分辨改善，或扩展把失效事实带回 Context，G0 为胜者并删除全部 candidate schema/code。

## 结果

在已选 R0 FTS top8 上，6 个 graph 问题的 required evidence Recall@8 均已为 1.0。即使给 G1/G2 使用五条人工冻结、双向展开的 oracle-quality 关系，结果仍为：

| Arm | Recall@8 | 额外边行 | 新表 | 在线分支 |
| --- | ---: | ---: | ---: | ---: |
| G0 NONE | 6/6（100%） | 0 | 0 | 0 |
| G1 EXPAND | 6/6（100%） | 10 | 1 | 1 |
| G2 FEATURE | 6/6（100%） | 10 | 1 | 1 |

G1/G2 没有增加任何 required evidence，也没有改变这 6 题的可回答上界。按预注册流程，只有 graph 类产生可见 retrieval 增益才进入 reader QA；因此没有为形式完整继续调用模型，也没有实现实体抽取、写入放大或 UI。冻结关系 SHA-256 `de6b0ab48437beef34eeb5b550554e19da2989be3cce831cc4e3d252779794a4`；最终 raw SHA-256 `eabe35ecc93b5f4b56411ce01c3c343f7b9d990b4cdadedf7e48d1b081ae1123`。

## 综合定案

选择 **G0 NONE**。oracle 关系上界都没有改善 evidence reach，真实实体/边抽取只会再增加错误、表、Revision 生命周期、删除联动和用户理解成本；没有产品收益支持这些状态。

生产 schema、Retrieval、Context、Memory 页面与 Settings 均不存在 Graph 表、索引、文件、分支、组件或入口。候选 runner 已移入可恢复废纸篓；只在仓库外持久证据目录保留冻结关系和 raw 结果。G0 是“没有图实现”，不是运行时开关或 fallback。

## 限制

- 6 个产品 graph 问题用于个人关系链验证，样本量不足以声称通用知识图谱效果。
- 手工冻结边给出图能力上界；若上界也不改善回答，没有必要再为实体抽取模型增加成本。
