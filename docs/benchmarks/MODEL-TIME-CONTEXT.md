# 模型当前时间与来源时间：统一历法锚点

2026-09-15。Owner：root。状态：隔离候选 integration-verified；真实语义复验、Main 晋级和桌面验收尚未完成。

## 问题与依据

Q4 固定16例的真实 gpt-6-astra 运行中，f03 把 `2026-09-14T23:40Z → 2026-09-15T00:00Z` 描述为跨午夜，f06 把前一 UTC 日期的话语当作另一当地日。该轮系统为 Asia/Shanghai，两时刻显示为9月15日07:40与08:00。最终 Agent 回复未因此给出错误具体日期，但 PFC 情境解释已存在无依据的历法推断，不能用回答恰好正确消除这个缺口。

源码检查发现 Text Agent 与 Voice 已传当前 Clock 和系统时区；PFC、Memory formation、selector 没有同等输入。修复的是实际缺失信息，不是给特定例子写正确答案，也不改动原16例的冻结输入、运行条件和原始结果。

主要来源与版本：

- [ECMA-402 DateTimeFormat](https://tc39.es/ecma402/#sec-intl.datetimeformat.prototype.formattoparts) 与 [resolvedOptions](https://tc39.es/ecma402/#sec-intl.datetimeformat.prototype.resolvedoptions)，访问2026-09-15，页面标识为 ECMAScript 2027 Internationalization API 在线草案，不能称已发布运行时版本。Intl 根据指定时刻与时区产生当地历法，不提供用户历史所在地。
- [Node.js Intl](https://nodejs.org/api/intl.html)，访问2026-09-15；本机实际 Node 24.18.0。生产 Electron 使用项目锁定运行时；本次不能以 Node 单测代替打包后实际验证。
- 当前 CharaMate `modelTimeContext`、PFC driver、Memory models/factory、AgentRuntime、Voice instructions 的实际代码，2026-09-15。原16例源码、输入和请求由仓外 Q4 freeze 保存。

这里没有新增协议硬限制、时间衰减、TTL、topK 或可调算法。输入仍受用户258,000 Token上限及较小Provider限额约束；现有精确计数404边界不因这个修复而消失。

## 唯一实现

`agent/modelTimeContext.ts` 为实际模型驱动提供一个当前历法输入：`now`、`timeZone`、`localDateTime`。Main 的 PFC/formation/selector callback 每次读取注入 Clock；不缓存应用启动时间。Text Agent 每个步骤使用同一函数，Voice 在其既有 instructions 重建时使用同一函数，不新增定时会话更新。Gregorian、拉丁数字与24小时显示通过 Intl 产生，不手工加八小时或模拟夏令时。

当前时间有效但系统时区缺失、无效或读取失败时，后两项为 null；真实 UTC 时区仍是合法值。模型明确区分未知当地日历与用户在UTC。时间上下文属于模型环境，不能成为新用户陈述、事件观察或 Memory 引文。

PFC Persona 裁剪、视觉材料组装与二阶段请求保留同一份步骤时间上下文，并计入完整请求预算。Memory formation 和 selector 实际请求也包含它。形成说明发生变化后处理器版本为 `source-evidence-formation-v11`，复用既有准确窗口/处理器恢复规则；没有新表、历史数据迁移、用户设置或第二套模型协议。

历史来源的发生时刻不被改写。旧话语中的“今天”不能锚定到数月后的处理日期，当前系统时区也不能补造历史作者的时区。已有事件/原文明示时区可用；未知的当地日期保留原文和不确定范围。当前修复不补齐此前未记录的来源时区元数据。

## 验证与未覆盖部分

定向5文件30项通过（22:06，0.341s）；含上海与UTC跨日区别、纽约实际夏令时跳转、未知/平台读取失败、PFC两次实际请求读取新 Clock、Persona 裁剪仍保留锚点、Memory 延迟形成原文/时间不变、selector 未知日历、Main formation factory 的时间传播和 Voice instructions。

随后完整离线 **1,512项**通过（22:08）：134 contract / 1,060 unit+component / 318 integration，1.19s / 7.11s / 10.46s；typecheck、lint和format通过，保留两条既有TanStack提示。包含先前Q3/Q4和canonical原文回收。首次编写测试曾误用 RecallPlan.entities 并存在 JSON.parse 的 unsafe 类型访问，静态检查拒绝；修正测试类型/字段后完整重跑，不改产品合同来绕过检查。

以上是历法计算与真实请求接线验证，不证明模型从此正确处理所有时间表达。真实复验将保留原 f03/f05/f06/f11/n01 作为后验回归，另有新来源场景；结果独立记录。尚未执行当前版本的完整连续故事、独立holdout和最终Electron验收。

## 同批真实问题的窄修正

f05 的实际回答符合当时原话，也允许用户改变选择；但决策指令要求“按这一偏好建议不放”，却遗漏对应当前偏好的 claim 依赖。旧原话用作 history 不等于当前适用性已绑定。PFC 指令增加一般规则：依赖旧偏好继续适用的当前建议需声明其当前 claim；单纯回答历史原话不要求其现在仍真。宿主资格规则没有放松。原结果记依赖声明不足，没有实际竞态误答的证据。

f11 保持安静时附加了不必要的当前前台依赖，记录为过度声明；原运行没有后续变化分支，不能称发生实际误拒。n01 正确表达未完成，却向用户复述内部校验口径；共用Agent指令要求以日常语言表达实际进展和未知。自然度与依赖完整性须由后续真实输出判断，不用提示文本存在代替验收。

本包没有候选模式、运行开关、备用算法或额外依赖需要保留。所有正式评测脚本与原始数据在仓库外。
