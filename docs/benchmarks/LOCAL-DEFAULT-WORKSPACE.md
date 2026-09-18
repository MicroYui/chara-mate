# 首次安装采用稳定的 Agent 工作目录

2026-09-16。正确性修复已进入 Main，受影响回归和最终实际包验收待执行；不是已经完成的分发验证。

## 问题与依据

修复前的 Main v21 在 `src/main/index.ts` 将 `CHARAMATE_WORKSPACE_DIR ?? process.cwd()` 传给 SettingsRepository。没有已保存设置时，Repo 直接返回这个默认值且不落盘；相对文件路径、命令 cwd 和项目 Skills 因而随启动方式改变。已准备的安装执行器明确以 `Contents/MacOS` 为 cwd，按源码可确定该条件会把缺省 Agent 文件写到包目录。Finder 实际 cwd 尚未测量，不能声称它必定为 `/`；缺少项目 Skill 根被视为空，也不能将问题说成必然启动失败。

2026-09-16 检查 [Electron v43.2.0 app 文档](https://github.com/electron/electron/blob/v43.2.0/docs/api/app.md)及当前 App/Settings/LocalTools/SkillService 一手源码。Electron 将 appPath 与 userData 区分，并建议应用自有文件置于 userData 子目录；提醒潜在云备份和大文件成本，不规定本产品大小阈值。所读官方原文 SHA `fcb4b1441573ecc154192937c2ccad22d100ced2b5f3b6f2545b3606bbc159e7`。本机实现以已有 userData 下的 artifacts、Skills 和 Data 统计为数据所有者。

## 选定行为与范围

首次默认使用 `userData/workspace`；Main 在读取实际 Agent 设置之后、构造 SkillService 之前，仅创建实际采用的应用自有目录。已有保存值优先于初始化默认值；显式开发工作目录仍可作为未保存时的默认值。用户指定的其它路径不自动创建、不替换、不回退。应用自有路径若是普通文件或无法创建，由既有启动失败路径收口。

SettingsService 将 workspace 归入既有“文件与运行产物”类别，不添加 schema、设置、模块或后台回收器。workspace 是可编辑工作文件，artifacts 继续存放 Run 产物引用，两者不合并文件生命周期，Activity 清理不触碰工作文件。

未选 Documents/CharaMate 作为生产默认：它更容易直接在文稿目录中找到，但脱离现有应用 Data 与冷备份根，需要另一套统计和备份归属；现有 Agent 设置已允许用户自行选择自己的目录。当前取舍不依赖虚构的实验优胜或新的数值门槛。

## 实施与验证计划

Root 为 Main/Settings 集成 owner；修改限定原初始化、Data 分类及相关回归。先核对默认路径不随启动 cwd 改变、保存/显式路径保持、workspace 字节进入现有类别；不扩展目录权限测试框架。实际新临时数据由最终同版包从安装目录启动，沿真实 Settings 和文件 Tool 创建、读取小文件，再以新 PID 读取，记录实际 cwd、结果路径及正常退出。原用户数据的升级/配置与全新默认值场景分别验收。

已合入 `index.ts`、`settingsService.ts` 及两份既有集成/Electron测试的定向修改：默认自有目录的创建、实际路径与文件统计有待执行的断言；保留已保存目录与显式默认行为。此后未运行新回归、新包、模型或真实用户库，前一版2118项离线结果不覆盖这四文件修改。正式吞吐的首家族两条件自然结束后安排受影响回归，最终包双PID读写另行执行。仓外准备执行器不进入生产路径。
