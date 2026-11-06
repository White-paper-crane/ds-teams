# 异构评审场：研究笔记

日期：2026-11-04　｜　作者：researcher　｜　前置文档：[会议室 v1 调研](research-meeting-room.md)

本文只补新证据，不重复上一篇已覆盖的级联/成本/自识别内容。每条格式为「结论 —— 数字 —— 来源」；抓不到的写「未核实」并列出试过的 URL。

## 0. 一页结论

- 同模型互评确有偏差，但**幅度小且不稳健**：GPT-4 自判给自己 +10% 胜率、Claude-v1 +25%，GPT-3.5 反而没有；论文自己承认样本不足以定论。
- 更硬的偏差来源不是「偏爱自己」，而是**顺序、长度、熟悉度**：顺序一翻，GPT-4 有 25%、GPT-3.5 有 58%、Llama 有 89% 的偏好反转。
- 「异构一定更好」**没有定论**。2026 年两篇结论相反：一篇说预算对齐后辩论打平甚至输、准确率跟的是成员能力；另一篇说只有异构架构能打破天花板。
- **能力差距比家族差异更重要**（至少在预算对齐的评测里）。所以「更强且不同家族」优于「为了不同而选弱一档」。
- 3 轮上限、少轮次收敛**有研究支持**：辩论收益几乎全在第一轮交换答案；轮数与人数以乘积 kτ 进入同一动力学；>4 轮收益趋平。

## 1. 同模型自评/互评，偏差到底多大

- GPT-4 判自己时给自己 **+10% 胜率**；Claude-v1 给自己 **+25%**；GPT-3.5 **不偏向自己** —— 原文同时声明「受限于数据量与小差异，本研究无法确认模型是否真有自我增强偏差」 —— [Zheng et al., MT-Bench, arXiv:2306.05685](https://arxiv.org/abs/2306.05685)
- 三个模型零样本自识别均 **>50%**，GPT-4 达 **73.5%**；成对比较下每位评估者的 self-preference 分数之和 **>1**（即无法靠随机抵消） —— [Panickssery et al., arXiv:2404.13076](https://arxiv.org/abs/2404.13076)
- **位置偏差比自偏好更致命**：交换两个回答的顺序后，偏好反转率 GPT-4 **25%**、GPT-3.5 **58%**、Llama **89%** —— 同上
- 机制不是「认出自己」，而是**熟悉度**：LLM 给低困惑度文本打高分（无论作者是谁），人类不这样；由此提出可量化的 self-preference 指标并测得 GPT-4 显著自偏好 —— [Wataoka et al., arXiv:2410.21819](https://arxiv.org/abs/2410.21819)
- self-bias 在 **6 个模型**（GPT-4、GPT-3.5、Gemini、LLaMA2、Mixtral、DeepSeek）× 翻译/受限生成/数学推理上**普遍存在**；self-refine 提升流畅度但**放大**偏差；更大模型 + 准确外部反馈能显著降低偏差 —— [Xu et al., arXiv:2402.11436](https://arxiv.org/abs/2402.11436)
- 裁判与人类一致率随「被评两模型的能力差距」增大而升高，从 **70% 升到接近 100%**；GPT-4 与人类一致 **85%**，人类彼此 **81%** —— [MT-Bench, arXiv:2306.05685](https://arxiv.org/abs/2306.05685)

对 ds-teams 的含义：同模型互评的问题不是「必然偏心」，而是**偏差方向固定且不可自检**。换家族把「已知的自我偏好」换成「未知的家族差异」，本身不保证更准；但把评审端从「同一权重」变成「不同预训练分布」，至少让位置偏差和熟悉度偏差不再系统性指向同一方向。

## 2. 模型异构对多智能体评审/辩论有收益吗

支持方：

- 3 agent / 2 轮辩论：算术 **67.0 → 81.8**、GSM8K **77.0 → 85.0**、国际象棋 pawn score **91.4 → 122.9**；事实性任务 MMLU **63.9 → 71.1**、传记 **66.0 → 73.8**；而 self-reflection 基线在 GSM8K（75.0）和 MMLU（57.7）上**掉点** —— [Du et al., arXiv:2305.14325](https://arxiv.org/abs/2305.14325)
- 纯开源模型堆出的 Mixture-of-Agents 在 AlpacaEval 2.0 达 **65.1%**，超过 GPT-4o 的 **57.5%** —— [arXiv:2406.04692](https://arxiv.org/abs/2406.04692)
- 异构直证：20 道 GSM8K 上 Bard 单独 **11** 题、ChatGPT 单独 **14** 题，两者辩论联合 **17** 题 —— [Du et al., arXiv:2305.14325](https://arxiv.org/abs/2305.14325)

反对方 / 收益消失条件：

- 预算对齐（同 token 预算）后，辩论相对 self-consistency 采样「**ties or even loses**」，代价是 **1.6× 墙钟时间、3.4× token**；混合模型队伍**输给**各家自有 roster 的多数投票，准确率「tracking member capability rather than heterogeneity」 —— [arXiv:2609.35875](https://arxiv.org/abs/2609.35875)
- 同质队伍里「辩论」的收益来自**再评估**而非同伴内容：噪声 placebo 能复现 self-correction 的收益；30 个密集辩论 agent 在 MMLU-Hard 上答案多样性**不多于 1 个** —— [Ringelmann Effect, arXiv:2606.02646](https://arxiv.org/abs/2606.02646)
- 现有 MAD 系统**并不可靠地优于** self-consistency / 多路径 ensembling，且对超参（如 agent 一致性程度）高度敏感 —— [Smit et al., arXiv:2311.17371](https://arxiv.org/abs/2311.17371)
- 单 agent + 强提示**几乎追平**最好的多 agent 讨论；只有 prompt 里没有 demonstration 时讨论才更好 —— [Wang et al., arXiv:2402.18272](https://arxiv.org/abs/2402.18272)

两篇 2026 论文为何相反（写进结论，别当成矛盾丢一边）：2606 测的是**多样性/正确性天花板的统计量**（N_eff/N 的拟合，R²>0.99），回答「这个队伍结构能不能超过硬天花板」；2609 测的是**预算对齐后的最终准确率**，回答「同样的钱，辩论值不值」。前者说异构能抬天花板，后者说抬不动当下的平均分。对 ds-teams 这种「一次评审、预算极小」的场景，**2609 的结论更贴脸**：2 个 agent、3 轮的规模下，收益大概率来自再评估，而不是「跨家族化学反应」。

## 3. 评审方选「更强但更贵」还是「同档不同家族」

- 2609 明确：混合模型队伍的准确率跟**成员能力**走，不跟异质性走；异构带来的额外收益要在「每个成员都够强」的前提下才谈得上 —— [arXiv:2609.35875](https://arxiv.org/abs/2609.35875)
- 只有**架构级异构**（heterogeneous teams）能降低 Ringelmann 系数 c、逃出硬天花板区 —— [arXiv:2606.02646](https://arxiv.org/abs/2606.02646)
- 裁判侧：能力差距越大，裁判与人类一致率越高（**70% → ~100%**），说明「评审方明显强于被评审方」时裁判更可靠 —— [MT-Bench, arXiv:2306.05685](https://arxiv.org/abs/2306.05685)
- 反向约束：不同的 LLM 做 agent 时，LLM 裁判「**可能不是公平的裁判**」，需要额外校准 —— [Liang et al., arXiv:2305.19118](https://arxiv.org/abs/2305.19118)

综合判断：**能力差距优先，家族差异是次要但几乎是免费的加成**。所以最优解不是二选一，而是「既更强、又不同家族」。小满（deepseek-v4.1-flash）是相对轻的档位，让旗舰档的另一家族来评审，同时拿到两边的收益。

## 4. 3 轮上限 + 90 秒沉默收敛，研究上站得住吗

- 辩论收益「**nearly all ... comes from the first exchange of answers**」；后续轮次主要在花钱 —— [arXiv:2609.35875](https://arxiv.org/abs/2609.35875)
- 轮数 τ 与同伴数 k **只以乘积 kτ 进入动力学**：把轮数从 6 砍到 3 等价于把 agent 数减半，收益曲线同形 —— [arXiv:2606.02646](https://arxiv.org/abs/2606.02646)
- Du et al. 主设置就是 **3 agent / 2 轮**，并报告轮数 **>4 后收益趋平** —— [arXiv:2305.14325](https://arxiv.org/abs/2305.14325)
- 停止规则要有「**adaptive break**」：否则模型一旦自信就退化（Degeneration-of-Thought），反复反思产不出新思路 —— [Liang et al., arXiv:2305.19118](https://arxiv.org/abs/2305.19118)
- 成本侧：辩论 = **3.4× token、1.6× 墙钟**（对比同等预算采样） —— [arXiv:2609.35875](https://arxiv.org/abs/2609.35875)

结论：**3 轮上限合理，甚至可以更狠（2 轮就够）**；「无意见即沉默收敛」符合 adaptive break 的精神——它把「没话找话」的轮次直接掐掉。但 **90 秒**这个数是工程参数、不是研究结论：**未找到关于「沉默超时阈值」的实证研究**（试过 arXiv 检索 multi-agent debate termination / convergence，无直接对应）。而且要留意：kimi-k3.1-pro 与 glm-5.3 都是**始终开启思考**的模型（见第 5 节），90 秒可能不够它们想完 + 写完，建议实测 P95 延迟再定阈值，或把评审端 `reasoning_effort` 设为 `low`。

## 5. 落地建议：大满端评审模型

**首选：glm-5.3　｜　备选：kimi-k3.1-pro**

理由（按权重）：

1. **不同家族 + 旗舰档，一次满足两个条件**：GLM 与 DeepSeek 预训练分布不同；GLM-5.3 是智谱当前旗舰，自称「编程与智能体能力比肩 Claude Fable 5」。
2. **价格公开且便宜**：输入 **¥8 / 百万 tokens**、输出 **¥28**、缓存命中 **¥2**，缓存存储限时免费 —— [智谱 API 定价](https://docs.bigmodel.cn/cn/guide/start/pricing)。对比 qwen3.8-max 的 ¥12/¥36（北京地域）。
3. **上下文与输出够用**：1M 上下文、最大输出 128K，中文 token 换算约 **1 token : 1.6 汉字** —— [GLM-5.3 模型介绍](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3)、[定价页](https://docs.bigmodel.cn/cn/guide/start/pricing)。
4. **备选 kimi-k3.1-pro 的强项**：3 万亿参数、1M 上下文、Terminal-Bench 4.0 **65.7%**（GPT-6 Astra 58.2%、Claude Opus 5.5 66.4%）、Kimi Code Bench 3.0 Long-horizon **61.2%**（K3 为 55.95%）—— 代码类议题的评审质量应更好 —— [Kimi K3.1 Pro 文档](https://platform.kimi.com/docs/guide/kimi-k3-1-pro-quickstart)。
5. **不选它的原因**：单价**未核实**（官方定价页的表格对爬虫渲染为空表，试过 [pricing/chat](https://platform.kimi.com/docs/pricing/chat)、[pricing/chat.md](https://platform.kimi.com/docs/pricing/chat.md)、[pricing/kimi-k3.1-pro](https://tokenrocks.ai/pricing/kimi-k3.1-pro) 均拿不到数字）；且 K3.1 Pro **始终开启思考**、`max_completion_tokens` 默认 131072，延迟对 90 秒窗口是风险。

| 模型 | 上下文 | 输入 ¥/MTok | 输出 ¥/MTok | 备注 |
| --- | --- | --- | --- | --- |
| glm-5.3 | 1M / 128K 输出 | 8 | 28 | 缓存命中 2；始终思考，`reasoning_effort` low/high/max |
| glm-5.3-flash | 1M / 128K 输出 | 0.8 | 2.8 | 原生多模态；省钱档 |
| kimi-k3.1-pro | 1,048,576 | 待核实 | 待核实 | Batch API 为标准价 60%；始终思考 |
| qwen3.8-max | 1,000,000（输入 991,808 / 输出 131,072） | 12 | 36 | 2.4 万亿参数 MoE；缓存命中 1.5 |
| qwen3.8-flash | 待核实 | 待核实 | 待核实 | 官方定位「快速且低成本」 |
| deepseek-v4.1-flash（现状） | 待核实 | 待核实 | 待核实 | 现役两端同模型 |

> **2026-11-04 实测更正**：glm-5.3 并非「始终思考」。`/v1/responses` 实测 10 次采样中只有 3 次 `reasoning_tokens > 0`（13/75/61），短 prompt 下多为 0；`reasoning_effort: low` 首字 4758ms、不传 2522ms，**加 effort 反而更慢**。所以「90 秒可能不够它想完」这条担忧不成立 —— 真正的慢因是 prefill（见 `docs/wake-governance.md` §14）。kimi-k3.1-pro 未实测，该结论对它仍未知。

来源：[智谱定价](https://docs.bigmodel.cn/cn/guide/start/pricing)、[Kimi 定价说明](https://platform.kimi.com/docs/pricing/chat)、[百炼 qwen3.8-max](https://help.aliyun.com/zh/model-studio/qwen3-8-max)、[百炼模型列表](https://help.aliyun.com/zh/model-studio/models)。

**接入路径**：TokenRocks 是 OpenAI 兼容聚合（`https://api.tokenrocks.ai/v1`，聚合 27 个模型，特价线路 DeepSeek/Qwen/GLM 0.5 折、Kimi 1.5 折，企业线路国模 3 折），换评审端只需改 base_url + model 名，不动会议室协议 —— [tokenrocks.ai](https://tokenrocks.ai/)。注意其特价线路「个别上游附带固定提示词」，评审场景对提示词敏感，建议走企业满血线路；TokenRocks 逐模型单价页是 JS 动态渲染，**单价待核实**。

**最小验证方案**（建议 lead 采纳）：拿 20 份历史 report 卡做离线对拍，同一份材料分别给 deepseek-v4.1-flash（现状）、glm-5.3、kimi-k3.1-pro 判 `pass|issues`，比较与人工标注的一致率与 token 成本。参考 2609 的做法，**必须做预算对齐**（同 token 或同金额），否则「异构更好」的结论会被额外花的钱解释掉。

## 6. 未核实清单

- kimi-k3.1-pro、qwen3.8-max/flash、deepseek-v4.1-flash 的 TokenRocks 实际单价（试过 URL 见上）。
- 三个候选模型的**中文基准分数**（C-Eval / CMMLU / SuperCLUE 均未抓到有效页面，只有厂商定位描述与 token 换算比）。
- 「沉默超时阈值」的直接实证研究（未找到对应论文）。
- 各模型中文场景下的实际 P95 延迟（需实测，非公开数据）。

## 7. 参考

1. [Zheng et al. 2306.05685 — MT-Bench / LLM-as-a-judge](https://arxiv.org/abs/2306.05685)
2. [Panickssery et al. 2404.13076 — LLM evaluators recognize and favor their own generations](https://arxiv.org/abs/2404.13076)
3. [Wataoka et al. 2410.21819 — Self-preference 的困惑度解释](https://arxiv.org/abs/2410.21819)
4. [Xu et al. 2402.11436 — Pride and Prejudice: LLM 自偏](https://arxiv.org/abs/2402.11436)
5. [Du et al. 2305.14325 — Multiagent debate](https://arxiv.org/abs/2305.14325)
6. [Liang et al. 2305.19118 — Encouraging divergent thinking（DoT / adaptive break）](https://arxiv.org/abs/2305.19118)
7. [Wang et al. 2402.18272 — Rethinking the bounds of LLM reasoning](https://arxiv.org/abs/2402.18272)
8. [Smit et al. 2311.17371 — Should we be going MAD?](https://arxiv.org/abs/2311.17371)
9. [2406.04692 — Mixture-of-Agents](https://arxiv.org/abs/2406.04692)
10. [2609.35875 — Beyond Symmetric Agents（2026-09）](https://arxiv.org/abs/2609.35875)
11. [2606.02646 — Ringelmann Effect in Multi-Agent LLM Systems（2026-05）](https://arxiv.org/abs/2606.02646)
12. [智谱 GLM-5.3 模型介绍](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3)｜[API 定价](https://docs.bigmodel.cn/cn/guide/start/pricing)
13. [Kimi K3.1 Pro 文档](https://platform.kimi.com/docs/guide/kimi-k3-1-pro-quickstart)｜[定价说明](https://platform.kimi.com/docs/pricing/chat)
14. [百炼 qwen3.8-max](https://help.aliyun.com/zh/model-studio/qwen3-8-max)｜[模型列表](https://help.aliyun.com/zh/model-studio/models)
15. [TokenRocks](https://tokenrocks.ai/)
