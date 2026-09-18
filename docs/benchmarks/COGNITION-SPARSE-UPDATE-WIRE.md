# COGNITION-SPARSE-UPDATE-WIRE：模型仅返回情境变更

2026-09-15 的开发比较选择 typed 字段更新；唯一实现随后已进入 Main，共同 v21 沿用该路径并在晋级时通过完整离线验证。下文输出、耗时与旧 v3 wire 均是原冻结阶段结果，当前模型 wire 为[Intent完成合同](COGNITION-INTENT-COMPLETION.md)的唯一 v6；本记录不证明最终持续桌面理解已达标。

## 问题、范围与选择

持续情境已经保存在 SQLite，但原模型每次更新仍需重述整份 Situation/Intent，包括没有变化的 episode、claim 和来源 ID。本次比较模型是否可以只返回有实际变化的字段与子项，由主机使用**该次真正提供的视图**恢复完整领域值，再接受原来的 schema、来源、revision、allocation 和事务检查。

选择这一边界的依据是：6 组开发输入没有发现明确事实质量损伤；输出 Token 减少 22.6%；剔除受实验者暂停影响的一整对后，其余 5 对请求到原始主机处理终态的总耗时减少 14.0%，4 对更快、1 对略慢。代价是输入 Token 增加 10.5%，新增约 290 行边界转换与验证代码，并曾出现两个主机解码失败。它是小规模、开发阶段的增量选择；若未来质量与维护证据不再支持，可用新的独立决策替换，生产不保留两个模式。

这不是对本地模型、两级认知、更多并发、Memory 检索或完整产品体验的选择。Main 的 Run、调度、可见交付及工具执行没有分叉；输入仍受用户明确要求的单次完整输入 **258,000 Token** 硬上限约束。

## 一手依据与版本

查阅日 2026-09-15，依赖和文件 hash 见外部预注册。

- [OpenAI Structured Outputs 官方说明](https://developers.openai.com/api/docs/guides/structured-outputs)：strict 输出受 JSON Schema 子集及 required 字段规则约束。它保证的结构约束不等于事实正确，也没有规定情境必须输出完整快照或某个工作集大小。
- [OpenAI Node SDK v6.49.0 Responses 源码](https://github.com/openai/openai-node/blob/v6.49.0/src/resources/responses/responses.ts)：本次 Responses 请求、流式事件及终态的协议依据。官方 SDK 位于既有 Provider adapter 内，没有接管领域状态机。
- TypeBox 0.34.52、better-sqlite3 13.0.1、SQLite 3.53.3；实际 `structuredOutput.ts`、`CognitionRepository`、`CognitionSnapshotReader` 源码是恢复、CAS、partial slots 与事务行为的依据。下述完整值替换修正来自实际本地代码及 SQLite 回归，不是脑科学推导。
- [SQLite Transaction](https://www.sqlite.org/lang_transaction.html)规定读写事务及单写者行为；领域变更与 revision 校验使用既有同步事务，不跨 `await` 保持写事务。

32,768-byte 工作集是本次比较的本地分配护栏；6,000-byte 是让开发 fixture 出现 partial view 的实验配置。它们均不是模型协议上限、脑科学阈值或本实验选出的最优值。

## 预注册与两臂

同一 gpt-6-astra、同一 Provider/Persona、完整来源与 SQLite 初态、空 EvidencePack 的 evidence-completion 阶段、相同图像、相同 compact JSON 指令、相同 v2 attention 三态。均未显式设置 `reasoning.effort`；12 次 `response.created` 实际报告 medium，不能据此说生产代码强制 medium。

唯一算法差异是更新 wire 的 typed 表示及解释该表示必需的说明。奇数组 full→更新，偶数组更新→full，共 12 次。没有重试、补样或 holdout 标签读取。空 EvidencePack 明确只测完成阶段，不伪称已测试真实检索和被动形成。运行窗口为 11:09:24–11:23:01 UTC，Apple M4 Pro、24 GiB、arm64、Node 24.18.0；与同一代理上的 Memory v6 开发工作可能重叠，没有证明服务端完全独占。

字段语义如下：

| 边界                                    | 含义                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| 已有实体的 required 字段为 null         | 保持当次 supplied 值                                                                  |
| required 字段给出实际值，包括合法空数组 | 设置该值                                                                              |
| optional 字段 keep / set / clear        | 保持 / 设置 / 删除；不是以 null 混合两种意义                                          |
| episodes / claims                       | 仅列变更或新增 ID；新 ID 的所有 required 字段必须完整                                 |
| episodeOrder / claimOrder               | null 保持可见既有顺序并追加新增项；非 null 必须是全部可见及新增 ID 的唯一完整排列     |
| partial allocation                      | 保留 canonical 既有槽位、未见历史与 preservedFields；不可借提供父 ID 改写未提供的子项 |
| historyEvidenceIds                      | 主机拥有；不是新事实支持，也不能通过模型更新写入                                      |

新实体仍完整创建。没有 JSONPatch 解释器、新的状态库、旧 wire fallback 或用户设置项。

## 完整 12 次结果

耗时为请求开始到原始响应/主机终态；第 2、3 次原来没有完成提交，因此不把下表统称为 12 次成功提交的端到端延迟。两次修正后的提交只在离线重放测得，未重复生成。

| 输入                                  | full 次序 / 秒 | 更新次序 / 秒 | 原始提交 full / 更新 | 输入 Token full / 更新 | 输出 Token full / 更新 |
| ------------------------------------- | -------------: | ------------: | -------------------- | ---------------------: | ---------------------: |
| 跨 App 延续支付回调，同时保留练琴事项 |     1 / 81.365 |    2 / 61.113 | 成功 / 主机失败      |         9,560 / 10,533 |          4,499 / 3,346 |
| 接受香菜的改口，阿澄花生过敏不变      |     4 / 70.413 |    3 / 67.952 | 成功 / 主机失败      |          8,298 / 9,271 |          3,885 / 3,435 |
| 英文简历写入与中文保存未知            |    5 / 53.319† |    6 / 50.334 | 成功 / 成功          |         9,223 / 10,196 |          3,659 / 2,792 |
| 取消的角色灯塔计划，后来允许继续生活  |     8 / 78.071 |    7 / 63.676 | 成功 / 成功          |        11,323 / 12,296 |          5,372 / 3,574 |
| 92 天后续接大字册子，局部历史视图     |     9 / 31.368 |   10 / 31.790 | 成功 / 成功          |          7,244 / 8,217 |          1,909 / 1,758 |
| 实际最新蓝色 PNG 与旧绿色历史         |    12 / 31.841 |   11 / 27.422 | 成功 / 成功          |         9,743 / 10,716 |          2,195 / 1,757 |

† 第 5 次遭遇实验者造成的约 32.98 秒进程暂停；原始耗时保留，**整对 effect_failure 不用于干净速度判断**，没有从耗时中直接扣掉暂停并冒充干净结果。后续调度已经加入请求之间的明确停止入口；产品没有这套实验控制。

- 原始在线提交：full **6/6**，更新 **4/6**。12/12 都有完整 JSON 与终态 usage；没有尾随空白或被截断 JSON 的 Provider 失败。
- 同一修正 decoder、同一原始响应、相同 SQLite 字节的零网络重放：**12/12 提交**。这与原始成功率分开记载。
- 全 6 对：输入 55,391→61,229 Token（**+10.54%**）；输出 21,519→16,662 Token（**−22.57%**）；实际 JSON 59,911→44,721 bytes（**−25.35%**）。未按未提供的价格单虚构人民币成本。
- reasoning Token 为 1,736→1,742；cached-input 命中均为 0。Provider 另报告 cache-write 55,373→61,211，不能把写入量称为命中收益。
- 干净 5 对：293.057→251.953 秒（**−14.03%**）；配对平均差 −8.221 秒。对 5 个开发差值进行全部 5⁵ 有放回组合的描述性 95% 区间为 **[−15.522, −1.699] 秒**。这不是随机用户总体置信保证，且其中两次原始主机解码失败的耗时仍须如上解释。
- 单次实际 input 最大 12,296；含系统、schema、图像等完整请求的保守估计最大 90,250，均低于 258,000。input-token count 端点返回 404，沿用既有保守预算门；没有把缺失精确 count 伪称测得。

## 语义评审与可见边界

实现者做过逐例检查；root 随后只阅读六组 A/B 来源、真实 PNG 和修正 decoder 提交后的状态，冻结评分后才可查看映射。**这只是映射盲评**：逐例评分前已收到作者“18/18”的汇总，因此不是完全隔离的独立盲评。

六组均 tie；每臂 17 项标准全覆盖通过，另 1 项按实际可检查部分通过。没有观察到事实错误、虚构行动、缺依据的世界效果、丢失可检查历史或过度干预。两臂在是否另建 Situation、保留额外待答 Intent、划分 Episode 上有差异，本轮没有证明哪一种长期更好。

必须保留的覆盖限制：

1. bounded_history 的两个 episode 都在输入中，preservedFields 为空；真实模型该例只验证隐藏的 5 条 claim 保留。**不能宣传隐藏 episode 或 protected scalar 已由该真实案例覆盖**；它们有单列离线 SQLite 回归。
2. effect_failure 的原 fixture structured outcome 是 unknown，即使文本描述成功或只读失败，也只证明如何处理这种限定输入；不是各种真实成功/失败 Tool 回执的完整验收。
3. 蓝色图像是实际附加的 400×300 PNG；旧绿色保留为带时间来源的历史。没有真实桌面屏幕流、OCR 权限质量或用户读取理解验收。
4. 六例每臂一次，审阅的是持续状态和候选行为；没有实际 Chat 投递、Territory 动作、Memory formation、长期用户研究或商业验收。

## 原始主机失败与修正

第 2、3 次失败来自 strict-required 的嵌套 optional null：`required T|null` 包裹 objectRefs/resumeConditions 后，公共 restore 不递归任意 `anyOf`，导致 appId/url/after 的 null 未被恢复。原机械编码直接使用领域省略值，没有暴露真实 strict 输出。

修正仅在此边界对**已知 concrete 分支的原字段 schema**恢复嵌套 Optional；没有为任意 union 猜类型。required null 仍保持，真实空数组仍设置，未知字段和缺失 set.value 仍拒绝。所有 12 个请求/schema/prompt/input hash 与原冻结值相同；原失败和第 5 次调度干扰未被覆盖，也没有额外付费请求。

初版机械比较还曾把顺序归一化；实际 SQLite 暴露下一工作集排序会变化后，才在付费前补齐 typed childOrder。保留旧 25 组归一化结果的限制。修正后 25 份原输出的字段映射、14 个 wire 检查和 7 项实际 SQLite 比较通过；不是 25 份完整 SQLite 等价测试。

## 生产化发现的独立正确性修正

将唯一边界重写后，实际 SQLite 回归发现既有完整更新 `{...previous,...value}` 会让已删除的 optional 字段复活；partial 保存只做 json_set，也有同一问题。这不是本 12 次比较的收益来源。

本次独立修正让完整业务值只与身份/createdAt/revision 元数据合并；partial 写入先删除完整值已省略且未受 preservedFields 保护的 optional 路径，再写入当前值。数组仍按原可见 ID 槽位合并，历史来源仍由主机累积。回归覆盖 nextWakeAt 清除后的调度、supersededBy 清除/恢复、被保护引用保持、隐藏 episode/claim、旧支持转历史、未知子项拒绝和 revision 变更拒绝。

将全部 12 份已有 raw 在新单一路径与修正后的 Repository 重放，12/12 提交；六份更新的展开领域 delta 与已修正实验 decoder 完全相同，更新 schema hash 也相同。原案例现有实体的这些 optional 字段没有产生额外差异，因此不能拿这 12 份样本代替新增正确性回归。生产 schema 名称提升为 `charamate_cognition_analysis_v3`，没有改变用户模型或 reasoning 设置。

## 持续吞吐仍未解决

另一个零网络、真实 Service/Repository 的 30 分钟回放发现：每秒新文本、60 秒一轮空 delta/quiet 分析时，结束仍有 **1,183** 条新内容来源未跨过连续水位；最老未处理内容 **19.7 分钟**，停输入后还需 **53.9 分钟**追赶。当前对象的最新版本会优先进入旧页工作集，但生成期间继续发生的变化不会自动进入已发出的请求。

该回放版本的 `decisionIsCurrent` 检查整个分析的 evidence read set，不只检查所选行为直接依赖的来源。这使同对象历史页和持续变化将 quiet 回放中 82/83 个已提交 Attempt 判为不再适用于行动；不能称为 82 次实际动作失败，更不能据此直接放松 guard。后续已通过[行动依据拆分](COGNITION-ACTION-CONTEXT.md)与[实际接收边界](COGNITION-ACTION-RECEIPT-BOUNDARY.md)分别修复这些机制；原回放不重算，不能作为当前 guard 拒绝率。详见独立 `COGNITION-CONTINUOUS-AGE` 记录。减少 14% 耗时不能使这个容量缺口消失。

## 复现标识、单路径与清理

外部 evidence 目录的主要标识：

| 文件                           | SHA-256                                                          |
| ------------------------------ | ---------------------------------------------------------------- |
| PREREGISTRATION.json           | e8bdc4df71f338d7f5a8f64d36d7e9b627a205de3fb38656862e88c9cf4b2c99 |
| HOST-CORRECTION-AMENDMENT.json | d45da6a8a781a27ff3231069720f5436ea9490c6b1b9dfea297f3edb3e66987b |
| paired-summary.json            | a29ce8826f532e7b66de7557cba51999810d668fedcc52c1cbce5aaf808d02c6 |
| root-review.json               | cd5c8d90589384886aa7b7578462c3a2e87b522251f1971c7f29c5712a91d85c |
| host-correction-replay.json    | fe7dd7d86f77a71b3e8231bddee08061e86a1ed11aa860e9eda627c1f92af289 |
| production-replay.json         | a87a2abf3d5b127f14ccdc163c2a5609170b7e5a954ebeadf722fb18e26d60ba |

最终单一路径由 `cognitionModelOutput.ts` 构造 typed 模型 schema、恢复 supplied 字段并做双层验证；`cognitionDriver.ts` 只调用它，Repository 保留领域权责。没有 full/sparse Arm 标志、机械 encoder、旧模型 fallback、第二个分类器或 UI 调参。

验证与删除证明将在同目录 HANDOFF.json/CLEANUP.json 固定：保留非敏感 raw 请求/响应、输入 fixture、结果和 hash；删除外部实验 runner、编译 bundle、机械 encoder、候选 schema 文件及共享 node_modules 的符号链接。领域回归是重写的普通合成用例，不带 Arm 标识，不复制实验模型答案。Main 集成、全仓回归与产品验收由集成 owner 最终记录。


## Main 集成核验

2026-09-15 root 已核查源码与冻结真实结果后集成唯一生产路径。主树 `npm run verify:offline` **1,307/1,307**（134 contract、887 unit/component、286 integration），typecheck/lint/format通过。相关桌面Provider fixture已更新为当前wire；本次尚未重跑Electron E2E与最终包，不用离线通过代替可见体验验收。
