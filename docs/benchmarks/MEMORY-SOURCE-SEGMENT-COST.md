# 来源分段 CPU 修正：保留同一窗口

2026-09-15，Q2 大 Episode 调查之后的独立工程修订，无模型调用。输入仍为先前已冻结的 4160 来源（64 主材、4096 context），原文 33,672,800 bytes，输入 SHA-256 `a8eb8b81c34346ad0f690df52d454011d754e05520ea1cd5f18c92fe9bf2dfe0`。本轮从同一 canonical TEXT SQLite fixture 读取完整 Episode；没有通过省略原文、缩短 context 或改变时间排序提升速度。

冻结原分段器每个候选都调用完整 `estimateInputBudget`，其递归投影、JSON.stringify 重复处理已经看过的文本。本轮 B 只分解同一个封闭明文结构的字节与对象成本，缓存每个来源元数据与是否无需 JSON 转义。非 ASCII、引号、斜杠、控制符及孤立 surrogate 仍按 JSON 字节计算。这是原本地 heuristic 的精确计算，不是 Provider token 数的精确计数。最终发送前仍经过完整 Provider guard。

C 在 B 上仅改为逐个 primary group yield。每组仍遍历完全相同的 context 候选；不改变覆盖率或输出。协议先于本轮结果追加在 protocol.md。32 组 Unicode/转义/多预算正确性对照全部相等（包含同样的过小预算异常），每个产出也用原完整 estimateInputBudget 复核。另新增生产回归检验 5 种文本在完整估算恰好容纳和少一单位时的真实边界。

| Arm | 3 次全部分段 | 含 materialize 的首段可用 | 末期 RSS | 全输出 |
| --- | --- | --- | --- | --- |
| A 原实现 | 13.92–14.44 s | 13.98–14.46 s | 261.3–261.8 MB | 7 段 |
| B 增量成本 | 1.32–1.35 s | 1.34–1.37 s | 195.8–196.7 MB | 7 段 |
| C B + lazy | 1.35–1.39 s | 252.8–257.9 ms | 193.9–194.2 MB | 7 段 |

九次结果窗口、coverage、原文与顺序完整 JSON hash 均为 `96fb33c134d506e7643963bf06e943160a5f0d8b53990e726e6d22973dbed28e`。3 次固定交替独立进程不是总体 p95。运行在 Apple M4 Pro /24 GiB，Node24.18.0，better-sqlite3 13.0.1 / SQLite3.53.3；资源窗口由另一评测进程退出后开始。

本轮连续收集全部 C 输出用于公平比较，没有模拟模型 await。因此 C 的 Main 最大 delay 仍为 1.37–1.41 秒，不能声称 generator 自己让出了事件循环。三种都先恢复完整33.67MB原文，故本补丁不解决全量物化和规范来源窗口读取。单 source 的极长文本也尚未单独证明。Q2 仍须重构 durable intake/source window 合同。

本次可独立交付 B：函数仍返回原数组，FormationService 及其恢复进度不改，避免与下一来源窗口合同进行两次接口变更。C 仅保留外部证据；待服务改为持久窗口游标时删除旧数组路径，不保留两个运行模式。

文件与 hash 在 segment-incremental-handoff.json；raw 在 segment-performance-results.jsonl 与 segment-correctness-results.json。源码补丁 segment-incremental-production.patch 已通过当前 Main git apply --check。隔离树 focused 51/51、ESLint、Prettier 通过；一致主树领域验证由 integration owner 执行。暂未加入 Q2 storage 的最终晋级决定。

## 一致主树验证

2026-09-15 19:33，root 按必要差异集成本项与并行队列/来源改动；`npm run verify:offline` 通过1,280项（134 contract、860 unit/component、286 integration），typecheck、lint、format通过。向量交换函数两处多余非空断言在首次lint失败后删除，不改变算法或已测结果；原失败日志保留。最终桌面、打包和真实长期质量仍由里程碑验收负责。
