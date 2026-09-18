# Provider 原生引用的可见显示

2026-09-15。此记录对应隔离候选，Root 负责最终公共合同与主仓集成。

## 决定与实际问题

将 OpenAI Responses 完成注解物化为普通 Markdown 链接，作为可选的 `ModelCompletedEvent.displayText` 传给现有 collector。AgentRuntime 保留即时 delta 展示，终态只更新同一 Message.content 与 Item.displayOutput 一次；不再次追加全文。没有新增表、持久正文副本、Renderer 分支、Provider 模式或依赖。

真实 s01:c09 回答包含 Stripe 与 PostgreSQL 两个 `url_citation`，但可见正文仍是 `citeturn0search0`。保存的 SSE 在官方 SDK 与原 Adapter 重放时，注解确实保存在 outputItems；丢失发生在可见文本选择，而非检索没给出处。原 Renderer 得到 0 个链接，修订后同一正文得到两个可点击且 URL 准确的来源。该回答原 Run 为 needs_input，不据此改写为已解决用户代码问题。

## 来源与协议边界

- [OpenAI Web search guide](https://developers.openai.com/api/docs/guides/tools-web-search)，2026-09-15 实际读取：网页引用提供 URL、标题及位置；展示网页来源时要求行内引用清晰且可点击。
- [Responses TypeScript reference](https://developers.openai.com/api/reference/typescript/resources/responses/methods/create)，同日实际读取；本地官方 SDK 6.49.0 `ResponseOutputText.URLCitation` 定义 start_index、end_index、title、url。其 character 措辞没有明确区分 UTF-16 与 Unicode code point。
- SDK 6.49.0 `src/core/streaming.ts:91–94` 对 AbortError 结束 iterator；collector 仍拒绝缺失 response.completed，Runtime 根据已中止信号完成取消。此次没有改变该生命周期。

当前真实 BMP 样本的两个排他范围 `[168,187)`、`[304,323)` 精确圈定 marker。非 BMP 两种坐标只以合成回归检查：若能精确定位 marker 才替换；普通正文不被删除。位置无效或坐标有歧义时，保留原文并在该 part 后附真实来源链接，不声称精确位置正确。没有注解就不从 marker 编造 URL。只接受实际网页 URL；同一 URL 跨段复用同一编号。

## 原始内容与显示文本的分工

raw delta、`turn.text`、outputItems 与同 Run 后继 Provider checkpoint 保持原样。结构化 Cognition、Memory 等消费者继续读取 raw text。可见 Message 在完成时变成带链接的 Markdown；复制消息和后续普通 Chat 历史/摘要读取实际已显示文本是期望行为。它们不要求再保存一份完全相同语义的 raw/display 正文。

消息完成前可能短暂显示原始 marker。取消发生在完成前时只保留已经流入的内容，不补注解、不猜来源。此包没有改变流式延迟或整段缓存回复。

## 确定性验证

最终受影响测试 118/118：Runtime/SQLite 56、OpenAI Adapter 32、collector/runtime mechanics 16、引用物化 9、Markdown Renderer 5；其中新增 16 个回归案例。TypeScript、受影响 ESLint/Prettier 和对 integration 的 patch dry-run 均通过。Runtime 覆盖 completed 与 needs_input 的同一 Message/Item 终态替换、后继模型 raw item，以及完成前真实 AbortSignal 取消。Renderer 用真实源派生 fixture 在同一挂载节点从流式文本更新为两个链接，验证没有重复正文。

额外使用完整原始 SSE 进行 SDK→Adapter→collector 的 loopback 重放，1/1，通过且零新增 Provider 生成。永久回归 fixture 保留原始正文、36 个 delta 边界、URL 注解和 usage；仅规范化 opaque ID，移除无关 reasoning/search items，未把原始整流或临时重放器放进生产。

初次定向 115/116：新测试错误期待 SDK 在 abort 时抛异常，实际 SDK 正常结束迭代。保留原失败，按当前源码改为断言 collector 缺少终态而拒绝，没有为过测试改变生产取消逻辑。后续新增取消/needs_input 测试曾出现 test-only 的 Promise rejection lint 与 checkpoint JSON 类型错误，已修正；最终静态检查绿色。

此包没有新增真实模型调用，没有重写在途连续实验结果。未跑全仓 offline、构建、打包或 Electron E2E；由 Root 集成后执行适用层。一个真实返回样本加边界回归不等于所有兼容 Provider 坐标行为已实测，也不证明被引网页结论本身正确。

## 交接与清理

10 个改动文件及每个 before/after SHA 在 `SOURCE-HANDOFF.json`；所有 baseline 与 integration 交接时一致。补丁 `native-citation-display.patch` SHA256：`84d89e7b2abe40bd478b560d5bfecd1d6c41742925804689a6d501417bffe0d6`。改动仅在隔离源码副本，未修改主仓或 integration。

完整原始 SSE SHA256：`ce77c0ea1f518584c3039fc4f0ad028a63e49aed44639909820322dee3d7a931`。仓外保留 `actual-input.json`、原始/最终重放结果、DOM 证明、首轮失败与最终结果、源码 manifest。集成确认后删除本包候选目录与临时 runner，保留补丁/记录及非敏感证据；当前尚未把“待集成清理”写成已完成。

## Root 集成复核（2026-09-16）

Root 已完整审阅补丁、SDK 6.49.0 类型与取消实现，逐文件核对 10 个 before/after SHA 并纳入隔离 integration。2026-09-16 00:00 的完整 `npm run verify:offline` 通过 1,570 项：134 contract（0.977s）、1,108 unit/component（5.61s）、328 integration（9.53s）；typecheck、lint、format 通过。此批同时包含普通关联情境投影修订，不把全部新增数量归因于引用显示。集成 manifest SHA 与最终发布源码在主仓晋级时登记。

Main 目前仅收到此文档，源码仍待最终晋级；正在运行的 553 文件连续故事快照保持不变，因此原始回答中的引用标记仍按原失败记录。最终 Main 构建、Electron 显示与打包验收尚未执行。

### 候选清理完成

隔离Owner已清理自有citation候选源码副本、临时重放器、配置和node_modules链接；原始SSE、失败/成功输出、patch与逐文件manifest均保留，Main和integration没有被清理。删除前源码归档SHA256为`b205ec21a3c08e9ec62b58f9e864f1a49b2a7687bf8c166a297e87b4ef0d4c2d`，清理结果SHA256为`8f57a5176afee0752fae5f54003fc5b876054740260a7ff862f724ecb8fe8f6c`。Root已复核10个自有路径均不存在、归档与原patch哈希一致、共享依赖和集成源码保留；最终Main晋级仍单独执行。

Root自有旧恢复、关联投影、反证与引用集成前副本已另行完成清理：36个精确根、1,682个文件在逐成员核验归档后删除；702个实际输入/输出/SQLite/报告/manifest保留项hash不变。归档SHA `39e36dcaeab6258f6d91ef95e917bb6aa3db0413e529dba110f82f28a7ab5910`，执行回执SHA `2bb2a451e5270ffaefab162259a805595411741ac3eb27cb2e4435ae3f652dc4`。Main、最终冻结源、当前纵向验收helper与共享依赖均不在删除范围。

## 已有可点击链接的消重与 Main 晋级（2026-09-16）

本节追加记录后续真实返回暴露的显示问题，不改写以上历史结果。Root 已将本次两个文件晋级 Main 与 integration；此前“Main 待晋级”是当时状态。最终全仓验证由 Root 另行补录，本节不提前宣称通过。仍在使用旧源码的 v2 冷批原始输出与评分完整保留，不回写为修复后的结果。

### 新观察、来源与选择

s02 continuation c24 的 `http-10.response.txt` 在 `response.completed.output_text` 中已含三个 `([foodallergy.org](https://...))` 链接，注解确切覆盖整个链接。旧显示代码又在同处追加数字链接，实际保存的 Message 与 Item 因而各有六个可见链接。三个原始范围是 `[323,392)`、`[424,505)`、`[543,612)`，对应 dining-out、avoiding-cross-contact、dining-out；这份 BMP 原文的 UTF-16 与 Unicode code point 切片一致，不能外推为协议对所有 Unicode 的保证。

2026-09-16 再次核对 [OpenAI Web search 的 Output and citations](https://developers.openai.com/api/docs/guides/tools-web-search#output-and-citations) 与本地官方 SDK **6.49.0** 的 URLCitation、Stream 实现。可点击来源要求与原先相同；新增事实是当前 Provider 的这份原文已经给出了链接。SDK 的 character index 仍未明确 UTF-16/code point，保留既有 range 歧义处理。

选择最小的最终显示修正：只有已确定的 annotation 范围严格等于观察到的 `([非空简单标签](普通http(s)地址))`，且地址与该 annotation.url 逐字相等时，省去**这一处**额外的数字链接。另一处普通正文的同 URL 注解仍补来源；第三处重复引用也作为独立位置保留。原生 marker、无效或不明确的范围继续按既有方式保留实际来源，不全局扫描 URL 去重。raw delta、outputItems 与模型输入不变。

不增加 Markdown parser、生产依赖、配置或运行模式。裸 `[label](url)`、带 title、嵌套/实体标签、复杂 URL，以及代码、转义、HTML、数学、表格、图片、缩进等无法确认的上下文，保守保留补链，可能仍重复。这个边界不保证任意复杂 Markdown 都能正确渲染，只避免已确认的重复，不以疑似链接为理由丢弃来源。

### 同输入验证

同一组 28 项 pure display 回归：原实现 **25 通过、3 失败**，候选 **28/28 通过**。原有 9 项全部保留，新增 19 项覆盖真实重复、另一处同 URL 正文仍补来源、原生 marker、范围和有限复杂语法。旧失败及早期 23/25 项过程结果均保留，未回写分母。

完整原始 SSE 通过官方 SDK 6.49.0 Stream 离线解码得到 **94 个事件、1 个 completed**。原显示逐字等于实际保存的 Message/Item；候选显示逐字等于 Provider 原文。现有 react-markdown 10.1.0 离线渲染的链接 **6→3**，仍逐项对应原三个注解 URL；delta 拼接等于 completed text，raw output 未变。原始 SSE SHA256 为 `9bdbda673d4845737ae6bfcd5ae60bd64f794846a876281a12e741add5d181f9`，重放结果 `REPLAY-RESULT.json` SHA256 为 `b8d35c400a956ce8301dd3bda78cb4a98ed683ad846d68d7d322983d6a0f3520`。

隔离 candidate 的 TypeScript、两文件 ESLint/Prettier、主树只读补丁/空白检查通过。零新增 Provider 生成、零 native/encoder 调用；未在本包重跑 Electron、打包或冷场景。第一次重放准备在读取 SDK 未导出的 package.json 元数据时失败，改为读取实际本地文件后成功；原失败日志保留，不将其算为模型失败。GFM pipe 的额外固定文本核对没有证明候选新增来源丢失，已保守回退，不据此夸大缺陷。

一个真实输出、三个注解、两个 URL 的显示修复，不证明被引网页结论正确，不改变原冷批语义评价，也不构成所有 Provider/Markdown 的兼容性验收。

### 晋级与复现标识

Root 于 2026-09-15 18:03:20 UTC 逐文件复核后，将 `openaiCitationDisplay.ts` 与同名 `.unit.test.ts` 纳入 Main 和 integration。只改变最终显示及其永久回归；原始 v2 SSE、Message/Item 和评分不变。

- 仓外证据标识：`provider-citation-existing-link`；中文完整结果 `RESULT.md` SHA256：`1ec8d484890438781d26b2dea52b76560484be61ea04d70bb94c6fb851f706f1`。
- 两文件交付清单 `SOURCE-HANDOFF.json` SHA256：`80e6296dc56847252dc38efb27f6b65c649f9f9fe872ff4216ac14723c2e237b`。
- 最小补丁 SHA256：`736b40f71a2d216d80cb0285faae8216a6e4aa14e24d7d798359e8f9f90ffc24`。
- Root 晋级回执 `ROOT-PROMOTION.json` SHA256：`d49b714f34c2d954a14f11a7c8e16929fb338995c2855f57fbfc1844ff975aed`。

候选源码、临时 runner/bundle 的清理计划单独列于仓外，当前尚未删除。原始 SSE/result、全部失败/成功记录、patch、协议、显示重放产物和哈希继续保留；不会跟随 node_modules 链接删除共享依赖。最终全仓验证与实际清理结果待 Root 确认后追加。

### 已有链接消重候选清理完成（2026-09-16）

Root 核准六个精确根后，执行前重新核对进程、21 个普通文件与 2 个依赖 symlink，先归档并逐成员验证，再删除候选/基线副本、两个自有脚本和两个 bundle。六根均已不存在，未跟随 node_modules 链接。原计划的 37 项保留证据哈希全部不变，其中包括 `root-pre-promotion/` 四个文件；Main/integration 的四个晋级文件哈希与共享依赖目标也复核通过。原始 v2 SSE、result、全部失败/成功记录、patch、协议及重放显示产物继续保留。

仓外 `provider-citation-existing-link` 归档 SHA256：`fc3aa4c33a34fa33a3451059800907b0b1a16788e71c6543a79cef81a9764193`；执行回执 `CLEANUP-RECEIPT.json` SHA256：`fcb7b0db23e2d9e7ee7f72624bb81f1725559ba13874e19123c0e7a8ada49958`；保留清单 SHA256：`802d2a7661676cb561cde12ce0c531ec494a0d876a7d7f9906a084c4e8326f3d`。此次仅清理已批准范围，没有新增模型/native 调用，不据此追加最终打包结论。

Root 集成复核补记：上述两文件晋级后的 Main v3 已通过 1,634 项完整离线、26/26 Electron E2E（含 build）、arm64 package 和实际 4B/512 编码器及 SQLite 向量 Worker packaged smoke；日志与原 v2 Provider UI 的版本边界见 COMPANION-PACKAGED-ACCEPTANCE。没有新增 Provider 生成来重跑已有引用输出。v3 源码冻结 SHA `bb832d12357aae73845406e2a32508f8310fc9593d3d74496e63bd467be7f6c9`。
