# COMPANION-ATTENTION：细粒度事实进入有界工作集

> 2026-09-15 后续状态：本记录描述第一轮原型，按应用工作集和开场专用语义门已被商业级持续情境重构取代；下文原始实验与局限保留，不能当作当前运行时合同。当前实现见 COMPANION-COGNITION-BOUNDED、COMPANION-COGNITION-THROUGHPUT 和 STATUS。

日期：2026-09-15。状态：**接受当前单一路径作为本地落地的结构护栏；确定性回放通过；注意力语义质量及真实用户体验尚未验证。**

本次选择是：细粒度桌面事实先在来源侧聚合，再进入按应用维护最新观察的本地工作集；纯操作计数更新事实，但不独立触发主动陪伴的语义模型。同一应用中的真实内容变化可以进入语义判断；角色是否应当开口，仍由同一个主动陪伴语义门和普通 Run 决定。没有新增脑区 Agent、分类器、第二条 Run 路径或算法 Settings。

**24 KiB 没有经过参数候选的事前预注册或质量比较。** 它是本轮实现先采用的工作集护栏，下面的回放在实现之后验证有界行为，不证明这个数值最优，也不把它写成“实验胜出”。五分钟来自项目既有主动消息保护值，本轮将同一个值用于两次语义评估之间的最小间隔；这是工程取舍，不是 SOTA、脑科学定律、Provider 硬限制或真实用户已经接受的最佳频率。

产品依据为[产品设计](../../REFACTOR_PRODUCT_DESIGN.md)的细粒度 Activity、主动陪伴和单一 Run 约束，以及[UI 设计](../../CHARA_MATE_UI_DESIGN.md)的自然参与与低管理负担方向。科学依据与完整研究见[认知和自主生活研究](../research/ai-companion-cognition-and-life-2026-09-15.md)。

## 问题与本次边界

只记录前台应用和窗口标题，无法区分“仍在同一个编辑器”与“已经阅读了另一段资料”。直接把每次点击、按键、滚动和内容版本追加到模型上下文，则会产生不断增长的输入，也可能把普通操作误当成应该开口的机会。

本包处理已取得的桌面事实进入注意力上下文的结构问题：事件来自哪里、代表谁的操作、保留哪一份当前观察、什么时候具备再次调用语义门的条件。它不声称已经解决准确理解意图、选择最值得关注的线索、找到最佳开口时机或长期情感陪伴。用户明确发出的文字、语音和任务仍沿原有 Run 路径处理，不经过这个五分钟主动观察冷却。

此次工作集的入口仍是 `ForegroundActivityObservation`。它不等于社交通知、任意普通浏览器 DOM、所有角色内部事件、多模态屏幕理解已经全部接入的通用事件中枢。

## 当前唯一实现

### 来源、局部可见性和 actor

[原生观察器](../../src/main/activity/native/macos-active-application-observer.mm)、[来源归一化](../../src/main/activity/activeApplicationSource.ts)、[捕获协调器](../../src/main/activity/activityCaptureCoordinator.ts)和[受管 Browser](../../src/main/browser/managedBrowser.ts)保留原有 `active_app`／`managed_browser` 数据来源，扩展观察合同中的 `boundary`、`content`、`contentStatus` 和 `interaction`。

| 来源或行为                  | 实际证据与限制                                                     | 归属及进入工作集方式                                                                               |
| --------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| 应用启动／退出              | NSWorkspace 可见应用生命周期；不宣称所有后台／LSUIElement 进程覆盖 | system 事实；不把后台启动当成当前前台，不沉淀成用户兴趣                                            |
| 应用激活、窗口／焦点变化    | 应用身份、窗口标题及真实 AX 焦点对象                               | 原生批次保留产生时的 actor，只有 user 观察交给主动注意力入口                                       |
| 同应用内内容变化            | AX `focused_element` 或受管 DOM `viewport` 的真实局部文字          | 不再只因 app／title／URL 相同而丢弃；内容改变可以成为结构变化信号                                  |
| 键鼠输入                    | 点击、按键、滚动事件类别的计数；不读取键值、输入字符或剪贴板       | 一秒来源侧聚合；纯 interaction 只更新工作集，不把频率解释成偏好、情绪或搭话请求                    |
| Agent 操作可见应用          | 与 app／browser／computer Tool 的执行归属连通                      | 原生 `setAgentActive` 在切换 actor 前 flush 旧批次，迟到结果仍保留原 actor；Agent 不变成 user 兴趣 |
| 受管 DOM 自动刷新           | 实际可见内容发生变化，但没有证据证明是用户操作                     | 保守保存为 system；Tool 驱动为 agent，真实输入相关批次为 user                                      |
| AX 未提供内容、画布或空视图 | `contentStatus=unavailable`；不能视为已经 OCR                      | 不补写不存在的页面内容；无标题且无可读内容时不请求语义门                                           |
| 受保护输入                  | 读取 AX 值前识别 secure text field；DOM 不读输入控件值             | 保留必要计数，排除内容；其他文本继续经过既有凭证删减边界                                           |

原生和 DOM 当前均采用一秒本地批次，文字片段最多 4,096 字符，DOM 每次最多检查 5,000 个文本节点；这些是来源适配器的工程边界，不是认知理论给定的阈值。模型并不按键逐次调用，Memory 也不逐次接收原始按键。Activity Episode 保留真实操作累计和末次可读内容片段，不把每个内容版本都追加到无限增长的摘要。

真实字段来源仍有差异：AX 只能读取目标应用暴露的对象，DOM 的可见文字不覆盖图片、画布、所有 shadow DOM 或子 frame。键鼠计数是收到的事件数，不等同于完整物理操作次数，也不证明用户认真阅读了哪一段文字。实际权限、目标应用 AX 支持和真实桌面覆盖需要后续验收。

### 工作集保留规则

[CompanionAttentionWorkset](../../src/main/journey/companionAttention.ts)使用一个内存 Map，键为 `appId`，缺失时用 `appName`。每次观察替换这个键的旧值并移动到末尾。当前快照序列化为 UTF-8 JSON 后最多 **24,576 字节**，超界时移除最早的键；单条观察本身超界时先移除其内容，并明确标记不可读。没有把任意截断文本伪装成完整读取。

这是一种简单的“每应用保留最近事实”，不是学习得到的显著性排序：

- `application`／`window`／`content` 的身份、标题、实际内容或可读状态改变，可以形成结构变化信号。
- `interaction`／`idle` 更新事实，不独立产生新的主动打扰机会；高频计数不是注意力投票。
- 只比较当前事实是否改变，不用主题关键词推断意图或情绪。
- 一个应用的旧文档会被该应用的新观察替换；本包没有保持每个窗口或文档的完整历史。
- 不保证 AX 与受管 DOM 已经按同一真实窗口 ID 合并；稀疏来源的旧观察也没有额外时间 TTL，最终受容量和新的观察替换约束。

工作集是临时上下文，不是长期记忆真源。保存或清理 Activity、生成 Memory、修改 Persona 仍归各自域所有。

### 语义评估和执行

[CompanionInitiativeService](../../src/main/journey/companionInitiative.ts)保留最新尚未判断的变化，同时把当前工作集作为 `recentObservations` 交给同一个语义门。已有气泡、正在执行的主动 Run、外部忙状态、活跃 Session 和既有主动策略继续阻止并发开场。语义门之后需要开口时仍启动普通助手 Run，不直接执行世界操作。

本轮新增的是**相邻语义评估之间至少五分钟**，即使上一轮选择 `none` 或发生错误，新观察也受该评估间隔约束。原有**成功接受／投递主动消息后的频率策略**仍独立存在，且可能因用户主动程度或负反馈要求更长间隔。两者不能混称成“每五分钟一定说话”。五分钟结束仅表示可以再次评估，模型仍可沉默。

24 KiB 只限制工作集快照，并不限制完整模型请求。当前语义请求还包含单独的 `observation`（可能与快照中的当前项重复）、系统指令、结构化输出 schema、Journey 候选与近期主动消息。下述回放确实出现 **24,807 字节的单次证据 JSON**，大于 24 KiB；它没有违反工作集护栏，但说明不能用工作集大小替代 Provider 输入计量。用户要求的 **258,000 Token 单请求输入硬上限**属于共享 Context／Provider 路径，系统、工具和多模态输入也需要计入，不能从本回放的字节数推断 Token 数或窗口安全余量。

## 来源和版本

以下外部来源于 2026-09-15 核对；官方页面未发布版本号时，仅记录访问日。

| 一手来源                                                                                                                                                                                                                                                                                                                                            | 日期／版本                                                   | 支持的结论与不能支持的结论                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| [Miller & Cohen：PFC 整合理论](https://www.annualreviews.org/content/journals/10.1146/annurev.neuro.24.1.167)                                                                                                                                                                                                                                       | 2001-03                                                      | 目标保持和控制偏置是可借鉴的理论；不证明分脑区软件、24 KiB 或五分钟有效                                  |
| [Sridharan 等：大规模网络切换](https://pmc.ncbi.nlm.nih.gov/articles/PMC2527952/)                                                                                                                                                                                                                                                                   | 2008-08-26                                                   | 认知网络存在相互作用；不能把 ECN 解释成若干可独立切换的人格／行为插件，也不提供本产品阈值                |
| [AXObserverAddNotification](https://developer.apple.com/documentation/applicationservices/1462089-axobserveraddnotification)、[焦点变化](https://developer.apple.com/documentation/applicationservices/kaxfocuseduielementchangednotification)、[值变化](https://developer.apple.com/documentation/applicationservices/kaxvaluechangednotification) | Apple 当前文档，访问 2026-09-15；本地 SDK 26.5               | 具体对象可注册通知，目标可能不支持；有 API 不等于全屏内容已可读                                          |
| [NSEvent global monitor](https://developer.apple.com/documentation/appkit/nsevent/addglobalmonitorforevents%28matching%3Ahandler%3A%29)、[Monitoring Events](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/EventOverview/MonitoringEvents/MonitoringEvents.html)                                                       | 当前 API；归档指南更新 2016-09-13；访问 2026-09-15           | global 不含自身应用，需要 local 补足，停止需 removeMonitor；不能据此宣称无需权限即可精确获取所有键盘活动 |
| [NSWorkspace 启动](https://developer.apple.com/documentation/appkit/nsworkspace/didlaunchapplicationnotification)／[退出](https://developer.apple.com/documentation/appkit/nsworkspace/didterminateapplicationnotification)、[secure text field](https://developer.apple.com/documentation/applicationservices/kaxsecuretextfieldsubrole)           | 当前官方文档，访问 2026-09-15                                | 可见应用生命周期和受保护字段语义；后台覆盖与非标准控件仍有限制                                           |
| [Playwright BrowserContext](https://playwright.dev/docs/api/class-browsercontext)、[DOM MutationObserver](https://dom.spec.whatwg.org/#interface-mutationobserver)                                                                                                                                                                                  | Playwright 锁定 1.62.0；DOM Living Standard，访问 2026-09-15 | 受管主 frame 的 binding／init script 和变化监听生命周期；不代表普通浏览器完整 DOM 或视觉理解             |
| [Home Assistant automation modes](https://github.com/home-assistant/home-assistant.io/blob/e73976b7f8c97c77f89792a504b8ff8337aedf6e/source/_docs/automation/modes.markdown)                                                                                                                                                                         | 官方仓库 commit `e73976b7f8c97c77f89792a504b8ff8337aedf6e`   | 工业系统明确处理重入、排队与替换语义；本文借鉴责任划分，没有继承它的数量／时间默认值或引入框架           |

本地实现参考基线为 `fc81239304c03648ee3f39ca178f3695ce474ffc` 加本轮未提交工作树。回放使用当前实现快照，不把 HEAD 等同于已经包含本轮改动。关键源码 SHA-256：

| 文件                                            | 格式化后复跑所用 SHA-256                                           |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| `src/main/journey/companionAttention.ts`        | `729804580479f5beefe220775ed04a242c11764906751fa6d147115c882207e9` |
| `src/main/journey/companionInitiative.ts`       | `ec52819297fc4735cc787d473ee330de0c4356722fa2d97a3a252a5e5bc7dbc9` |
| `src/main/journey/companionInitiativePolicy.ts` | `61ae2f0cdfa963e87e913a21d999177a592fc3b6e87e3d3508d9584214a63986` |

## 确定性回放方法

这是实现之后的结构验证，不是随机用户试验或注意力质量 benchmark。隔离 runner 在仓库外构建，生产源码仅只读导入，未创建生产 Arm、flag 或新依赖。回放前记录当前配置和源码指纹；这不追溯性地构成对 24 KiB 参数的预注册。

运行环境为 Apple Silicon arm64、Node **24.18.0**、esbuild **0.27.7**，沿主项目现有依赖构建。六类轨迹使用固定下标生成，无随机采样：应用名、文档名与文本全部为合成内容，时间从 `2026-09-15T02:00:00.000Z` 开始，间隔为一秒或两秒。文本正文由固定中文短句重复 48 次组成，未尝试模拟真实意图标签。

共有 **5,520 个来源事件**；混合 actor 轨迹中的 **480 个 agent／system 事件**在两个比较路径之前都被同样排除，留下 **5,040 个 user 观察**。这是已经过来源聚合的观察层回放，不把这些数量冒称为捕获了 5,520 个真实鼠标或键盘操作。

比较拆成两层，避免一次改变所有条件：

1. **上下文表示比较**：在完全相同的每个观察检查点，以及当前生产调度实际发起的每个语义请求点，计算两种证据 JSON 的 UTF-8 字节数。全输入参考保留到该时刻的所有 user 观察；当前路径只放工作集。两者都使用相同的当前 observation，Journey／近期主动记录在本次固定为空。全历史大小由精确 JSON 元素字节和分隔符累计计算，不实际分配不断增长的请求。
2. **触发结构检查**：运行真实 `CompanionInitiativeService` 和 `ModelCompanionInitiativeDecider`，用虚拟时钟执行计时器，Provider stub 始终返回合法 `none`。每个观察完成后等待当前任务收敛，轨迹末尾再推进五分钟排空待评估观察；既有投递历史为空、安静时段关闭、没有气泡／Session／外部忙状态。记录实际进入 fake Provider 的请求数，不发网络请求。

“每个 user 观察都调用一次”的 5,040 次仅为无节流参照，不是旧生产代码的实测结果。上下文的主要比较固定在同样的 24 个实际请求点，因此减少调用与缩小输入的收益分开报告。所有 stub 的 `none` 都是预设输出，**不是模型判对了沉默，也不计任何语义准确率**。

检查包括：每个工作集快照不超过 24 KiB；当前来源身份保留；纯 interaction 轨迹不产生额外模型请求；同应用真实内容变化可再次评估；无可读证据不伪造内容；同一应用的新文档替换旧文档；关闭后计时器清空；没有创建 Chat、Run 或主动投递。

## 结果与解释

所有下表字节数均为 UTF-8 JSON 字节，不是 Token、网络传输计量、Provider 账单或磁盘占用。

| 合成轨迹 | 来源事件 / user 观察 | 结构变化信号 | 实际 fake 语义请求 | 全历史峰值 B | 工作集峰值 B | 相同实际请求点：全历史证据 B → 当前证据 B |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 同应用持续输入 | 1,200 / 1,200 | 1 | 1 | 2,528,436 | 2,109 | 4,175 → 4,175 |
| 同应用内容变化 | 1,200 / 1,200 | 1,200 | 5 | 2,460,181 | 2,053 | 6,162,189 → 20,871 |
| 48 应用轮换 | 720 / 720 | 720 | 6 | 1,483,401 | 22,672 | 4,588,211 → 128,182 |
| 同应用三文档切换 | 600 / 600 | 600 | 5 | 1,226,781 | 2,046 | 3,079,257 → 20,817 |
| 局部可读／不可读交替 | 600 / 600 | 220 | 2 | 472,851 | 1,998 | 251,854 → 8,134 |
| user／agent／system 混合 | 1,200 / 720 | 720 | 5 | 1,455,949 | 8,097 | 3,651,813 → 44,861 |

合计 **3,461 次结构变化信号、24 次语义请求、0 次 Run／主动投递**。相同 24 个请求点，全历史证据累计 **17,737,499 B**，当前证据累计 **227,040 B**，在这些合成轨迹上减少 **98.72%**。当固定为每个观察都是一个计量检查点时，全历史证据的反事实累计为 **4,575,250,713 B**，当前工作集证据累计 **38,697,387 B**，减少 **99.15%**；这不是实际发送了 4.58 GB 数据，只是可复核的结构量计算。

以每观察一请求作参照，5,040 次机会降至 24 次，减少 **99.52%**。这个数字很大主要因为测试刻意含有持续输入／内容突发，且模型输出固定沉默；“永远不调用”还能把次数降到零。因此它只能证明节流路径起效，不能证明自然度、有效机会召回、用户接受度或陪伴体验提高。

最大工作集为 **22,672 B**，始终低于 24,576 B。48 应用轮换的末尾保留 11 个应用，而同一应用三个文档交替的末尾只保留一个观察：这是明确的数据舍弃，不是无损压缩。尚无证据证明被舍弃的旧文档恰好都不重要。

实际单次证据 JSON 峰值 **24,807 B**；此外，24 次请求的固定指令共 **61,848 B**、结构化 schema 共 **13,992 B**，还未计 Provider 协议及 Token 化差异。故本次结果不能替代完整上下文预算检查。

纯输入轨迹只有首次一轮请求，其后的 1,199 个输入窗口仍更新工作集，没有因为次数高而产生新请求。同应用内容轨迹产生五轮请求，证明标题不变不再自动屏蔽真实内容变化。局部可读／不可读轨迹只产生两轮请求；没有真实用户机会标签，不能将“少请求”解读为恰好跳过了不重要的机会。

这是六个人工构造轨迹的确定性全集，不是随机用户样本；不计算伪装成泛化结论的置信区间。相同输入和 bundle 重复执行后，输入、结果、检查点及请求证据的 hash 完全一致。随后主仓两处源码仅发生 Prettier 格式变化，对格式化后的源码重新构建回放，四个结果 hash 仍相同。

## 决定、复杂度和未验证问题

本轮保留当前工作集与来源聚合作为唯一生产实现，不保留全历史 Arm，也不引入更复杂的显著性模型或内部可调档位。理由是用户明确要求细粒度理解同时避免所有事件进入上下文；当前小型内存结构满足输入有界、来源可说明和单 Run 约束。这个决定是落地护栏的实施选择，**不是注意力算法已经优于所有其他候选或 24 KiB 已经胜出**。

复杂度增加限定为临时工作集、待评估观察和一个语义冷却计时器；来源适配器增加监听和短时聚合。没有给注意力新增数据库表、后台模型循环、持久情绪分数、学习型分类器、Settings 或第二条 Harness。所有模型调用仍由当前已有语义门负责。

仍然开放的问题：

- 缺少真实用户的有价值机会／误打扰标签，无法评价机会召回、错误开口率和被忽略的上下文。
- 24 KiB 与按应用保留最近一项的组合可能丢失同应用旧文档、跨窗口关系或稀疏但重要的线索。
- 五分钟可能延迟一个短暂而重要的新机会；现在只有低调用量的结构证据，没有证明这种延迟值得。
- 标题、AX／DOM 片段及操作计数不证明情绪、意图、进度或阅读注意力；`ECN` 多模式也没有被当作脑科学事实实现。
- 真机 AX、输入权限、页面布局覆盖、实际 CPU 和电量、睡眠／恢复与长期运行尚需设备验证；本回放没有采集真实桌面。
- 文本回应策略 pilot 已单独完成，结果由[COMPANION-RESPONSE-STRATEGY](./COMPANION-RESPONSE-STRATEGY.md)记录。它比较表达策略，不能替代本工作集的时机或事实选择质量实验。

下一次若要改变工作集规则、容量或评估间隔，应在运行前明确单一变量、用户机会标签、成本和延迟代价，再比较真实质量。不要仅以输入量更小选胜者，也不要因为“像人脑”而免除证据要求。

## 证据、失败和清理

原始证据保存在仓库外 `companion-cognition-research-20260915/evidence/attention` 证据包。仓库仅保留本文；输入和逐检查点数据没有复制进生产目录。关键 SHA-256：

| 文件                  | SHA-256                                                            |
| --------------------- | ------------------------------------------------------------------ |
| `input.jsonl`         | `7c31f242f577cd2c7d24a874ff376f9eff58bd715128a5b80646a1692d3d48a3` |
| `results.json`        | `5f7fceb376b43394dd22f16ad508294d7baa7998eb3e2d4cb4b851c319f41c70` |
| `checkpoints.jsonl`   | `ea603c293de97b0c4553c642426e56fac1cb5da71fdb3ce1d72bc77181dfd277` |
| `gate-requests.jsonl` | `4c5aab74832ab8de35f1f747f2d03402a24d5ac15e00a8f775c358f099abcac2` |

证据包另含运行配置、源码指纹、只读生产源码快照和复跑验证。复现使用上述输入逐条推进虚拟时钟，对同一 user 序列维护全历史 JSON 长度与当前工作集，调用快照对应的生产服务，并让 fake Provider 固定返回 `none`；不能改成模型自由生成之后仍称同一个实验。

隔离 runner 首次因 CommonJS 顶层 await 不能编译，包装修正过程中又出现一个括号错误；两次均未执行回放、未生成有效结果。修复仅改变运行包装，输入生成和比较规则没有改变。有效回放完成后，候选 runner、构建 bundle 和临时输出均删除；仅保留仓库外原始结果与非执行的生产源码快照，不保留候选算法、生产分支、开关或依赖。

验证：独立回放完成且重复一致；主仓 `companionAttention`、`companionInitiative`、`companionInitiativePolicy` 的 **3 files / 19 tests** 通过（Vitest 192 ms）。细粒度 Activity 包此前在独立工作树完成 **25 files / 193 tests**、typecheck、受影响 lint／格式及 macOS 26.5 SDK 原生语法编译，完整细节见研究报告。本 Decision 没有新增生产代码或测试，没有运行真实 Provider、真机采集、全仓 build 或 Electron E2E；整体集成验收由根任务另记。

## 2026-09-15 原生加载增补

在 macOS 26.6.2 / Electron 43.2.0 / arm64 的已有 AX 权限下，使用隔离合成窗口实际加载新版 Addon；两个导出、重复订阅拒绝、stop幂等、actor切换和重订阅通过。同一窗口取得 ALPHA→BETA 的局部文字变化与 agent 归属，合成密码控件返回protected且未输出值。两次短运行正常退出，停止后1.1–1.3秒观察窗无合成窗口回调。sendInputEvent到达Renderer但未产生NSEvent键盘/滚动计数，不能据此宣称全局键鼠覆盖通过；其他真实应用、启动/退出、拒绝权限与长期资源占用未验。无付费模型或新增OS授权。

外部native-smoke证据 manifest SHA-256为 c64fc91ce883405ff47bb934f6428cd05f76a206f7fc2e599fb824c76ac236c8，加载Addon SHA-256为 fd9972a4cc2d72aa79ecc5e952dd39fc22dc919d82849e403332eb077fc08b58。临时脚本与profile已删除。后续集成仅把工作集移除过大content的解构写法改成副本delete以满足lint，含义不变，现行离线回归继续覆盖此行为；上文回放hash对应归档快照，不伪称为当前文件hash。

随后补充一轮真实 NSEvent 路径验证，耗时 7.950 秒。使用临时 Swift helper 向隔离 Electron 的 PID 投递合成点击、右方向键和滚动；每次投递前均确认前台 PID、窗口标题和窗口内坐标。现有 AX 与事件投递权限为 true，未触发新授权。user 与 agent 两个批次分别收到 `clicks=1 / keystrokes=1 / scrolls=1`，actor 正确；停止后无回调，进程正常退出。这里验证的是本进程 NSEvent 路径，未覆盖其它应用的 global monitor。Renderer 收到两次 keydown，但未收到 pointerdown/wheel，因此不宣称页面点击、滚动动作也完成。

外部证据标识为 `native-nsevent-smoke/20260915T073515Z`，result SHA-256 `8c0ab58f7b4901f120201f6c80469ded85f9dc4d105dfe334732bb9712572aad`，manifest SHA-256 `062c15ea3adf7c4f60360242a05d5c8511262d0d46576789cfab443a15948dae`。runner、Swift 源码/二进制和临时 profile 已删除，无 Provider 调用。主工作区整体离线、构建、Electron 及打包验收见 [STATUS](../progress/STATUS.md)，不改变上文回放和真实平台验证各自的分母。
