# 服务暂不可用的错误分类与记忆恢复

2026-09-16。Decision ID：PROVIDER-SERVICE-RECOVERY。Root 集成；实现已进入 Main，受影响SDK/SQLite回归、全离线及400/503桌面展示已经通过。对应 Product §6.3.1、§6.4；此项修复真实服务错误分类，不改变记忆形成、检索或巩固选型。

## 问题与选择

正式 v21 的首个基线条件遇到一次真实 HTTP 503 `model_overloaded`。SDK 请求没有产生模型提案或 usage，形成工作保留全部来源、未提交游标与 attempt=1。公共 `mapSdkError()` 却把它归为 `PROVIDER.REQUEST_FAILED`、retryable=false。已有普通模型成功恢复只接收 timeout、unreachable、rate-limited，无法恢复这项服务过载。该条件和失败记录保留，不因后续修复改写原分母。

新增一个明确的 `PROVIDER.UNAVAILABLE` 类别，覆盖 SDK HTTP 服务端失败；既有 501 能力不支持的判定仍先执行。Formation 与 Consolidation 把该类别纳入已有恢复入口：只处理成功事件发生前已经失败、当前来源和处理器仍匹配的工作，巩固继续核对实际请求 profile/API/model。已提交前缀、精确引用、尝试次数与原工作 ID 沿用现有实现。

没有把全部 REQUEST_FAILED 改为可重试，没有按错误正文猜测，也没有改写已经用通用类别保存的旧失败。它们仍可通过已有明确重试、配置变更或处理器变更路径处理。没有新表、迁移、队列、定时器、模型或用户设置；普通请求、凭据、语义与上下文错误继续保持各自含义。

## 一手来源与协议边界

本日读取安装的官方 OpenAI JavaScript SDK **6.49.0**：[`src/core/error.ts`](https://github.com/openai/openai-node/blob/v6.49.0/src/core/error.ts) 100–102 行将 HTTP 5xx 构造为 InternalServerError；[`src/client.ts`](https://github.com/openai/openai-node/blob/v6.49.0/src/client.ts) 1035–1055 行的 shouldRetry 在处理显式重试头后将服务端错误列为可重试。这是 SDK 的当前行为，不是 CharaMate 必须复制的重试次数或延迟。

本产品保留现有生成/输入计数的 `maxRetries:0`，错误返回时不追加同请求重试。之后另一个普通 Run 的首次真实成功，才是恢复既有失败工作的新事实；SDK 对同请求自动重试的开关不是本地持久任务的长期调度协议。一次恢复仍可能再次失败，系统不承诺服务已经永久恢复，也不积存未来重试额度。

本包修改 SDK HTTP 边界；Realtime WebSocket 的既有握手归类没有借此改成第二个恢复路径。

## 验证与当前限制

2026-09-16实际通过的既有扩展回归：官方 SDK 对自有 loopback HTTP 的 500/503 输入计数与生成错误、实际 profile/协议/model 归属、一次生成不暗中重试；真实 SQLite/RunEvent/MemoryMaintenance 的 503 形成失败在普通成功后续接并形成记忆，400 普通请求失败仍不被该事件重试；巩固新增类别继续受来源、身份与单次事件约束。原 501 不支持和其它错误检查继续保留。

源前备份与交付状态在仓外 `integration/provider-unavailable-recovery`。全离线2149/2149包含上述扩展；桌面实际400显示失败、503显示可继续的中断，计划均为未完成历史且不继续旋转。随后在未分配Run的IPC返回处保留ProviderError的具体code/message/retryable，避免将预算拒绝描述成从不存在的执行边界继续；对应两项新增IPC检查通过。未操作用户数据库、未注入付费服务故障，也未修改正式 v21 源。完整同版独立语义、资源和安装验收仍由本地成熟度 Goal 继续完成。
