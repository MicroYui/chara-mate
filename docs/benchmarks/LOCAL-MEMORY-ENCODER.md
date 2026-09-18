# 本地语义编码器：部署、维度与选证诊断

- 日期：2026-09-15，2026-09-16 更新；状态：**4B/512 已选为唯一生产路径并进入 Main，实际随包加载与 Worker 冒烟通过；整体陪伴质量和真实大库质量仍需独立证据**。
- 当前唯一生产编码器：官方 **Qwen3-Embedding-4B Q4_K_M，512 维 MRL 前缀再 L2 归一化**；llama.cpp b10964 / Apple Metal。本文件不声称它已通过商业产品验收。
- 问题：真实语义编码能否本地随包运行；4B/8B、维度和候选预算如何共同影响相关证据；是否已有必要训练领域模型。
- 集成 owner：root；部署与本项实验：explain_memory；Memory 检索和 worker：memory_research。实验代码、模型候选及原始结果保存在仓库外，生产没有模型选择档位、训练服务或备用编码器。

## 1. 当前决定及其依据

选择 4B/512 为本地生产编码器。它在本轮实际候选预算下没有少召回已标注证据，与 8B/1024 接同一 Astra selector 的结果相当，权重及原生常驻资源明显较少；512 维又降低了 SQLite 净荷与扫描成本。8B 不因公开榜单或开发集 top5 稍优自动胜出。0.6B 没有参加本轮最终 selector 配对，不能据此证明 4B 是所有模型中的最小充分选择。

**现在不启动 embedding 微调。** 当前唯一共同漏选发生在缺少情境、存在多个合法答案的开发题；所需纠正证据已经进入候选。补齐摄影情境后，两组都选对。训练检索器不能补回调用者没有表达的具体问题，也不能替代 Memory 的形成、版本和人物归属。后续发现可靠的大库召回缺口时仍可重开训练实验，不把当前决定解释为永久不训练。

这次没有读取 holdout 标签。自写的 24 个连续故事中只使用 development 部分抽出的文本，再加入人物、时间、纠正、计划与结果、同应用多任务、角色经历、稀有约定和否定等对照；56 次选证不是完整的连续陪伴验收。

## 2. 版本与来源

| 对象                     | 固定版本或来源                                                                                                                                             | 用途                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Qwen3 Embedding 技术报告 | [arXiv:2506.05176v3](https://arxiv.org/abs/2506.05176v3)，2025-06-11                                                                                       | 多阶段训练、指令、MRL；公开质量不能代替产品评测         |
| Qwen 官方代码            | [44548aa5f0a0aed1c76d64e19afe47727a325b8f](https://github.com/QwenLM/Qwen3-Embedding/tree/44548aa5f0a0aed1c76d64e19afe47727a325b8f)，2025-09-30            | 末 Token pooling、归一化、官方 SWIFT 训练入口           |
| llama.cpp                | [b29c606e28a01b1bc8c1351026a0fa6e616bf6c4](https://github.com/ggml-org/llama.cpp/tree/b29c606e28a01b1bc8c1351026a0fa6e616bf6c4)，b10964，2026-09-14 发布包 | UNIX socket、tokenize、embedding、上下文及取消/退出协议 |
| 原生发布包               | `llama-b10964-bin-macos-arm64.tar.gz`，11,149,739 B；SHA-256 `033c845c1df9bf945ff37bb193238b40910b2244be3e1e637b2ceb5878f1a6f5`                            | 官方 GitHub release，MIT                                |
| SWIFT 训练源码           | [44007491be59ec236ab7ed9ddf1d8b51dad183fa](https://github.com/modelscope/ms-swift/tree/44007491be59ec236ab7ed9ddf1d8b51dad183fa)，2026-09-15               | 当前 InfoNCE 实现、训练可行性；未安装或训练             |

设备为 Apple M4 Pro、24 GiB 统一内存、arm64；本轮生产 adapter / 扫描 runner 使用 Node 24.18.0。真实文本 selector 全部为用户指定的 `gpt-6-astra`。每个完整请求执行前检查输入估计，实际 usage 另行保存；258,000 是用户的单次输入硬上限，不是累计费用或 Run 时长限制。

| 官方模型  | GGUF snapshot                              | 权重 B / SHA-256                                                                   | 原维度 |
| --------- | ------------------------------------------ | ---------------------------------------------------------------------------------- | -----: |
| 0.6B Q8_0 | `370f27d7550e0def9b39c1f16d3fbaa13aa67728` | 639,150,592 / `06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439`   |   1024 |
| 4B Q4_K_M | `f4602530db1d980e16da9d7d3a70294cf5c190be` | 2,496,703,776 / `2b0cf8f17b4c723c27303015383c27ec4bf2d8314bb677d05e920dd70bb0f16b` |   2560 |
| 8B Q4_K_M | `69d0e58a13e463cd99a9b83e3f5fee7c10265fab` | 4,676,804,928 / `3fcd3febec8b3fd64435204db75bf0dd73b91e8d0661e0331acfe7e7c3120b85` |   4096 |

三者来自 [Qwen 官方模型组织](https://huggingface.co/Qwen)，固定模型卡声明 Apache-2.0。准备脚本核对模型/发布包 hash，随包复制归属说明、模型卡与许可证。模型 API、GGUF hash 和模型语义版本分开记录。

## 3. 实验顺序与失败

1. 先用本机已缓存官方 0.6B BF16 建立真实中文编码参照：PyTorch 2.11.0、Transformers 4.57.6、MPS；不是产品 Python 依赖。48 条输入全 finite；Q8 对 BF16 的 cosine 最小 0.999386，12 个原始 query 的 top1 排名相同。
2. Transformers.js 4.2.0 / onnxruntime-node 1.24.3 / 官方 ONNX snapshot `c25a394dd583836952667c12f008335071b3f43d` 未能安装：官方 npm registry 的 DNS/连接/SSL 失败。没有使用企业镜像，也没有把未运行的 ONNX 路线判为质量差。
3. 顺序运行 0.6B、4B、8B 原生模型，保存短文、变长 batch、资源和退出结果。运行时没有同时装载两个模型。
4. 长输入首次探索复用了前缀，因此保留其结果但不把耗时当独立冷输入；修订 v2 使用不同段落起点、先跑 Token ID、后跑字符串一致性。首版一个段落只到 1998 Token，在编码前预检失败，修订后才覆盖目标长度。
5. 使用缓存的真实向量做 MRL 单变量诊断，再以当前 Memory 流水线实际候选作 4B/512 与 8B/1024 的 selector 配对。后两者是筛选后的配置比较，不能将效应分别归因于模型规模和维度。
6. 新生产 adapter 实际编码与退出验证完成；随后保持真实 4B/512 encoder 驻留，用其三个真实 query 和合成 SQL 大库测 Main/生产 worker。合成负载不用于语义质量结论。

## 4. 开发集检索与最终选证

冻结扩展输入为 60 篇文档、28 个 query、20 个故事/关系组；SHA-256 `d8aea59c9834979419da13f545dad84100cd41221e2f79c72b3a9992d6578dfc`。原始 36 篇/12 query 中，0.6B、4B、8B 的 top1 为 9/12、10/12、10/12，top5 均 12/12。扩展集原维度结果为 19/28、22/28、22/28；top5 为 27/28、27/28、28/28。

官方 [4B 模型卡](https://huggingface.co/Qwen/Qwen3-Embedding-4B) 和 [8B 模型卡](https://huggingface.co/Qwen/Qwen3-Embedding-8B) 支持 MRL 可变维度。本轮截取前 D 维后对 query/document 分别重新 L2 归一化，没有 hash 向量或随机投影。MRL 减少索引尺寸和点积工作，不减少 4B/8B 主干前向计算或模型权重。

| 配置      | top1 / 28 | top5 / 28 | 所有必需证据在 top20 / 28 |  MRR | 100k Float32 净荷 |
| --------- | --------: | --------: | ------------------------: | ---: | ----------------: |
| 4B / 512  |        20 |        28 |                        28 | .838 |          204.8 MB |
| 4B / 1024 |        21 |        27 |                        28 | .852 |          409.6 MB |
| 4B / 2560 |        22 |        27 |                        28 | .870 |          1,024 MB |
| 8B / 512  |        22 |        27 |                        28 | .866 |          204.8 MB |
| 8B / 1024 |        23 |        28 |                        28 | .905 |          409.6 MB |
| 8B / 4096 |        22 |        28 |                        28 | .876 |        1,638.4 MB |

原维度 top1 差异很不确定：按 20 个组 bootstrap 2000 次、seed 20260915，4B−0.6B 为 +10.7pp，95% 区间约 [-3.7,+26.7]pp；8B−4B 为 0pp，区间约 [-13.8,+14.8]pp。这些开发集区间不能证明等效或 8B 优胜。

**实际候选流水线不是固定 top5。** 本次模型比较当时固定同一 SQLite 真源、过滤、词法/向量/RRF、证据来源投影和预算进入 `MemoryRecallPipeline`。最终 evidence 预算 8k 对应本次 32k candidate allocation；按最小合法序列化 EvidenceItem 推出的容量上界是 125。实际 60 条并未全部送入 selector：每题最终为 **45–46 条**。六个配置的必需证据都保留，因而本轮确实覆盖了预算裁剪，但没有暴露真实大库排名不足。

本次模型实验的融合方式不定义最终生产默认；后续[融合决策](MEMORY-RANK-FUSION.md)已选择交替融合并单独验证，模型选择结论与其证据分开保留。

摄影纠正证据在 4B 原维度排第 10，在 8B 原维度排第 3；两者都进入最终候选。用 top5 将这一差异直接当最终体验差异是不成立的。

同一 `ModelMemoryEvidenceSelector`、同一 `gpt-6-astra`、同一 schema/instructions，固定候选后执行 28 题 × 2 配置，共 56 次；按题交替执行次序，实验并发为 2。生产 prompt 未为个别样本修改。

| 指标                           |        4B / 512 |       8B / 1024 |
| ------------------------------ | --------------: | --------------: |
| 候选必需证据完整覆盖           |           28/28 |           28/28 |
| 原始标注的最终必需证据完整覆盖 |           27/28 |           27/28 |
| 协议/模型调用失败              |            0/28 |            0/28 |
| 平均额外选择文档               |            .179 |            .179 |
| selector p50 / p95（n=28）     | 4.575 / 7.216 s | 4.435 / 7.250 s |
| input / output Token           | 302,459 / 5,003 | 302,622 / 4,888 |

“额外文档”不自动等于无关回忆：合同/道歉信的澄清、普通日习惯与纪念日约定的对比、暂停攀岩改游泳都可能提供有效证据。4B 在“排查支付重复执行”题多选了一条同浏览器的休闲活动，提示仍需在完整场景检验选证精简；不能只看必需证据 recall。

原始唯一共同失败题只问“本人喜欢的放松活动”，未提摄影情境。两组都选择了同库的明确自述“喜欢船、在海上最放松”，这同样能回答表面问题。保留原始 **27/28**，不事后改 gold。另做透明的两次事后诊断：固定原候选，仅给问题补上“替表妹挑摄影课曾被误认成用户爱好”的情境，两组都选中纠正记录。这隔离了条件选证，不是新检索成绩，也不提高原始主分数。

56 次总输入/输出为 **605,081 / 9,891 Token**；纠歧两次另为 **21,688 / 306 Token**，总计 58 次 **626,769 / 10,197 Token**。主试验最大实际输入 10,847 Token，最大完整输入估计 35,133，远低于 258k；实际 usage 与保守估计分别记录，没有把估计声称为精确 tokenizer 计数。代理未提供可核实单价，未推算金额。

## 5. 真实原生资源与长输入

短文 batch2 的 warm p50/p95（去除首批，n=43）：0.6B 为 27.5/32.0ms，4B 为 142.1/180.1ms，8B 为 211.7/284.4ms。短文采样最大 server RSS 分别约 1.20/3.13/5.32 GB。warm 进程 ready 为 406/506/610ms，但**新拷贝资源首次启动出现 18–20 秒**；原因尚未隔离，不归因为某个系统机制，也不能只用 warm 数字描述首次体验。

Qwen 实测是 **causal attention + LAST pooling**。固定 llama 源码 `server-context.cpp` 的 `can_split` 允许这类序列跨 microbatch；不应套用其他 non-causal encoder 必须整条塞入 ubatch 的规则。模型公开支持的 32k 窗口与本次进程的 `ctx=2048` 分配不是同一概念。

- 实际 tokenizer 计量的 128/512/1024 Token 不同中文段落，在 ctx2048、batch/ubatch512 成功；长度 **等于 ctx 的 2048** 返回 HTTP400。增加 batch 为 2048 不能修复这个 context 条件。
- ctx2560 时，2048 Token 在 batch512 与 batch2048 都成功。共 28 个成功配置 finite，4 个预计 context 错误，usage 与 Token ID 数一致。
- ctx2560/batch512 的独立 2048 Token 输入：4B 3.237s、峰值约3.34GB；8B 5.643s、约5.53GB。batch2048 约3.292/5.638s，却升至4.34/6.50GB。这组数据未显示大 batch 的可用收益，当前保留512分配。
- 普通文本的字符串/Token ID 向量 cosine 为 .999978–.999990；不是逐位相等。字面 `<|im_start|>` 的 parse_special=false 为28 Token，字符串默认路径为25，cosine 仅 .723/.827，因此生产必须先 tokenize 字面文本，再发 Token ID。
- 早期8B大 batch长输入期间系统 swap 从0升到308.94MB；其他桌面进程也存在，不能完全归因于模型。后续长输入没有继续增长。这不证明8B长时间与真实桌面共存健康。

新生产 adapter 从准备脚本实际生成的独立目录运行4B：首次 query18.974s；特殊标记文本64.7ms；长文准确分成3段、重拼无丢字，前两段实际编码6.50s且 finite；已发 embedding 请求的取消2.4ms，随后 query105.8ms；shutdown58.5ms，退出后禁止重启。该次 server 峰值 RSS3.26GB。另一次实际4B/512为首次17.94s、warm67.1/65.7ms，输出512维、norm1，关闭46.3ms。请求取消记录证明客户端及时结束且后续可用，不把它解释为 GPU 在同一毫秒完成抢占。

## 6. 100k 与多问题成本

生产 exact worker 使用相同算法，移出 Main 解决 UI 阻塞，不让计算免费。先前4096维100k扫描约6–7s；新实验使用真实4B/512编码的3个query，在同一模型驻留期间，扫描相同生成规则的合成512维 SQL负载。每格3次顺序重复，worker结果与Main逐项hash一致；这个小样本报告范围，不伪造可靠p95。

| 规模 / 问题数 | Main直扫   | 实际持久worker       | worker时Main事件循环最大延迟 |
| ------------- | ---------- | -------------------- | ---------------------------- |
| 10k / 1       | 90–101ms   | 91–157ms（含首启动） | 1.3–7.3ms                    |
| 10k / 3       | 260–275ms  | 256–317ms            | 1.8–9.0ms                    |
| 100k / 1      | 852–877ms  | 903–958ms            | 1.3–3.2ms                    |
| 100k / 3      | 2.45–2.65s | 2.41–2.81s           | 1.5–8.9ms                    |

Main直扫会产生几乎等长的事件循环阻塞，不能作为正常交互实现。100k纯向量净荷204.8MB，**实际 SQLite为524.7MB**，包括表、索引、页布局和元数据，不能用净荷替代落盘体积。采样Node进程RSS约148–461MB；这不包括独立模型进程，也不是整个Electron峰值。系统swap本轮308.94→300.94MB，不能由单次下降宣称无内存压力。

多问题顺序 exact 的2.4–2.8s还需叠加约3×warm编码与selector，属于明确的性能成本。需要真实大库候选质量之后，再决定是否评估单次多query扫描或ANN；本包没有引入第二索引/算法。不得把本合成库的相似度成绩当100k语义召回证明。

## 7. 部署与验证边界

生产目录包含唯一 GGUF、`llama-server`、相邻 dylib、编译的 `embedding-supervisor`、manifest及许可证。准备工具只使用官方下载源并验证hash；运行不依赖实验路径、Python或Homebrew。打包应置于ASAR外、保留相对RPATH与dylib symlink，并由既有签名链签名。编译的最低macOS目标为13.3，不等于在13.3实际验收。当前已完成完整 Electron arm64 打包与实际编码器/Worker 冒烟；正式签名/notarization 与多小时桌面共存仍待验收。

原生supervisor以kqueue感知父进程退出/终止信号，join唯一子进程并清理自己的socket；SIGTERM后5秒的清理宽限只处理失控基础设施，不是Run或请求时限。此前真实原生显式退出/父进程SIGKILL实验均约62ms完成、无升级SIGKILL、socket移除；新生产路径也验证了正常退出。父进程硬退出后可能留下空临时目录，正常退出由Main清理。

`LocalEmbedding` 将 tokenize/encode 串行化；支持排队取消、装载期间取消、截断HTTP响应失败、子进程退出后明确重建、应用退出后禁止重启。文档按实际Token计量分段，保留Unicode字符并复核边界；query包含instruction一起计数。向量检查原维数、finite、Float32范围和非零范数，再取512维归一化。索引namespace含模型/引擎/维度/instruction/特殊标记解析/分段窗口；batch与线程只影响调度。

独立工作包17项focused离线测试、限定文件lint/format、diff whitespace检查通过；TypeScript检查中本包文件无错误，完整检查当时受并行集成的旧调用合同阻塞，不把它记作全仓green。数值HTTP fixture只测试协议/生命周期，不假装真实语义模型。试验runner与候选依赖不进入仓库，focused fixture重写为单一生产合同的回归，没有Arm开关。资源打包接线及最终回归由root在本Decision之后记录。

## 8. 何时训练，以及怎样复现

后续满足以下诊断才重开微调：所需事实已经正确形成、人物/版本/时效过滤正确、问题提供了足够情境，而跨独立故事的正确证据仍经常在真实候选预算外；在不增加干扰和资源的前提下，基础模型/查询表达/现有检索已不能解决，并且训练能改善最终选证或回答。若证据已在候选内，先查query计划和selector；若没形成或被错误覆盖，先修形成/版本链。数值门槛应在新实验预注册，不能从当前28题事后发明。

[Qwen固定版本的官方训练说明](https://github.com/QwenLM/Qwen3-Embedding/blob/44548aa5f0a0aed1c76d64e19afe47727a325b8f/docs/training/SWIFT.md) 指向ModelScope SWIFT，支持embedding任务、InfoNCE、正例及显式困难负例、全参和LoRA等方式。训练原料应为完整问题/情境与真实支持段落，并保留人物、时间和纠正差异；不能把可共同支持答案的段落一律当负例。按故事/人物分组划分训练、开发和独立holdout，holdout不参与挖负例、改instruction或选checkpoint。

可复现的下一步是独立训练环境，固定 `Qwen/Qwen3-Embedding-4B@5cf2132abc99cad020ac570b19d031efec650f2b` 的BF16底座、上述SWIFT commit、数据hash和依赖lock；**不能直接对发布用Q4 GGUF执行梯度训练**。官方入门命令的八卡/epoch/lr是示例，不是本产品阈值。本机24GiB已验证推理，没有验证4B/8B训练吞吐或峰值；先做有限LoRA资源probe，再决定本地MPS或独立CUDA机器，不能把推理内存直接当训练内存。

一个基于当前官方参数的独立训练起点如下；尚未执行，不代表这些超参数已经选胜：

```sh
# 外部虚拟环境中安装固定SWIFT源码并冻结依赖；base为上述固定BF16快照。
INFONCE_TEMPERATURE=0.1 INFONCE_USE_BATCH=True \
swift sft --model /path/to/pinned-base --task_type embedding \
  --model_type qwen3_emb --train_type lora --loss_type infonce \
  --dataset /path/to/train.jsonl --val_dataset /path/to/dev.jsonl \
  --label_names labels --output_dir /path/to/external-checkpoints
```

这里显式写temperature很必要：旧Qwen训练说明写0.01，但本次读取的[SWIFT当前loss源码](https://github.com/modelscope/ms-swift/blob/44007491be59ec236ab7ed9ddf1d8b51dad183fa/swift/loss/embedding.py)实际默认0.1，并新增可选query-query/document-document负例项。二者是版本差异，不能混用后声称复现。上述loss文件没有多前缀MRL损失；微调full维度后不能假定512维性能仍保留。必须单独验证512；若需要训练多前缀目标，应在外部实验显式实现/验证损失，再与原模型公平比较。

晋级流程：固定未微调基线 → 同数据/预算的LoRA候选 → 模型权重合并 → llama.cpp转换并量化 → 同tokenizer/短长输入数值检查 → 完整候选预算与同selector → 连续场景/holdout/资源比较。任何checkpoint或量化变化都产生新模型hash和索引namespace，重建索引；最后随包仅一个合并后的模型。训练器、LoRA适配开关和失败checkpoint不进入产品运行时。

## 9. 外部证据索引

以下均属于外部工件集合 `companion-commercial-20260915`；只在本文件保留可复现标识，原始模型、runner与大JSON不入库。

| 工件                                                               | SHA-256                                                            |
| ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `embedding-runtime/large-model-manifest.json`（模型/原生资产清单） | `40bb067fa90d80f0502dc0678fabce761c7e5bf85893412f0f592485fb08e0e7` |
| `embedding-runtime/large-model-summary.json`                       | `abfa6ef260000237fe6f5dde8527011ba633f18e3eb6d3c9e5321592a0c72b4c` |
| `embedding-runtime/long-input-v2-summary.json`                     | `a96f9369aa98a387d0307eb61f3281024383e20724a41457c13395d3958972c3` |
| `embedding-runtime/production-adapter-results.json`                | `1b986d90c17d5258be920e06763a02c10d49c6f45b605999625a7f9494641397` |
| `embedding-runtime/mrl-results.json`                               | `9c96487ac28ead095c90eae76b918086839d4ea228497518de5d0373b3a47189` |
| `embedding-selector/candidates.json`（含源码hash与全部候选）       | `30f7d3a0ab631fa09235059185fc59af63e53a58a4cfe305a72be0e898caa5fb` |
| `embedding-selector/paired-latest.json`（56次主试验）              | `d1a46941b6aee3f19b4e439cd9769f2ec9b5a19692f667b24195a805fd651006` |
| `memory-performance/mrl512/summary.json`                           | `668d0635b0e40d6a7cd2affcc96678746f63b868f4f246a4204199d8a14fdcf9` |
| `embedding-runtime/training-source-version.json`                   | `4ac92834005dc3bf0d12ae8a0506eebfed93fc9fb29262bee623aeabc446bad1` |

另保留 `bf16-results.json`、`supervisor-results.json`、各模型/长输入原始JSON和日志、实际准备后的资源清单，以及 `embedding-selector/context-amendment/` 的两次纠歧记录。初版预检失败和受前缀缓存影响的记录未删除，也未合并进最终延迟分布。

## 已结束的外部候选清理（2026-09-16）

所选 4B/512 已进入 Main 并完成实际打包编码器与向量 Worker 冒烟后，按精确清单删除未选的 Embedding 0.6B Q8_0、8B Q4_K_M，以及另一项本地感知实验的 4B Q4_K_M，共 8,056,893,408 B 的公开权重。保留各自固定仓库版本、下载 URL 和原始 SHA；未再复制权重归档。模型体积是逻辑字节，不代表 APFS 实际回收空间。所选 Embedding 4B、共享 llama 引擎、Main 资源与最终验证源完全保留。

同一清理包的 69 个已结束诊断源码文件和 4 个自有链接先归档、逐成员复核后删除，未跟随链接；不是 69 个生产文件。474 个保留项全部复核一致，原始模型调用、失败、SQLite、JSON、报告、官方源码和当前验证入口未变。仓外回执 `remaining-owned-cleanup/CLEANUP-RECEIPT.json` SHA `256aad01adcfbcb9951091d5118d31694afcbe9ea4b890974db1bc905f355455`；普通源码归档 SHA `c29c49d1723b6c715db707f1a7009b12bea17fb8e336091967c274eace89c916`。清理没有新模型/native 调用，不改变选择结果或增加微调证据。
