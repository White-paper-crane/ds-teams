#!/usr/bin/env node
// ds-teams · 体检预检 CLI（零依赖，node 22）
// 用法：node check.mjs [--room <id>] [--legacy-window N] [--json] [--bridge]
//   环境变量：DS_TEAMS_URL（默认 http://127.0.0.1:8792）、DS_TEAMS_KEY（默认读 data/key.txt）、
//             DS_TEAMS_LEDGER（默认 data/dispatch-state.json）
// 输出：每行 PASS/WARN/FAIL + 一句证据，总行数 ≤30；--json 输出结构化对象。
// 退出码：全 PASS/WARN → 0；任一 FAIL → 1。
// 只读：只发 GET 与读本地台账，不写任何数据、不建房。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.DS_TEAMS_URL || "http://127.0.0.1:8792").replace(/\/+$/, "");
const MAX_LINES = 30;

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes("--json");
// v2 起房间桥接自动注入默认停用，lag 是历史游标，不应再当故障；需要检查旧桥时显式 --bridge。
const CHECK_BRIDGE = argv.includes("--bridge") || process.env.DS_TEAMS_CHECK_BRIDGE === "1";

function argValue(name) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : "";
    if (argv[i].startsWith(name + "=")) return argv[i].slice(name.length + 1);
  }
  return "";
}

const HELP = `用法：node check.mjs [--room <id>] [--legacy-window N] [--json] [--bridge]

只读预检（不建房、不写数据）：
  1. /api/health：ok、seq；默认不查桥接（v3 有独立心跳），加 --bridge 才查 lag（>60 条 WARN，>300 条 FAIL）
  2. /api/rooms：open 房清单；测试/回归/dbg/自检房仍 open、非主房过多 → WARN
  3. /api/state?since=0：最近 N 个 seq（默认 50，--legacy-window 可调）中「我接 #N / 让给你 #N」残留 → WARN
  4. data/dispatch-state.json：ACTIVE 任务 deadline 过期、claimed>15min、running>45min → WARN
  5. room.claims：同 target 多 token（winner 已在目标后发言则视为已消费）、悬空 target、超期未清（>24h，protocol.CLAIM.staleWarnMs，非服务端 TTL） → WARN
  6. data/settings.json + data/ops-events.jsonl：评审端延迟告警开/关、今日超阈值条数；阈值 ≤ 沉默窗口会误报 → WARN

退出码：全 PASS/WARN → 0；任一 FAIL → 1。--json 输出结构化对象。`;

if (argv.includes("-h") || argv.includes("--help")) {
  console.log(HELP);
  process.exit(0);
}

// 协议阈值单一来源：protocol.mjs 存在且导出 LIMITS 就用它；尚未落地时用 dispatch-lib 同值兜底。
const FALLBACK = {
  stallClaimedMs: 15 * 60e3,
  stallRunMs: 45 * 60e3,
  maxOpenRooms: 3,          // 非主房 open 超过 3 间 → WARN
  staleWarnMs: 24 * 3600e3, // 与 protocol.CLAIM.staleWarnMs 同值兜底；服务端不做时间过期
};
let LIMITS = { ...FALLBACK };
let protoWAKE = null;
let ACTIVE_STATES = new Set(["claimed", "spawned", "running", "reported"]);
try {
  const proto = await import(new URL("./protocol.mjs", import.meta.url).href);
  if (proto.LIMITS && typeof proto.LIMITS === "object") LIMITS = { ...LIMITS, ...proto.LIMITS };
  if (proto.WAKE && typeof proto.WAKE === "object") protoWAKE = proto.WAKE;
  if (proto.ACTIVE instanceof Set) ACTIVE_STATES = new Set(proto.ACTIVE);
} catch {
  // protocol.mjs 还没落地/加载失败：静默用兜底值，不影响体检
}

const checks = [];
const add = (level, id, text) => { checks.push({ level, id, text: String(text) }); };

function readKey() {
  if (process.env.DS_TEAMS_KEY) return process.env.DS_TEAMS_KEY.trim();
  try { return fs.readFileSync(path.join(ROOT, "data", "key.txt"), "utf8").trim(); } catch { return ""; }
}

function errText(e) {
  if (!e) return "未知错误";
  const code = (e.cause && e.cause.code) || e.code || "";
  const msg = String(e.message || e);
  return code && !msg.includes(code) ? `${code}: ${msg}` : msg;
}

// 只读 GET；只在连接被拒/被重置时重试（服务正在重启的场景）。
async function getJson(pathname, { attempts = 1, retryMs = 1000 } = {}) {
  const url = `${BASE}${pathname}${pathname.includes("?") ? "&" : "?"}k=${encodeURIComponent(readKey())}`;
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = null; }
      if (!res.ok) return { ok: false, status: res.status, error: (data && (data.error || data.message)) || text.slice(0, 160) || `HTTP ${res.status}` };
      if (data === null) return { ok: false, status: res.status, error: "响应不是 JSON：" + text.slice(0, 160) };
      return { ok: true, status: res.status, data };
    } catch (e) {
      lastErr = e;
      const code = (e && e.cause && e.cause.code) || (e && e.code) || "";
      const retriable = code === "ECONNREFUSED" || code === "ECONNRESET";
      if (!retriable || i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, retryMs));
    }
  }
  return { ok: false, status: 0, error: errText(lastErr) };
}

const now = Date.now();
const mins = (ms) => Math.max(0, Math.round(ms / 60000));
const key = readKey();

// ---------- 1. 服务 / seq / 桥接 ----------
let health = null;
if (!key) {
  add("FAIL", "key", "找不到平台 key：设 DS_TEAMS_KEY 或确认 data/key.txt 存在");
} else {
  const hr = await getJson("/api/health", { attempts: 5 });
  if (!hr.ok) {
    const hint = hr.status === 401
      ? "key 不对（data/key.txt 或 DS_TEAMS_KEY）"
      : "服务没起或端口不对；启动：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ensure-server.ps1";
    add("FAIL", "health", `GET ${BASE}/api/health 失败（${hr.status || "连接失败"}）：${hr.error}；${hint}`);
  } else if (hr.data.ok !== true) {
    add("FAIL", "health", `/api/health ok=${hr.data.ok}（应为 true）：${JSON.stringify(hr.data).slice(0, 160)}`);
  } else {
    health = hr.data;
    add("PASS", "health", `/api/health ok=true at=${health.at || "-"}（${BASE}）`);
  }
}

// ---------- 2. 状态：seq + 旧声明 ----------
let state = null;
const sr = key ? await getJson("/api/state?since=0", { attempts: 3 }) : { ok: false, status: 0, error: "无 key" };
if (sr.ok) {
  state = sr.data;
  add("PASS", "seq", `seq=${state.seq}（消息 ${Array.isArray(state.messages) ? state.messages.length : 0} 条）`);
} else if (key) {
  add("FAIL", "state", `GET /api/state?since=0 失败：${sr.error}`);
}

if (health && CHECK_BRIDGE) {
  for (const name of ["me", "daman"]) {
    const b = health.bridges && health.bridges[name];
    if (!b || !Number.isFinite(Number(b.lag))) {
      add("WARN", `bridge:${name}`, `health 缺 ${name} 桥接游标（cursor/lag 不可读）`);
      continue;
    }
    const lag = Number(b.lag);
    const evidence = `lag=${lag} 条 cursor=${b.cursor}`;
    if (lag > 300) add("FAIL", `bridge:${name}`, `${evidence}（>300 条；查 data/bridge-${name}.log 与桥接插件是否加载）`);
    else if (lag > 60) add("WARN", `bridge:${name}`, `${evidence}（>60 条；桥接可能落后/忙碌，先看最新 action）`);
    else add("PASS", `bridge:${name}`, evidence);
  }
} else if (health) {
  add("PASS", "bridge", "默认不查桥接（v3 桥接有心跳，历史游标可能造成假 lag；需要时加 --bridge）");
}

// ---------- 3. 房间 ----------
let rooms = null;
const rr = key ? await getJson("/api/rooms", { attempts: 3 }) : { ok: false, status: 0, error: "无 key" };
if (rr.ok && Array.isArray(rr.data.rooms)) rooms = rr.data.rooms;
else if (key) add("FAIL", "rooms", `GET /api/rooms 失败：${rr.error}`);

const roomFilter = argValue("--room");
let open = [];
if (rooms) {
  open = rooms.filter((r) => r.status === "open");
  add(open.length ? "PASS" : "WARN", "rooms", open.length
    ? `open 房 ${open.length} 间：${open.map((r) => `${r.id}「${r.title}」`).join(" / ")}`
    : "没有 open 房（全部 closed/archived）");

  for (const r of open.slice(0, 5)) {
    const last = r.last ? `${r.last.who} #${r.last.seq}` : "无消息";
    add("PASS", `room:${r.id}`, `${r.id}「${r.title}」idle=${r.idleSeconds ?? "?"}s 消息=${r.messageCount ?? "?"} 最后=${last}`);
  }
  if (open.length > 5) {
    add("WARN", "rooms-extra", `另有 ${open.length - 5} 间 open 房未逐条列出：${open.slice(5).map((r) => r.id).join(",")}`);
  }

  const testRooms = open.filter((r) => /测试|回归|dbg|自检/i.test(String(r.title || "")));
  add(testRooms.length ? "WARN" : "PASS", "test-rooms", testRooms.length
    ? `测试/回归/dbg/自检房仍 open ${testRooms.length} 间：${testRooms.map((r) => `${r.id}「${r.title}」`).join(" / ")}；清理：node tools/cleanup-test-rooms.mjs`
    : "无 测试/回归/dbg/自检 房残留");

  const roomFilterOpen = !!roomFilter && open.some((r) => r.id === roomFilter);
  const mainId = roomFilterOpen
    ? roomFilter
    : open.slice().sort((a, b) => (Number(b.messageCount) || 0) - (Number(a.messageCount) || 0))[0]?.id || "";
  // --room 无效时这行没有可信的「主房」，直接跳过，由 room-arg FAIL 定位；不拿无效 id 冒充主房。
  if (roomFilterOpen || !roomFilter) {
    const nonMain = open.filter((r) => r.id !== mainId);
    const roomLimit = Number(LIMITS.maxOpenRooms) || FALLBACK.maxOpenRooms;
    add(nonMain.length > roomLimit ? "WARN" : "PASS", "open-rooms", `open ${nonMain.length} 间（阈值 ${roomLimit}，主房 ${mainId || "-"}）`
      + (nonMain.length > roomLimit ? `：${nonMain.map((r) => r.id).join(",")}；用 close/archive 收尾` : ""));
  }

  if (roomFilter && !roomFilterOpen) {
    const exists = rooms.some((r) => r.id === roomFilter);
    add("FAIL", "room-arg", exists
      ? `--room ${roomFilter} 存在但状态不是 open（可能已 closed/archived）`
      : `--room ${roomFilter} 不在 /api/rooms 里（可能 id 拼错或已归档）`);
  }
}

// ---------- 4. 旧声明残留 ----------
if (state && Array.isArray(state.messages)) {
  const all = state.messages;
  const w = Number(argValue("--legacy-window"));
  const windowSize = Number.isFinite(w) && w > 0 ? Math.floor(w) : 50;
  // 按 seq 窗口而非数组尾部：历史有压缩/删除，数组尾部 50 条可能包含几百个 seq 前的消息。
  const maxSeq = Number(state.seq) || (all.length ? Number(all[all.length - 1].seq) : 0);
  const cutoff = maxSeq - windowSize;
  const msgs = all.filter((m) => Number(m.seq) > cutoff);
  const legacy = msgs.filter((m) => /^\s*我接 #\d+/.test(String(m.text || "")) || /^\s*让给你 #\d+/.test(String(m.text || "")));
  const span = maxSeq ? `#${cutoff + 1}–#${maxSeq}，窗口内 ${msgs.length} 条` : "无消息";
  if (legacy.length) {
    const sample = legacy.slice(-3).map((m) => `#${m.seq}「${String(m.text).slice(0, 24)}」`).join(" ");
    add("WARN", "legacy-claim", `最近 ${windowSize} 个 seq 中旧「我接 #N/让给你 #N」残留 ${legacy.length} 条（${span}；${sample}）；带外 claim 后不该再发，用 say.mjs recall 撤回`);
  } else {
    add("PASS", "legacy-claim", `最近 ${windowSize} 个 seq（${span}）无「我接 #N/让给你 #N」残留`);
  }
}

// ---------- 5. 台账 ----------
(function checkLedger() {
  const file = process.env.DS_TEAMS_LEDGER || path.join(ROOT, "data", "dispatch-state.json");
  let db;
  try {
    // 兼容 Windows 记事本/PowerShell 写出的 UTF-8 BOM
    db = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    add("WARN", "ledger", `台账读取失败（${path.relative(ROOT, file)}）：${errText(e)}`);
    return;
  }
  const tasks = Object.entries((db && db.tasks) || {});
  const active = tasks.filter(([, t]) => t && ACTIVE_STATES.has(t.state));
  const problems = [];
  const claimedMs = Number(LIMITS.stallClaimedMs) || FALLBACK.stallClaimedMs;
  const runMs = Number(LIMITS.stallRunMs) || FALLBACK.stallRunMs;
  for (const [k, t] of active) {
    const ts = Date.parse(t.updatedAt || t.claimedAt || "") || now;
    const age = now - ts;
    if (t.deadlineAt && Date.parse(t.deadlineAt) < now) {
      problems.push(`${k} state=${t.state} deadlineAt=${t.deadlineAt} 已过（${mins(now - Date.parse(t.deadlineAt))}min）`);
    }
    if ((t.state === "claimed" || t.state === "spawned") && age > claimedMs) {
      problems.push(`${k} state=${t.state} 已 ${mins(age)}min（>${mins(claimedMs)}min；用 dispatch watchdog 或 set-state 收尾）`);
    } else if ((t.state === "running" || t.state === "reported") && age > runMs) {
      problems.push(`${k} state=${t.state} 已 ${mins(age)}min（>${mins(runMs)}min；查回合是否卡死）`);
    }
  }
  if (problems.length) {
    for (const p of problems.slice(0, 5)) add("WARN", "ledger", p);
    if (problems.length > 5) add("WARN", "ledger", `另有 ${problems.length - 5} 条超期未列出（--json 看全部）`);
  } else {
    add("PASS", "ledger", `${tasks.length} 任务 / ACTIVE ${active.length} / 无 deadline 过期或超时`);
  }
})();

// ---------- 6. claim 队列 ----------
(function checkClaims() {
  if (!rooms) return;
  const targets = [];
  for (const r of rooms) {
    if (r.status !== "open" || !r.claims || typeof r.claims !== "object") continue;
    if (roomFilter && r.id !== roomFilter) continue;
    for (const [target, list] of Object.entries(r.claims)) {
      if (!Array.isArray(list) || !list.length) continue;
      targets.push({ room: r, target: Number(target), list });
    }
  }
  const msgs = state && Array.isArray(state.messages) ? state.messages : [];
  const seqSet = new Set(msgs.map((m) => Number(m.seq)));
  const staleMs = Number(LIMITS.staleWarnMs) || FALLBACK.staleWarnMs;
  const problems = [];
  let consumedCount = 0;
  for (const { room, target, list } of targets) {
    const why = [];
    // winner = token 最小（protocol.mjs CLAIM.winner）；若 winner 在目标消息之后已发言，说明这轮已被消费，多 token 是历史残留。
    const winner = [...list].sort((a, b) => (Number(a.token) || Infinity) - (Number(b.token) || Infinity))[0] || {};
    const consumed = !!winner.who
      && msgs.some((m) => Number(m.seq) > target && m.who === winner.who);
    if (consumed) consumedCount++;
    if (list.length > 1 && !consumed) why.push(`${list.length} 个 token（${list.map((c) => `${c.who}#${c.token}`).join(", ")}）`);
    const dangling = Number.isFinite(target) && target > 0 && state && !seqSet.has(target);
    if (dangling) why.push(`target ${target} 消息不存在，无法判断是否已消费`);
    const ages = list.map((c) => now - (Date.parse(c.at || "") || now)).filter((n) => Number.isFinite(n));
    const maxAge = ages.length ? Math.max(...ages) : 0;
    if (maxAge > staleMs && !consumed) why.push(`最早 ${mins(maxAge)}min 未清（>${mins(staleMs)}min）`);
    if (why.length) problems.push(`${room.id}#${target}${dangling ? "（历史）" : ""}：${why.join("；")}`);
  }
  if (problems.length) {
    for (const p of problems.slice(0, 5)) add("WARN", "claims", p);
    if (problems.length > 5) add("WARN", "claims", `另有 ${problems.length - 5} 条 claim 问题未列出（--json 看全部）`);
  } else {
    add("PASS", "claims", `无同 target 多 token / 悬空 target / 超期（检查 ${targets.length} 个 target`
      + (consumedCount ? `；${consumedCount} 个多 token 已消费，按历史忽略` : "") + "）");
  }
})();

// ---------- 7. 评审端延迟告警（data/settings.json + data/ops-events.jsonl） ----------
// 只读：不调 API，直接看本地开关与事件文件，服务没起也能体检。
// 设计意图（见 settings-lib.mjs 注释）：阈值必须 > 沉默观察窗口，否则沉默收敛会被误记成延迟。
await (async function checkReviewLatency() {
  const OPS = process.env.DS_TEAMS_OPS_FILE || path.join(ROOT, "data", "ops-events.jsonl");
  let st = null;
  try {
    const mod = await import(new URL("./settings-lib.mjs", import.meta.url).href);
    st = mod.readSettings();
  } catch (e) {
    add("WARN", "review-latency", `settings-lib 加载失败（${errText(e)}）；评审延迟告警不可判定`);
    return;
  }
  const rl = (st && st.reviewLatency) || {};
  const win = Number(protoWAKE && protoWAKE.outcomeWindowMs) || 90000;

  // 本地日（不是 UTC 日）：ops 事件 at 是 ISO UTC，直接切字符串会错一天
  const localDay = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const today = localDay(new Date(now).toISOString());
  let events = [];
  try {
    const lines = fs.readFileSync(OPS, "utf8").split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let rec;
      try { rec = JSON.parse(lines[i]); } catch { continue; }
      if (!rec || rec.code !== "REVIEW_LATENCY") continue;
      if (localDay(rec.at) !== today) continue;
      events.push(rec);
      if (events.length >= 200) break;
    }
  } catch { events = []; }

  if (rl.enabled === false) {
    add("PASS", "review-latency", `告警已关闭（UI 房间头 #latencyChip 可再开）；今日仍记录 ${events.length} 条历史事件`);
    return;
  }

  const warnMs = Number(rl.warnMs) || 0;
  const criticalMs = Number(rl.criticalMs) || 0;
  const bad = [];
  if (warnMs >= criticalMs) bad.push(`黄线 ${Math.round(warnMs / 1000)}s ≥ 红线 ${Math.round(criticalMs / 1000)}s（应 warnMs < criticalMs）`);
  if (warnMs <= 0) bad.push("warnMs 非法（应为 1000..3600000）");
  if (criticalMs <= 0) bad.push("criticalMs 非法（应为 1000..3600000）");
  if (events.length >= 5) {
    const worst = events.reduce((a, b) => (Number(b.latencyMs) || 0) > (Number(a.latencyMs) || 0) ? b : a, events[0]);
    const reviewers = [...new Set(events.map((e) => e.reviewer).filter(Boolean))].join("/");
    bad.push(`今日超黄线 ${events.length} 条（黄线 ${Math.round(warnMs / 1000)}s / 红线 ${Math.round(criticalMs / 1000)}s，最慢 ${Math.round((Number(worst.latencyMs) || 0) / 1000)}s，评审端 ${reviewers || "?"}）`);
  }
  if (bad.length) add("WARN", "review-latency", bad.join("；"));
  else add("PASS", "review-latency", `今日超黄线 ${events.length} 条（黄线 ${Math.round(warnMs / 1000)}s / 红线 ${Math.round(criticalMs / 1000)}s > 沉默窗口 ${Math.round(win / 1000)}s；沉默只记红不记黄）`);
})();

// ---------- 输出 ----------
const failed = checks.some((c) => c.level === "FAIL");
const exitCode = failed ? 1 : 0;
const summary = {
  PASS: checks.filter((c) => c.level === "PASS").length,
  WARN: checks.filter((c) => c.level === "WARN").length,
  FAIL: checks.filter((c) => c.level === "FAIL").length,
};

const LABELS = {
  health: "服务", seq: "消息", key: "key", state: "状态", rooms: "房间",
  "test-rooms": "测试房", "open-rooms": "非主房", "rooms-extra": "房间",
  "legacy-claim": "旧声明", ledger: "台账", claims: "claim", "room-arg": "参数",
  "review-latency": "评审延迟",
};
const labelOf = (id) => LABELS[id]
  || (id.startsWith("bridge:") ? `桥接 ${id.slice(7)}` : id.startsWith("room:") ? "房间" : id);
let lines = checks.map((c) => `${c.level} ${labelOf(c.id)} ${c.text}`);
if (lines.length + 1 > MAX_LINES) {
  const keep = MAX_LINES - 2;
  const omitted = checks.length - keep;
  lines = lines.slice(0, keep).concat(`WARN 输出截断：另有 ${omitted} 条检查未显示（--json 查看全部）`);
}

if (JSON_OUT) {
  const out = {
    ok: !failed,
    exitCode,
    generatedAt: new Date().toISOString(),
    base: BASE,
    seq: state ? state.seq : null,
    health: health ? { ok: health.ok === true, at: health.at || null, bridges: health.bridges || null } : null,
    room: roomFilter || null,
    summary,
    checks,
    lines,
  };
  console.log(JSON.stringify(out));
} else {
  console.log(`ds-teams 体检 · ${new Date().toISOString()} · ${summary.PASS} PASS / ${summary.WARN} WARN / ${summary.FAIL} FAIL`);
  for (const line of lines) console.log(line);
}

process.exitCode = exitCode;
