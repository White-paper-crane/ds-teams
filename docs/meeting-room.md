# 会议室（评审场集中）设计契约

> 版本 v1｜2026-11-04｜对应 goal-8dfee529。实现依据；改设计先改本文件。
> 用户拍板（m04428）：A 方案采用；研究支撑；不考虑 token；对已有构建改造修正、新模块精简优美；避免 AI 垃圾；避开花钱买低质量意见；模型代码设定非用户决策；要真人测评。

## 1. 目标

让大满、小满在房间内自主互评（交活→评审→收敛），不以用户为中心转接；模型选择由代码决定，评审方天然异构；评审无意见即沉默收敛，不产生客套垃圾。

## 2. 研究支撑（全文与来源见 docs/research-meeting-room.md）

- 集中式编排错误放大率 4.4×，独立 Agent 17.2×（arXiv 2512.08296 v3，已核对）；本方案评审循环集中在评审场一侧，属集中式。
- 同模型自审不可信（GPT-4 零样本自识别 73.5%、内在自我纠错实测掉点 GSM8K 95.5→89.0）；异构强裁判与人类一致率 >80%。本方案起草侧 deepseek-flash vs 评审侧 deepseek-v4-pro 天然异构。
- 模型级联：RouteLLM 路由省 >85% 成本保 GPT-4 95% 性能；适用前提「任务有弱模型可解子集 + 可靠难度信号」——本方案正是把评审（把关子集）固定分给大模型。
- 成本：DeepSeek cache hit 是 miss 价的 1/30～1/50；命中前提是前缀稳定。评审上下文只累加在评审场一侧 → cache 命中集中。
- **反方证据（直面）**：Anthropic 官方明说「需共享同一上下文、依赖多的任务」不该用多 agent；2512.08296 结论是「架构-任务匹配而非数量决定成败」。取舍（§8）：本方案保双端入口与掉线接管，评审史只留评审场一侧，草拟侧按需回看结论卡——语义等价集中式编排，不硬凑物理单 session。

## 3. 架构决策

| 决策 | 内容 | 理由 |
|---|---|---|
| 会议室形态 | 评审场集中：daman 会话兼评审场（满血 deepseek-v4-pro），me 会话保持 flash 快响应 | 不加第三个会话/成员；评审史只累积一处，cache 集中；保双端入口与掉线接管 |
| 模型代码化 | 桥接常量 FALLBACK_MODEL 分端：daman 桥 = deepseek-v4-pro，me 桥 = deepseek-flash | 用户开房不用管模型；代码决定，异构交叉 |
| 触发 | report 卡落库即开议题，投递给评审方（对方） | 交付即复核，正是「说完成带证据」的机器执行 |
| 评审意见 | 评审方用 `say.mjs review <room> --verdict pass\|issues "意见"` 交卡 | 参数化收敛信号，零语义猜测 |
| 无意见 | 评审方沉默 90s（wake NO_REPLY）→ 议题按沉默收敛，写一行 system 卡 | 用户要求「没意见就不回复」；零客套 |
| 修订循环 | verdict=issues → 草拟方收到 review 卡 → 修订再交 → 旧议题记 superseded、开新议题再审 | 收敛式评审；台账保留完整轮次史 |
| 上限 | MEETING.roundCap=3；超轮次收敛并提示群主裁决 | 防无限互驳 |
| 无新 kind/成员/UI | 全部复用 report/review/system 卡与现有渲染 | 反臃肿 |

BC 缺陷规避：不做压缩投递（B 丢细节）；不做全量闲聊互投硬扛（C 亿级/天）；闲聊仍点名才投（既有修复）。

## 4. 数据与协议

### 4.1 议题台账 `data/meeting-state.json`（meeting-lib.mjs 读写，tmp+rename）

```jsonc
{
  "issues": {                       // 按议题 id 索引
    "mt-<n>-<who>-<4hex>": {
      "id": "...", "roomId": "...", "author": "me|daman",
      "reviewer": "daman|me",       // 对方；两端都有报告则互为评审
      "reportSeq": 123,             // 触发议题的 report 卡 seq
      "title": "报告标题（前 60 字）",
      "taskId": "t1",               // 同房同作者同 taskId 修订重交 → 旧 open 议题记 superseded
      "rounds": [ { "n": 1, "verdict": "open|pass|issues|silent|cap", "text": "", "at": "ISO" } ],
      "status": "open|converged|aborted|superseded",
      "closedBy": "silent|pass|issues|cap|room-closed|superseded",
      "updatedAt": "ISO"
    }
  },
  "keep": 200                       // 议题保留条数（LRU 裁剪）
}
```

### 4.2 protocol.mjs 新增常量

```js
export const MEETING = Object.freeze({
  roundCap: 3,                      // 最多评审轮次
  silenceWindowMs: 90_000,          // 与 WAKE.outcomeWindowMs 一致
  verdicts: ["pass", "issues"],     // review 卡合法 verdict
});
export const MEETING_VERDICT_SET = new Set(MEETING.verdicts);
```

### 4.3 服务端端点

| 端点 | 行为 |
|---|---|
| POST `/api/rooms/:id/report`（现有） | 落 report 卡后，若未带 `--noreview` → meeting-lib.open() 开议题（同 taskId 修订重交先记旧议题 superseded） |
| POST `/api/rooms/:id/review`（现有） | 落 review 卡后，若带 verdict → meeting-lib.respond()（记轮次；pass→收敛；issues→等草拟方再交） |
| POST `/api/wake/settle`（现有） | settle 成功后，若 outcome=NO_REPLY 且该 wake 的 (roomId,seq) 命中 open 议题的 reportSeq → meeting-lib.onSilence() 收敛 |
| GET `/api/meeting/state?roomId=` | 议题列表（评审场只读视角，?k 平台鉴权） |

### 4.4 桥接改造（两桥对称）

1. `FALLBACK_MODEL` 分端：daman 桥 `deepseek-v4-pro`，me 桥 `deepseek-flash`（常量，不读环境）。
2. deliver() 对 report 卡注入时，消息头部拼「评审任务头」：

```
【评审任务】对方交了一份报告，你是指定评审方。
评审规则：只提实质问题（事实错/逻辑断/证据缺/风险漏）；没有实质问题就不要输出任何内容（沉默即通过，系统会自动收敛）。
有意见时用工具交卡：node say.mjs review <roomId> --verdict issues "结论/证据/改法"（无 target，默认给对方）。
禁止客套、禁止复述报告内容。
报告全文：
<原文>
```

3. 闲聊与 report 以外的卡不动（现有互投规则保持）。

### 4.5 say.mjs 改造

- `review` 子命令加 `--verdict pass|issues`（默认 issues；pass 卡一行「评审通过」）。
- `report` 子命令加 `--noreview`（逃生口：交活但不触发评审）。

## 5. 收敛状态机

```
open --(review 卡 verdict=pass)--> converged(pass)   [system 卡：X 评审通过]
open --(review 卡 verdict=issues)--> round+1; 对方再交 report 则开新议题
open --(90s NO_REPLY)-------------> converged(silent) [system 卡：X 沉默，按无意见收敛]
open --(round >= roundCap)--------> converged(cap)    [system 卡：已达 3 轮，请群主裁决]
房间 close/archive ---------------> 全部 aborted
```

## 6. 防 AI 垃圾清单

- 评审任务头固定模板，禁客套、禁复述；
- pass 卡一行；silent 收敛卡一行 system；
- 评审注入走 wake 闸门（每日硬上限在）；
- 无新 UI 噪音：评审任务头只进 agent 上下文，不进人眼（卡正文仍人可读）。

## 7. 测试与真人测评

- tests/meeting.test.mjs：open/respond/onSilence/roundCap/越权/room-closed 收敛，隔离实例。
- 全量 run-all + check 无回归。
- live 部署后真人测评（演练房）：小满 CLI 交 report → 台账开议题 → 大满（满血）评审卡 verdict → 收敛卡；全程 bcdp 截图 + 台账/日志证据。

## 8. 取舍（明示）

- 不是物理单 session 共享：评审史只在大满侧累积，小满侧只看到 review 卡结论。收益：不动会话拓扑、保掉线接管；代价：草拟方上下文不含评审过程，若需要可后续把评审全文写入房间记忆（不扩大会话）。
- silent 收敛依赖 90s 观察窗，评审方偶发超时未答会被记「沉默通过」——由群主可见的 system 卡兜底，可人工翻案。
