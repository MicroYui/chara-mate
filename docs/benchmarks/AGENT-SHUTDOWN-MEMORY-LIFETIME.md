# 退出时先等待 Run，再释放记忆依赖

2026-09-16。root 为 Main 生命周期与跨域集成 owner。状态：选中退出顺序已随共同 v21 集成 Main；该次 v21 完整离线验证通过；最终同版打包进程退出仍待验收。

## 问题与选择

旧 Main 先关闭向量 Worker 和本地编码器，再调用 `AgentRuntime.interruptAll()`。实际 Memory 检索仍在运行时，关闭编码器会让工具收到普通依赖错误；Run 可以继续请求模型并生成回答，将退出过程标为 completed。

选择调整现有顺序：停止新输入和后台调度，停止续接入口，标记并等待活动 Run 中断，再关闭 Worker、编码器及其余工具资源。等待用户输入或审批的 Run 仍按现有规则保留，退出不替用户回答或批准。没有新增调度器、状态机、超时或兼容路径。

## 当前依据

2026-09-16 阅读 [Electron app 文档](https://www.electronjs.org/docs/latest/api/app#event-before-quit)：正常退出的 `before-quit` 可以阻止默认退出，使既有异步清理完成；它不保证所有操作系统强制退出都会触发。另阅读 [Node.js v24.21.0 Worker 文档](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html#workerterminate)：`terminate()` 的 Promise 在 Worker exit 时完成。项目验证使用 Node.js 24.18.0。

上述来源定义进程事件与等待语义；“先停止调用者，再关闭其依赖”是当前依赖关系要求，不是外部协议规定的时间阈值。实际源码中 `LocalEmbedding.shutdown()` 会中止在途和排队请求，原 Run 未收到退出信号时可以把该错误当普通工具失败。

## 实际复现与回归

复现经过实际 AgentRuntime、MemoryService、SQLite、LocalEmbedding 客户端、独立子进程和 UNIX HTTP。仅模型事件及原生向量计算使用确定性夹具，不调用真实 Provider，也不声称测了 4B 语义或性能。

旧顺序复现为 completed，违背预期 interrupted；新顺序在同一在途检索位置得到 interrupted，仅发生最初一次模型请求，工具 Item 为 interrupted。原失败与两个顺序的实验源码保留在仓外 `shutdown-memory-probe-1.txt`、`agentRuntime-shutdown-probe-source.ts`。生产回归只保留新顺序的一个用例，不含 Arm 开关。

选定回归 `shutdown-memory-regression-1.txt` 为 1/1、1.42 秒；其余 Runtime 用例本次未运行，不能算新的全域通过。文件与证据说明见仓外 `SHUTDOWN-MEMORY-LIFETIME-FREEZE.json`，SHA `49fc3335fb5566af33f12d5aa8de96709e1b90f706b3bdd6b295823e7992ac62`。v21 晋级时的 Main 完整离线记录及后续待验项见 [STATUS](../progress/STATUS.md)；最终同版打包进程退出仍须单独通过。
