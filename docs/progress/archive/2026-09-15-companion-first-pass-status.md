# CharaMate 当前状态

> 更新日期：2026-09-15

## 当前里程碑

**AI 陪伴认知、记忆与自主生活 — integration-verified / 本地交付完成，代理精确输入上限仍有能力缺口**

用户确认长期 AI 陪伴定位、角色自主生活、细粒度桌面情境与更克制的记忆使用；允许必要重构。本地实现复用一个 Run/Item 与现有调度器。在线多人、跨平台记忆与角色社区本次交付研究方案，不预建服务器。完整入口：[研究与实施方案](../research/ai-companion-local-implementation-2026-09-15.md)。

本地退出条件已满足：Product/UI/Decision 与代码一致；事件 actor/内容范围、用户打断、Persona 切换、真实经历、领地自动安放/收藏/撤销、旧事可达、完整输入预算路径通过离线回归；native build、受影响 Electron E2E 与 packaged smoke 完成。当前代理不支持精确输入计数，因此 258,000 Token 的真实协议硬上限尚不能标成完全验收；这个缺口与离线实现完成分开记录。

## 活跃工作包

| 包 | Owner | 状态 | 范围与剩余工作 |
| --- | --- | --- | --- |
| COMPANION-RESEARCH | root + 认知/记忆/在线研究 | done | 三份一手来源报告、实施入口、前瞻协议与四份 Decision；在线能力保留为未来方向 |
| COMPANION-ATTENTION | Activity owner / root 集成 | done | 细事件、AX/DOM局部内容、键鼠聚合、actor边界、24KiB工作集、语义机会冷却；原生合成窗口通过，覆盖范围见下文 |
| COMPANION-LIFE-TERRITORY | Territory owner / root 集成 | done | 持久意图、用户优先、真实Tool经历、自动安放/收藏、Persona切换与撤销；自主生活、重启延续与生成的Electron流程通过 |
| COMPANION-MEMORY-LIFECYCLE | Memory owner / root 集成 | done | 移除曝光排序强化，保留旧相关事实；年龄淡化实验不采纳，无候选状态进入运行时 |
| COMPANION-RESPONSE-STRATEGY | root | done | 24对Astra Pilot完成；Text/Voice共用紧凑策略，保留结果后取舍与样本限制 |
| COMPANION-CONTEXT-BUDGET | Provider owner / root 集成 | integration-verified | 完整Responses请求守门、首次/分批摘要、Voice首次历史检查通过；代理精确计数/服务端上限是剩余部署缺口 |

共享 Activity/Territory 合同、DB v25 与 Main/Run 由 root 唯一集成；没有新依赖、第二 Runtime、第二调度器或生产实验开关。源码集成在 main 工作区，未提交或推送。

## 最后绿色验证（2026-09-15）

| 命令 / 验证 | 结果与耗时 |
| --- | --- |
| `npm run verify:offline` | **1,061 tests**：134 contract / 660 unit+component / 267 integration；对应测试阶段1.00s / 4.41s / 9.65s；typecheck、lint、format全部通过 |
| 最终 `npm run check:fast` | 首次空库模型改为Astra后再次通过，约23.12s；其中134 contract，1.15s；仅保留两个既有TanStack Virtual/React Compiler lint warning，无error |
| 最终受影响 Provider 回归 | `providerService.unit.test.ts` 11 tests，0.231s；此前错误提示文案修改后 `openaiModelProvider.test.ts` 30 tests，0.266s |
| `npm run build` | Main/Preload/Renderer与新版native addon通过；保留既有大chunk提示 |
| `npx playwright test` 及两文件定向重跑 | 首轮26流程中24通过（约1.4min）；修正Chats精确计数fixture、Journey单行JSON解析fixture后，两条重跑通过（5.5s）；不是一次26/26全绿调用 |
| `npm run package`、`npm run smoke:package` | macOS arm64包与隔离用户目录启动通过；首次15.95s / 5.46s，Astra空库默认修改后重新打包并smoke通过，最终日志写入跨度约16.72s / 4.68s |
| 原生合成窗口 smoke | AX局部内容/受保护控件、订阅生命周期、actor切换通过；后续7.950s NSEvent运行中，user与agent各收到1点击/1keydown/1滚动；临时脚本及profile清除 |

Electron覆盖角色自主 `observe → sleep → 保存暂停意图`、Tool真实结果保存、没有伪造用户消息、重启延续，以及小物件同Run生成后自动安放/真实来源。Package smoke覆盖数据库、Browser往返、Renderer/角色资产、单实例、托盘、后台/Dock行为与初始Provider元数据。未运行本轮DMG make、独立dev smoke、真实图片/语音质量和真人长期试用；离线fake不能替代这些结论。

文本 Pilot 使用用户指定 **gpt-6-astra：48/48成功**，116,074 input、107,870 cached input、2,348 output，单次最大2,624 input。无重试/截断，64次预算剩余16次未用；没有Image/Realtime付费调用，代理单价未知。24对为策略4胜/20平/0负，不能宣称长期效果显著。注意合成回放在相同24请求点将证据JSON从17,737,499B降到227,040B；这是结构结果，不是语义质量或账单下降。

## 产品影响与能力边界

1. 当前 localhost 代理不支持精确 Responses input-token count，也没有已核实的服务端输入硬上限；保守估算能挡住明显过大/未知请求，但不能证明真实Token绝对≤258,000。已知较小Provider限额仍取交集。详见 COMPANION-CONTEXT-BUDGET。
2. AX/DOM只覆盖可访问局部文字；画布、图片与普通浏览器完整页面不等于已理解。原生验证覆盖合成Electron本进程，未证明其它应用global monitor、应用启停、拒绝权限、睡眠恢复或长期资源表现；长期语义注意质量未经真人纵向验证。
3. 本轮没有训练未来价值预测器或上线自动年龄遗忘；离线淡化候选伤害旧事召回而被否决。R0广义主题检索仍有噪音局限，详细后续候选在Memory研究报告。
4. 空库初始文本模型现为gpt-6-astra，已有用户Profile不改写。已保存的CharaMate copilot_api凭据曾返回401；本轮文本Pilot用Codex已配置的同host凭据验证连接，未替换用户保存的凭据。真实图片质量、Realtime、Firebase/FID、物理手机与系统通知权限切换未在本轮验证。

## 之前的验收

此前 Phase 0–7、桌面与本地 Android Companion 完成状态、绿色命令和已知发布边界保存于[2026-09-02 状态归档](archive/2026-09-02-status.md)。它们是历史证据，不与本轮验证混算。当前小物件自主完成取代历史逐件Preview行为，详见当前Product/UI与本次Decision。
