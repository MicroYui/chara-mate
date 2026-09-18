# Cognition 拒绝反馈：说明实际缺少的完成依据

2026-09-16。决定：更精确的宿主拒绝信息已进入 Main；只改既有错误文本与普通回归，不放宽完成校验、不增加恢复循环。独立完成依据合同另行处理，不由本包替代。

## 实际问题与选择

原独立验收 s07 的 c06/c10/c12 都把浇水意图设为 fulfilled。所引 effect 的正文声称成功，但结构化 outcome 为 unknown。后两次真实 SDK 请求已完整带上上一次 `Attempt.error`，因此不是读取器漏供反馈。

旧错误只说 `Intent completion requires an effect or user report`，没有说明已引用的 kind=effect 与 outcome=performed 不同。模型输出表明它把成功措辞当完成；无法由可见输出证明模型内部原因，但原错误确实缺少对应拒绝条件。

新错误保留异常类型和原前缀，补充模型实际 Intent 引用、状态转换、所引 effect 的 ID/kind/outcome，并说明 unknown、partial、not_performed 和缺少 outcome 都不是 performed，未知也不等于失败，用户请求/问句不是完成报告。新建意图使用模型原 localId，避免返回事务回滚后失效的随机 ID。没有新字段、表、开关、调度或重试次数。

来源是当前 `CognitionRepository.commitAnalysis`、`resolveCognitionAnalysis` 与原 s07 wire/SSE。官方 [Function calling 文档](https://developers.openai.com/api/docs/guides/function-calling)（2026-09-16 访问）说明应用可在后续输入返回错误结果；它没有规定本产品如何重试。CharaMate 仍在下一次正常事件/恢复时携带现有 Attempt 信息，本包不引入无新进展的付费循环。

## 离线与真实验证

候选锁定 Node 24.18.0、SDK 6.49.0、SQLite 3.53.3。新增七项回归覆盖各类未完成 outcome、原 localId、实际 performed 和用户完成报告。旧实现新增用例 5 失败 / 2 通过，新实现 7/7；相关三文件 130 项、Cognition 目录 261 项及静态检查通过。Main 晋级后相同三文件 130 项通过，1.47 秒。

原三份 SSE 经实际 decoder 与 checkpoint 副本的 `commitAnalysis` 回放，仍 3/3 拒绝，88 张表内容完整回滚，目标仍 active/revision 1，水位仍 0。原库不改。副本来自拒绝后的检查点，仅恢复对应 Attempt 的 analyzing 状态并移除其失败 outcome/error，不能称为精确拒绝瞬间的完整前态。

真实诊断预先冻结 c10/c12 两请求，各自仅替换上一 Attempt.error；恢复该字段后与原 SDK payload 深等。c12 使用新宿主对原 c10 输出生成的错误，不消费新 c10 的结果。顺序各调用一次 `gpt-6-astra`、无自动重试或 encoder；实际 wire 与冻结清单一致。

| 请求 | 实际输入 / 输出 Token | 真实结果                                                         |  调用耗时 |
| ---- | --------------------: | ---------------------------------------------------------------- | --------: |
| c10  |        10,809 / 2,910 | decoder 和 commit 通过；浇水 suspended/rev2，完成未核实；水位 10 | 52.257 秒 |
| c12  |        11,357 / 3,098 | decoder 和 commit 通过；浇水 suspended/rev2，完成未核实；水位 12 | 54.918 秒 |

两次 usage 都已知，缓存输入均 0。完整输入估算为 57,144 / 58,409，低于 258k；这不是精确 tokenizer 或临界容量实验。调用时间含代理等待，不作独占性能比较。

Root 和执行者检查实际解码输出、原始来源与保存状态：两次都没有 fulfilled，没有把 unknown 当浇水失败，也没有借用户问句作完成依据。c10 明确“换好以后长什么样”不证明已换盆；c12 保留用户没养植物与角色自己生活的归属。暂停核实是模型选择，不是宿主悄悄改写。两次 Attempt 只到 ready 提案，没有 dispatch、额外 recall 或真实回复。

## 边界与交付

这是两个已知失败输入的定向恢复，不能估计普遍恢复成功率，也不能改写原独立验收的三次拒绝。新旧生成并非同期重复采样，模型随机性与服务状态保留。一般读取器可能因预算省略大 Attempt，本例没有发生；本包未改变这一边界。

现有完成 guard 仍可能把一般 user utterance 当报告。本次输出没有误用它，不证明这个结构缺口已修复；s17 的实际反例由独立完成依据包处理。失败输出仍整次回滚并保留水位，错误文本本身不会成为世界效果或记忆原文。

Main 晋级两文件：`cognitionProjection.ts` 与 `cognitionRejectionFeedback.unit.test.ts`。前者 SHA 从 `72a92b98297d7b01669c8d7fcc8aceeebfb06ea0757566c1f73653468c628e39` 变为 `0fa4e05320901d2bc4cc85c674a8e75690256ab3c9495ad4ab12e805b643751a`；新增测试 SHA `caaba2bd044e04517b8d0f62cd0e76f372188efbaad658d6a419ffaa420544c7`。这些是本次选择时的源码标识，后续完成合同可继续替换同一路径。

仓外证据位于 `cognition-rejection-feedback/`：

| 标识                   | SHA-256                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| OFFLINE-FREEZE.json    | `40f90de886e14f08380ebf0c7619bd1938379bae641f12c6096ee1c3a661a1ba` |
| offline/CALL-LIST.json | `93d67544d9e121a64232c8cb6faddc3775b1612bf7e9ede3c8e1c3d52123d2d0` |
| LIVE-RESULT.md         | `17536405e100f7d8074c1fccfd008bc3c653097c571634a600cd298765ebad74` |
| SEMANTIC-REVIEW.json   | `4b84229d40e13b911f567397ae17a3ca7406cba20fc852627e5a129fcd98e06e` |
| LIVE-MANIFEST.json     | `342099e67545c593a2e9bdb408ec44a88f760d4cc9dbe1c5cd64a803e76a6a24` |
| ROOT-PROMOTION.json    | `27fe96dfb57b1b49e8252a4f1701612828757b4420ebeab7bda4e48ae9d2d362` |

原失败、实际 wire/SSE、SQLite、普通补丁和复核继续保留。测试以通用意图 fixture 编写，不含原故事标签或 Arm 开关。2026-09-16 02:51:47 UTC 按冻结清单完成候选清理：六根中的 644 个普通文件及一个依赖链接先逐项归档核对，再精确删除；67 个保留文件（含全部五份 SQLite、wire/SSE 和 Root 前像）重核相等。共享依赖和当前完成依据候选未改动。

清理记录 `cleanup-inventory/RECEIPT.json` SHA `a3a3a428afbcaa495a406d49bf8d593ebd19bfaef305cc6042ba9b163b08b89f`；仓外归档 SHA `46838e111cffc9061f07ee3f52f0ea7e1aab1dccf78d9645befc04dbb2c462f3`，8,956,359 字节。不保留可执行的备用路径。
