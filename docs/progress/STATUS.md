# CharaMate 当前状态

> 更新日期：2026-08-01

## 当前里程碑

**Phase 1 — 产品骨架与 Chats：implementing**

Phase 0 已完成。Phase 1 当前只启动 Renderer fixture lane；Chat 数据、Main 服务、Provider/Secret 与真实 IPC 接入尚未启动。

当前里程碑退出条件：

- [ ] App Shell、六个一级页面入口、Chats 侧栏与空状态满足冻结 UI 方案；
- [ ] Composer 的 Chat/Agent、Model、权限、附件、Voice/Send/Stop 位置与状态通过组件测试；
- [ ] 用户/助手消息、内容渲染、复制、Run 折叠、Tool 二级详情和 Approval fixture 满足 UI 验收；
- [ ] Renderer fixture 与共享 Contract/Schema 一致，不引入 Main、数据库或 Provider 的临时兼容路径；
- [ ] 受影响的 L0/L1、React component test、Electron Chats fixture E2E、build 与 package smoke 通过。

## 活动工作包

- `P1-APP-SHELL` + `P1-CHAT-UI` + `P1-CONTENT` + `P1-RUN-PROJECTION`（fixture lane）：owner `feat/phase1-chats-ui-fixtures` worktree，状态 `implementing`。范围为 Renderer、冻结 fixture、component/E2E；非目标为真实 Chat Repository/Service、Provider、Agent Runtime 与业务 IPC。关键画面和组件外观需与用户逐项评审后冻结。

## 依赖、阻塞与待决 Decision

- Phase 0 无阻塞。2026-08-01 一手 npm/GitHub 核对发现预登记的 `better-sqlite3@13.0.2` 与 Playwright `1.62.1` 未发布，已在实现前把权威设计修正为已发布的 `13.0.1` 与 `1.62.0`。
- 官方 Electron 43 ESM 文档要求 ESM Preload 使用 `.mjs`，并说明 sandboxed Preload 不支持 ESM；当前唯一配置保持 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: false`。目标机实测顶层 `await app.whenReady()` 不继续执行，当前实现把 `app.setPath` 留在 ready 前并以 Promise 生命周期启动；这是 Electron `43.2.0`/Forge `7.11.2` 的实测行为，不是协议硬限制或产品启发式。
- 生产 Agent Runtime 仍受 `HARNESS-LOOP`、`TOOL-DISCOVERY` 阻塞。
- 生产 Memory/Activity 仍受 `MEMORY-STORAGE`、`MEMORY-RETRIEVAL`、`CONTEXT-RECIPE`、`MEMORY-GRAPH`、`ACTIVITY-DISTILLATION`、`ACTIVITY-RETENTION` 阻塞。
- 生产 Voice 仍受 `VOICE-ARCHITECTURE`、`VOICE-TRANSPORT`、`VOICE-TOOL-JOIN` 阻塞。
- Multi-agent 与自进化分别受 `MULTI-AGENT`、`SELF-EVOLUTION` 阻塞；未晋级时对应生产协议、组件、表和设置不存在。

## 最近绿色验证

- 2026-08-01：`npm ci`，`17.6s`；从精确 lockfile 干净安装 698 个 package，lockfile 无变化，SHA-256 为 `f698ddaf57b10f07668016bb76eb87186d8bd03b04dd6d42490bab4e62d103ca`。
- 2026-08-01：`npm run verify:phase0`，质量修复后复跑 `18.4s`；25 个 contract、16 个 focused、2 个 SQLite integration、Main/Preload/Renderer build、dev smoke、Forge package、隔离 packaged smoke 与 1 个 Electron E2E 全部通过。时间戳日历校验、单 Run 取消绑定、smoke/E2E 失败清理与 Renderer readiness 异步断言均有对应实现或回归覆盖。
- 2026-08-01：`npm run test:live && npm run test:benchmark`；两者按设计报告 `not-applicable`，Phase 0 没有外部 endpoint 或 Benchmark Decision owner，且未进入默认回归。
- 2026-08-01：`npm ls --all --json` 无 missing、invalid 或 peer problem，30 个直接依赖均为精确版本，`npm audit --omit=dev` 为 0。
- 2026-08-01：`rg`/`find`/ASAR 单路径审计，`<1s`；无第二 lockfile/build path、业务空目录、ORM、通用 Agent 框架或候选算法代码；产物包含唯一 ESM Main/Preload/Renderer 与已解包原生模块。

## 已知产品影响问题

- Electron Forge Vite Plugin 在当前官方说明中仍标记为 experimental；已通过 Phase 0 的开发启动、原生模块、打包、隔离 packaged-app smoke 与 Electron E2E，并冻结为唯一构建路径。
- Forge 打包当前携带 `better-sqlite3` 的多平台预构建二进制，macOS `.app` 约 305 MB；不阻塞 Phase 0 正确性，发布优化需在不增加第二构建路径的前提下处理。
- 完整 `npm audit` 报告 33 个仅开发工具链告警（4 low、28 high、1 critical），均来自精确锁定的 Forge/Vite 间接依赖；生产依赖审计为 0，且 npm 没有为 Forge `7.11.2` 给出兼容的直接修复。后续 Forge 升级必须重新通过完整工具链兼容性套件，不能用报告建议的旧版替换已验证路径。
