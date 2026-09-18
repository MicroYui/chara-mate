# 视觉读取集成前的验证记录

保留原版本、失败、分母与边界；当前状态见[STATUS](../STATUS.md)。

## 最近绿色验证

2026-09-17，已选来源保护SQL增量后的实际 Main `npm run verify:offline` **2401/2401，49.959秒**：136 contract、1649 unit/component、616 integration，1.02/7.75/13.23秒；typecheck/lint/format通过，两个既有TanStack警告不变。验证运行于未来需求比较的共同构库阶段，没有与条件竞争窗口重叠；该共同构库墙钟包含宿主检查负载。记录 `integration/cognition-capacity-query-main-verification-v1`，尚未重建包或重跑Electron。

2026-09-17，同一共同源完成当前512维Memory单域结构容量；100k全历史七次warm中位883.156ms，Node/Worker采样RSS峰516.52MiB，正式墙钟43.513秒。暂停后的快照/写入、取消恢复及新PID重开符合预期；100k无暂停完整索引提交晚于iterator关闭，明确保留未曝光。结构数据、编码接线与实际语义分开，详见[向量执行记录](../../benchmarks/MEMORY-VECTOR-EXECUTION.md)。不将独立单域结果称为三域并行验收。

2026-09-17，普通情境、目录及动态工具交付组合源 Main `npm run verify:offline` **2399/2399，57.388秒**：136 contract、1647 unit/component、616 integration，15/177/38文件，1.14/9.35/14.83秒；typecheck/lint/format通过。原夹具构造、旧额度断言、类型和lint失败逐次保留；两个既有TanStack警告不变。运行源码冻结`c62d0fab56b8c5c7fafffb67483c413bc83c3fc0e74b5d21bed097e9b54c4d5e`。`npm run build`通过（15.753秒），Agent/Chats/Foundation/MemoryActivity/Journey/Territory实际Electron **24/24**通过（77.683秒）。这些流程使用确定性适配器；真实模型语义与最终安装另计。

2026-09-17，阶段连续性集成后实际 Main `npm run verify:offline` **2315/2315**（54.699秒）：136 contract、1580 unit/component、599 integration，15/175/38文件，1.10/8.58/14.42秒；typecheck/lint/format通过。`npm run build` **15.528秒**、受影响 Agent/Chats/Foundation Electron **19/19，57.695秒**通过。新增测试的两轮lint失败已保留并修正，生产逻辑未因lint调整；原两个TanStack警告和构建chunk提示保留。仓外 `integration/assistant-phase-validation-v1`，详见[阶段连续性记录](../../benchmarks/ASSISTANT-PHASE-CONTINUITY.md)。本次未执行package或新真实模型质量对照。

2026-09-17，必要修正集成后实际 Main `npm run verify:offline` **2304/2304**（54.37秒）：136 contract、1578 unit/component、590 integration，15/175/38文件，1.10/8.29/14.15秒；typecheck、lint、format通过，两个既有TanStack警告保留。`npm run build` 通过（15.64秒）。此前受影响581项与类型检查通过；首次Main全检查在一处新增测试的无效初始化lint停止，去掉初始化后完整重跑通过，原失败日志保留。本次未重跑Electron或package。仓外记录 `integration/mandatory-fixes-validation-v1`，完整运行源码与已构建外部bundle来源一致，测试文件另有该一行lint修正。

2026-09-17，包含完整读取、Memory 集合差及反馈续接的最终候选 `npm run verify:offline` **2285/2285**：136 contract、1571 unit/component、578 integration，15/175/38文件，1.03/7.84/13.83秒；typecheck、lint、format通过，两个既有TanStack警告保留。`npm run build` 通过（14.59秒），相同运行源码的受影响Electron **20/20**（55.4秒），包含原30k Chats、17个Agent场景、typed bridge及Renderer恢复。Main 已逐字合入该运行源码，在实际目录再次完成 `npm run verify:offline` 2285/2285（52.39秒）和 `npm run build`（14.90秒），均 exit 0。

前源2262项、原Electron首轮19/20后基础清单单例修正、六项准备生命周期，以及真实gpt-6-astra引用修复（实际55206输入/1637输出）均保留原记录。引用修复仅一次新调用，其首响应是录制回放，未在该回放提交DB或行动；GUI与离线结果不改称自然语义成功率。详细资源分母、原失败和版本见 [动态行动预算决策](../../benchmarks/COGNITION-DYNAMIC-ACTION-BUDGET.md)。

2026-09-16，首对正式条件之间的资源窗口：`npm run verify:offline` **2149/2149**，含134 contract、1492 unit/component、523 integration；15/170/38文件，1.08/8.11/15.07秒。typecheck、lint、format通过，保留两个既有TanStack警告。`npm run build` 与基础Electron 1/1通过。

受影响 Agent/Chats/Recovery 首跑14/18；两处问答夹具将 answered/cancelled 误作普通工具失败，旧Plan夹具仍期待500永久失败。修正夹具合同后，问答两入口及400/503计划展示4/4通过。原30k Chats仍实际被预算预检拒绝，保持失败而不增大限额。随后生产仅补 ProviderError 在IPC的具体错误透传，6项IPC测试、typecheck、受影响lint及重build通过；此后增量没有重计为完整全离线通过。

仓外记录：`integration/main-first-pair-window/VERIFICATION.json` SHA `752fc9b213012bf8b14cdbc123fd92a90eb9dcff3f801fdfe13436bababd2d2e`；含原失败、增量验证及窗口结束源哈希。正式吞吐仍用原冻结；当前package/make及真实安装尚未执行。旧Main v6的26/26 E2E、arm64 package和实际4B/512 Worker smoke仅作为历史基线。
