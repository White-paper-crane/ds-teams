# 聊天优先 v3（Chat-First v3）

> 2026-11-03。v2 的骨架全部保留：dispatch 台账唯一任务真源、gate 验证、control.mjs/control.html、项目空间、scope/brief 隔离 worker。
> 本版把「房间聊天」扶回主界面；控制台退为细节视图。双桥恢复，但按审计报告的五条根因修复。

## 1. 目标形态（用户 2026-11-03 定）

- 两个常驻人格：大满（桌面）、小满（QQ），有人设、有记忆，不是工具人。
- 聊天是主界面：聊着天派活、查进度、要文件；控制台只在想看细节时打开。
- @谁谁接；@两人自然分工；未点名允许闲聊（三人互打趣、她俩互聊），不双回、不刷屏。
- 机器话（“我接 / 让给你 / 收到”）只进日志和台账，不进聊天时间线。
- 交付可信：说完成要带证据；进度说人话，细节进台账（沿用 gate + artifacts）。
- 不掉线：一方断了，另一方发现并接手，不互相等。
- 一个群聊一份隔离记忆；不同群聊=不同会话，任务之间不干扰。
- 两端都能各自拉 subagent，与单个 agent 会话一致（现状已满足，无代码工作）。
- 群聊按需拉起，房间 UI 设计保持（只加记忆面板）。
- 少运维：重启、配置、bug 由两端自理；不可逆/花钱/对外才问群主。

## 2. 服务端 API 契约（v3）

### 2.1 投递：ack 推进游标（修 R1 静默丢消息）

- `GET /api/state?since=N&who=me|daman`：**不再推进游标**。游标只由 ack 推进。
- `POST /api/state/ack`，body `{who, key, seq}`：把该端游标推进到 seq（含）。桥接对每条消息注入成功或判定跳过（含客户端侧 flood 跳过）后立即 ack；hold 期间不 ack，下个 tick 重取重试。
- 服务端永不丢弃任何消息；丢弃策略只存在于桥接端，且**任务卡/报告/复核/文件/系统卡永不丢弃**。

### 2.2 心跳与掉线（修「不掉线」）

- `POST /api/bridge/heartbeat`，body `{who, key}`：写 `db.heartbeat[who]=iso`。
- `GET /api/bridge/status?k=`：返回 `{heartbeat:{me,daman}, down:{me,daman}, downAfterMs:180000, takeoverAfterMs:900000}`。
- 判定：某端见过至少一次心跳，且距上次心跳 >180s → `down=true`；从未见过心跳不算 down（防冷启动误报）。
- patrol 每 60s：若 `down[me]`，daman 名下的 active 任务里 `claimedAt` 早于 15 分钟且 `assignee=me` 的，改 `assignee=daman`，并向任务所在房推一张 kind=system 卡「⚠️ 小满掉线，任务「T-…」转给大满」；对 daman 掉线对称处理。台账写事件 `takeover`。
- 双端都 down：什么都不做（等任一端回来）。

### 2.3 房间记忆（修「一个群聊一份记忆」）

- 存储：`data/memory/<roomId>.jsonl`，每行 `{ts, by, text}`，append-only。
- `GET /api/rooms/:id/memory?k=` → `{roomId, count, entries:[{ts,by,text}]}`（倒序）。
- `POST /api/rooms/:id/memory`，body `{who, key, text}`：text ≤2000 字符，否则 400；房间最多 100 条，超出丢最旧。
- 房间归档时 `data/memory/<roomId>.jsonl` 一起移入 `data/archive/memory/`；restore 时移回。
- `say.mjs memory <roomId> [--text ...] [--list]`：CLI 读写。
- 建群时服务端自动推一张 kind=system 卡，附该房记忆尾 3 条摘要 + 人设摘要（见 2.4），两端都会注入。

### 2.4 人格卡与机器话隔离

- 新增 `data/personas.json`（服务端只读常量）：
  ```json
  {
    "me":    { "name": "小满", "tone": "活泼、直接、短句", "channel": "QQ" },
    "daman": { "name": "大满", "tone": "稳、负责、短句", "channel": "桌面" }
  }
  ```
- 建群时自动推 kind=system 卡：群名、成员、三句规则（@谁谁接/不抢答/闲聊可以、机器话只进日志、交付带证据）。
- 桥接注入白名单：`say / task / progress / report / review / file / system`；**kind=ack 只记日志（action=ack-log），永不注入**。
- claim 仍是带外声明（不进时间线），服务端行为不变。

### 2.5 双端对称（修 R2 双控制面）

- me 端桥接 `CLAIM_ENABLED=true`，与 daman 对称；me 端 claim 成功也写 claim 事件。
- 未点名 say：两端都可 claim（token 小者赢），输方 skip(reason=claimed-peer) 并 ack。
- @me 只 me 接、@daman 只 daman 接、@两人两端都接（沿用现有 relevant 规则）。
- **对方的话只有点名才投**（2026-11-04 修 token 燃烧）：peer 消息默认不注入、不唤醒对端（PRD「AI 间不自动对话」）。两个例外照投：①正文点名我（MY_RE）；②结构化产物卡 report/review/progress/file（低频高价值，保留「方案互相反驳与补充」通道）。@对方 是让对端醒来的日常方式；task 卡走 assignee 分支。
- busy hold 保留，但同一条消息 hold 连续超过 60s 时，允许另一端 claim 接手注入（token 机制不变，只是把 claim 范围从「歧义消息」扩到「被 hold 超时的卡」）。

## 3. 桥接改动清单（两端对称）

1. 每 tick 先发 heartbeat。
2. 拉 `GET /api/state?since=cursor`；逐条处理；注入成功/判定跳过 → `POST /api/state/ack`；hold → 不 ack。
3. 丢弃策略：只对 kind=say 做 flood 上限（同房 5 条留最新）；kind in {task,progress,report,review,file,system} **永不丢弃、永不 backlog-skip**。
4. kind=ack → 写日志 ack-log，不注入。
5. me 端 claim 开启，claim 事件对称写。
6. 心跳失败/服务端 5xx 连续 3 tick → 写 error 日志并指数退避（2s→4s→8s…上限 30s），恢复后回到 2s。
7. 保留 busy watchdog（15s 复位）、cooldown、attach。

## 4. UI 改动（最小）

- 房间页加「记忆」面板：列表（倒序）+ 输入框（who 从登录态来，POST memory）。
- 其余房间设计不动；控制台入口已有，降为细节视图（文案改「细节」）。

## 5. 明确不做

- 不重写房间 UI；不加消息总线的持久化中间件（服务端 rooms.json 已是持久层）。
- 不做跨模型异构审查（本机只有 deepseek-flash）。
- 不改 dispatch 台账唯一真源地位；project_state 仍只读派生。
- 不做 A2A/MCP；房间仍是 HTTP + 轮询（2s，带退避）。

## 6. 验收

1. `node tests/run-all.mjs` 全绿（含新增 server-v3 用例）。
2. `node check.mjs` 10 PASS 起（v3 后可能增加项）。
3. 实测：两桥心跳出现、ack 出现；任务卡从 say.mjs 发出后两端日志出现 inject（不丢卡）；me 端 claim 事件可见；ack 卡不进时间线。
4. 掉线演练：手动停 me 桥 → daman 端 3 分钟内收到 takeover 系统卡、台账 assignee 转移。
5. 记忆演练：建测试房 → POST memory → GET 可见 → 归档后 memory 文件随房间进 archive。
6. 控制台仍 200，台账/CLI/gate/scope 功能不回归。

## 7. 实施结果（2026-11-03 22:45 已落地）

- 状态：✅ 已落地。live 双桥 22:36:04 reload 后心跳齐报；`/api/bridge/status` 200。
- 验收 3 ✅：room-6bd6ac 真实演练——群主发任务卡 `T-V3-DELIVER`（assignee=me）→ 小满桥 inject → 小满 claim 拆 s1/s2 → 子代理出报告 → done+review pass（约 90s）；两端 cursor 均 ack 到 3246；flood 只压 say，六种卡未见丢弃；ack 卡未进时间线。
- 验收 5 ✅：room-6bd6ac POST memory 2 条 → GET 可见 → 解散归档后 `data/archive/memory/room-6bd6ac.jsonl` 随房归档。
- 验收 4（部分）：心跳 backdate 10min → `/api/bridge/status` down.me=true，恢复后 false；真实 15min 转派逻辑由 `tests/server-v3.test.mjs` 隔离实例覆盖（400ms patrol 实测 assignee 转移+system 卡）。
- 验收 1/2/6 ✅：`# tests 33 / # pass 33 / # fail 0`；`check.mjs` 10 PASS/0 WARN/0 FAIL；`/control` 200、CLI/gate/scope 不回归。
- 现场修正：两端 agent 在验收中自发把 system 卡改成白名单（只投 ⚠掉线/转派类，建群公告不注入回合），已从 live 同步回仓库。
- 未做（明示非目标）：跨模型异构审查；消息总线中间件；房间 UI 重写。
