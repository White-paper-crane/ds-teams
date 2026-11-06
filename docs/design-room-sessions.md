# 每房一对新会话（Room-Session Pair）设计稿

> 2026-11-04｜状态：设计，未实现｜结论：**不建议现在全量推**（§7）｜动手前先读 docs/chat-first-v3.md、docs/meeting-room.md

## 1. 现状与卡点

| # | 卡点 | 代码位置 | 为什么不能只改一个常量 |
|---|---|---|---|
| 1 | 会话 id 硬绑 | plugins/ds-teams-bridge.mjs:34（DAMAN）、plugins/ds-teams-bridge-me.mjs:30（ME） | 常量被四处共用：meSessionId():236-244、resumeWithContext():247-262、liveAgent():264-278、keepWarm():280-287，全部按「唯一会话」写 |
| 2 | 回退逻辑会选错会话 | ds-teams-bridge.mjs:236-244；ds-teams-bridge-me.mjs:213-215 | 找不到原会话时取 mtime 最新的目录；新建的房会话最新 → 主会话消息全投进房会话 |
| 3 | 游标/事件日志单例 | ds-teams-bridge.mjs:30 CURSOR_FILE、:32 EVENT_LOG | 一个 cursor 文件对应一个会话；多会话要 per-(who,room) 游标 |
| 4 | 忙闲状态单值 | ds-teams-bridge.mjs:90-92 busy/lastInject | 一个 busy 管一个 agent；A 房忙会把 B 房的注入按住 |
| 5 | 每消息固定取同一 agent | ds-teams-bridge.mjs:477 `liveAgent(meSessionId())` | 注入目标不按 roomId 选，改常量也没用 |
| 6 | 服务端游标是 who 级 | server.mjs:564-577（ack 只前进）、:556-563（state 返回全部房消息） | 多房共用一条 seq 流；某房 hold 就不能抬游标 → 必须改低水位 ack |
| 7 | 评审场契约冲突 | docs/meeting-room.md:22（daman 会话兼评审场，评审史集中） | 每房新会话 = 评审史分散，cache 前缀从「一份」变「每房一份」 |

## 2. 目标形态

### 2.1 切分

| 层 | 职责 | 形态 |
|---|---|---|
| server.mjs | 房间/消息/记忆真源 | 不改（可选：加只读 `/api/room-sessions`） |
| 调度器 `plugins/ds-teams-host.mjs`（新，单插件） | 房生命周期观察、room→session 映射、分发、低水位 ack、归档 | 一个插件，persona 双槽（daman/me），取代两个单例桥 |
| 会话池 | 每房每端一个 DSH session | 常驻上限 K=4 房，超出 LRU 只 dispose 不归档 |
| 旧桥 | 回退 | 开关 `ROOM_SESSIONS=off` → 走旧 DAMAN/ME 单例路径 |

合并理由：两桥本就在同一 host、同一 cordis.patch.yml（改动记录.txt:59），gen/定时器可一处管。迁移期可先改 daman 桥、再复制 me（对称代码已在 test/v3 两处验证过）。

### 2.2 房↔会话映射台账 `data/room-sessions.json`（tmp+rename 落盘，同 meeting-state 做法）

```jsonc
{
  "version": 1,
  "gen": 6,
  "rooms": {
    "room-9f3a1c": {
      "roomId": "room-9f3a1c", "title": "…", "status": "live|closed|archived|failed",
      "openedAt": "ISO", "closedAt": null, "archivedAt": null,
      "ends": {
        "daman": { "sessionId": "session-<uuid>", "createdAt": "ISO", "status": "live|archived|failed",
                   "lastInjectSeq": 3246, "lastAckSeq": 3240, "lastError": null },
        "me":    { "sessionId": "session-<uuid>", "createdAt": "ISO", "status": "live",
                   "lastInjectSeq": 0, "lastAckSeq": 0, "lastError": null }
      }
    }
  }
}
```

| 字段 | 用途 |
|---|---|
| ends.<who>.sessionId | 唯一入口；`session-` 前缀 + UUID（对齐 dsh-proactive/lib/wake.js:645） |
| status（房级 + 端级） | 房级跟 server rooms.status（server.mjs:520-534/810）；端级记会话自身死活 |
| lastInjectSeq | 幂等：重放同 seq 不重投（替代现在的全局 cursor 文件） |
| lastAckSeq | 低水位 ack：`ack = min(所有 live 房 lastAckSeq)`，hold 的房不抬高水位 |
| lastError | 排障（建会话失败/preset mount 失败/归档被拒） |

## 3. 建/关房流程

### 3.1 开房（调度器见 room.status=open 且台账无记录 → 建）

| 步 | 动作 | 依据 |
|---|---|---|
| 1 | 生成 `sessionId = "session-" + crypto.randomUUID()` | wake.js:645 同款 |
| 2 | `const handle = await ctx.get("agents").create({ sessionId, agentOptions: { provider: "tokenrocks", model: "deepseek-v4.1-flash" }, setup: (agentCtx, agent) => ctx.get("agentPresets")?.mount(agentCtx, "standard"), meta: { cwd: WORKSPACE, agentPreset: "standard" } })` | CreateFacadeOptions 签名见 dsh-proactive/lib/wake.d.ts:152-163；调用样例 wake.js:646-652；返回 AgentHandleLike{agent, dispose()}（wake.d.ts:164-168） |
| 3 | `meta.cwd` 必须等于现有会话的 cwd | SESS_ROOT 是按 cwd 编码的目录名（ds-teams-bridge.mjs:33）；cwd 不同 → 会话落到别的目录，桥扫不到。最容易踩的一脚 |
| 4 | 写台账（先写再投递），status=live | 避免建完会话没记账 → 重挂载重复建 |
| 5 | seed 三件：人设、群规则、房记忆尾 N 条 | 人设 data/personas.json（chat-first-v3.md:44-52）；记忆 `data/memory/<roomId>.jsonl`（server.mjs:541-544 readMemory 同源，取尾 3 条） |
| 6 | me 端重复一遍 | 两端当前同为 tokenrocks/deepseek-v4.1-flash（ds-teams-bridge.mjs:40-41） |

seed 投放方式（二选一）：
- A `seed: SessionEvent[]`：零额外 turn，最省；事件形状**待核实**（§8）。
- B 把简报拼进该房「首条注入消息」头部（沿用 ds-teams-bridge.mjs:572 的 followup 路径）—— 确定可行，**推荐**。简报模板（≤1.5K tok，逐字节固定）：你是谁/在哪房/规则三句（chat-first-v3.md:53）/记忆尾 3 条/回话命令 `node say.mjs say <room> "..." --who <me>`（同 ds-teams-bridge.mjs:545）。禁止放时间戳或序号，否则每次开房都 miss。

### 3.2 关房（close → archive）

服务端：close 只有群主（server.mjs:803-815，只置 status=closed，数据保留）；archive 要求先 closed（server.mjs:844-852）→ 房间 JSON + data/memory/<roomId>.jsonl 进 data/archive/（server.mjs:277-291）。会话侧顺序敏感：

| 步 | 调用 | 依据 |
|---|---|---|
| 1 | `await handle.dispose()` | AgentHandleLike.dispose()（wake.js:672-676 同款用法）；先停 turn/子代理/后台任务 |
| 2 | `await ctx.get("workspaceController").archiveSession({ sessionId, stopActivity: true })` → `{ archivedSessionIds }` | asar 内 zod schema：入参 `{ sessionId: string, stopActivity?: boolean }`；不传 stopActivity 且会话活跃 → 拒绝 `workspace/session-active` |
| 3 | 台账 status=archived/archivedAt；重复关房只补状态 | 幂等 |
| 4 | **不要移动或删除会话目录** | 归档只写 `workspace.json` 的 `global.archivedSessionIds`（~/.dsh\storages\workspace.json:12-37）；改动记录.txt:10-15 实测：只改文件不生效，必须走宿主 API |

还原：`unarchiveSession({ sessionId })`（先例见改动记录.txt:12）；房侧 `POST /api/archive/:id/restore`（server.mjs:688-697）。

## 4. 成本模型

| 项 / 场景 | 值 | 依据（口径） |
|---|---|---|
| 工具 schema | 78,944 B / 85 个 | session-5ce7f79a… 首条 `request/header.data.header.tools`（本机会话日志按 zstd 块头解码） |
| 系统提示 | 8,085 字符 | 同会话首条 `system/message` |
| 静态前缀估算 | **≈22–26K tok** | 英文按 3.6 B/tok：78,944/3.6≈21.9K；中文按 1.4 字/tok：8,085 里的中文≈2.4K。启发式口径，误差 ±20% |
| 房简报 seed | 0.5–1.5K tok | 人设+规则+记忆尾 3 条（§3.1 模板） |
| 开房首轮 | 一次性 ≈24K miss tok | 新会话前缀零命中，全按 miss 计价 |
| 第 2..N 轮 | ≈0 | 前缀逐字节稳定（工具/系统提示/简报位置固定）→ 命中 |
| 跨缓存 TTL 后再开口 | 再付 ≈24K | DeepSeek 前缀缓存有 TTL（小时级，具体值**待核实**） |
| 摊销 | 24K / N 轮 | 一房 20 轮 ≈1.2K tok/轮，约占每轮上下文的 2%（按 50–100K 上下文口径） |
| 钱（量级） | ≈$0.0065/房 | 假设 miss $0.27/M（flash 官网价口径）；单价**待核实**（§8） |
| 命中价 | miss 的 1/30–1/50 | docs/meeting-room.md:15 |
| 并发成本 | M 房 × 2 个常驻 agent | 内存与启动开销线性上升，比 token 更先撞墙 → 常驻上限 K=4 |

结论：token 成本不是阻碍项（一房一美分级，且只在开房首轮）。真正的账是「同时活跃 M 房 = M 份缓存条目 + 2M 个常驻 agent」。

## 5. 最小验证路径（单房灰度，不动 server、不改 ack 语义）

| 步 | 动作 | 通过标准 |
|---|---|---|
| 1 | 一次性插件调 `agents.create` 手动建 2 个会话（不经桥），手写台账一行 | 两个 `session-*` 目录出现在 SESS_ROOT；各自首帧是 `system/message`；`workspace.json` 的 `sessionIds` 含二者（待核实项） |
| 2 | 桥接只改「取哪个 id」：`sessionFor(roomId)` 命中台账用房会话，未命中走旧 DAMAN（替换 ds-teams-bridge.mjs:250 的 id 来源） | 未映射的房行为零变化（回归） |
| 3 | 开测试房 room-test01，群主发 3 条（say 点名 / task / report） | 新房会话出现 3 次注入；旧 DAMAN 会话 `request/header` 计数不增 |
| 4 | close → archive 两步，校验归档 | 两 id 进 `workspace.json` 的 `archivedSessionIds`；再对已归档会话 followup → 被 gate 拒、无新 turn（改动记录.txt:10-12 同现象） |
| 5 | 回滚演练 `ROOM_SESSIONS=off` + 重挂载（patch 内容必须变，改动记录.txt:61-62） | ≤30s 恢复旧单例，台账原样不动 |

验收硬指标 4 条：①隔离（旧会话零新增 turn）；②不丢（三张卡全进新房会话，ack 后不重放）；③归档（关房后无新 turn、归档集合含 2 个 id）；④回滚（开关一次 ≤30s 生效）。

## 6. 风险与回滚

| 风险 | 具体表现 | 处置 |
|---|---|---|
| 热重挂载 | 新实例拿旧 handle → 双投/双轮询；旧实例 handle 未 dispose 留在 registry | 沿用 gen 递增（ds-teams-bridge.mjs:67-73）；重挂载后一律 `agents.get(id)`，取不到就 resume，绝不复用旧 handle |
| gen 碰撞 | 两插件共用 `Symbol.for("ds-teams-bridge.gen")` 名会互相顶掉 | 键名带端别：`ds-teams-host.gen.daman` / `.me` |
| 旧会话残留 | 房已关会话还在 SESS_ROOT，回退逻辑（:236-244）会选它 | 归档 + 台账；回退逻辑加「跳过 archivedSessionIds」白名单 |
| ack 丢消息 | 多房共用 who 级游标，A 房 hold 卡住 B 房 | 低水位 ack：`min(各 live 房 lastAckSeq)`；先只有 1 房时可暂不改 |
| 内存/启动 | 5 房 = 10 个 agent | 常驻上限 K=4，LRU 只 dispose（不归档，下次 resume） |
| 评审场退化 | 评审史每房一份，跨房不共享；cache 前缀从 1 份变 M 份 | 明示取舍（接受）或让评审仍回主会话——与 meeting-room.md:22 二选一，需用户拍 |
| 唤醒/年龄 | 每消息 1 次 admit，`dailyLimit` 200/端（protocol.mjs:86）不随房数涨；但 `contextAgeThreshold` 500（:87）按会话算，多房后几乎不再触发 | 预算不用改；年龄软告警失效，改用每房 lastInjectSeq 计数 |

回滚：台账房级 `status:"paused"` + 开关关 → 全部走旧单例；会话不删不挪（归档本身就是回滚友好的资料保全）。

## 7. 结论：**不建议现在全量推**

理由三条：
1. 痛点还没发生：当前只有 1 间 open 房（改动记录.txt:34），「记忆互串」没有真实事故证据。
2. 关键路径上的宿主行为未验证：`agents.create` 在热进程内建会话 + `agentPresets.mount`、`archiveSession` 的真实 gate 行为，本机都没跑过（签名已确认，行为未验）。
3. 改造面横跨桥接调度 / 游标 / 唤醒 / 评审四处，回归面大于收益。

建议路径：按 §5 单房灰度（约一天工作量），拿到「隔离生效 + 归档生效 + 回滚 ≤30s」三条证据后，再决定是否推全房。

## 8. 待核实清单

| 项 | 怎么核实 |
|---|---|
| `seed: SessionEvent[]` 的事件形状 / `isSeeded` 语义 | 建一个测试会话，读 `<SESS_ROOT>/<id>/session.v4.jsonl.zstd` 首帧（逐行独立 zstd 帧，需按块头解析） |
| `create` 是否自动登记 `workspace.sessionIds` | 建会话后看 ~/.dsh\storages\workspace.json 的 `tables.workspaces[].sessionIds` |
| `archiveSession` 对活跃 turn 的真实行为 | 测试会话跑长任务时归档，看返回是否 `session-active`、是否杀掉 turn |
| DeepSeek 前缀缓存 TTL | provider 文档，或用 .dshw-usage.json 连续两天的命中率反推 |
| flash 单价 | tokenrocks 控制台账单 |
