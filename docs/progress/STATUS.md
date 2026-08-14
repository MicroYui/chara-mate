# CharaMate 当前状态

> 更新日期：2026-08-14

## 当前里程碑

**Phase 6 — Done（桌宠移动动画与 Territory 窗口交接已收口）**

Phase 0–4 已完成；Phase 5 的 Automations 已完成，主动聊天与 Decision-gated Multi-agent/Evolution 仍是独立后续包。Phase 6 已完成空间粒度、2.5D 深度、高密度起始房和实机反馈收口：左键只选择/查看且绝不触发寻路，途中连续右键从桌宠当前插值位置平滑改道；Zone 生成使用一张环境与 20 类独立可编辑陈设组成的原子候选。产品内 Azure `gpt-image-2` 已完成 21 张图片的完整华丽领地 Live，并将 22 个独立实例全部应用到 Revision 3。

2026-08-14 的探索态故事卡、移动动画和桌面桌宠交接均已收口。坐姿平移的残留复现来自长时间运行的开发体验进程在 Fast Refresh 后保留了旧 Pixi 控制器；现在移动路径会先提交 running 视觉状态再发布目标快照，并以实际 atlas texture 行而非诊断标记做回归。主窗口可见且停留 Territory 时临时隐藏桌面 Character Window，离开页面或主窗口隐藏/关闭后恢复，不修改用户的桌宠选择或持久设置。

Phase 6 退出条件：

- [x] World 合同改为 24 px 原子单位、48 px 宏格与显式 depth mode；Definition schema、fixture、Repository 和 IPC 消费者一致。
- [x] SQLite Repository、Main Service、typed IPC/Preload 与 Renderer 使用唯一 `territory` API；Revision 冲突、原子提交、删除恢复、永久删除和孤儿资产清理完成。
- [x] PixiJS 把桌宠、可遮挡结构、家具与附件放入共享脚底 Y 深度；镜头默认显示大 Zone 局部，细格碰撞/寻路与前后遮挡通过实际行走验收。
- [x] 游览/建造沿用完整物件生命周期，但布置网格区分原子格与宏格，物件视觉 footprint 不再形成隐性占用上限。
- [x] 单物件、选区、完整 Zone 与扩建仍共用 Candidate/Preview/change-set；单物件 compiler 不再把所有内容固定为同一粗粒度地面物件。
- [x] `gpt-image-2` 的物件去背景、Zone environment plate 与原子 Asset Pack 使用唯一生产管线；背景和起始/生成内容都可继续编辑或删除。
- [x] Memory/Activity 来源快照、稳定记忆物件身份、来源跳转/演出、桌宠走近与 `seatable`/`sleepable`/`inspectable` 行为完成。
- [x] `TERRITORY-SCENE-GENERATION` 与 `TERRITORY-WORLD-PERFORMANCE` 已接受；失败 Arm、runner、临时资产和旧生产路径已删除。
- [x] 随包起始房呈现高密度、长期生活过的多个角落，并以离线、Build、Electron E2E、实际视觉与必要 Azure Image Live 重新验收。
- [x] 探索态左键不再移动或产生不可达错误；连续右键改道不重挂 Pixi 桌宠控制器，也不闪现到旧目标。
- [x] Azure `gpt-image-2` 完成环境 + 20 类独立陈设的完整 Zone 候选，视觉审阅、应用和最终回归通过。
- [x] 实际 Pixi 显示帧在每次移动期间稳定使用 running 行，抵达后才回到 idle；连续改道与同向/竖向起步均通过实机复验。
- [x] 主窗口可见且停留 Territory 时只显示场景内桌宠；离开 Territory、主窗口隐藏或关闭时桌面 Character Window 恢复。

## 工作包状态

| 工作包 | Owner | 状态 | 结果 |
| --- | --- | --- | --- |
| `P6-TERRITORY-SANDBOX-DESIGN` | `codex/territory-sandbox-design` | `done` | 产品/UI 改为单一可扩建 2.5D World，不再保留固定场景或容量语义 |
| `P6-TERRITORY-WORLD-CONTRACT` | `codex/territory-sandbox-design` | `done` | schema v3 冻结 24 px 原子单位、48 px 宏格、tile span 与三种 depth mode |
| `P6-TERRITORY-WORLD-RUNTIME` | `codex/territory-sandbox-design` | `done` | 共享脚底 Y 深度、结构遮挡、局部镜头、细格碰撞与寻路完成 |
| `P6-TERRITORY-BUILD-UI` | `codex/territory-sandbox-design` | `done` | 细/宏网格、完整生命周期及探索态右键移动/左键互动完成 |
| `P6-TERRITORY-AI-CREATION` | `codex/territory-sandbox-design` | `done` | 生成 Definition 按语义编译尺寸、层级与碰撞，继续使用唯一 Candidate 路径 |
| `P6-TERRITORY-RICH-ROOM` | `codex/territory-sandbox-design` | `done` | 交付 48 × 30 原子格、403 个 Zone 实例与多个生活角落的随包起始房 |
| `P6-TERRITORY-MEMORY-LIVING` | `codex/territory-sandbox-design` | `done` | Memory/Activity 来源、记忆形成演出与类型化桌宠行为完成 |
| `P6-TERRITORY-INPUT-AND-GENERATED-SHOWCASE` | `codex/territory-sandbox-design` | `done` | 左键纯查看、连续右键改道与 21 张 Azure 完整生成领地已通过实景与 E2E 验收 |
| `P6-TERRITORY-EXPLORE-STORY-CARD` | `codex/territory-sandbox-design` | `done` | 探索态介绍改为不遮挡场景的紧凑故事卡；可展开完整内容，建造检查器保持不变 |
| `P6-TERRITORY-PET-MOVEMENT-ANIMATION` | `codex/territory-sandbox-design` | `done` | running 视觉状态先于目标快照提交；单元与 Electron E2E 直接断言实际 atlas 行，冷启动实机复验通过 |
| `P6-TERRITORY-DESKTOP-PET-HANDOFF` | `codex/territory-sandbox-design` | `done` | Territory 活跃且主窗口可见时只显示场景桌宠；切页、隐藏、最小化或关闭主窗口均恢复 Character Window |
| `P5-AUTOMATIONS-CONTRACT/CORE/UI` | `main` | `done` | Reminder/Agent Task 唯一生产路径完成 |
| `P5-PROACTIVE` | `main` | `specified` | 独立后续工作，不阻塞 Phase 6 |
| `P5-MULTI-AGENT` / `P5-EVOLUTION` | disposable decision work | `specified` | 仅在各自 Decision 晋级后实现 |

## 依赖、边界与已知问题

- Phase 6 没有未完成 Decision 或当前产品 blocker；移动实际纹理行与 Territory/Character Window 可见性生命周期已有自动化和冷启动实机覆盖。
- 粗粒度起始房、桌宠固定高层与生成物固定尺寸三个重开原因均已消除；探索态左右键职责已分离，underlay 的互动命中不再阻止行走。
- Zone/扩建的连续环境底图是一个可编辑 Definition；需要独立移动的家具、附件、记忆物件、碰撞和寻路仍是结构化实体。底图内部的墙面/铺地不会从图片反推为可选几何，这是已接受生成路径的明确边界。
- Territory 保存来源内容、日期和上游 Revision ID 的历史快照；原 Memory/Activity 后续删除不会损坏 Territory，也不会被 Territory 反写。
- `TERRITORY-WORLD-PERFORMANCE` 只证明目标设备上 2,568 实体压力输入的直接 scene tree 胜于本次 Culler/cache Arms，不宣称任意无限规模；未来真实规模变化需新 Decision，不能偷偷加入容量常量。
- 构建仍会报告大型懒加载内容 chunk 提示；当前产品旅程、启动和压力实测均通过，它不是 Phase 6 blocker。
- 本次主机锁屏期间复跑 `smoke:package` / `smoke:dev`：数据库、受管浏览器、主 Renderer、Character Renderer 与后台窗口数均通过，受管浏览器往返后仅 macOS Dock 可见性为 `true`，命令因此退出 1；同日解锁状态的两项最近绿色结果仍保留，需在解锁后再复验该环境断言。

## 最近绿色验证

- 2026-08-14 桌宠移动与窗口交接最终链：`npm run check:fast` 通过（contract 10 files / 85 tests；仅 2 条既有 TanStack Virtual lint warning），`npm run test:focused` 61 files / 269 tests 通过，`npm run build` 通过；定向 Pet Electron E2E 1/1 与 Foundation preload E2E 1/1 通过，覆盖纯竖向移动的实际 atlas running 行、抵达后的 idle 行、切页恢复以及关闭主窗口恢复 Character Window。全量重启后的 Computer Use 实机复验再次确认移动/抵达姿态，并完成 Territory → Chats → Territory 切换。
- 2026-08-14 桌宠移动姿态上一轮自动化：`npm run check:fast`、61 files / 266 tests、Build 与定向 E2E 均通过，但断言只覆盖诊断状态；用户随后仍在实机复现坐姿平移，因此该结果不足以关闭工作包。
- 2026-08-14 探索态紧凑故事卡：`npm run check:fast` 通过（contract 85；仅 2 条既有 TanStack Virtual lint warning），`npm run test:focused` 60 files / 265 tests 通过，Territory 组件定向测试 11/11 通过；Electron 实机检查了默认卡片、展开态和进入建造后的完整检查器。
- 2026-08-13 Phase 6 最终链：`npm run verify:offline` 25.39s 通过（contract 85、focused/component 264、integration 145，共 494 项；仅 2 条既有 TanStack Virtual lint warning）。
- `npm run build` 13.02s 通过；`npm run test:e2e` 17/17 通过（完整命令 29.55s，Playwright 18.0s），包含左键选择地毯、右键走上地毯、无系统菜单、途中改道、奇数原子格落点和跨重启恢复。
- macOS arm64 `npm run package` 25.25s 通过；同日解锁状态的最近绿色 `npm run smoke:package` 5.28s、`npm run smoke:dev` 6.82s 仍有效，本次锁屏复验结果见已知问题。
- `npm run test:live` 30.3s：Azure Voice 3/3 通过；未提供显式图片 Live 环境变量，仓库的 Territory Image Live 1 项按设计跳过。
- 使用正常应用中已保存的 Azure `gpt-image-2` profile 完成产品内 Live：在既有 72 × 72 RGBA 琥珀玻璃台灯之外，生成一张 1152 × 720 环境与 20 类透明独立陈设，共 22 个实例全部落位并原子应用至 Revision 3；44 件可替换旧内容移回收藏库，透明键色全图清理与回归测试完成。凭据未写入仓库。
- `npm run test:benchmark` 返回 `not-applicable`：候选 runner 已按生命周期删除，胜者证据保存在两份中文 Decision Record。

## 当前来源快照

- 2026-08-13 复核 OpenAI `gpt-image-2` 模型专属指南、OpenAI JavaScript SDK `6.49.0`（tag commit `04671d278ef1531692ae31a870251eec90f3c2d2`）与 Azure Image 指南：目标模型只请求 opaque 输出并省略 `input_fidelity`；图片不定义碰撞、锚点或 World 几何。详见 `docs/benchmarks/territory-scene-generation.md`。
- 同日复核 PixiJS 8.19.0 的 Assets、Culler 与 `cacheAsTexture`；CharaMate 在目标 Electron/硬件压力输入上选择活动 Zone + 直接 scene tree + Assets cache。详见 `docs/benchmarks/territory-world-performance.md`。
