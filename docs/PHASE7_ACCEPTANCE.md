# Phase 7 产品验收手册

> 面向首个完整 CharaMate 产品版本。自动化结果以 `docs/progress/STATUS.md` 最近绿色验证为准；Live 与签名公证始终单独报告，不用离线 fake 代替。

## 1. 展示前准备

```bash
npm ci
npm run verify:offline
npm run build
npm run test:e2e
npm run package
npm run smoke:package
npm run make
```

开发态运行使用 `npm start`。首次启动若尚无 Provider，Chats 会显示“先连接一个模型”，点击“前往 Models”即可进入唯一的 Provider 配置路径。

## 2. 六个一级页面

1. **Chats**：从无模型引导开始；配置 Provider 后在同一 Composer 切换 Chat/Agent、Model 与三档权限，验证附件、Markdown/代码/公式、Stop、恢复、审批、补充信息和会话左侧的重命名/置顶/归档/恢复/删除。
2. **Territory**：首次进入即显示完整房间；左键只选取，右键只移动。验证布置、Undo/Redo、生成/编辑/取消/应用候选、物件删除恢复、来源跳转、跨 Zone、连续改道、碰撞与前后深度。
3. **Memory**：验证搜索、来源、编辑 Revision、置顶、归档/恢复、候选接受/拒绝，并从来源回到 Chat/Activity/Territory。
4. **Activity**：验证暂停/恢复、Episode 搜索与编辑、Digest/Memory/Territory 候选和已蒸馏原始数据清理。
5. **Automations**：在页面列表页头新建 Reminder/Agent Task，验证立即运行、暂停、编辑、删除及打开同一 Chat/Run。
6. **Settings**：验证 Appearance、Character、Voice、Models、Agent、Browser & Computer、Skills、MCP、Activity 和 Data。Appearance 包含跟随系统/浅色/深色、三套预设及自定义颜色；深色会从自定义基础色板派生低亮度版本。Data 必须可进入并显示真实目录和分类占用。

## 3. 窗口与系统表面

- **Character Window**：拖动、缩放、动画速度、v1/v2 pet 导入和跨重启恢复；主窗口位于 Territory 时桌面角色消失，离开、最小化或关闭后恢复。
- **主动对话跟随窗**：只投影同一正式 Chat/Run/Voice；临时邀请超时或关闭会清理，首个回复后原地转正。
- **Tray**：验证 Template 图标、显示主窗口、新建对话、Voice/Activity 自然状态和退出；第二实例只激活既有应用。
- **Managed Browser**：验证打开、Cookie 导入、同一 Browser Profile、Tool Item 与审批；关闭应用后无残留 Chromium。
- **Dev Dashboard**：仅开发态 loopback；查询 Run、Tool、Memory、Storage、Voice、Image 汇总和过滤后的 trace，普通产品 UI 不出现研发参数。

## 4. 恢复、并发与资源

- 同时运行两个 Chat，确认消息、Model、权限、Memory 和 Browser Profile 不串线。
- 在 running、waiting approval、needs input 与 context compaction 状态关闭再打开应用，确认 checkpoint、Item 与操作入口恢复。
- 验证 Stop/取消、过期审批、重复点击与迟到事件保持幂等；Renderer 进程崩溃后主窗口自动重建一次，React 渲染错误显示“重试界面/重新载入应用”。
- 对文件、图片、Activity 截图、Memory 来源和 Territory 资产逐一从引用打开，确认业务数据只持久化引用与元数据。
- Settings → Data 的清理确认文案必须明确：只删除已蒸馏 Activity 原始事件、截图和孤立 Activity 资产。

## 5. 视觉与可访问性

- 在跟随系统、浅色、深色和自定义背景下检查正文、代码、公式、表格、禁用态、错误与焦点环。
- 在 1180×800、最小 900×640 和 Retina 缩放检查页面；内容容器独立滚动，Approval 与 Composer 操作可见。
- 只用键盘完成六页导航、Composer 模式/模型/权限、Settings、Memory、Activity、Automation 与 Territory 的 React 控件。
- 打开系统“减少动态效果”后，动画和过渡停止或缩短，功能与状态不丢失。

## 6. Live 能力

`npm run test:live` 只在对应凭据和设备已明确提供时运行。结果逐项记录 Provider 自动发现/手填、Chat Tool Calling、Azure Realtime、Azure Image 生成与编辑、MCP、Managed Browser/Computer Use；没有真实凭据、麦克风、屏幕录制或辅助功能授权的项目标为“未运行 + 原因”，不得写成通过。

## 7. macOS 发布

`npm run make` 生成唯一 Forge DMG。无 Apple 凭据时产出未签名的本地验收安装器；正式发布由 CI/发布机提供：

- `CHARAMATE_MACOS_SIGN_IDENTITY`：Developer ID Application identity；
- `CHARAMATE_NOTARIZE_KEYCHAIN_PROFILE`：`xcrun notarytool store-credentials` 保存的 profile；
- `CHARAMATE_NOTARIZE_KEYCHAIN`：可选，自定义 keychain 名称或路径。

配置了 notarization profile 却没有签名 identity 时构建立即失败，避免产出被误认为已公证的包。正式发布需保存 `codesign --verify --deep --strict`、`spctl --assess --type execute`、notarytool 与 stapler 结果；仓库不保存凭据。

若 Endpoint DLP 扫描器对 MakerDMG 创建的临时 `/Volumes/...` 返回持续 code 16，Forge 配置只在普通卸载失败后对该临时卷执行一次 `hdiutil detach -force`；不停止扫描器、不改系统安全配置，也不扩大到其他卷。

## 8. 当前来源快照

- Renderer 恢复依据锁定 `electron@43.2.0` 随包 `electron.d.ts` 的 `render-process-gone` reason 与 `forcefullyCrashRenderer`；自动重建主窗口一次是 CharaMate 恢复策略，不是 Electron 协议硬限制。
- 签名/公证依据锁定 `@electron/packager` 随包类型的 `osxSign`/`osxNotarize`，以及 `@electron/notarize@2.5.0` 的 keychain profile contract。
- DMG 依据锁定 `@electron-forge/maker-dmg@7.11.2`、`electron-installer-dmg@5.0.1` 与 `appdmg@0.6.6`；后者上游仅对 code 16 指数重试，因此本机 Microsoft Defender DLP 持续 dissent 使用上一节的临时卷兼容处理。macOS host 是该 maker 的平台要求。
