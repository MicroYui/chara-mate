# 动作新鲜度使用实际接收边界

2026-09-16，正确性修复已由 root 合入共同 v21 并同步 Main；v21 晋级时的全离线检查已通过，后续源码变更以 [STATUS](../progress/STATUS.md) 为准，完整吞吐重跑与最终安装待完成。集成以 common-v20-frozen 为精确共同基线，原吞吐源、输入及旧结果均保留。

## 问题与原始证据

在 poster-edits 的真实持续到达比较中，最新用户原话已经越过历史积压被供给给 PFC，但动作新鲜度仍以连续正文前缀判断新消息。已接收、已供给的原话再次被识别成新控制，quiet 也变 superseded/deferred；恢复的旧 due 又被同一失败上下文抑制，出现未完成消费却不再工作。原始闭库查询记录见吞吐 v20 的独立诊断和执行修订。不能通过停止工作后的低费用证明更好的吞吐。

依据版本：common-v20 全源 manifest SHA557e2826853d897cfd1374812b3894cd13506fab04ac2008c6ac387637aa37b2；实际产品 Repository、SnapshotReader、Service、ActionReadSet 是本行为的一手源。本修复没有新增协议限制或工程阈值，也不借用外部 Agent 的默认数值。

## 唯一生产合同

- readSnapshot 在实际同步捕获原始 Attention 时固定 receivedThroughSequence，并将它计入完整序列化字节分配。它只说明当时已接收至何处，不说明模型已理解这些来源。
- createAttempt 必须接收真实 read 的 snapshot 和该序列；Dependencies 保存严格必填的 host-owned 字段。禁止晚查当前数据库、按创建时间猜测或用正文前缀回填。
- 现有 userGeneration 检查保留；后到同 generation 的真实 user utterance/control 仍通过 receipt sequence 使旧动作失效。来源去重、Persona、Claim、Intent、当前对象、Memory 资格不变。
- Recall completion 只补材料，沿用最初 Attempt 的接收边界；较晚 readSnapshot 不能抬升它，因为那时出现的新用户原话可能并未供给 completion。
- 连续正文通过 throughSequence/analyzedThroughSequence 记录；目录审阅仍是独立水位。该字段不产生原文 Claim 资格、Memory handoff 或正文回收许可。

## 范围和复杂度

生产修改限 SnapshotReader、Repository、Service、ActionReadSet 和既有共享 Dependencies Schema。没有新表、DDL、调度任务、重试周期、设置、模型调用、候选运行模式或兼容分支。其余变化为必填调用合同与针对实际错误的回归。严格必填不为回放旧实验库加 fallback；root 在资源窗关闭后核实实际默认用户库schema24且不存在cognition_decision_attempts表；因此不需要旧Attempt兼容。这一结论来自表存在性核查，非仅凭版本推断。

## 验证计划与真实结果

原共同源的红例只更正两个现有错误期望，并移除当前对象测试中为隔离问题而删除用户原话的操作。新源覆盖：已供给用户越过 FIFO 后仍可 settled、同 generation 原话在 snapshot 后/创建前到达、同 generation 原话在 Recall 中到达、实际绑定事务拒绝旧决定、持久 JSON 读回边界、同 Persona 的新 control、其它 Persona 原话不误伤、原对象和 Claim 变化检查。旧正文未消费仍 pending。

正式条件于13:06:01 UTC自然退出后执行验证：原共同源41项中3个预期红例，修复后针对性44/44通过；相关认知、Journey、App、Memory/Activity边界及全部contracts合计606/606（46个文件）通过，完整typecheck、affected lint与format均exit0。首轮606中2个失败完整保留：一个部分投影fixture未传新必填stamp，另一个旧测试将已供给用户误拒绝当期望，均按实际read与真实新消息时序修正。没有新增真实模型调用。原四家族八条件分母保持，修复后两臂共同源和新 profile 的完整比较另记，不覆写旧结果。

## 删除与可声称范围

修复是单一宿主正确性路径，生产不保留旧谓词。仓外红例副本和运行器只作本次证据，不交付 Main。确定性通过只能证明上述接收/消费与失效合同，不等于语义注意质量、长期自主生活或正式吞吐已经通过。

统一集成记录：27文件中5个生产文件，其余为必填合同与回归。仓外 `action-freshness-source-frozen/FREEZE.json` SHA `79386351551c7ef3bc2958219581ca62fc19917b19ea49fd78fae200b1690def`；Root精确集成记录 SHA `a5d1cca1f4e30a4ff01a5c29810739ba8a16c407680fdcb8b97f45ee333458d9`。独立审查确认两个相反的时序合同均被实际 Repository/Service 检查覆盖；同实例重建 Repository 只算持久 JSON 回读，不冒充跨进程重启。共同 v21 完整 `npm run verify:offline` 已通过：134 contract、1488 unit/component、496 integration，共2118项；类型、lint、format通过。验证记录 SHA `df0e5d21b396cc1c1776d92eaf862e7d63ddffd95f032a3db1e576d8d11a2027`。此结果仍不替代真实吞吐和最终安装验收。

Main 同版验证：155 个已选定运行/测试改动集成后，`npm run verify:offline` 2118/2118；678 个非 Markdown 文件与共同冻结逐项一致。验证记录 SHA `bcae3f9d2a78df018643ad2676c889ed3581885c0d9ad7dd52ae6501a0bdbf28`。未将独立吞吐候选当作已选定实现，也未重写旧 v20 两个条件的失败结果。
