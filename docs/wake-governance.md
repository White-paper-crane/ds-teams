# 唤醒治理（wake governance）设计契约

生成 2026-11-04。依据：群主 PRD（m03652）+ `docs/唤醒与沉默消耗-问答.md`。
目标：唤醒（= 一次 followup 注入 = 一个 turn）从「房间侧不可见」变成可审计、可预算、可对账的事件。判定路径保持零模型调用。

## 1. 不变式（继承 v3）

- 判定 = 纯规则（relevant / claim / busy / cooldown），0 token；本条不引入任何模型调用。
- 一条消息最多唤醒 1 个会话；at-most-once：游标推进后同 seq 不再注入。
- 桥接判定后、注入前新增唯一一道服务端闸门（admission）；被拒唤醒不产生任何 Harness 调用。
- 所有协作必须有文件产物；变更写 changes.txt；删除=移 trash；测试全量。

## 2. 角色分工

| 层 | 职责 | 禁止 |
|---|---|---|
| 桥接（判定+执行） | relevant/claim/busy/cooldown 判定；注入前调 admit；注入后 settle | 判定路径不得调模型 |
| 服务端（编排闸门+台账） | 预算计数、wake_id 签发、台账持久化、对账查询 | admit 路径不得调模型 |
| 日检脚本 tools/wake-audit.mjs | 双向对账 turn_count vs inject_count | 只读 |
| 房间 UI | 显示当日唤醒计数/预算、HIGH_CONTEXT_AGE 角标 | 只读展示 |

## 3. 数据模型（data/wake-state.json，服务端新文件）

```json
{
  "injectTotals": { "me": 0, "daman": 0 },
  "days": {
    "2026-11-04": { "me": { "count": 0, "blocked": 0 }, "daman": { "count": 0, "blocked": 0 } }
  },
  "wakes": {
    "<wakeId>": {
      "wakeId": "w-<seq>-<who>-<4hex>", "at": "ISO", "who": "me|daman",
      "seq": 123, "roomId": "...", "kind": "text",
      "allow": true, "blockReason": "COUNT" | null,
      "outcome": "REPLIED|NO_REPLY|MONOLOGUE|ERROR" | null, "outcomeAt": "ISO" | null
    }
  }
}
```

- 只保留最近 500 条 wakes（超出丢最旧）；injectTotals 与 days 永不清。
- wakeId 主键；seq 仅作展示顺序（PRD §7.1）。
- 写入走 tmp+rename（同 dispatch-lib 风格），无文件锁（单 server 进程前提，沿用现状）。

## 4. API（server.mjs 新增；鉴权：?k= 平台 key + body.key 成员 key，与现有端点一致）

1. `POST /api/wake/admit` body `{who,key,seq,roomId,kind}`
   - 校验 member key；今日计数 count >= WAKE.dailyLimit → `{ok:true, allow:false, reason:"COUNT", budget}`，days[day][who].blocked++，wakes 记 allow:false/blockReason:COUNT，**返回后桥接 ack 并终止，不注入**。
   - 放行：days count++、injectTotals++、签发 wakeId、wakes 记 allow:true → `{ok:true, allow:true, wakeId, budget:{used,limit}, highContextAge:bool}`
   - 幂等：同一 `(who,seq)` 已 admit 过 → 返回既有结果（重复 tick 不重复计数）。`seq<=0` 的注入（如 promote nudge，kind="nudge"）不做幂等，每次签发新 wakeId，同样计预算。
2. `POST /api/wake/settle` body `{who,key,wakeId,outcome}` — outcome ∈ REPLIED|NO_REPLY|MONOLOGUE|ERROR；只允许目标 who 回填自己；outcome 已存在则不覆盖（先到先得）；返回 `{ok:true}`。
3. `GET /api/wake/state?date=YYYY-MM-DD`（平台 ?k= 即可）→ `{ok, day, days, injectTotals, highContextAge:{me,daman}, wakes:[最近 50 条倒序]}`。
4. `GET /api/bridge/status` 增补 `wake: {injectTotals, highContextAge, today:{me:{used,limit,blocked}, daman:{...}}}`（零额外模型调用）。

## 5. 常量（protocol.mjs 新增 `WAKE`，环境变量可覆盖）

```js
export const WAKE = Object.freeze({
  dailyLimit: 200,            // 每端每日唤醒次数硬上限（WAKE_DAILY_LIMIT 覆盖）
  contextAgeThreshold: 500,   // 累计注入次数 >= 此值 → HIGH_CONTEXT_AGE
  softTokenPerTurn: 40000,    // token 软阈值估算用（历史均值/回合）
  softTokenDailyLimit: 8000000, // 每日估算 token 软阈值：超过只告警不阻断
  outcomeWindowMs: 90000,     // 注入后观察窗口：90s 内本端无房内输出 → NO_REPLY
});
```

## 6. 桥接改造（两个文件对称）

判定顺序不变：ack-skip → claimed-peer → busy → cooldown → claim → **admit** → followup。

- admit 只在实际注入前调用一次（busy/cooldown 时 hold 不 admit，不虚增计数）。
- `adm.allow === false` → `evt({action:"wake-blocked", reason:"COUNT", seq, ...})`，return true（视为已处理，ack，0 注入）。
- followup 抛错 → `settle(wakeId, "ERROR")`，原有 error 事件保留。
- **promote nudge 也过闸**：nudgePromoted 的 followup 同样先 admit（seq=-1, kind="nudge"）再注入；被阻则 evt wake-blocked 且不注入。
- 注入成功 → evt 带 wakeId；启动 outcome watcher（定时器，dispose 时停）：
  - 记注入时本端在房间的最大 seq 基线；
  - 每 2s 拉 /api/state，若出现 who===WHO 且 seq>基线 的房内消息（say/report/progress/review/ack 均可，不含 system）→ settle REPLIED 并停止；
  - 超过 outcomeWindowMs 无输出 → settle NO_REPLY 并停止。
  - 每端同时最多 1 个 watcher（新注入替换旧的：旧 wake 直接 settle NO_REPLY 并注明 superseded）。
- MONOLOGUE 判定降级：桥接看不到会话回合输出，MVP 不单独判「（继续听，不插嘴）」；它若没在房间说话即 NO_REPLY（PRD §8 允许回填失败降级；若日后宿主暴露回合输出 API 再升级）。wake-audit 对账可辅助发现 MONOLOGUE 型沉默消耗（turn 增了但 inject 外无房内回复）。
- dispatch_decision 显式化：WOKEN = admit allow:true（台账有）；SILENT_NOT_TARGETED / SILENT_CLAIM_LOST / SILENT_NO_WAKE_SWITCH = 桥接日志已有 skip(reason=not-relevant/claimed-peer/flood) 事件；WAKE_BLOCKED_BY_COUNT = wake-blocked 事件 + 台账 blockReason。不新增房间消息字段。

## 7. tools/wake-audit.mjs（日检，只读）

- 输入：服务端 `GET /api/wake/state`（或直读 data/wake-state.json）+ 两个 session 的 turns 计数：
  - 大满：`<dsh-sessions>\<session-id>.json`（或参数指定）
  - 小满：同目录下按 mtime 最新的 `onebot-private-*` 目录内同名 json
  - turns 字段与用法见 2026-11-03 token 审计（turns=348、steps=2391 之类；usage.cacheRead 等）。字段缺失要报，不猜。
- 输出（`node tools/wake-audit.mjs [--date YYYY-MM-DD] [--json]`）：
  - 今日/指定日：inject_count（台账 allow:true 数）、blocked_count、outcome 分布（REPLIED/NO_REPLY/MONOLOGUE/ERROR/未回填）。
  - turnDelta = 当日 session turns 增量；inject_count − turnDelta > 0 → 疑似丢失注入样本；turnDelta − inject_count > 0 → 疑似未归因唤醒样本（列 wakeId/时间/两端谁）；差值非零列出样本 ID，人工判定类型（外部直接 turn / 回填失败 / 真隐藏消耗）。
  - HIGH_CONTEXT_AGE / 当日剩余预算。
  - exit 0 正常；差值非零 exit 1（供定时任务告警）。

## 8. UI（小改，ui.html）

- 房间 header 加唤醒状态 chip：`唤醒 me X/200 · daman Y/200`，HIGH_CONTEXT_AGE 时变黄加 title；数据从 `GET /api/wake/state`（5s 随现有刷新一起拉，失败静默）。仅展示，不做阻断交互。

## 9. 验收（对照 PRD 六节，测试化）

1. 仅判定不唤醒：inject 0、wake 台账无新增（现有测试覆盖 + 新增断言）。
2. 同 seq 重复投递 10 次 → admit 幂等，count 只 +1。
3. 未 @ 未命中：连续 tick inject_count=0（现有 skip 测试覆盖）。
4. claim 输家 0 注入：现有 claim-api/route 测试覆盖，台账无该 seq 的 allow:true。
5. 日限额用尽：后续 admit 全部 allow:false/COUNT，0 模型调用（新增测试：隔离实例小限额）。
6. wakeId 贯穿：admit → evt → settle → wakes 条目可查（新增测试）。
7. settle 幂等、outcome 合法值校验、跨 who 回填拒绝（新增测试）。
8. wake-audit 对账：构造夹具台账+session turns 差值，脚本输出样本并 exit 1（新增测试）。
9. HIGH_CONTEXT_AGE：injectTotals 超阈值后 /api/bridge/status 与 wake/state 标记（新增测试）。

## 10. 非目标 / 降级

- 不做语义去重、不做 bot-to-bot 自动对话、不做注入重试（PRD 已排除）。
- 预算被阻 = 已处理（ack 推进游标），不阻塞后续消息。
- token 软阈值只进 budget 展示与 wake-audit 提示，不阻断（PRD：次数硬闸、token 软）。

## 11. 实施顺序

1. protocol.mjs WAKE 常量 + wake-lib.mjs + server.mjs 四端点 + tests/wake.test.mjs（先服务端，隔离实例可测）。
2. 双桥 admit/settle/watcher（对称改，改完 node --check + 对照 diff）。
3. tools/wake-audit.mjs + 夹具测试。
4. ui.html chip。
5. live 部署（复制插件 + touch reload）、真人一轮验证（注入一条看台账 wakeId/outcome）。
6. changes.txt / 改动记录.txt、tests/run-all、check.mjs、git commit。

## 12. 实施结果（2026-11-04 已落地）

- 服务端：protocol.mjs WAKE 常量；wake-lib.mjs 205 行；server.mjs +42（admit/settle/state 三端点）；tests/wake.test.mjs 8/8。
- 双桥：daman 桥 824 行 / me 桥 705 行，admit 闸门对称、outcome watcher 对称；nudge 过闸仅 daman 端（v3 既有不对称，契约允许）。
- 工具：tools/wake-audit.mjs（--date/--json，双向对账 exit 0/1/2）+ tests/wake-audit.test.mjs 11 用例。
- 测试：run-all 52/52（wake 8 + wake-audit 11 新增，其余无回归）。
- live：8792 重启 pid 19316；两桥复制到 live plugins；live cordis.patch.yml 追加注释行（内容变更）触发重挂载。教训：只 touch 不改内容，宿主不重挂插件。
- 真人实测（room-8d102a，已解散）：@小满/@大满各一发 → 台账 4 条 admit、3 条 REPLIED、1 条未到 90s 窗口；wake-audit 正确报出 me 端 turn 多出注入 2（对端消息注入的 turn 按被唤醒端口径未归因——工具按设计暴露差异，后续对齐口径或人工认读）。
- 已知边界：daman 是长寿会话，turns 无当日基线时 turnDelta 标注「不可测」不猜；MONOLOGUE 判定降级（桥接看不到回合输出，没在房间说话即 NO_REPLY）。

## 13. 评审端延迟告警（2026-11-04 已落地）

目的：把「评审等太久」从主观感受变成可查的记录。房间头部一个 chip 就能看、能一键关。

- 口径（路 A，可归因）：`reviewLatencyMs(issue)` = 本轮起点 → `issue.updatedAt`。
  - 返工轮（`rounds.length >= 2`）起点取 `rounds[len-2].at`；
  - 否则取 `issue.reportTs`（`meeting-lib.open()` 在开议题时固化，**不能**回头查 report 卡：归档会清主库消息）；
  - 最后才回查 `db.messages`。
  - 路 B（真端到端，含 busy 排队）在 `wake-state` 的 `at → outcomeAt`，NO_REPLY 恒等 90s 会成噪声，故只用于体检、不用于告警。
- 阈值：默认 `thresholdMs = 120000`。必须 > `WAKE.outcomeWindowMs`（90s），否则「沉默通过」会被误记成慢——这是沉默链路接同一处 warn 的代价，用阈值而非豁免来隔离。
- 存储：`data/settings.json`（`{reviewLatency:{enabled, thresholdMs}}`）、`data/ops-events.jsonl`（超 2MB 裁到 2000 行）。
- API：`GET /api/settings`、`PATCH|POST /api/settings`（enabled 必须 boolean、thresholdMs 限 1000..3600000，非法 400）、`GET /api/ops/events?n=&code=`（n ≤ 200）。
- UI：房间头 `#latencyChip`，点击翻转 enabled（PATCH），5 秒节流刷新，按**本地日**计数，文案随阈值在「秒」「分」间自适应。
- 巡检：`check.mjs` 第 7 段 `review-latency`（只读本地文件，服务没起也能跑）：关掉→PASS；阈值 ≤ 沉默窗口→WARN；今日 ≥5 条→WARN 并报最慢值与评审端。
- 测试：`tests/settings.test.mjs` 29 断言、`tests/ops.test.mjs` 39 断言。
- 阈值敏感性（9 条可算样本）：20s→5 条、45s→3、60s→3、90s→2、120s→1（只抓 141s 长尾）。

## 14. 每房一对新会话（P2 单房灰度，2026-11-04 已落地）

动机：闲聊首字 8–16s 的真因是**会话上下文规模**（seq=5006 那次：模型耗时 14.38s，其中 132K 输入 prefill 占绝大部分；桥侧开销不到 1s）。glm-5.3 prefill 比 flash 慢 2–2.5 倍（73.5K 中位 8251ms vs 4100ms），但换模型不是主因。每房一对新会话能把首字拉回 2–3s。

- 台账 `data/room-sessions.json`：`{version, enabled, rooms:{<roomId>:{title, ends:{daman:{sessionId}, me:{sessionId}}}}}`。5 秒缓存。
- 桥：`roomSessions()` + `sessionFor(roomId)`；注入点 `liveAgent(sessionFor(m.roomId))`；`meSessionId()` 的 mtime 回退扫描**排除**房会话；me 端 `archGuard()` 把房会话一并保活。
- **BOM 坑（实测踩到）**：`Set-Content -Encoding UTF8`（PS 5.1）会写 `EF BB BF`，`JSON.parse` 抛错被 catch 吞掉 → 灰度看起来生效其实没生效。已改成剥 BOM 后再解析，daman 端解析失败还会打日志。
- 回滚：`enabled:false`，≤5 秒全线回落共用会话，**不需要重挂载**。
- 实测（room-c6abbf）：主会话对房间密钥串 0 命中、房会话 8 命中；回滚后主会话 7 命中、房会话 0 命中；两端对称可正常回话。
- 未做：运行时 `agents.create` 自动建会话（`create` 后必须 append/flush 才落盘，否则桥 resume 抛 `SessionPersistenceNotFoundError`）；本轮用已有小会话充当灰度端会话。

## 15. 断桥遗留 wake 兜底回收（2026-11-04 已落地）

问题：桥进程断线/重挂载会丢掉 outcome watcher，wake 台账就留下 `outcome:null` 的孤儿条目。对账时会被当成「未回填」，也污染 `wake-audit` 的窗口统计。

- 判定证据（不调模型）：该 wake 所在房间内，`who` 与本端相同、`seq > wake.seq` 的最早一条输出，`ts − wake.at <= outcomeWindowMs` → `REPLIED`，否则 `NO_REPLY`。房间已归档时回落到 `data/archive/<roomId>.json` 里的消息快照。
- 触发：`sweepStale()` 挂在服务端 `patrolOnce()` 里（默认 60s 一次），只处理 `allow:true` 且已过 `outcomeWindowMs + WAKE_REAP_GRACE_MS`（默认 30s）的条目；已回填的跳过（先到先得），`allow:false` 的不动。
- 标记：回收的条目写 `outcome`/`outcomeAt`，并置 `reaped:true`，便于和桥端真实回填区分。
- 一次性补账：`tools/_reap.mjs`（`--dry` 预览）对现存遗留条目跑同一套判定；本次清掉 5 条（3 条 NO_REPLY、2 条 REPLIED），原文件备份在 `Desktop\trash\2026-11-04\wake-state.json.bak-before-reap`。
- 测试：`tests/wake.test.mjs` 新增 2 例——纯函数注入假读写覆盖「窗内 REPLIED / 超窗 NO_REPLY / 未到窗口不动 / 已回填不覆盖 / 空转不写盘」，以及隔离实例里 `WAKE_OUTCOME_WINDOW_MS=300` 后由 patrol 自动落 `NO_REPLY` 且带 `reaped:true`。

