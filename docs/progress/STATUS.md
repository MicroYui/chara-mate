# CharaMate 当前状态

> 更新日期：2026-08-01

## 当前里程碑

**Phase 0 — 工程基线与稳定契约：implementing**

退出条件：

- 单 package Electron/Forge/Vite、strict TypeScript/React 工程已创建并精确锁定依赖；
- dev launch、Main/Preload/Renderer build、Forge package 和 packaged-app smoke 通过；
- `better-sqlite3` 在开发与打包产物中完成真实事务、关闭和重开读取；
- Chat/Message/Run/RunItem/Approval、IPC sequence、artifact、cancel 和 redaction 契约实现且正反例测试通过；
- fast check、focused test、full offline、build/package、E2E 和 live/benchmark scripts 已真实建立并写回 `AGENTS.md` Commands；
- 尚未通过实验的算法、Transport 和参数没有被写成生产默认值。

## 活动工作包

- `FND-QUALITY` — owner：Phase 0 integration owner；状态：`implementing`。实际命令已写回 `AGENTS.md`，待完整 Phase 0 验收链、单路径审计和最终文档收口。
- `FND-CONTRACTS` — owner：Phase 0 integration owner；状态：`done`。Chat/Message/Run/RunItem/Approval、Provider snapshot、artifact、error 与取消的 Schema/类型及正反例已通过双验证器。
- `FND-IPC` — owner：Phase 0 integration owner；状态：`done`。请求/响应/订阅类型、`afterSequence` 重放、连续 sequence 校验和真实窄 Preload 边界已验证。
- `FND-CORRECTNESS` — owner：Phase 0 integration owner；状态：`done`。统一 ID/clock/AbortSignal、取消、artifact 引用、fixture、Pino/SQLite redaction 入口已验证。
- `FND-TOOLCHAIN` — owner：Phase 0 integration owner；状态：`done`。唯一 Electron/Forge/Vite、原生数据库、package、隔离 packaged smoke 与 Electron E2E 路径均已验证。
- `WP-DOC-STACK-001` — 状态：`done`。

## 依赖、阻塞与待决 Decision

- Phase 0 当前无外部阻塞。2026-08-01 一手 npm/GitHub 核对发现预登记的 `better-sqlite3@13.0.2` 与 Playwright `1.62.1` 未发布，已在实现前把权威设计修正为已发布的 `13.0.1` 与 `1.62.0`。
- 官方 Electron 43 ESM 文档要求 ESM Preload 使用 `.mjs`，并说明 sandboxed Preload 不支持 ESM；当前唯一配置保持 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: false`。目标机实测顶层 `await app.whenReady()` 不继续执行，当前实现把 `app.setPath` 留在 ready 前并以 Promise 生命周期启动；这是 Electron `43.2.0`/Forge `7.11.2` 的实测行为，不是协议硬限制或产品启发式。
- 生产 Agent Runtime 仍受 `HARNESS-LOOP`、`TOOL-DISCOVERY` 阻塞。
- 生产 Memory/Activity 仍受 `MEMORY-STORAGE`、`MEMORY-RETRIEVAL`、`CONTEXT-RECIPE`、`MEMORY-GRAPH`、`ACTIVITY-DISTILLATION`、`ACTIVITY-RETENTION` 阻塞。
- 生产 Voice 仍受 `VOICE-ARCHITECTURE`、`VOICE-TRANSPORT`、`VOICE-TOOL-JOIN` 阻塞。
- Multi-agent 与自进化分别受 `MULTI-AGENT`、`SELF-EVOLUTION` 阻塞；未晋级时对应生产协议、组件、表和设置不存在。

## 最近绿色验证

- 2026-08-01：六份 Markdown 的本地链接目标检查，`<0.1s`，通过。
- 2026-08-01：六份 Markdown 的 `git diff --no-index --check`，`<0.1s`，通过。
- 2026-08-01：13 个 Decision ID 与完整产品能力关键词的跨文档 `rg` 审计，`<0.3s`，通过。
- 2026-08-01：12 个新增一手来源 URL 的 HTTP 检查，`11.0s`，全部返回 `200`。
- 2026-08-01：`npm run format:check && npm run typecheck && npm run lint && npm test`，`4.2s`；4 个测试文件、8 个测试通过。
- 2026-08-01：`npm run build`，Main、Preload、Renderer 三个 ESM 目标通过。
- 2026-08-01：`npm run smoke:dev`，真实事务、关闭重开与 Renderer ready 通过。
- 2026-08-01：`npm run package && npm run smoke:package`，应用复制到仓库外临时目录后独立启动，ASAR 外原生模块、真实事务、关闭重开与 Renderer ready 通过。
- 2026-08-01：`npm run test:e2e`，`3.5s`；Playwright Electron 窄 preload API 旅程通过。
- 2026-08-01：`npm run verify:offline`，`3.8s`；21 个 contract、13 个 focused、2 个 SQLite integration 测试通过。
- 2026-08-01：`npm run test:e2e`，`4.3s`；新增真实 IPC 请求校验后 Playwright Electron 旅程通过。
- 2026-08-01：`npm ls --all --json`，依赖树无 missing、invalid 或 peer problem；`npm audit --omit=dev` 为 0。

## 已知产品影响问题

- 尚无已接受的 Benchmark Decision Record；Decision-gated 生产能力仍不得实现。
- Electron Forge Vite Plugin 在当前官方说明中仍标记为 experimental；已通过 Phase 0 的开发启动、原生模块、打包、隔离 packaged-app smoke 与 Electron E2E，并冻结为唯一构建路径。
- Forge 打包当前携带 `better-sqlite3` 的多平台预构建二进制，macOS `.app` 约 305 MB；不阻塞 Phase 0 正确性，发布优化需在不增加第二构建路径的前提下处理。
- 完整 `npm audit` 报告 33 个仅开发工具链告警（4 low、28 high、1 critical），均来自精确锁定的 Forge/Vite 间接依赖；生产依赖审计为 0，且 npm 没有为 Forge `7.11.2` 给出兼容的直接修复。后续 Forge 升级必须重新通过完整工具链兼容性套件，不能用报告建议的旧版替换已验证路径。
