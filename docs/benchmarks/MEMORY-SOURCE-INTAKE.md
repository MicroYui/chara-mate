# Memory 形成来源引用入口

2026-09-15，root为Main、共享合同和数据库集成owner。选用统一的来源引用入口，删除完整Episode生产入口。与原文块存储、认知持久交接的相邻决策分别见 [来源存储](COMPANION-MEMORY-SOURCE-STORAGE.md) 与 [认知交接](COGNITION-MEMORY-HANDOFF.md)。本包没有模型调用，不声称语义质量提升。

## 问题与选择

Memory已经保存某来源后，Main仍先读取所有正文、排序并hash完整Episode，会在每次重复移交时再次付出正文物化成本。现统一传入来源ID、用途与顺序，由Memory仅在缺少canonical原文时调用其所属领域的resolver。Chat只选择当前Run和紧邻前一交流；Run只读取实际边界之前的终态Tool来源；Activity仍以真实event来源生成canonical JSON。

SourceReference SQL不把content、displayOutput或modelContent返回JS。SQLite的trim和JSON函数仍可能在原生层读取整TEXT；首次外域来源读取也仍可能返回大字符串。本包不是所有底层读取的流式化，不提供未经测量的吞吐/内存改善数字。

## 来源与既有行为

2026-09-15核对better-sqlite3 13.0.1 / SQLite 3.53.3、实际Message与RunItem更新代码、Activity原始字段的可变范围。completed Message和terminal Item不能重写正文；Activity后补endedAt不进入canonical正文。来源ID因此指向稳定的内容、角色、渠道、引用对象与原始时间。

[ECMAScript TrimString](https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.trim)当前在线2027规范是空白判断依据。SQLite默认trim只处理空格，所以查询传入完整WhiteSpace/LineTerminator集合，保留NUL和非空白零宽字符。[SQLite JSON函数](https://www.sqlite.org/json1.html)与[Row Values](https://www.sqlite.org/rowvalue.html)（页更新2025-05-31）作为JSON类型和复合游标依据。Tool名与messageId仍严格保留原先nullish fallback，而非truthy fallback。

单一入口保留各来源的六字段canonical格式和资格：completed非空消息；completed/failed且有字符串status、summary的非memory工具；用户来源Activity。模型摘要不是原文。主材和context按实际身份去重，同一原文既为主材又为context时仅保留主材用途。context不能产生独立的新确认。

工作版本依赖规范化五字段metadata、有序来源ID和primary用途，不再hash重复正文；这依赖上述实际source owner的不可变约束。显式再次注册不同的原文仍由Memory拒绝，resolver没有调用不能当作比较过未提交的正文。

## 两项有意的语义修正

Run的recordedAt取最后primary的原始时间。旧入口取所有来源的最后时间，可能被前一交流的晚到回复向后推；新规则与Cognition的主材时钟一致。因此不宣称整个旧Episode元数据始终相等，每条原文自己的时间仍保留。

独立审查在真实SQLite复现：删除Chat会删除Run、RunItem和Message；旧引用若只是有效新事件的history，仍可让整个混合handoff卡住。现根据宿主实际记录的evidence.chatId查询Chat是否仍存在，已删除Chat的未交接引用退出形成资格。其余有效primary和context照常移交；全部primary退出时不提升context。Chat还在但Item或Message缺失，仍报missing并保留pending；缺少chatId时不猜测删除。已经独立进入Memory的内容继续由Memory管理，不重建Chat。没有新增状态表、权限或删除记录。

## 集成与验证

根代理在独立integration工作树使用实际Chat/Run/Activity/Memory/Cognition仓储完成集成：Memory入队与handoff确认同事务；确认失败回滚原文块和工作，重开数据库后只恢复pending；已有canonical来源无需再次resolver，异步形成只在提交后唤醒。此前开发库的旧Memory来源表升级实验正确增加原文metadata，原Revision/source/span/index保持，外键校验通过。2026-09-17用户明确尚无已发布用户，当前仅保留新库Schema，旧迁移代码已删除；该历史实验不变成本轮兼容承诺。

主集成前完整离线为1,332项（134 contract、903 unit/component、295 integration）；随后删除语义与last-primary时间修正的4文件28项定向验证、完整typecheck通过。手动删除、provisional到期、启动清理的5项实际SQLite回归均保留。主工作区最终于20:09通过1,338项完整离线：134 contract、903 unit/component、301 integration；typecheck/lint/format通过，两个既有TanStack警告。本轮未重新运行桌面E2E或打包验收。

对照协议和来源标识在仓外SOURCE-REFERENCES-PROTOCOL；52文件集成清单及原始备份按hash保留。旧runMemoryEpisode、cognitionMemoryEpisodes、旧全正文Chat查询和对应旧测试均已删除，回归改为实际来源引用、原文解析与原子交接。不保留运行时旧入口或Arm开关。

本包不能证明全天桌面响应质量、PFC注意力吞吐或未来价值预测；后续持续场景与独立holdout仍是商业验收的必要部分。
