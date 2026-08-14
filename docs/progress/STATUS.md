# CharaMate 当前状态

> 更新日期：2026-08-14

## 当前里程碑

**Phase 6 — Done（自由领地与桌宠体验已收口）**

Phase 0–4 已完成。Phase 5 的 Automations、Multi-agent 与 Self-evolution 已分别通过 Decision、单一路径生产重写和桌面验收；主动聊天仍是独立后续工作包。Phase 6 已完成 24 px 原子空间、2.5D 深度、高密度起始房、完整生成/编辑/删除生命周期，以及 Memory/Activity 生活化联动。

产品内 Azure `gpt-image-2` 已生成一张环境与 20 类独立可编辑陈设，22 个实例应用至 Revision 3。探索态左键只选择/查看，右键从当前插值位置平滑移动；实际 atlas running 行、抵达后的 idle 行和连续改道均已覆盖。主窗口可见且停留 Territory 时只显示场景桌宠，切页、隐藏、最小化或关闭主窗口后恢复桌面 Character Window。

Phase 6 退出条件：

- [x] World 合同使用 24 px 原子单位、48 px 宏格与显式 depth mode；Schema、fixture、Repository、IPC 与 Renderer 一致。
- [x] PixiJS 使用共享脚底 Y 深度、结构遮挡、局部镜头和细格碰撞/寻路，不再存在固定场景或 12 件容量语义。
- [x] 单物件、选区、完整 Zone 与扩建共用 Candidate/Preview/change-set；背景和生成内容均可继续编辑或删除。
- [x] `gpt-image-2` 的环境、透明物件与编辑使用唯一生产 Adapter；失败 Arm、runner、临时资产和旧 Territory 路径已删除。
- [x] Memory/Activity 来源快照、稳定物件身份、来源跳转/演出和类型化桌宠行为完成。
- [x] 高密度起始房、实际生成房、左右键职责、移动姿态和桌面/场景桌宠交接均通过离线、Build、Electron E2E 与实机验收。

## 工作包状态

| 工作包 | Owner | 状态 | 结果 |
| --- | --- | --- | --- |
| `P6-TERRITORY-SANDBOX-DESIGN` | `codex/territory-sandbox-design` | `done` | 产品/UI 改为单一可扩建 2.5D World，不保留固定场景或容量语义 |
| `P6-TERRITORY-WORLD-CONTRACT/RUNTIME` | `codex/territory-sandbox-design` | `done` | schema v3、原子网格、共享深度、结构遮挡、镜头、碰撞与寻路完成 |
| `P6-TERRITORY-BUILD/AI` | `codex/territory-sandbox-design` | `done` | 完整物件生命周期与单一 Candidate 生成路径完成 |
| `P6-TERRITORY-RICH-ROOM` | `codex/territory-sandbox-design` | `done` | 48 × 30 原子格、403 个起始实例及环境 + 20 类 Azure 独立陈设完成 |
| `P6-TERRITORY-MEMORY-LIVING` | `codex/territory-sandbox-design` | `done` | Memory/Activity 来源、记忆演出与类型化桌宠行为完成 |
| `P6-TERRITORY-INPUT/PET-HANDOFF` | `codex/territory-sandbox-design` | `done` | 左键纯查看、连续右键、实际纹理行与 Character Window 生命周期通过验收 |
| `P5-AUTOMATIONS-CONTRACT/CORE/UI` | `main` | `done` | Reminder/Agent Task 唯一生产路径完成 |
| `P5-MULTI-AGENT` | `main` | `done` | Agent 自主按需调用两个只读、资源互斥 child；无 Composer 开关或第二套 Harness |
| `P5-EVOLUTION/SKILL-DELETE` | `main` | `done` | 严格结构化 Reviewer、用户确认、Skill replay、管理与永久删除完成 |
| `P5-PROACTIVE` | `main` | `specified` | 独立后续工作，不阻塞 Phase 6 |

## 依赖、边界与已知问题

- Phase 6 没有未完成 Decision 或当前产品 blocker；移动实际纹理行与 Territory/Character Window 可见性已有自动化和冷启动实机覆盖。
- Automations、Multi-agent 与 Self-evolution 都只有一条生产路径；主动聊天仍按自身依赖推进。
- `MULTI-AGENT` 的机械 Execution Gate 是 no-winner；生产能力来自透明的结果后产品修订，只覆盖两个只读、资源互斥 child，不能表述为通用并行加速。
- Zone/扩建的连续环境底图是可编辑 Definition；独立家具、附件、记忆物件、碰撞和寻路仍是结构化实体，底图内部不会从图片反推为可选几何。
- Territory 保存来源内容、日期和上游 Revision ID 的历史快照；原 Memory/Activity 后续删除不会损坏 Territory，也不会被 Territory 反写。
- `TERRITORY-WORLD-PERFORMANCE` 只证明目标设备上 2,568 实体压力输入的直接 scene tree 胜于本次 Culler/cache Arms，不宣称任意无限规模。
- 构建仍会报告大型懒加载内容 chunk 提示；当前产品旅程、启动和压力实测均通过，它不是 blocker。
- 锁屏状态曾仅触发 macOS Dock 可见性环境断言；本次合并后已在解锁状态重新通过 packaged smoke，不是产品 blocker。

## 最近绿色验证

- 2026-08-14 Phase 6 合并回 `main`：`npm run verify:offline` 通过（contract 11 files / 92 tests、focused/component 66 files / 294 tests、integration 18 files / 156 tests，共 542 项；仅 2 条既有 TanStack Virtual lint warning）；生产 Build 与 Electron E2E 20/20 通过；macOS arm64 `npm run package` 和 `npm run smoke:package` 通过，主 Renderer、Character Renderer、SQLite、受管浏览器往返与后台窗口数均绿色。
- 2026-08-14 桌宠移动与窗口交接：`npm run check:fast` 通过（contract 85；仅 2 条既有 TanStack Virtual lint warning），`npm run test:focused` 61 files / 269 tests 通过，`npm run build` 通过；Pet Electron E2E 1/1 与 Foundation preload E2E 1/1 通过。全量重启后的实机复验确认移动/抵达姿态、Territory → Chats → Territory 切换及关闭主窗口恢复桌面桌宠。
- 2026-08-13 Phase 6 完整链：`npm run verify:offline` 通过（contract 85、focused/component 264、integration 145，共 494 项）；`npm run test:e2e` 17/17 通过；macOS arm64 package 与解锁状态的 packaged/dev smoke 通过。
- 2026-08-13 Skills 与 Self-evolution：`npm run verify:offline` 通过（contract 90、focused/component 292、integration 149，共 531 项）；`npm run test:e2e` 21/21 通过，覆盖普通保存、归档、恢复、永久删除及成长结果单一入口。
- 2026-08-13 Multi-agent：最终 `npm run verify:offline` 通过（contract 83、focused/component 275、integration 142，共 500 项），Electron E2E 19/19 通过；真实 Provider Run 首次 collaboration 成功。
- `npm run test:live` 最近一次 Azure Voice 3/3 通过；产品内 Azure Image Live 已生成并应用完整 Zone，凭据未写入仓库。
- `npm run test:benchmark` 返回 `not-applicable`：候选 runner 已按生命周期删除，胜者证据保存在中文 Decision Record。

## 当前来源快照

- 2026-08-13 复核 OpenAI `gpt-image-2` 模型指南、OpenAI JavaScript SDK `6.49.0`（tag commit `04671d278ef1531692ae31a870251eec90f3c2d2`）与 Azure Image 指南；详见 `docs/benchmarks/territory-scene-generation.md`。
- 同日复核 PixiJS 8.19.0 的 Assets、Culler 与 `cacheAsTexture`；目标设备选择活动 Zone + 直接 scene tree + Assets cache，详见 `docs/benchmarks/territory-world-performance.md`。
- 同日复核锁定 `openai@6.49.0` 的 Responses Structured Outputs 类型、Agent Skills specification，以及 Codex subagents 官方手册与公开源码 commit `95aada11c4150e4ba28d6279c50f0995c1d93e5a`；Self-evolution 与 Multi-agent 的启发式和限制分别保存在对应 Decision Record。
