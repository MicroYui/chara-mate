# 局部意图更新保留真实用户请求依据

本次修复的是已确认的宿主正确性缺口：partial Intent更新承诺保留未展示的原引用，却在校验已有explicit_user资格时只看可见列表。修复后，实际留存的用户原话能继续支撑同一请求；不需要模型猜测并重新附上未展示的依据。新建、完整替换、改变owner/basis以及新完成状态的要求保持各自边界。

## 来源与原结果的修正

实际失败来自s06-A最后一次分析，Attempt 81d7a993-de9f-40b1-87a6-7f4a3eb3a21a；Intent 21f2d763-e11d-4e9f-bfbd-af49fa08dc21 rev3。输入partial allocation.evidenceIds=[]，可见Intent.evidenceIds也为空。真实用户原话45d5a23b-8e20-4baa-9ed3-590621a915c6完整供应在snapshot，但旧canonical Intent自身的依据未在局部列表展开。模型只向局部列表追加100s截图f318e69c-4c0d-5617-adec-4e7eae1a3731。

代码承诺同时存在于Driver的partial数组说明、Repository.preservePartialUpdates及savePartialEntity：局部可见引用被合并，未展示的canonical引用保留。问题是dependencySnapshot只恢复allocation的可见列表，随后validateIntent在最终保存之前检查。原用户依据虽仍真实保存在同一canonical版本，资格校验看不到它。原拒绝是实际记录，但不能据此断言模型删除了完整支持；把“每个partial更新必须重新附上已供应原话”当作完整合同也过强。

上一包真实提示A/B均正常理解截图，A被拒/B提交的记录保持原样。现在通过宿主修复，原A无需修改即可提交，表明先前提示补充是在模型端绕过了一处宿主校验缺口。原报告不追改；新增PARTIAL-CONTRACT-ADDENDUM.md透明修正归因及提示建议，其原报告SHA保持1f806f45925659524dda64d8889abc1bd086999123be6a99325d4653760350d3。

## 选定的单一路径

Repository只对实际allocation中的partial Intent更新执行保留资格读取。模型返回的evidenceIds/effectEvidenceIds仍必须来自本次真实供应列表或可见allocation引用；不存在的新ID和未供应引用不会因canonical保留而放行。full view没有此保留资格读取，仍按完整替换校验和保存。

对owner=user且basis=explicit_user的更新，查询同Intent ID、同Persona、同expectedRevision且原owner/basis相同的canonical evidenceIds，与实际Cognition Evidence关联；只接受kind=utterance、actor=user、同Persona且receivedAt不晚于Attempt创建的真实行。来源缺失、其它Persona、agent话语、普通观察或尚未收到的来源均不能支撑。只读取存在性所需的一条来源metadata，不把canonical全文或全部旧引用载入模型；LIMIT1是“存在一个合法请求依据”的逻辑见证，不是调参topK。

Projection仅在验证“已有explicit_user请求仍有依据”时使用这条metadata。它不加入snapshot.evidence或其它Claim/Choice可引用的全局Map，不为另一个新Intent提供资格，也不进入新fulfilled的effects/supports判断。新完成仍需要本次可见的实际performed回执或相关用户报告。已有请求资格与本次动作完成是两个判断。源的实际时间与身份不改写；现有generation、Persona和实体revision冲突检查继续执行。

已有savePartialEntity继续按既定方式保留canonical数组并追加模型供应的观察。修复不改模型输出文本，不为模型自动发明用户来源，不加表、迁移、Provider回退、运行模式或Settings项。Driver同步准确说明：新建/full替换/owner或basis变更须有自身的实际供应用户依据；同owner/basis的partial可沿用合法canonical请求支持，不能把它当成新完成凭据。

## 确定性验证

新19条focused回归覆盖：真实canonical依据完全未装入本次模型输入；原话独立供应但未列在partial Intent；full替换丢弃唯一用户依据拒绝；full可用另一条真实供应用户原话替换旧支持；错误actor、观察、跨Persona、未来receipt、来源被删除；返回未供应evidence/effect ID；retained不能作为新choice来源或支撑新Intent；旧请求不能独自证明新fulfilled；真实performed回执可以按既有合同支持完成；owner/basis变化无新供给拒绝、有供给接受；revision及userGeneration失效仍拒绝。

全Cognition领域13文件、241测试通过，TypeScript、4文件ESLint及格式检查通过。测试只用合成SQLite来源/回执，不证明实际外部Tool效果。准备工作首次遇到一个测试fixture误写effect.scope并漏runId、以及工作副本未复制通用测试fixture导致类型错误；已按现有schema和相同项目fixture修正，最终检查通过，不把这些准备失败说成产品失败。

另冻结三份完整原始SSE，通过当前官方OpenAI SDK6.49.0、现有Adapter、Driver进行原样解码，再向同一终态原数据库的独立副本提交。解码结果逐字段与原模型domain output相同；没有重新生成或修补模型文字。

| 原SSE来源 | 旧宿主 | 修复宿主 |
|---|---|---|
| 最初s06-A末次输出 | 拒绝：需要用户话语 | 提交成功 |
| 上一提示配对A输出 | 同一拒绝 | 提交成功 |
| 上一提示配对B输出 | 提交成功 | 提交成功 |

6次宿主回放使用3份现成SSE，真实Provider调用0、native0。旧失败回放事务保持原状态；新宿主三者均将同一Intent rev3→4，canonical引用为原用户话语+100s截图，仍active、effectEvidenceIds=[]。1260、本地已保存、远端送达未知的原输出内容未变；没有向用户发消息或执行世界动作。

原DB是已完成运行的终态库，不假称为失败瞬间完整快照；副本只通过公开saveAttempt恢复冻结Attempt的analyzing状态，已有canonical状态与原始来源不修改，两侧相同。现有冲突检查与实际原SSE重放验证相关版本仍匹配。离线回放中的模型usage是原SSE历史字段，不是新花费；不把1/3→3/3宿主接收当作3个新独立模型样本或总体稳定率。

## 一手来源、版本和边界

依据是已冻结的当前CharaMate partial协议与Repository/Projection真实源码，BASELINE.json记录集成树版本/hash，SOURCE-HANDOFF.json记录精确变更。SQLite实际运行版本3.53.3（回放通过SELECT sqlite_version()取得），better-sqlite3 13.0.1、OpenAI SDK6.49.0、Node24.18.0。SQLite官方[JSON函数](https://www.sqlite.org/json1.html)说明json_each的逐元素关系视图；官方[日期时间函数](https://www.sqlite.org/lang_datefunc.html)说明julianday及时间值处理，访问日期2026-09-16。本次使用它们判断同一canonical数组中的实际来源及收到时间，不增加TTL、日期衰减或其它经验阈值。

查询至多物化一条合格来源metadata，SQLite内部仍需读JSON TEXT；没有声称原生存储完全流式或没有扫描成本，也没有进行大库性能实验。源metadata只验证已有请求资格，不能机械判断自然语言目标是否语义偏离原请求、也不能鉴定用户原话是否真正报告完成；这些语义判断仍由正常模型及连续验收承担。full分支、现有完成判断和其语义边界没有借此扩展重构。

新Driver提示没有再发真实请求测试。其依据是修正后的确定性合同，后续Root冻结的cold/holdout与产品验收使用这条唯一指令；不能把旧SSE回放说成新提示质量评测。本包未启动完整Service时序、前台Agent或Electron E2E，不替代最终并行验收。

## 交付与保留

只交四文件：cognitionRepository.ts、cognitionProjection.ts、cognitionDriver.ts，以及新cognitionPartialIntentGrounding.unit.test.ts。无shared/schema变更，全部在新的独占candidate副本；未编辑integration、Main或final-validation-source。Root已获SOURCE-HANDOFF及补丁，最终集成和全离线由Root负责。

补丁SHA8e54e2785e12bd9f7a023cb5d8f37b0d51cbbfaddfd74fb172686719ec643758；SOURCE-HANDOFF SHA9df11ad877e895e013a9cd325f91a0960890e40056c069f7ed52e18546a6cb2f；replay/SUMMARY.json SHA157897238a12f7ef9008691e09eab027b8f0a021065710f3091d3269e6574893。原始SSE/输入/图片/SQLite留在cognition-explicit-intent-support，6份副本与解码/提交结果留在本包replay/，均仓外。

Root逐项核对清单后，候选源码与离线runner已按独立精确清单归档并删除。11个精确根共643文件、3个符号链接；135个原始结果、报告、附注、回放及补丁保留项的hash前后一致。仓外归档SHA `cc08a9493aa843e3aa1d70ebe0134e3103048235804a579da0fd7c05bbe04de1`，清理回执SHA `ccde39beb37e0321083b9f33a9548dc7bfff6c67a3562ec6e12f7b913a6d546b`。未删除共享依赖或改写旧实验分母。

## Root 集成与产品回归

Root完整审阅四文件与19项新增回归，核对三份原SSE的六次宿主结果后，按before/after hash集成；集成清单SHA `5da283924dbb761197ba73a9ff31c350a2d9f333fdfb15bb8c590fc1e614099f`。随后连同本轮已选修订共84个src/tests文件进入Main，保留Main既有打包、资源、配置和文档，晋级清单SHA `f72b47ef7e76748b40bdbe1e5955e81b56a5814a0486ab52780fb359fd4b083a`，未提交或推送。

2026-09-16 01:29，Main完整 `npm run verify:offline` 通过1,615项（134合同、1,153单元/组件、328集成）；typecheck/lint/format通过。随后生产构建通过，Electron E2E 26/26通过，约1.3分钟；macOS arm64打包和实际4B/512编码器、SQLite向量Worker冒烟通过。保留既有TanStack与bundle体积提示。真实自然话题延续使用627文件冻结源码，SHA `b52baa6c9b68d124251777ff1fecc2151cf8bc830a33a7f9dba8c7f24c11b2a9`；其结果与本次确定性回放分开，独立holdout尚待完成。
