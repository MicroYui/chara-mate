# 明确工具名称与当前可用范围的搜索修复

2026-09-16。选择修复两处实际工具供给错误，保留已选 metadata BM25、全语料统计、执行资格和最终供给上限。先合隔离共同 v19，现已随共同 v21 集成 Main；该次 v21 完整离线验证通过；最终同版连续执行另行验收。

## 当前来源与问题

按当日官方 [Tool search 文档](https://developers.openai.com/api/docs/guides/tools-tool-search)及锁定 `openai@6.49.0` 的 Responses 定义，客户端负责发现并返回工具；协议没有规定 BM25 排名或名称优先级。SDK 文件 SHA `a9750c98699ed1d5a8941af9adc709f5d71dfc5bac0deec7c13b392bb4444fb2`，读取行 7121–7224、8402–8422。既有 [tool-discovery 决策](tool-discovery.md) 中 8 是最终 Schema 供给选择，不是资格过滤前最多考察 8 个。

Life3 的真实查询 `+territory.observe`、`territory.observe 读取当前住处布局 revisionId targets` 在 limit=1 时都返回 territory.act，原因是其他工具描述提及了 observe。后续 Root 检查发现 Runtime 请求全局排名后才筛选当前 Run 范围，但 Registry/BM25 已先截到 8；前 8 项不可用时，真正允许的第 9 项消失。

## 唯一实现及验证

Registry 先识别实际已注册的完整工具名称，按查询顺序去重，再以原 metadata BM25 补足。自然描述沿旧排名；它不新增语义模型或手写同义词。当前 Runtime 已算出的 available Set 同时约束名称命中与 BM25 候选，在最终截取之前生效。BM25 的总文档数、DF、平均长度和排序不变，不按当前小范围重建索引；真实调用仍沿原 Dispatcher 资格检查。

两个实际名称查询修复后均返回 observe。五条自然控制的完整排序未变；其中一条中文自然查询原本为空，仍为空，不能宣称解决自然语言匹配质量。

范围修复先冻结未改生产源码的失败：真实 SQLite/AgentRuntime 注册 9 项，分别在 Chat 与 Automation 所选范围测试自然查询、不可用名称混合查询、多名称查询。6/6 原搜索输出为空，修复后全部供给并执行允许读取一次。另三项检查空/未知集合、限制值及全语料统计；特意构造重建小库会颠倒顺序的例子，防止范围过滤暗改排名。新增九项原实现均失败。

Root 名称修复组合检查 98/98，范围修复后 Tool/Runtime/Capabilities 四文件 107/107、3.59 秒；全 TypeScript 与受影响 lint/format 通过。交付方更换一个领域套件的 109 项与 Root 107 项不是同一分母。脚本 Provider 只验证 Tool Search → Schema → Dispatcher 机制；本包零真实模型、encoder 或原生操作，不计自主行为质量。

## 复杂度、证据与边界

范围参数是一次调用的 ReadonlySet，复用现有 Run 可用范围，不增加权限来源、状态、缓存、Settings、fallback 或检索算法。名称修复与范围修复最终只形成同一个 Registry/BM25/Runtime 路径及普通回归。原查询、失败和自然控制保留；候选实现和执行记录均在仓外，最终交付按清单清理。

名称交付 `platform/tool-identity-discovery/HANDOFF.json` SHA `d57d7c835f6f2cb971617e321b2b95e64bc739fc647274d4fe14f9befc9f96cb`；范围交付 `platform/tool-scope-discovery/HANDOFF.json` SHA `57d356b50dcea55c1e00bc00381c5d7032c7be3240f70b191b6297956014d6e2`；Root 组合 `integration/tool-scope-integration-20260916/FREEZE.json` SHA `f9978aefb88c6c20a1b38c1f77294ea510577551ce62e0ecdf7764ac8f5a1b7d`；共同源 `COMMON-V19-SOURCE-FREEZE.json` SHA `067ceb0902e92b8cec972fc06113a7778787f3ea3cd019307a60d32ef72e70a3`。

不保留已知漏供给路径，也不把本次修复当作新的自然检索选型胜出。后续[当前真实能力 C1](COGNITION-CURRENT-CAPABILITY.md)已在两个历史家族取得有界恢复结果，但不增加本搜索包的零模型分母，也不证明完整长期自主活动；最终同版连续验收仍待完成。
