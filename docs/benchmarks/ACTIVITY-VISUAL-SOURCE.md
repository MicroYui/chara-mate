# ACTIVITY-VISUAL-SOURCE：当前可见区域的视觉证据

2026-09-15，状态：focused-verified；集成 owner：root。原生与 Activity 域验证完成，Main/Cognition 已接线；正式打包与完整陪伴体验待验收。本稿没有宣称副屏、macOS 13.3 真机、全天视频能耗或线上模型质量已验收。原型与结果在外部 `activity-visual-native/`，不进入生产。

## 选定路径

仅有 AX/DOM 文本时，画布、图片和视频内容不可见，原来的“存在截图”提示不足以作视觉判断。本实现选用一条本地 ScreenCaptureKit → Apple Vision OCR → Activity 本地图像引用路径，由既有 PFC 判断关注和行动。没有独立 caption 决策器、第二模型循环或截图参数设置页。

原生捕获当前前台窗口与实际显示器相交的可见区域。AX PID/窗口几何与 SCK 窗口必须唯一匹配；选择真实最大相交面积的显示器，将区域换算成显示器局部 logical points，再按匹配 NSScreen.backingScaleFactor 输出像素。匹配失败明确不可用，不退回主屏。跨屏窗口只声明所选显示器内那一部分，clipped=true。这是该区域真实合成画面，包含可见遮挡，不能解释成整个应用的完整内容。

SCK 维护一个 latest CVPixelBuffer，5 fps、queueDepth=3 是产品资源候选值，不是苹果协议上限，也不是模型频率。BGRA 每行逐字节比较，只在像素真实变化后发 surface/actor/capturedAt/sequence 小通知，原生 JS 通知队列最多一条。没有像素变化百分比显著性阈值。视频没有 AX/键鼠事件时也能唤醒既有 PFC 的合并调度。

分析准备时才调用 consumeLatestVisualEvidence：取当时最新帧，后台 Vision accurate OCR，再做 PNG 编码、文本脱敏和凭据区域像素遮盖。中间帧不 OCR、不编码、不写 PNG、不写 Activity event；coalescedFrames 明示被合并的已观察帧，不能声称视频每个片段都被理解。暂停、睡眠、停止或对象变化使当前缓存与在途任务失效。像素变化本身不使同一对象的只读模型分析反复取消。

凭据检测复用 shared redaction：命中 OCR 行同步黑色遮盖；跨行凭据匹配覆盖参与的 OCR 文本集合。检测失败不输出原图。OCR 可能漏字，不能宣称穷尽图中秘密；没有新增隐私产品流程。

## 来源与时间

每个新 screenshot 必须有真实 surface id/epoch、actor、capturedAt、receivedAt、sequence、OCR 引擎/revision/语言/状态/行框，以及脱敏 PNG SHA256 contentRevision。surface.bounds 是全局左上 logical points；OCR boxes 是图内左上归一化坐标。真实旧截图没有可靠 metadata，持久 schema 的 visual 仍 optional，没有旧格式新生产者。

SCK displayTime 是 window server 显示时刻的 mach absolute time；实测可能比 receivedAt 晚约2ms。实现用有符号时间差，保留原关系，不伪造成接收时刻。

consume 返回 {event, reference}，不再次 publish；Main 先 observe 真实 event 再取快照。Driver 的 visualCoverage 区分实际装入输入、不可用和预算省略。文本来源可以独立支持文字事实；没有送入的图片不能支持视觉判断。Attempt 的依赖 ID 列表本身不证明收到过像素。本包不把 OCR 文本当作图片理解结论。

resolveVisualEvidence 精确校验 eventId、artifactId、contentRevision 与引用 metadata，读文件后再核对来源存在和实际 PNG hash；已清理、来源修改、文件丢失明确 unavailable。合法历史图片不因当前窗口后来出现新像素失效。isCurrentVisualSource({surface,actor}) 则检查当前 actor、id/epoch、surface metadata；sequence 仅拒绝帧乱序，不把每像素变化当作动作失效。

完全相同 PNG 按内容复用，多条 event 可共享资产。删一个 Episode 不会删其它 event 仍引用的文件；retention 检查所有共享引用。新增 activity_event 记忆来源对应真实 ActivityEvent.id；getEvent/resolveEventReference 返回准确 event、本地日期与实际可选 Episode ID，不猜 ID、不伪造导航。

## Primary sources 与平台版本

读取日期2026-09-15；Apple SDK26.5头文件的 SCStream/SCContentFilter/sourceRect/frame status/displayTime、Vision revision3、CoreGraphics permission 声明是具体版本依据，对应官方入口：

- [SCStream](https://developer.apple.com/documentation/screencapturekit/scstream)、[displayTime](https://developer.apple.com/documentation/screencapturekit/scstreamframeinfo/displaytime)：Idle可复用；Blank/Suspended/Stopped清空latest并作availability失效，不能让旧OCR复活。
- [VNRecognizeTextRequest](https://developer.apple.com/documentation/vision/vnrecognizetextrequest)：实现选择accurate/revision3、zh-Hans/en-US、关闭语言纠错。
- [CGRequestScreenCaptureAccess](https://developer.apple.com/documentation/coregraphics/cgrequestscreencaptureaccess())：首次启用且preflight=false最多请求一次OS权限，不逐帧重试。SDK未声明显式UI gesture约束；本轮验收使用已有授权的合成窗口，未新触发私人桌面采集。

Electron43.2.0/Node-API，Apple clang/SDK26.5，显式macOS13.0编译目标。复用既有原生addon，增加ScreenCaptureKit/Vision/CoreMedia/CoreImage/ImageIO系统framework，无新增第三方依赖或进程。

`native-minimum-os.json` 实际Mach-O清单：Activity新版13.0；当前llama-server/supervisor及链接dylib全部13.3；Electron本体声明12.0。整产品最低版本应为13.3，由root接Info.plist。实际运行环境macOS26.6.2，不能称13.3真机已验收。

## 实测与诚实边界

原型固定读取自己创建的Electron窗口自身PID，失焦即暂停，无正常全局前台订阅，未采用户私人应用。外部fixture不是生产第二模式。

| 检查 | 实际结果 |
| --- | --- |
| Retina/数字 | 850×720 logical→1700×1440 PNG；OCR总额880→980 |
| 同字异图 | 改柱形图，PNG revision不同；OCR不能替代图像去重 |
| OCR差异 | 同英文偶有fixture/fxture差异，未包装成确定性视觉结论 |
| 凭据 | 合成access_token命中1处，PNG对应行黑色遮盖，已目视检查 |
| 遮挡 | 自建遮挡窗口文字进入OCR，反映可见合成画面 |
| 离屏裁剪 | bounds x1428/y199/w300/h720→600×1440，clipped=true，epoch变化 |
| 高频变更 | 50次/秒约3.169秒，16个metadata notices，15个observed中间帧合并，1次消费/1张91,438-byte PNG |
| 高频资源 | CPU user147,607us/system33,823us；Main RSS254,509,056bytes，进程高水位286,528KiB |
| OCR延迟 | 12次available pull，cold339.4ms，后续123.0–175.4ms |
| 生命周期 | stop3.157ms；pause期间在途结果、paused pull、stopped pull均不可用 |
| 稳定静态 | 无边框固定合成窗口稳定后4.092秒0changed，5次pull同sequence/PNGhash，4组逐像素比较均0差异 |

上表是短窗口原型；不能外推全产品RSS、全天能耗或视频语义质量。静态诊断刻意做5次OCR，所消耗CPU不能当生产静止状态耗电。

保留失败：首窗口出现时两图hash不同，带窗口装饰的1秒静态段有1次真实变化，未宣称零变化；随后无边框稳定段才测得零。修复displayTime无符号减法下溢、错误Retina比例得到1。实验标签曾抢在帧呈现前，改用自有内容双rAF+capturedAt gate对齐。失败JSON均保留，不计为通过。

相关离线8文件61测试通过（17:58:45，787ms），覆盖source/actor/暂停/停止竞态、缺失来源、共享文件、原始Buffer不落状态、metadata不落event；Activity域与integration及脚本ESLint/Prettier通过；完整原生arm64编译通过。Detached worktree其它域旧复制差异使完整tsc非绿，Activity文件没有类型错误；root负责最终全库集成验证。

未执行：副屏（当前只有单显示器）、真实DRM/锁屏画面、13.3设备、全天桌面共存、完整Astra/Memory联调、无障碍OS权限首次提示交互。native pending-start completion与availability竞态已实现修复，未假称所有OS竞态都已真人复现。

## 后续来源保护小包

retention 的 distilled_at 只表示确定性 Timeline Episode 已形成，不能代表 PFC/Memory 已消费。已接入批量 SourceRetentionGuard：未设置或读取失败时不删原始来源；Main 组合 Cognition/Memory 公开接口返回的保护集合，Activity 不读取其它域的表。未消费/未结束决策/当前视觉/未完成形成来源受到保护，共享 asset 的任一引用受保护时，年龄与容量路径均不能删除文件。活跃语义证据仅在 Memory 已保存唯一完整 canonical 原文后允许回收 Activity 层，重启恢复使用同一快照；不会把保存文字说成保留了原图。没有新增 TTL。

Main 已接入按需消费、真实 PNG Provider 输入和 dispatch/bind/publication 时的当前对象检查；像素每次变化不构成强制取消。18:04:37 的合并定向98项通过，包含实际 Main/SQLite/Run 12项；typecheck已通过。来源保护补丁随后集成；下一步完成打包和端到端体验验收。旧ScreenCapture构造依赖已删除。最终生产只有本地视觉证据一条路径，实验runner/图片均保留在仓外。


## 工件与删除边界

外部工件集 `companion-commercial-20260915/evidence/activity-visual-native` 保留固定合成窗口原型、原始失败/成功结果及截图；冻结实现清单 `handoff-manifest.json` SHA-256 为 `26db46973e73650ad94a51023f2c76ac9a2dbda2a4aaa2218d9691cf428a4485`。该清单用于复现此次交接。来源保护补丁清单 `activity-retention/frozen` SHA-256 为 `1f70f03bdaf233849ed919fe19fc931c453d80012e5ff42e96fadae079ae4da0`，Activity 相关 66 项回归通过；完整 Main 组合仍以最终全量回归为准。生产仅保留 Activity 原生适配层及其单路径回归测试，没有原型 PID 模式、候选视觉服务或实验控制页面。
