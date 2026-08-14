# TERRITORY-WORLD-PERFORMANCE：活动 Zone 的唯一渲染策略

- 日期：2026-08-13
- 状态：接受
- 决策 ID：`TERRITORY-WORLD-PERFORMANCE`
- 对应产品：`REFACTOR_PRODUCT_DESIGN.md` §10.9

## 问题与产品边界

在不删除、自动收回或降级用户内容的前提下，选择同一个 Territory World 在 PixiJS 8.19.0 中的唯一生产渲染策略。World/Zone、2.5D 固定视角、七层语义、无全局物件数量上限和 PixiJS 单 Renderer 已由产品决定，不是本实验 Arm。

## 一手来源快照

- [PixiJS 8 Culler Plugin](https://pixijs.com/8.x/guides/components/application/culler-plugin)，读取于 2026-08-13：插件默认不启用；容器须显式 `cullable`，自定义 `cullArea` 可避免 bounds 计算。官方只把它定义为大型离屏场景的可选工具，并未保证任意规模下收益。
- [PixiJS 8 cacheAsTexture](https://pixijs.com/8.x/guides/components/scene-objects/container/cache-as-texture)，读取于 2026-08-13：适合复杂且静态的容器，以 GPU 纹理占用换取后续绘制成本；动态、稀疏或过大的内容不适合持续缓存。
- [PixiJS 8 Assets](https://pixijs.com/8.x/guides/components/assets)，读取于 2026-08-13：`Assets.load` 是 Promise 化且带缓存的资源入口，重复 URL 返回同一缓存资源，并提供显式 unload。
- 项目锁定 `pixi.js@8.19.0`、Electron `43.2.0`、Playwright `1.62.0`。以上文档描述能力，不提供 CharaMate 的分块尺寸、实体上限或低配阈值。

## Arms 与单变量

- `P0`：活动 Zone 作为数据流式边界；Pixi 直接 scene tree；生成图片只经 `Assets` 缓存。没有 Culler、`cacheAsTexture` 或容量常量。
- `P1`：在 `P0` 上只增加 `CullerPlugin`、实体 `cullArea` 与容器裁剪。
- `P2`（探索性）：在 `P1` 上再把 terrain/structure 合成为静态纹理。它只用于判断缓存是否值得继续研究，不参与 `P0/P1` 的单变量主比较。

所有 Arm 渲染完全相同的 World、桌宠和视觉层。候选只在本 worktree 中临时存在；测量后删除失败实现、标记、插件注册和缓存容器。

## 环境与输入

- 设备：MacBook Pro `Mac16,7`，Apple M4 Pro 14 核，24 GB；macOS 26.6.1 arm64。
- 产品窗口：真实 Electron 主窗口，WebGL Renderer；每个 scored run 先独立启动并等待 Territory canvas ready。
- 小场景：随包起始 Zone，168 个实例。
- 压力场景：同一语义 fixture 扩为 `64 × 40` Zone，2,560 个 terrain 实例与 8 个其他实例；2.4× 镜头缩放后多数实体离开视口。
- 压力输入规范 SHA-256：`edf3dae57c1a92902a5aa76a99b548ad487d32c64d4b37f7750b4fc079ac6667`。
- 每轮采样 240 个 `requestAnimationFrame`；主指标为 Chrome `Performance.getMetrics` 的 `TaskDuration` 增量，辅以帧间隔 p95、最大帧和 canvas ready 时间。原始结果未含用户数据，运行结束后随临时用户目录删除；一次性 runner 未进入仓库。

## 结果

### 2,568 实体压力场景（2.4×）

| Arm | ready | 240 帧 TaskDuration（ms） | 中位数 | 帧间隔 p95 | 最大帧 |
| --- | ---: | --- | ---: | --- | --- |
| `P0` 直接树 | 648.83 ms | 503.08 / 59.98 / 57.83 | 59.98 | 9.1 / 8.9 / 8.9 ms | 14.4 ms |
| `P1` Culler | 624.48 ms | 900.07 / 668.08 / 393.56 | 668.08 | 9.3 / 9.3 / 9.2 ms | 49.8 ms |

两条路径的首轮都包含独立 Renderer 的 JIT/上传热身，因此同时保留全部分母而不只展示最好一轮。`P1` 的 ready 点估计快 24.35 ms，但连续渲染主线程成本在三轮均明显高于 `P0`；帧 p95 没有对应收益。

### 168 实体起始 Zone

最大缩放静置 240 帧时，`P0` TaskDuration 五轮中位数为 `54.51 ms`，`P1` 为 `99.76 ms`；两者帧 p95 都约 `9 ms`。交替缩放探索中，`P0` 三轮中位数为 `136.78 ms`，探索性 `P2` 为 `192.68 ms`，帧 p95 仍无改善。静态缓存因此没有晋级。

样本是目标设备上的确定性产品压力测试，不是设备总体的随机样本；n 很小，不伪造总体置信区间。结论依据一致方向、效应量、帧质量、复杂度和 GPU 纹理成本共同作出。

## 产品决定

生产只保留 `P0`：

1. Main 一次只向 Renderer 投影活动 Zone；离开再返回时从同一不可变 Revision 重建，不删除视口外或其他 Zone 的内容。
2. Pixi 使用稳定 layer/depth 排序与直接 scene tree；不注册 Culler，不调用 `cacheAsTexture`，不保留运行时开关。
3. 生成图片统一由 `Assets.load` URL cache 加载并在 World 重建时释放局部 texture 引用；随包起始图形继续由同一 Pixi Renderer 绘制。
4. Repository 保留有语义的可选 viewport projection API，供真正需要窄读取的调用方使用；当前目标规模不先发明 chunk 大小、预载半径或动画数量阈值。
5. 没有用户可见质量档位、全局物件数量常量或“超限自动收回”。空间合法性仍只由 Zone、碰撞和锚点决定。

长期产品回归保留真实 Electron 的缩放、Shift/中键平移、渲染策略标识、离开/返回与重启完整性；它们验证获胜生产行为，不再携带 Arm 选择。

## 失败 Arm 删除与限制

- 已删除 `CullerPlugin` 注册、`cullable/cullArea` 状态、静态缓存容器和失败 Arm 标记；没有依赖、设置或 fallback 残留。
- 本次不能声称直接树在任意百万实体或无限 Zone 上最好；产品也不承诺无限开放世界。若未来真实可达规模明显超过本输入，应以新 Decision 修订证据，不能偷偷加入数量上限。
- 本次没有比较 WebGPU、第二 Renderer、游戏引擎或画质档位，因为它们会扩大已冻结产品边界。

## 复现信息

构建命令为 `npm run build`；测量使用锁定 Playwright 启动 `.vite` Electron 发布构建，临时数据库只替换当前 Revision 的 Zone bounds 和 terrain 实例，三条 Arm 之外的输入完全一致。最终仓库不保留 runner、压力数据库、截图或候选代码。
