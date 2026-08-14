# TERRITORY-SCENE-GENERATION：World 视觉资产与变更候选单路径决策

- 日期：2026-08-13
- 状态：接受
- 决策 ID：`TERRITORY-SCENE-GENERATION`
- 对应产品：`REFACTOR_PRODUCT_DESIGN.md` §10.4

## 问题与边界

为单物件、已有选区、完整 Zone 与扩建 Zone 选择一条生成、编辑、归一化、预览、修复和原子应用路径。World/Zone、七层空间语法、不可变 Revision、Style Profile、Asset Pack 和所有结果先预览后确认已经由产品确定，不是实验 Arm。

本 Decision 只选择如何给结构化 World change 提供视觉资产。图片输出不能成为坐标、碰撞、锚点、寻路或任意脚本的真源。

## 一手来源快照

- [OpenAI Image generation guide](https://developers.openai.com/api/docs/guides/image-generation)，读取于 2026-08-13：单次 Generation/Edit 推荐 Image API；`gpt-image-2` 支持 `/v1/images/generations` 与 `/v1/images/edits`，任意尺寸须同时满足边长、16 像素倍数、长宽比和总像素约束。该模型不支持透明背景，图片输入自动按高保真处理，应省略 `input_fidelity`。
- [GPT Image 2 model page](https://developers.openai.com/api/docs/models/gpt-image-2)，读取于 2026-08-13：生产别名为 `gpt-image-2`，当前列出的快照为 `gpt-image-2-2026-04-21`，Generation 与 Edit 都是模型能力。
- [OpenAI JavaScript SDK `6.49.0` Images 源码](https://github.com/openai/openai-node/blob/v6.49.0/src/resources/images.ts)，项目锁定 tag commit [`04671d278ef1531692ae31a870251eec90f3c2d2`](https://github.com/openai/openai-node/tree/04671d278ef1531692ae31a870251eec90f3c2d2)：类型与注释确认 `gpt-image-2` 的 opaque 限制、任意合规分辨率、multipart Edit 和 PNG 输出。SDK 的 `input_fidelity` 是跨模型通用字段；模型专属指南要求本路径省略它。
- [Microsoft Foundry OpenAI image guide](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/dall-e)，读取于 2026-08-13：Azure 以 deployment 路由 Generation/Edit，Edit 使用 multipart；deployment、API Version 与配额仍由目标 Azure resource 决定。
- [Electron `nativeImage`](https://www.electronjs.org/docs/latest/api/native-image)，项目锁定 Electron `43.2.0`：Main 可解码、读取 bitmap、重建 alpha 并按目标尺寸输出 PNG。

需要区分：透明背景不支持和请求尺寸约束是当前协议能力；SDK `6.49.0` 的序列化是当前源码行为；`medium`、单 Definition 一张视觉图、Zone plate、洋红连通去背景阈值 `96` 都是 CharaMate 产品选择。

## 候选路径

### `S0`：结构化 compiler + 每个 Definition 一张视觉资产

- Territory 先冻结 base Revision、Zone、Style Profile、锁定实例和来源，再确定结构化 mutation。
- 新物件使用一张 opaque `1024x1024 medium` PNG，prompt 要求纯洋红留白；Main 做边缘中位色四连通去背景，并归一化到 Definition 声明尺寸。
- 已生成/编辑的物件有源 PNG 时走同 deployment 的 Edit；随包 Pixi 图形没有伪造源 PNG，按原语义和 Style Profile 重新 Generation。
- 选区按实际 Definition 数量生成视觉资产，并在一个 Asset Pack/change set 中原子预览和应用；不发明固定套装件数。
- Zone/扩建使用一张 opaque full-bleed base environment plate，保持地面、墙体/景观、光照和通路的视觉连续；独立家具、附件、来源实体、碰撞与寻路仍是结构化实例，不从图片反推。
- Asset Pack 是原子 manifest，不强迫所有素材拼进一张 atlas。单物件或 Zone 可以是一项，协调选区可以是多项。

### `S1`：让整张概念图直接成为 World 状态

把模型图像分割为碰撞、坐标、家具和锚点会把不稳定像素解释变成玩法真源，无法满足锁定、删除恢复、附件图和确定性重启。它在产品正确性边界上被淘汰，不做付费质量排名。

### `S2`：固定 contact sheet/tileset 后按格裁切

这需要预先规定素材格数、角色和切片阈值；模型没有返回与 CharaMate Definition/anchor 一一对应的结构化保证。当前没有证据证明它比每个实际 mutation 一张完整视觉图更一致，却会增加切片失败、空素材和第二套修复逻辑。按“证据相当时选择最简单基线”的规则不晋级；生产中没有 atlas 模式或 fallback。

## 选择与生产合同

选择 `S0`。唯一流程是：

1. 创建持久化 `generating` candidate 并立即返回；远端任务在后台运行，typed push 更新进度，用户可取消。
2. compiler 根据 intent 形成 `item / selection / zone / expansion` 的 Definition、Instance、Zone/Connection 和 Asset Pack mutation；锁定实例不进入变化。
3. Image Adapter 从一个 Generation 基准 Endpoint 推导同 deployment 的 Generation 或 Edit；始终请求 opaque PNG，并省略 `input_fidelity`。
4. Item/selection 做确定性去背景和尺寸归一化；Zone/expansion 保留 full-bleed opaque plate。Main 校验 PNG、尺寸、哈希、asset 引用、连续 Definition/Pack Revision 和空间语义。
5. 候选按新增、移动、替换分组叠加到真实 World projection。继续修改复用稳定 candidate ID；排除分组和新增锁定内容会进入重新生成后的 change set。
6. 确认时图片登记、Asset Pack、Definition/Instance 和 World Revision 在同一事务中应用。Provider、处理、取消、过期或应用失败都不改变当前 Revision；被替代的候选文件回滚，永久删除回收孤立 Pack、Definition 和生成文件。

普通 UI 不显示 prompt 模板、quality、尺寸、色差阈值或输入保真参数，也没有第二套图片 Provider、经典场景或运行时生成模式。

## 确定性证据

- 输入规范 SHA-256：`cecef235edcb35c92950868849a4a27cdbd67967d9dd6a36b74e89f6a15a1261`。规范固定 `gpt-image-2`、Azure `2025-04-01-preview`、item `1024x1024 medium opaque`、Zone `1536x960 medium opaque`、起始 Style Profile 与生产归一化规则。
- 合同测试覆盖 Asset Pack 连续 Revision、资产/Style 引用和不可执行 mutation；生成集成覆盖立即返回/取消、item、selection Definition Revision、锁定 Zone、语义分组排除后重生成、扩建/进入、永久回收和 Provider 失败。
- 回环 Azure Adapter 测试证明一个基准 Endpoint 派生 JSON Generation 与 multipart Edit，保留 API Version/查询参数，并确认 `gpt-image-2` Edit 不发送 `input_fidelity`。
- 去背景 fixture 为 3 张 `9x9` 手工边缘图，共 243 像素；阈值 `96` 在该固定样本上 precision/recall/F1 都为 1.0。完整分母、其他阈值与限制保留在 `territory-image-processing.md`，不外推为真实图片成功率。

## 真实目标 deployment 验收

2026-08-13 在 macOS arm64、Electron `43.2.0`、OpenAI SDK `6.49.0` 和本机已保存的 Azure `gpt-image-2` Profile 上执行显式 live；日常数据库与 secret 文件只读，World、asset 目录和 runner 均为一次性临时数据。

### 原子产品链路

- 指令：把暮色小屋改造成初秋雨后的月光玻璃花房，保持温暖、可居住的 2.5D 像素艺术构图。
- Generation → `768x480` 生产归一化 → persisted candidate → apply 共 `43,328 ms`。
- candidate 为 `ready`；生成 Asset `688,627 bytes`、SHA-256 `4db81bd8b5b8b398c6ceda94672ec6b5e74c164df5c937393c5063c7c64aaa8b`；Asset Pack 引用完整；应用后 World Revision 从 sequence 1 原子推进到 2。

### 独立视觉复核

- 使用生产 prompt compiler 与同一 Style Profile 再生成一张 Zone 样本；Provider/归一化耗时 `47,106 ms`，最终 `768x480` PNG SHA-256 `f2d3df6b8e3d03aba79dd632d1b4dbe03e71013628ec77f38e41a29345871316`。
- 人工检查：月光玻璃花房构图完整，像素边缘清晰，室内外边界和中央通路可辨；没有宠物、人物、文字、UI 或散落家具，能作为 background/structure plate 与独立实体叠加。
- 图片和 runner 在复核后删除；仓库只保留本记录和获胜生产回归。

2026-08-08 的真实 item Generation/Edit/确认链路继续作为物件基线证据，见 `territory-image-processing.md`。两次 Zone 样本只能证明当前 deployment、输入和时点下链路与主观构图可用，不能伪装成总体成功率、风格一致率或长期延迟分布。

## 限制与恢复

- 一张 Zone plate 的内部墙面、窗景和铺地不是独立实例；需要逐件移动的家具、附件和记忆物必须保持独立 Definition。用户可继续编辑或删除 plate，也可在其上自由组合实体。
- 多 Definition 选区共用 Style Profile 与 prompt 编译规则，但当前未做付费的跨图片一致性总体测量；不声称任意大套装都自动完美一致。用户可在 Preview 中定向重生成，失败不会写 World。
- 洋红连通去背景可能在物件贴边、背景色进入主体或强抗锯齿时失败；Preview 是普通产品恢复入口，不引入隐藏模型或阈值模式。
- Edit 只在有真实生成/编辑源 PNG 时使用；随包 Pixi 原生图形走语义重生成，避免把不存在的 PNG 冒充参考图。
- 当前目标 API 的复杂请求可能有明显远端延迟；产品不设置任意 wall-clock kill。用户显式取消通过 AbortSignal 结束任务，候选状态可重试。

## 失败路径删除证明

- 没有 contact-sheet parser、图片推断碰撞、第二套 scene schema、透明请求、`input_fidelity` 控件、quality/size 设置、候选 runtime mode 或 Provider fallback。
- 旧固定场景、12 件容量、旧 Candidate/Image Store、旧 Canvas 和历史 adapter 已从生产代码、Schema、fixture 与 E2E 删除。
- 一次性 live runner、临时数据库、图片、候选素材和失败路径均未进入仓库。
