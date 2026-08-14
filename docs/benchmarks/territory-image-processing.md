# TERRITORY-IMAGE-PROCESSING：领地图片生成与去背景单路径决策

- 日期：2026-08-08
- 状态：现有孤立物件原型接受；**目标沙盒生成范围已由 2026-08-13 产品修订取代**
- 范围：旧 `P6-TERRITORY-IMAGE` 单物件路径

## 2026-08-13 范围修订

新的 Territory 产品目标同时需要单物件、协调 Asset Pack、地形/结构、选区、Zone 重绘和扩建。本文只比较孤立物件的洋红去背景与默认缩放，不能证明它适用于 tileset 边缘、墙体、场景背景、动画变体、Style Profile 或完整区域一致性。

本文继续作为当前原型和 `TERRITORY-SCENE-GENERATION` 的基线证据保留；它不再单独定义目标产品管线。新 Decision 必须用目标 `gpt-image-2` deployment 和真实 World Preview 比较唯一素材生成/编辑、归一化、修复与一致性方案，随后用胜者替换旧单物件假设；不能把本文路径与新 Asset Pack 路径作为两个运行时模式并存。

## 问题与结论

目标 deployment 是 `gpt-image-2`，它的 Generation 与 Edit 都不能直接请求透明背景。生产实现因此固定为一条路径：同一 Azure deployment 生成或编辑一张 `1024x1024`、`medium`、opaque PNG；统一 prompt 要求纯洋红背景和完整留白；Main 进程按边缘中位色做四连通背景移除；用户确认后默认缩放为 `96x96` PNG，并调用既有 Territory asset + manifest 入口。2026-08-13 的模型专属指南明确要求 `gpt-image-2` 省略 `input_fidelity`，当前生产请求已按新来源修订。

本地连通背景的色差阈值固定为 `96`。不安装 `sharp`、抠图模型或第二个 Image Provider，不提供阈值、质量、尺寸或去背景模式开关。

## 一手来源快照

- [OpenAI Image generation guide](https://platform.openai.com/docs/guides/image-generation)，读取于 2026-08-08：Images API 分为 Generation 与 Edit，Edit 接收已有图片。
- [OpenAI JavaScript SDK `6.49.0` Images 源码](https://github.com/openai/openai-node/blob/v6.49.0/src/resources/images.ts)，仓库锁定版本 `6.49.0`、tag commit [`04671d278ef1531692ae31a870251eec90f3c2d2`](https://github.com/openai/openai-node/tree/04671d278ef1531692ae31a870251eec90f3c2d2)。生成类型明确说明 `gpt-image-2` / `gpt-image-2-2026-04-21` 不支持 `background: transparent`，该请求会报错；Generation/Edit 都支持 PNG、`medium` 与 `1024x1024`。SDK 暴露跨模型通用 `input_fidelity` 类型，但 2026-08-13 的 [GPT Image 专属指南](https://developers.openai.com/api/docs/guides/image-generation) 要求该模型省略它，因为所有输入已自动高保真处理。
- [Microsoft Learn Azure OpenAI REST `2025-04-01-preview`](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/reference-preview)，页面元数据 `ms.date=2026-05-19`、读取于 2026-08-08：同一 deployment 下分别提供 `/images/generations` JSON 请求与 `/images/edits` multipart 请求。
- [Electron `nativeImage`](https://www.electronjs.org/docs/latest/api/native-image)，项目锁定 Electron `43.2.0`：`toBitmap()` 返回平台相关的原始位图，`createFromBitmap()` 接受该格式。生产算法不解释前三个颜色通道的顺序，只计算同一位图内的颜色距离并修改第四个 alpha 字节。

需要区分：

1. 当前 API/SDK 能力约束：目标 `gpt-image-2` 不能直接输出透明背景；Edit 必须使用 multipart。
2. 当前源码与本地协议观察：锁定 SDK 在回环 HTTP 端点上把 Generation 发送到配置 deployment 的 `/images/generations`，把 Edit 发送到同级 `/images/edits`，并保留 `api-version` 与其他查询参数。
3. CharaMate 启发式：`medium`、`1024x1024`、色差 `96` 与默认最终 `96x96` tile asset 都是产品选择，不是协议硬限制。

## 最小离线比较

### 输入与方法

- 环境：macOS arm64；Node `24.18.x`；Electron 锁定版本 `43.2.0`。
- 数据：3 张 `9x9` 手工标注的普通像素物件边缘图，共 243 像素；分别覆盖标准洋红、暖色偏移、冷色偏移、轻微背景色差、贴边抗锯齿色与被物件包围的同背景色细节。
- 输入 JSON SHA-256：`85400420542ce1c8d3beebc880ef913416e70ea07a226316bfcf1c94f12ab858`。
- 单一变化量：边缘中位色的三通道曼哈顿距离阈值，比较 `48 / 96 / 144`。
- 主要指标：背景移除 precision、recall 与 F1；物件像素误删为失败。
- 一次性 runner 在结果生成后删除，没有进入生产树；获胜算法的普通行为被改写为 focused regression test，不携带 Arm 名称或开关。

### 结果

| 阈值 | TP | FP | FN | TN | Precision | Recall | F1 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 48 | 168 | 0 | 48 | 27 | 1.0000 | 0.7778 | 0.8750 |
| 96 | 216 | 0 | 0 | 27 | 1.0000 | 1.0000 | 1.0000 |
| 144 | 216 | 2 | 0 | 25 | 0.9908 | 1.0000 | 0.9954 |

`48` 留下明显背景边缘；`144` 开始吃掉与背景接近的物件轮廓；`96` 在该小样本上完整移除背景且没有误删，因此晋级。

表中分母是固定 fixture 的全部 243 个像素，结果是这组输入上的确定性精确计数。像素彼此相关且输入不是随机抽样，因此不把它们伪装成独立样本计算总体置信区间，也不把结果外推为真实生成图片的成功率。

## 尺寸与质量取舍

没有用真实 Provider 做 `low / medium / high` 的付费质量排名，不能声称 `medium` 在所有物件上质量最好。选择 `1024x1024 + medium` 的理由是：它是当前双方协议直接支持的标准正方形请求，能提供足够的轮廓像素给去背景，而默认最终运行时只保留 `96x96`，继续提高源图质量与尺寸会增加成本和延迟，却没有本项目证据证明缩小后的收益。Edit 不发送 `input_fidelity`，由目标模型按当前官方行为自动高保真处理。真实 Azure Generation/Edit 仍需独立于离线回归报告，mock 不能伪造其视觉质量。

### 产品接口补充（2026-08-08，非实验改判）

用户明确要求桌宠的固有 Tool 能暴露最终图片高度/宽度、2.5D 占地、锚点和插槽位置/数量，同时让 Agent 只填写少量必须语义字段。因此 `96x96` 保留为省略参数时的默认最终 asset 尺寸，单个候选可在结构化输入中显式声明其他 `visualSizePx`；远端请求仍固定为 `1024x1024`，去背景算法、阈值、候选存储和安装入口均不变。该补充没有比较新的算法 Arm，也不声称其他最终尺寸质量更优；它是产品 authoring 契约的显式扩展，不保留尺寸模式、自动尺寸策略或 Settings 开关。

同理，默认 manifest 仍是 `2x2` 地面物件、底边中心深度锚点和底行占用/碰撞。显式 `structure` 只是让调用者提供已知的物件语义；插槽数组的长度就是数量，数组元素提供位置和最大附件尺寸，不另设可能不一致的计数字段。领域层在 Provider 调用前编译并校验该结构，确认时仍只进入同一 asset + manifest 路径。

## 真实桌面人工验收

2026-08-08 在 macOS arm64 的隔离 CharaMate 用户目录中，通过真实 Electron 界面和已保存的 Azure `gpt-image-2` Profile 完成一次手工产品旅程：

1. 在“星空工坊”填写“验收台灯”、用途描述和“小巧木质工坊台灯，暖黄色灯光，正面略俯视的 2.5D 像素风，完整物体，透明背景”，点击“生成预览”。候选从 `generating` 进入 `ready`，数据库时间差为 `42.286s`。
2. 预览以透明棋盘背景显示完整 2.5D 灯具；落盘候选为 `1024x1024`、带 alpha PNG。
3. 填写“把灯罩改成深蓝色，保留暖黄色灯光与其余结构”，点击“生成修改版”。Edit 返回新的 `ready` 候选，主体结构保持一致，预览仍带透明背景；本次没有把单个主观样本外推为指令遵循率或风格稳定性指标。
4. 点击“确认加入收藏库”后，Edit 候选进入 `accepted`，“验收台灯”出现在收藏库；最终 asset 为 `96x96`、带 alpha PNG，场景在确认前没有被修改。

非敏感原始图片保留在仓库外；复核标识为：Generation preview SHA-256 `46941f4e29566b950d6f0c0caf86707b1f4d57f44bf9513e7625d2a9ea289cf9`，Edit preview `43ac07715abe123c3c4a517960a007511c2c896e4f8ff401898df723942f6cc1`，最终 asset `3c54c4ca5131c6d2a2cab7e1b0a9db83a7b48832e36b9debf23398949b4aa1c3`。该旅程证明本次配置下真实 Generation/Edit、去背景、确认和安装连通，不证明其他提示词、画风或负载下的成功率；真实失败恢复由独立确定性 Electron E2E 注入 Azure `429` 后验证。

## 失败、限制与恢复

- 连通移除只清理与图片边界相连且接近边缘中位色的区域；若模型无视 prompt、让物件贴边，或把背景色大量画进轮廓，结果可能不完整。候选预览与继续编辑是这类普通失败的产品恢复入口。
- 去背景、缓存或 Provider 失败只把候选记为 `failed`；原场景和已安装资产不变。应用在 `generating` 时退出，重启后改记为可重试失败。
- 确认安装失败时候选保持 `ready`。安装沿既有幂等入口重试，不复制资产表、manifest 路径或 Renderer URL。
- 小型合成样本只证明阈值在所列边缘条件下的行为，不能替代真实生成图片的人工观感验收。

## 删除与单路径证明

- 生产代码只有阈值 `96`，没有 Arm、feature flag、Settings 控件或 fallback chain。
- 未加入 `sharp`、分割模型、独立 worker、第二张候选资产表或第二套 Provider Key/Endpoint。
- Azure SDK 默认请求重试被设为 `0`；一次远端失败立即进入持久化候选状态，由同一个明确“重试”动作恢复，不保留隐藏重试策略。
- 候选确认后只调用 `TerritoryService.installGeneratedItem`；默认或显式最终尺寸都由同一 normalizer 处理，Pixi 与收藏库仍只读取 `chara-mate-territory://asset/.../sprite.png`。
