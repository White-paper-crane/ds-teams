// ds-teams · 唤醒治理台账（服务端，docs/wake-governance.md §3/§5）
// 唯一事实源：data/wake-state.json（可用 DS_TEAMS_DATA_DIR 或 DS_TEAMS_WAKE_STATE 覆盖，测试用）。
// 职责：预算计数、wakeId 签发、outcome 回填、对账查询。判定路径零模型调用。
// 纪律：写入 = tmp + rename（同 dispatch-lib）；wakes 只保留最近 500 条；days/injectTotals 永不清。
// 单 server 进程前提：无文件锁（沿用现状）。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WAKE, WAKE_OUTCOME_SET } from "./protocol.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DS_TEAMS_DATA_DIR || path.join(ROOT, "data");
const STATE_FILE = process.env.DS_TEAMS_WAKE_STATE || path.join(DATA_DIR, "wake-state.json");

// wakes 台账只保留最近 500 条；state 接口只吐最近 50 条。
const WAKES_MAX = 500;
const STATE_WAKES_MAX = 50;
const WHO_LIST = ["me", "daman"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function freshDb() {
  return { injectTotals: { me: 0, daman: 0 }, days: {}, wakes: {} };
}

function normalizeDb(j) {
  if (!j || typeof j !== "object") return freshDb();
  return {
    injectTotals: j.injectTotals && typeof j.injectTotals === "object" ? j.injectTotals : {},
    days: j.days && typeof j.days === "object" ? j.days : {},
    wakes: j.wakes && typeof j.wakes === "object" ? j.wakes : {},
  };
}

// 可注入的读写（纯函数式：测试可传假 read/write，不碰磁盘）。
export function readState() {
  try {
    return normalizeDb(JSON.parse(fs.readFileSync(STATE_FILE, "utf8")));
  } catch {
    return freshDb();
  }
}

export function writeState(db) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = STATE_FILE + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
  fs.renameSync(tmp, STATE_FILE);
}

// 本地日期键 YYYY-MM-DD（days 的 key 口径，与契约示例一致）。
function todayKey(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function ensureDay(db, day) {
  if (!db.days[day] || typeof db.days[day] !== "object") {
    db.days[day] = { me: { count: 0, blocked: 0 }, daman: { count: 0, blocked: 0 } };
  }
  for (const who of WHO_LIST) {
    if (!db.days[day][who] || typeof db.days[day][who] !== "object") db.days[day][who] = { count: 0, blocked: 0 };
    db.days[day][who].count = Number(db.days[day][who].count || 0);
    db.days[day][who].blocked = Number(db.days[day][who].blocked || 0);
  }
  return db.days[day];
}

function total(db, who) {
  return Number(db.injectTotals && db.injectTotals[who]) || 0;
}

function isHigh(db, who) {
  return total(db, who) >= WAKE.contextAgeThreshold;
}

// wakes 超出上限时丢最旧（按 at 升序，保留最后 WAKES_MAX 条）。
function pruneWakes(db) {
  const entries = Object.values(db.wakes).filter((e) => e && typeof e === "object");
  if (entries.length <= WAKES_MAX) return;
  entries.sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
  const keep = new Set(entries.slice(-WAKES_MAX).map((e) => e.wakeId));
  for (const k of Object.keys(db.wakes)) if (!keep.has(k)) delete db.wakes[k];
}

function budgetOf(counts, who) {
  return { used: counts[who].count, limit: WAKE.dailyLimit };
}

// token 软阈值估算（PRD：只告警不阻断）：唤醒次数 × 历史均值/回合。
function softOf(count) {
  const est = Number(count || 0) * WAKE.softTokenPerTurn;
  return {
    est,
    limit: WAKE.softTokenDailyLimit,
    over: est >= WAKE.softTokenDailyLimit,
  };
}

// 注入前闸门：放行则计数+签发 wakeId；超限则 allow:false/COUNT 且 blocked++。
// seq>0 幂等：同一 (who,seq) 已 admit 过 → 返回既有结果，不重复计数（重复 tick 不虚增）。
// seq<=0（如 promote nudge，kind="nudge"）不做幂等，每次签发新 wakeId，同样计预算。
export function admit({ who, seq, roomId, kind, read = readState, write = writeState } = {}) {
  const db = read();
  const day = todayKey();
  const counts = ensureDay(db, day);
  const seqN = Number(seq);
  const prior = seqN > 0
    ? Object.values(db.wakes).find((e) => e && e.who === who && Number(e.seq) === seqN)
    : null;
  if (prior) {
    const allow = prior.allow === true;
    const out = { ok: true, allow, wakeId: prior.wakeId, budget: budgetOf(counts, who) };
    if (!allow) out.reason = prior.blockReason || "COUNT";
    else out.highContextAge = isHigh(db, who);
    return out;
  }
  const allow = counts[who].count < WAKE.dailyLimit;
  const wakeId = "w-" + seqN + "-" + who + "-" + crypto.randomBytes(2).toString("hex");
  const entry = {
    wakeId,
    at: new Date().toISOString(),
    who,
    seq: seqN,
    roomId: String(roomId || ""),
    kind: String(kind || "text"),
    allow,
    blockReason: allow ? null : "COUNT",
    outcome: null,
    outcomeAt: null,
  };
  db.wakes[wakeId] = entry;
  pruneWakes(db);
  if (allow) {
    counts[who].count += 1;
    db.injectTotals[who] = total(db, who) + 1;
  } else {
    counts[who].blocked += 1;
  }
  write(db);
  const out = { ok: true, allow, budget: budgetOf(counts, who) };
  if (allow) {
    out.wakeId = wakeId;
    out.highContextAge = isHigh(db, who);
  } else {
    out.reason = "COUNT";
  }
  return out;
}

// outcome 回填：只允许目标 who 回填自己的 wake；outcome 已存在则不覆盖（先到先得）。
// outcome 合法值校验由调用方（server 路由）做 400；这里仍兜底校验，返回 code 供路由映射。
export function settle({ who, wakeId, outcome, read = readState, write = writeState } = {}) {
  if (!WAKE_OUTCOME_SET.has(outcome)) return { ok: false, error: "bad outcome", code: 400 };
  const db = read();
  const e = db.wakes[wakeId];
  if (!e || typeof e !== "object") return { ok: false, error: "unknown wake", code: 404 };
  if (e.who !== who) return { ok: false, error: "not your wake", code: 403 };
  if (e.outcome) return { ok: true, outcome: e.outcome, already: true };
  e.outcome = outcome;
  e.outcomeAt = new Date().toISOString();
  write(db);
  return { ok: true, outcome };
}

// 兜底回收：窗口期已过、仍未回填的 wake（桥断线/重启丢了 watcher）按证据补 outcome。
// 证据：该房内本端 seq > wake.seq 的最早一条输出，ts - at <= windowMs → REPLIED，否则 NO_REPLY。
// 只处理 allow:true 且已过 windowMs+graceMs 的条目；已回填的跳过（先到先得）。
export function sweepStale({ now = Date.now(), windowMs = WAKE.outcomeWindowMs, graceMs = Number(process.env.WAKE_REAP_GRACE_MS || 30_000), lookup = () => [], read = readState, write = writeState } = {}) {
  const db = read();
  const out = [];
  for (const e of Object.values(db.wakes)) {
    if (!e || typeof e !== "object" || e.outcome || e.allow !== true) continue;
    const at = Date.parse(String(e.at || ""));
    if (!Number.isFinite(at) || now - at <= windowMs + graceMs) continue;
    let outcome = "NO_REPLY";
    try {
      const first = (lookup(e.roomId) || [])
        .filter((m) => m && String(m.who) === e.who && Number(m.seq) > Number(e.seq))
        .sort((a, b) => Number(a.seq) - Number(b.seq))[0];
      const ts = first ? Date.parse(String(first.ts || "")) : NaN;
      if (Number.isFinite(ts) && ts - at <= windowMs) outcome = "REPLIED";
    } catch {}
    e.outcome = outcome;
    e.outcomeAt = new Date(now).toISOString();
    e.reaped = true;
    out.push({ wakeId: e.wakeId, who: e.who, roomId: e.roomId, kind: e.kind, seq: e.seq, outcome });
  }
  if (out.length) write(db);
  return out;
}

// 状态查询（GET /api/wake/state）：?date=YYYY-MM-DD 可选，缺省今天；只读不落盘。
export function getState({ date = "", read = readState } = {}) {
  const db = read();
  const day = date ? String(date) : todayKey();
  if (date && !DATE_RE.test(day)) return { ok: false, error: "bad date: expect YYYY-MM-DD", code: 400 };
  if (!db.days[day]) ensureDay(db, day);
  const wakes = Object.values(db.wakes)
    .filter((e) => e && typeof e === "object")
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))
    .slice(0, STATE_WAKES_MAX);
  return {
    ok: true,
    day,
    days: db.days,
    injectTotals: { me: total(db, "me"), daman: total(db, "daman") },
    highContextAge: { me: isHigh(db, "me"), daman: isHigh(db, "daman") },
    softTokens: { me: softOf(db.days[day].me.count), daman: softOf(db.days[day].daman.count) },
    wakes,
    limit: WAKE.dailyLimit,
  };
}

// 今日计数（含预算上限与被阻数），供 /api/bridge/status 与 UI chip 使用。
export function todayCounts({ read = readState } = {}) {
  const db = read();
  const counts = ensureDay(db, todayKey());
  const out = {};
  for (const who of WHO_LIST) {
    out[who] = { used: counts[who].count, limit: WAKE.dailyLimit, blocked: counts[who].blocked };
  }
  return out;
}

// /api/bridge/status 的 wake 字段（契约 §4.4 形状）。
export function bridgeWake({ read = readState } = {}) {
  const db = read();
  const today = todayCounts({ read: () => db });
  return {
    injectTotals: { me: total(db, "me"), daman: total(db, "daman") },
    highContextAge: { me: isHigh(db, "me"), daman: isHigh(db, "daman") },
    softTokens: { me: softOf(today.me.used), daman: softOf(today.daman.used) },
    today,
  };
}

// 单端 HIGH_CONTEXT_AGE 判定：injectTotals[who] >= contextAgeThreshold。
export function highContextAge(who, { read = readState } = {}) {
  return isHigh(read(), String(who || ""));
}
