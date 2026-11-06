# 研究汇编：共享会议室 + 模型级联 架构改造支撑材料

> 项目：ds-teams。用途：支撑「双独立 AI 会话（大满/小满，各自上下文、消息互投）→ 共享会议室 + 模型级联（deepseek-flash 草稿、满血集中评审、收敛式评审循环）」的设计决策。
> 方法：2026-11-04 经 web_search / web_fetch 抓取并核对官方文档与论文原文；所有数字取自原文。
> 凡例：每行「结论——数字——来源（markdown 链接）」；不确定处标「待核实」；由多条证据组合推出的结论标「推导」。定价类数字有时效性，以链接页面当前值为准。

## 1. 模型级联（cascade / draft-and-review）

- 级联可以匹配最强单模型（GPT-4）的性能，同时最高省 98% 成本；或在相同成本下准确率比 GPT-4 高 4% —— 数字：98% 成本降 / +4% 准确率 —— 来源：[FrugalGPT, arXiv:2305.05176](https://arxiv.org/abs/2305.05176)（Stanford，2023-05）
- 用路由器在 GPT-4 与较弱模型之间选择：MT Bench 成本降 >85%、MMLU 降 45%、GSM8K 降 35%，同时保持 GPT-4 性能的 95% —— 数字：>85% / 45% / 35% 成本降，95% 性能 —— 来源：[RouteLLM 官方博客](https://lmsys.org/blog/2024-07-01-routellm/)、[RouteLLM, arXiv:2406.18665](https://arxiv.org/abs/2406.18665)（LMSYS）
- RouteLLM 比商用路由方案（Martian / Unify）在同等性能下便宜 40%+，且无需重训即可泛化到 Claude 3 Opus vs Llama 3 8B 的模型组合 —— 数字：40%+ 更便宜 —— 来源：[RouteLLM 官方博客](https://lmsys.org/blog/2024-07-01-routellm/)
- 弱模型（GPT-3.5-turbo）做一致性检查、强模型（GPT-4）兜底：六个推理基准上性能与纯 GPT-4 相当，成本仅为其 40% —— 数字：40% 成本 —— 来源：[Mixture-of-Thought, arXiv:2310.03094](https://arxiv.org/abs/2310.03094)（ICLR 2024）
- 难度路由器把大模型调用次数减少至多 40%，响应质量无下降 —— 数字：至多 40% 调用减少 —— 来源：[Hybrid LLM, arXiv:2404.14618](https://arxiv.org/abs/2404.14618)（ICLR 2024，Microsoft）
- 级联有效的条件：任务存在弱模型可解的子集、且可获得可靠难度信号（如答案一致性）；信号质量决定收益——开放问答（MT Bench）省 85%，数学推理（GSM8K）只省 35%（强模型优势大、难度难预判的领域省得少）—— 数字：85% vs 35% —— 来源：[RouteLLM 官方博客](https://lmsys.org/blog/2024-07-01-routellm/)；难度信号机制：[MoT, arXiv:2310.03094](https://arxiv.org/abs/2310.03094)
- 级联失效的条件（引自多 agent 放大研究的对应结论）：任务单 agent 基线准确率已超过 45% 时，继续加 agent 是负收益（β=−0.236, p=0.004），即级联收益有上限、达到上限后再加评审不划算 —— 数字：45% 阈值 —— 来源：[arXiv:2512.08296 v3](https://arxiv.org/abs/2512.08296)（详见第 5 节）

## 2. 共享上下文 vs 消息互投的成本账（DeepSeek context caching）

- 机制：DeepSeek 磁盘上下文缓存默认开启、无需改代码；输入前缀完整匹配某个「缓存前缀单元」时，该部分按 cache hit 价计费 —— 来源：[DeepSeek 官方 KV Cache 文档](https://api-docs.deepseek.com/guides/kv_cache)
- 缓存单元在用户输入末尾、模型输出末尾、公共前缀检测处及固定 token 间隔处持久化；命中是 best-effort，不保证 100%；闲置数小时至数天自动清除；usage 返回 prompt_cache_hit_tokens / prompt_cache_miss_tokens 两个字段 —— 来源：[DeepSeek 官方 KV Cache 文档](https://api-docs.deepseek.com/guides/kv_cache)
- 折扣量级（官方定价，2026-11-04 抓取）：deepseek-flash 输入 cache hit $0.003/M vs miss $0.15/M（off-peak），命中价仅为未命中价的 1/50（省 98%；peak 为 $0.006 vs $0.3）；deepseek-v4-pro 输入 hit $0.022/M vs miss $0.66/M（off-peak），即 1/30（省约 97%）—— 数字：1/50、1/30 —— 来源：[DeepSeek 官方定价页](https://api-docs.deepseek.com/quick_start/pricing)
- 输出价：deepseek-flash $0.6/M、deepseek-v4-pro $1.98/M（off-peak）；peak 时段为 UTC 01:00–04:00 与 06:00–10:00 的工作日（不含中国节假日）—— 来源：[DeepSeek 官方定价页](https://api-docs.deepseek.com/quick_start/pricing)
- 该机制引入时（2024-08-02）官方公告标题即称「cutting prices by an order of magnitude（价格降低一个数量级）」—— 来源：[DeepSeek News 0802](https://api-docs.deepseek.com/news/news0802.md)
- 共享会议室为何比消息互投便宜（推导；每步依据见括号）：
  1. 房间议程+草稿对 N 位评审者是同一段前缀：评审输入 = 前缀（cache hit）+ 少量增量，只有增量按未命中价计费（依据：前缀匹配机制与 hit 1/50 折扣，[文档](https://api-docs.deepseek.com/guides/kv_cache)、[定价](https://api-docs.deepseek.com/quick_start/pricing)）；
  2. 消息互投时每个 agent 各自重发整段上下文，前缀各自断裂、各自 cache miss，同一内容重复付全价（推导）；
  3. 多 agent 系统的通信 tokens 约为聊天场景的 15 倍（单 agent 约 4 倍），互投模式把这一放大系数也乘进去了（数字：[Anthropic 多 agent 研究](https://www.anthropic.com/research/multi-agent-research-system)）；
  4. 共享文件/会议室天然符合 Anthropic「子 agent 产出落文件系统、只回传轻量引用」的建议，避免传话式重复拷贝（[Anthropic 多 agent 研究](https://www.anthropic.com/research/multi-agent-research-system)）。
- 成本优势的前提与风险：命中要求前缀与已缓存单元完全匹配；前缀一旦变动（消息顺序、时间戳、房间号等动态噪声混入前缀）即全量 cache miss；官方文档只描述完全匹配的单元，未承诺部分匹配的部分命中 → 待核实「前缀不匹配时是否存在部分命中」—— 来源：[DeepSeek 官方 KV Cache 文档](https://api-docs.deepseek.com/guides/kv_cache)
- 设计中可落实的做法（推导）：固定「系统提示 + 房间议程 + 草稿正文」为稳定前缀、变量（每轮评审意见）放在末尾，使每一轮评审输入的前缀尽量与上一轮命中同一缓存单元

## 3. LLM 自评偏置与异构评审

- 自偏好（self-preference）：同模型给自己的输出打更高分，而人类标注者认为两者质量相当——同模型自审存在系统性偏袒 —— 来源：[Panickssery, Bowman & Feng, NeurIPS 2024, arXiv:2404.13076](https://arxiv.org/abs/2404.13076)
- 自识别（self-recognition）：GPT-4 零样本在「自己 + 另两个 LLM + 人类」的输出中认出自己的准确率 73.5%；用 500 个样本微调后，GPT-3.5 / Llama-2 的自识别准确率 >90% —— 数字：73.5% / >90% —— 来源：[Panickssery et al., arXiv:2404.13076](https://arxiv.org/abs/2404.13076)
- 自识别能力与自偏好强度线性相关，且是因果方向（能认出自己才偏袒自己）——对「同一模型评审自己的草稿」是直接风险证据 —— 来源：[Panickssery et al., arXiv:2404.13076](https://arxiv.org/abs/2404.13076)
- 位置偏置：选项顺序反转时，GPT-4 / GPT-3.5 / Llama 翻转自己偏好的比例分别为 25% / 58% / 89% —— 数字：25% / 58% / 89% —— 来源：[Panickssery et al., arXiv:2404.13076](https://arxiv.org/abs/2404.13076)
- 无外部反馈的内在自我纠错（同模型反复改自己的答案）全线掉点：GPT-4 GSM8K 95.5→91.5→89.0（纠错两轮）、CommonSenseQA 82.0→79.5→80.0；GPT-3.5 CommonSenseQA 75.8→38.1→41.8；Llama-2 GSM8K 62.0→43.5→36.5；GPT-4 仅在带 oracle 标签时才 95.5→97.5——早期文献的「自我纠错提升」实为 oracle 反馈假象 —— 来源：[Huang et al., ICLR 2024, arXiv:2310.01798](https://arxiv.org/abs/2310.01798)
- 同模型自我纠错倾向保留原答案：GPT-3.5 在 GSM8K 上 74.7% 的情况保留原答案，且把正确改错的概率高于把错误改对 —— 数字：74.7% —— 来源：[Huang et al., arXiv:2310.01798](https://arxiv.org/abs/2310.01798)
- 纯同模型多 agent 辩论不解决问题：3 agent、2 轮辩论（gpt-3.5-turbo-0301）不优于 self-consistency 基线 —— 来源：[Huang et al., arXiv:2310.01798](https://arxiv.org/abs/2310.01798)
- 异构强模型当裁判是有依据的：LLM-as-a-judge 存在三大已知偏置（位置、冗长、自我增强），但 GPT-4 裁判与人类偏好的一致率 >80%，达到人类之间的一致水平——即「强模型评审弱模型草稿」可行，「同模型自审」不可信 —— 数字：>80% —— 来源：[Zheng et al., NeurIPS 2023, arXiv:2306.05685](https://arxiv.org/abs/2306.05685)

## 4. Anthropic 官方多 agent 指南

- 总原则：区分 workflows（预定义代码路径）与 agents（模型动态决策）；「能用最简单的方案就用最简单的」；agentic 系统是以延迟和成本换取任务性能 —— 来源：[Building Effective Agents, Anthropic（2024-12）](https://www.anthropic.com/research/building-effective-agents)（该页已加「工具链已变、请参考 Managed Agents」的注记）
- 很多应用场景单次 LLM 调用 + 检索 + few-shot 就够了，不必上多 agent —— 来源：[Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)
- orchestrator-workers 模式：中央 LLM 动态拆任务、委派 worker、汇总结果；适用于「无法预知需要哪些子任务的复杂任务」；与 parallelization 的区别是灵活性（动态决策 vs 预定义切分）—— 来源：[Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)
- evaluator-optimizer 模式：一个模型生成、另一个模型评估并循环给出反馈；官方适用案例为文学翻译与复杂搜索 —— 来源：[Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)
- 官方实测收益：Opus 4 领队 + Sonnet 4 子 agent 的编排，在内部研究评测上比单 agent Opus 4 高 90.2%（广度优先查询）—— 数字：+90.2% —— 来源：[How we built our multi-agent research system, Anthropic（2025-06）](https://www.anthropic.com/research/multi-agent-research-system)
- 官方实测成本：agent 消耗约为聊天场景 4 倍的 tokens，多 agent 系统约为 15 倍 —— 数字：4× / 15× —— 来源：[Anthropic 多 agent 研究](https://www.anthropic.com/research/multi-agent-research-system)
- BrowseComp 成绩方差的 95% 可由 3 个因素解释：token 用量（单因素即占 80%）、工具调用次数、模型选择 —— 数字：95% / 80% —— 来源：[Anthropic 多 agent 研究](https://www.anthropic.com/research/multi-agent-research-system)
- 官方明说的「不该用多 agent」场景：需要所有 agent 共享同一上下文的场景、agent 间依赖多的任务；多数编码任务并行度低、实时协调弱 —— 来源：[Anthropic 多 agent 研究](https://www.anthropic.com/research/multi-agent-research-system)（注：这是对「共享会议室」设计的反方证据，改造论证需正面回应此点）
- 官方实践建议：子 agent 产出落到文件系统、只回传轻量引用，避免「传话游戏」式的消息拷贝 —— 来源：[Anthropic 多 agent 研究](https://www.anthropic.com/research/multi-agent-research-system)

## 5. arXiv 2512.08296 结论核对（v3）

- 版本信息：v1 提交 2025-12-09，v3 修订 2026-04-08；本节以 v3 HTML 全文为准 —— 来源：[arXiv:2512.08296](https://arxiv.org/abs/2512.08296)
- ✅ 确认：独立架构（independent）trace 级错误放大 17.2×，集中式编排（centralized）4.4×（集中式验证瓶颈拦截了错误扩散）—— 与用户提供的数字一致 —— 来源：[arXiv:2512.08296 v3](https://arxiv.org/abs/2512.08296)
- ✅ 确认：45% 能力天花板——单 agent 基线准确率已超过 45% 的任务，增加 agent 是负收益（β=−0.236, p=0.004）—— 与用户提供的数字一致 —— 来源：[arXiv:2512.08296 v3](https://arxiv.org/abs/2512.08296)
- ❌ 「~4 agent 饱和」：未在 v3 正文找到该表述 → 待核实；v3 的原文结论方向相反地表述为「决定协作成败的是架构-任务匹配，而非 agent 数量」，即按数量谈饱和不是该文的结论 —— 来源：[arXiv:2512.08296 v3](https://arxiv.org/abs/2512.08296)
- ⚠️ 口径澄清：17.2× / 4.4× 是错误放大系数，不是性能提升倍数；两者相除可读作「集中式比独立式少放大约 3.9 倍错误」（推导）—— 来源：[arXiv:2512.08296 v3](https://arxiv.org/abs/2512.08296)
- 其他关键数字：性能跨度从 +80.8%（可分解金融推理、集中式）到 −70.0%（顺序规划、独立式）；规划类任务的所有多 agent 变体均 −39% ~ −70%；动态网页导航去中心化 +9.2%；工具密集任务的协调开销 β=−0.096, p=0.002；R²=0.373（任务感知模型 0.413）；held-out 配置上最佳架构预测准确率 87%；实验规模为 260 配置 / 6 基准 / 5 架构 / 3 LLM 家族 —— 来源：[arXiv:2512.08296 v3](https://arxiv.org/abs/2512.08296)
- 官方配套博客存在（[Towards a science of scaling agent systems: When and why agent systems work](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/)），但本机两次抓取失败（TypeError: fetch failed），未能核对其中是否有「~4 agent 饱和」表述 → 待核实 —— 来源：[Google Research Blog](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/)

## 6. 对改造设计的直接含义（推导小结）

- 「flash 草稿 + 满血集中评审 + 收敛循环」= RouteLLM 级联 + Anthropic evaluator-optimizer + 集中式编排，三份文献各给一条支持数字：保持 95% 性能同时省 15%–85% 成本（RouteLLM）、生成-评估循环为官方推荐模式（Anthropic）、集中式错误放大 4.4× vs 独立式 17.2×（2512.08296）（推导，依据见第 1/4/5 节）
- 评审必须异构：同模型自审有自偏好与自识别偏置（GPT-4 零样本自识别 73.5%），且内在自我纠错实测掉点——评审者应为更强模型（满血评审 flash 草稿），方向与「强裁判 vs 弱草稿」一致（推导，依据见第 3 节）
- 收敛式循环的停止条件有上限证据：任务已超 45% 准确率时继续加评审是负收益（β=−0.236, p=0.004）——循环必须在「无实质意见」时停止，且评审轮次不宜多（推导，依据见第 5 节；同模型多轮辩论不优于 self-consistency，见第 3 节）
- 共享会议室成本优势成立的前提：房间前缀稳定（议程/草稿顺序固定、无动态噪声混入前缀），否则全量 cache miss、优势归零（推导，依据见第 2 节）
- 风险提示：Anthropic 官方把「需要共享同一上下文、agent 间依赖多」列为多 agent 低收益场景——会议室设计应以「少而精的集中评审 + 轻量回传」规避，而非大量 worker 并跑（推导，依据见第 4 节）

## 附录：来源清单

- [FrugalGPT, arXiv:2305.05176](https://arxiv.org/abs/2305.05176)
- [RouteLLM 官方博客（LMSYS）](https://lmsys.org/blog/2024-07-01-routellm/)
- [RouteLLM, arXiv:2406.18665](https://arxiv.org/abs/2406.18665)
- [Mixture-of-Thought, arXiv:2310.03094](https://arxiv.org/abs/2310.03094)
- [Hybrid LLM, arXiv:2404.14618](https://arxiv.org/abs/2404.14618)
- [DeepSeek 上下文缓存机制（KV Cache 文档）](https://api-docs.deepseek.com/guides/kv_cache)
- [DeepSeek 定价页](https://api-docs.deepseek.com/quick_start/pricing)
- [DeepSeek News 0802（缓存定价公告）](https://api-docs.deepseek.com/news/news0802.md)
- [Panickssery et al., 自偏好与自识别, arXiv:2404.13076](https://arxiv.org/abs/2404.13076)
- [Huang et al., 内在自我纠错, arXiv:2310.01798](https://arxiv.org/abs/2310.01798)
- [Zheng et al., LLM-as-a-Judge, arXiv:2306.05685](https://arxiv.org/abs/2306.05685)
- [Building Effective Agents, Anthropic](https://www.anthropic.com/research/building-effective-agents)
- [How we built our multi-agent research system, Anthropic](https://www.anthropic.com/research/multi-agent-research-system)
- [Towards a Science of Scaling Agent Systems, arXiv:2512.08296](https://arxiv.org/abs/2512.08296)
- [Google Research Blog：该论文官方配套博客（本机抓取失败，未核对内容）](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/)
