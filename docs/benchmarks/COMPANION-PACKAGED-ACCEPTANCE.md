# 本地陪伴重构：打包应用验收

2026-09-16。当前 Main v6 已完成同版离线、桌面 E2E、打包和实际编码器/Worker 验收；下面保留 v2 的两个真实 Chat 与 v3 工程回归，版本分开计量。本记录只说明实际验收范围；多年陪伴质量、日常后台能耗和正式发行质量仍需各自证据。

## 源码和构建

最终晋级清单含84个 src/tests 文件，其中25个新增；Main 原有配置、依赖锁、资源及打包路径保留。晋级清单 SHA `f72b47ef7e76748b40bdbe1e5955e81b56a5814a0486ab52780fb359fd4b083a`。统一627文件源码冻结 SHA `b52baa6c9b68d124251777ff1fecc2151cf8bc830a33a7f9dba8c7f24c11b2a9`；代码未提交或推送。

| 实际验证                         | 结果                                                                                                   | 边界                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `npm run verify:offline`         | 1,615项通过：134合同 / 1,153单元组件 / 328集成；对应0.949 / 5.91 / 9.60秒；typecheck、lint、format通过 | 确定性回归，不是语义质量样本；保留两个既有TanStack警告                             |
| `npm run test:e2e`（含生产构建） | 26/26，约1.3分钟                                                                                       | 实际Electron窗口、Chat/Run/Memory/Activity/自主生活/恢复流程；Provider为确定性边界 |
| `npm run package`                | macOS arm64包成功                                                                                      | 未验证签名、公证、DMG发行                                                          |
| `npm run smoke:package`          | 实际4B编码器生成512维向量；SQLite向量Worker、窗口、托盘、单实例、浏览器和后台恢复检查通过              | 独立临时数据；空库未配置Provider时有明确配置错误，不冒充真实模型完成               |

环境为 Apple M4 Pro / 24 GiB、Node24.18.0、SQLite3.53.3、better-sqlite3 13.0.1、OpenAI SDK6.49.0。包装的唯一编码器是 Qwen3-Embedding-4B Q4_K_M / 512；模型 SHA `2b0cf8f17b4c723c27303015383c27ec4bf2d8314bb677d05e920dd70bb0f16b`。编码器选择及其研究边界由原独立 Decision 定义，本验收不重新比较模型或声称需要微调。

## 实际产品中的两个新 Chat

01:40:19–01:41:21，Playwright 启动当前打包应用，使用新的独立 user-data/workspace，通过产品 typed IPC 保存测试 Profile，通过真实 Composer 发送文本；模型为已授权的 gpt-6-astra。没有预插 Memory 或改写用户真实数据，也没有要求模型调用特定 Tool。

第一句：“今天我只想安静地聊两句，不用安排任何任务。记住我自己的这个小习惯：下雨时喜欢坐在窗边听钢琴。” Agent 自主调用 `memory.record`，实际形成两条有原话来源的 Revision：用户的雨天习惯，以及限于今天、当前角色对话的安静交流要求。后一条明确保留“今天”的自然语言限定，没有声称模型给出了精确日历有效截止时刻。Agent 在写入完成后确认记住，不安排任务。发送到完整回复约23.54秒，不能据此称即时陪伴延迟已经达标。

随后点击“新建对话”，询问“刚才我说的下雨时的小习惯是什么？不用替我安排活动。” Agent 自主提出一个具体检索问题，调用 `memory.search`；实际返回一条与雨天习惯相关的记忆，含用户主体、当前Revision、原Chat来源及准确quote，coverage为supported、无gap。最终回答“下雨时，喜欢坐在窗边听钢琴”，没有添加活动安排。发送到完整回复约17.45秒；本次与一个纵向试验共享模型服务和硬件，不作为独占性能或P95。

两个Run均 completed。Root逐张检查三张产品截图：两个Chat内容及Memory列表可读、无布局遮挡；Memory界面显示上述两条持久化内容。Renderer错误列表为空，stderr只有正常调试连接关闭。只读SQLite复核了实际形成的内容、来源语义及PFC尝试；没有直接修改数据库。

没有保存此次首条完整Provider wire，因此这例只证明真实跨Chat形成、自然搜索与采用，不计入已证实的冷检索分母。也没有覆盖应用重启后的实际模型回忆、用户纠正、多人主体混合、完整桌面感知、真实图像生成或长期遗忘；这些不从两句对话外推。

## 用量、后台状态与证据

日志可确认6次带usage的调用：4次前台生成、1次Memory形成、1次Selector；合计49,990 input / 814 output，2,419 cached input已包含在input内，最大已知单次input为11,788。两个配置后的PFC尝试分别被新用户控制和测试退出取消，未取得response.completed，不能把其用量当作零；标题及其它未计量辅助工作也不从日志推算总generation数。本记录不给出伪精确的全应用费用或请求总数。

首次空库PFC在配置保存前报告 `PROVIDER.INVALID_CONFIGURATION`；配置变更后重排的实际尝试可在SQLite中确认，随后被上述正常控制变化取代。没有把被取消尝试称为完成的注意决策，也不把测试关闭当作产品自动Run超时。

仓外证据组 `packaged-live-ui/live-2026-09-15T17-40-19.500Z` 保留两次Run快照、事件、三张PNG、日志、只读数据库提取及实际SQLite。14项结果清单 SHA `3369c573f267ce61835a52399b47bdd30a9fd0ef1ea1a4ef5874e5a7614f1c1a`。测试Profile使用平台SecretStore，退出后精确删除该隔离目录的凭据文件；真实用户Profile和数据库未改写。临时验证runner仅在仓外，非产品第二路径；交付后按本次清理记录处理。

## 单一路径复核

Root审读全域单路径报告（SHA `6552b6fc93281283092459da3c7bd932412536872d3bd05d5934fb9734b2e638`）及晋级后partial Intent/同Run回复补充报告（SHA `382b20404d623d4f806ac61d97c1dc52fe051e60a93cb216bfeca3fa24601613`）。未发现新增实验运行模式、跨域SQL或第二状态机；后者核对84个文件hash一致，语义审查范围限于12个实际读取文件，不能等同84文件全面审计。已有partial依据只保留原请求资格，新增引用和完成支持仍受实际供应来源约束。

本轮交付的实现已经进入主程序。最终质量判断同时看实际形成、注意选择、检索、回答、延迟和复杂度，不能用通过的测试数量替代陪伴体验。

## v3 显示修复后的最终工程回归

2026-09-16，v2 之后仅改变 Provider 引用显示和同名回归文件，修正实际原文已含可点击链接时的重复补链；不改模型原文、记忆或认知上下文。新 627 文件源码冻结 SHA `bb832d12357aae73845406e2a32508f8310fc9593d3d74496e63bd467be7f6c9`，Main 逐文件一致。

同一 v3 的 `verify:offline` 1,634 项通过（134 contract、1,172 unit/component、328 integration；1.06、6.50、10.22秒），含生产 build 的 E2E 26/26 通过（约1.3分钟），macOS arm64 package 和实际 512 维编码器/SQLite 向量 Worker packaged smoke 均通过。两个既有 TanStack lint warning 和空新库未配置 Provider 的明确配置错误仍分别记录。smoke 已退出后才启动两组独立质量运行，未同时占用第三个编码器。

仓外 `memory-continuity-final-holdout/MAIN-V3-VERIFICATION.json` SHA `8d6c7547eda13661588ef16e265d4cae1848a8f4ba629b27d6813d9917421516` 记录四份本机日志的哈希。以上是工程回归；前述两个真实 UI Chat、延迟、截图和用量继续属于 v2，不把它们重新计作 v3 真实模型验收。没有再调用真实模型重放这两句 UI 对话。

## v6 完成依据与普通承接合入后的统一工程验收

当前单一路径另含实体/类型纠正、连续观察时钟、完成依据 v6 及最新实际选择的普通消费者。2026-09-16 同一 Main 的完整离线 **1,734 项**通过（134 contract / 1,272 unit+component / 328 integration；1.03/6.47/9.75 秒），含 production build 的 E2E **26/26**（约 1.3 分钟），arm64 package 及 packaged smoke 均成功。smoke 实际加载 4B/512 编码器和 SQLite 向量 Worker，检查数据库、窗口、托盘、受管浏览器、单实例及后台恢复。

仓外 `main-v6-validation/MAIN-V6-VERIFICATION.json` SHA `060727ed06ed6cebc9f3959ebea6162463871e2d796fd8efff2096fbea352b09`；632 份运行/构建/测试源冻结 `18b608725ec5888b6b723db688233a1f13706d766c09a5074328bda8c5635c8e`，不计 prose 文档，不能与此前 627 文件实验快照直接比较文件数。四份完整日志均保存。原 v5 的 25/1 E2E 及 fixture 修正记录保留，v6 已实际全量重跑。

smoke 在无 Provider 的隔离临时数据中仍正确记录配置缺失，不冒充真实注意判断；没有修改用户真实数据。八个完成语义场景和固定其状态后的八次实际普通 Agent 回归见[完成依据 Decision](COGNITION-INTENT-COMPLETION.md)，不把它们称为新的 packaged UI 测试。签名、公证、DMG、全天能耗与多人/多平台质量仍未验证。
