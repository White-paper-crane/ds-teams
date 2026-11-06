// ds-teams · dispatch 台账（C 端 / 大满侧）
// 唯一事实源：data/dispatch-state.json（可用 DS_TEAMS_LEDGER 覆盖，测试用）。
// 给 dispatch.mjs CLI（大满/小满回合都可调）与桥接 watchdog/promote 共用。
// 纪律：先写台账再 spawn；写入 = tmp + rename；终态不再触发 spawn。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACTIVE, TERMINAL, CAP, LIMITS } from "./protocol.mjs";

export { CAP };

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LEDGER = process.env.DS_TEAMS_LEDGER || path.join(ROOT, "data", "dispatch-state.json");
// ACTIVE 占并发名额；queued 排队但不占名额。状态定义见 protocol.mjs。
const DEFAULTS = {
  claimedMs: LIMITS.stallClaimedMs,
  runMs: LIMITS.stallRunMs,
  queuedMs: LIMITS.stallQueuedMs,
  maxAttempts: LIMITS.maxAttempts,
};

export const taskKey = (roomId, taskId) => String(roomId).trim() + "::" + String(taskId).trim();

const nowIso = () => new Date().toISOString();
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

function pushEvent(e, type, by, detail) {
  e.events = Array.isArray(e.events) ? e.events : [];
  e.events.push({ at: nowIso(), type: String(type || ""), by: String(by || ""), detail: String(detail || "").slice(0, 500) });
  if (e.events.length > 200) e.events = e.events.slice(-200);
}

function sha256File(fp) {
  return crypto.createHash("sha256").update(fs.readFileSync(fp)).digest("hex");
}

function cleanList(v, max = 20) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x || "").trim()).filter(Boolean).slice(0, max);
}

export function readLedger() {
  try {
    const j = JSON.parse(fs.readFileSync(LEDGER, "utf8"));
    if (j && typeof j === "object" && j.tasks && typeof j.tasks === "object") return j;
  } catch {}
  return { version: 1, tasks: {} };
}

export function writeLedger(db) {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  const tmp = LEDGER + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
  fs.renameSync(tmp, LEDGER);
}

// 跨进程互斥：桌面端桥接与 QQ 端会话都会写台账，读-改-写必须串行。
// 锁文件 + 重试；持锁超过 10 秒视为死锁残留，直接破掉（宁可丢一次写，不卡死）。
const LOCK = LEDGER + ".lock";
function withLedgerLock(fn, { timeoutMs = 3000, staleMs = 10000 } = {}) {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  const start = Date.now();
  let fd = null;
  while (fd === null) {
    try {
      fd = fs.openSync(LOCK, "wx");
    } catch (e) {
      if (e && e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(LOCK).mtimeMs > staleMs) fs.rmSync(LOCK, { force: true });
      } catch {}
      if (Date.now() - start > timeoutMs) throw new Error("ledger lock timeout: " + LOCK);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.rmSync(LOCK, { force: true }); } catch {}
  }
}

export function counts(db = readLedger()) {
  let g = 0;
  const rooms = {};
  for (const e of Object.values(db.tasks)) {
    if (!ACTIVE.has(e.state)) continue;
    g++;
    rooms[e.roomId] = (rooms[e.roomId] ?? 0) + 1;
  }
  return { global: g, rooms };
}

const canClaim = (roomId, db = readLedger()) => {
  const c = counts(db);
  return c.global < CAP.global && (c.rooms[roomId] ?? 0) < CAP.room;
};

// 原子 claim：同 (roomId, taskId) 只成功一次。
// 名额满时落 queued（不 spawn），返回 queued:true + 排队位置；有位置才 claimed。
function claimLocked(roomId, taskId, seq, extra = {}) {
  const db = readLedger();
  const k = taskKey(roomId, taskId);
  const prev = db.tasks[k];
  if (prev) return { ok: false, duplicate: true, key: k, state: prev.state, entry: prev };
  const now = new Date().toISOString();
  const entry = {
    roomId: String(roomId).trim(),
    taskId: String(taskId).trim(),
    assignee: extra.assignee ?? "daman",
    state: "claimed",
    attempts: 1,
    sourceSeq: seq ?? null,
    claimedAt: now,
    updatedAt: now,
    subtasks: [],
    teammates: [],
  };
  if (extra.deadlineAt) entry.deadlineAt = extra.deadlineAt;
  let queued = false;
  if (!canClaim(entry.roomId, db)) {
    entry.state = "queued";
    entry.queuedAt = now;
    entry.queuePos = Object.values(db.tasks).filter((e) => e.state === "queued").length + 1;
    queued = true;
  }
  db.tasks[k] = entry;
  writeLedger(db);
  return { ok: true, duplicate: false, queued, key: k, entry };
}

function setStateLocked(key, state, patch = {}) {
  const db = readLedger();
  const e = db.tasks[key];
  if (!e) return { ok: false, error: "unknown key " + key };
  const { by = "", ...rest } = patch;
  const from = e.state;
  e.state = state;
  // 从 timeout/interrupted 恢复时清掉旧的失败原因，避免日志里挂着已失效的借口。
  if (state !== "timeout") delete e.timeoutReason;
  if (state !== "blocked") delete e.blockReason;
  Object.assign(e, rest, { updatedAt: new Date().toISOString() });
  if (from !== state) pushEvent(e, "state", by, `${from} -> ${state}`);
  writeLedger(db);
  return { ok: true, entry: e };
}

// 名额释放后按 sourceSeq 顺序把 queued 提升为 claimed；返回被提升的 key 列表。
function promoteLocked() {
  const db = readLedger();
  const q = Object.entries(db.tasks)
    .filter(([, e]) => e.state === "queued")
    .sort((a, b) => (a[1].sourceSeq ?? 0) - (b[1].sourceSeq ?? 0));
  const out = [];
  for (const [k, e] of q) {
    if (!canClaim(e.roomId, db)) continue;
    e.state = "claimed";
    e.updatedAt = new Date().toISOString();
    delete e.queuePos;
    out.push(k);
  }
  if (out.length) writeLedger(db);
  return out;
}

// spawn 失败：attempts+1；未到 maxAttempts 回 queued 重试，到了标 failed。
function failLocked(key, reason = "") {
  const db = readLedger();
  const e = db.tasks[key];
  if (!e) return { ok: false, error: "unknown key " + key };
  e.attempts = (e.attempts ?? 1) + 1;
  e.lastError = String(reason || "").slice(0, 300);
  e.updatedAt = new Date().toISOString();
  const max = e.maxAttempts ?? DEFAULTS.maxAttempts;
  const retry = e.attempts <= max;
  e.state = retry ? "queued" : "failed";
  if (retry) e.queuedAt = e.updatedAt;
  writeLedger(db);
  return { ok: true, retry, attempts: e.attempts, state: e.state };
}

// 超时看门狗：deadlineAt 过期、或 claimed/queued 卡太久 → timeout。
// 返回被改动的 [{ key, from, reason }]。
function watchdogLocked(opts = {}) {
  const claimedMs = opts.claimedMs ?? DEFAULTS.claimedMs;
  const runMs = opts.runMs ?? DEFAULTS.runMs;
  const queuedMs = opts.queuedMs ?? DEFAULTS.queuedMs;
  const now = Date.now();
  const db = readLedger();
  const out = [];
  for (const [k, e] of Object.entries(db.tasks)) {
    if (TERMINAL.has(e.state)) continue;
    const ts = Date.parse(e.updatedAt || e.claimedAt || "") || now;
    let reason = "";
    if (e.deadlineAt && Date.parse(e.deadlineAt) < now) reason = "deadline passed";
    else if (e.state === "queued" && now - ts > queuedMs) reason = "queued too long";
    else if (e.state === "claimed" && now - ts > claimedMs) reason = "claimed but never spawned";
    else if (e.state === "spawned" && now - ts > claimedMs) reason = "spawned but never running";
    else if ((e.state === "running" || e.state === "reported") && now - ts > runMs) reason = "running too long";
    if (!reason) continue;
    out.push({ key: k, from: e.state, reason });
    e.state = "timeout";
    e.timeoutReason = reason;
    e.updatedAt = new Date().toISOString();
  }
  if (out.length) writeLedger(db);
  return out;
}

const REVIEW_VERDICTS = new Set(["pass", "fail"]);

// 复核记录（口径按小满 #1028 卡）：pass -> done；fail -> blocked 并带 blockReason。
function addReviewLocked(key, { by = "daman", verdict, note = "" } = {}) {
  const db = readLedger();
  const e = db.tasks[key];
  if (!e) return { ok: false, error: "unknown key " + key };
  if (!REVIEW_VERDICTS.has(verdict)) return { ok: false, error: "verdict must be pass|fail" };
  const at = new Date().toISOString();
  const why = String(note || "").slice(0, 300);
  e.reviews = Array.isArray(e.reviews) ? e.reviews : [];
  e.reviews.push({ by, verdict, note: why, at });
  if (verdict === "pass") {
    e.state = "done";
    delete e.blockReason;
  } else {
    e.state = "blocked";
    e.blockReason = why || "rejected in review";
  }
  e.updatedAt = at;
  writeLedger(db);
  return { ok: true, entry: e };
}

// 关房条件：该房所有非 aborted 任务都到 done，且每条有一次 pass 复核
// （或显式 noReview: true 的豁免）。空房间不算可关。
export function roomStatus(roomId, db = readLedger()) {
  const rows = Object.values(db.tasks).filter((e) => e.roomId === roomId && e.state !== "aborted");
  // reviewed 是旧口径留下的等价状态（pass 即完成），按 done 处理。
  const pending = rows.filter((e) => !["done", "reviewed"].includes(e.state)).map((e) => e.taskId);
  const unreviewed = rows
    .filter((e) => {
      if (e.noReview === true) return false;
      const rev = Array.isArray(e.reviews) ? e.reviews : [];
      return !rev.some((r) => r.verdict === "pass");
    })
    .map((e) => e.taskId);
  return {
    roomId,
    tasks: rows.length,
    pending,
    unreviewed,
    canClose: rows.length > 0 && pending.length === 0 && unreviewed.length === 0,
  };
}

// 重启语义：非终态一律 interrupted，不自动重拉。
function markInterruptedLocked() {
  const db = readLedger();
  let n = 0;
  for (const e of Object.values(db.tasks)) {
    if (!TERMINAL.has(e.state)) {
      e.state = "interrupted";
      e.updatedAt = new Date().toISOString();
      n++;
    }
  }
  if (n) writeLedger(db);
  return n;
}

// 桥接注入判据：只送「别人发给大满的功能性任务」，daman 自己发的不回灌。
// assignee 一旦写了就是权威：写明给别人的卡，正文提到「大满」也不算我的（#1132 误投）。
export function isTaskForDaman(m, room) {
  if (!m || m.kind !== "task") return false;
  if (!room || (room.status && room.status !== "open")) return false;
  if (m.who === "daman") return false;
  if (m.assignee) return m.assignee === "daman";
  return /大满|daman/.test(String(m.text || ""));
}

/* ---------- 控制面 v2：无房间任务卡 ---------- */

// 建卡只写 queued，不占并发名额；start 才占名额。
function createTaskLocked(input = {}) {
  const db = readLedger();
  const projectId = String(input.projectId || "local").trim();
  const taskId = String(input.taskId || "").trim();
  if (!ID_RE.test(projectId)) return { ok: false, error: "bad projectId" };
  if (!ID_RE.test(taskId)) return { ok: false, error: "bad taskId" };
  const key = taskKey(projectId, taskId);
  if (db.tasks[key]) return { ok: false, duplicate: true, key, entry: db.tasks[key] };
  const title = String(input.title || taskId).trim().slice(0, 200);
  const gate = input.gate && String(input.gate.command || "").trim()
    ? {
        command: String(input.gate.command).trim(),
        cwd: String(input.gate.cwd || ".").trim(),
        timeoutMs: Math.max(1000, Math.min(3_600_000, Number(input.gate.timeoutMs) || 300_000)),
      }
    : null;
  const entry = {
    roomId: projectId,
    projectId,
    taskId,
    title,
    owner: String(input.owner || "lead").trim(),
    assignee: String(input.assignee || "lead").trim(),
    state: "queued",
    attempts: 0,
    acceptance: cleanList(input.acceptance),
    writeScope: cleanList(input.writeScope),
    gate,
    artifacts: [],
    reviews: [],
    events: [],
    subtasks: [],
    teammates: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  pushEvent(entry, "created", entry.owner, title);
  db.tasks[key] = entry;
  writeLedger(db);
  return { ok: true, duplicate: false, key, entry };
}

function startTaskLocked(key, input = {}) {
  const db = readLedger();
  const e = db.tasks[key];
  if (!e) return { ok: false, error: "unknown key " + key };
  if (ACTIVE.has(e.state)) return { ok: true, already: true, key, entry: e };
  if (["done", "failed", "aborted"].includes(e.state)) {
    return { ok: false, error: "terminal task: " + e.state, key, entry: e };
  }
  const now = nowIso();
  const owner = String(input.owner || e.owner || "lead").trim();
  const assignee = String(input.assignee || e.assignee || owner).trim();
  if (!canClaim(e.roomId, db)) {
    e.state = "queued";
    e.owner = owner;
    e.assignee = assignee;
    e.updatedAt = now;
    e.queuePos = Object.values(db.tasks).filter((x) => x.state === "queued").length + 1;
    pushEvent(e, "queued", owner, "cap full");
    writeLedger(db);
    return { ok: true, queued: true, key, entry: e };
  }
  e.state = "claimed";
  e.owner = owner;
  e.assignee = assignee;
  e.claimedAt = now;
  e.updatedAt = now;
  e.attempts = Number(e.attempts || 0) + 1;
  delete e.queuePos;
  delete e.blockReason;
  delete e.timeoutReason;
  pushEvent(e, "started", owner, assignee);
  writeLedger(db);
  return { ok: true, queued: false, key, entry: e };
}

function reportTaskLocked(key, input = {}) {
  const db = readLedger();
  const e = db.tasks[key];
  if (!e) return { ok: false, error: "unknown key " + key };
  if (!["claimed", "running", "reported"].includes(e.state)) {
    return { ok: false, error: "cannot report from state " + e.state };
  }
  const list = Array.isArray(input.artifacts) ? input.artifacts : [];
  const out = [];
  for (const raw of list) {
    const rel = typeof raw === "string" ? raw : raw && raw.path;
    if (!rel) continue;
    const abs = path.resolve(ROOT, String(rel));
    if (!fs.existsSync(abs)) return { ok: false, error: "artifact missing: " + rel };
    const st = fs.statSync(abs);
    if (!st.isFile()) return { ok: false, error: "artifact not a file: " + rel };
    if (st.size > MAX_ARTIFACT_BYTES) return { ok: false, error: "artifact too large: " + rel };
    out.push({
      path: path.relative(ROOT, abs).replace(/\\/g, "/") || String(rel),
      size: st.size,
      sha256: sha256File(abs),
      at: nowIso(),
    });
  }
  e.artifacts = Array.isArray(e.artifacts) ? e.artifacts : [];
  for (const a of out) {
    if (!e.artifacts.some((x) => x.path === a.path && x.sha256 === a.sha256)) e.artifacts.push(a);
  }
  e.state = "reported";
  e.reportedAt = nowIso();
  e.reportSummary = String(input.summary || "").slice(0, 1000);
  e.updatedAt = e.reportedAt;
  pushEvent(e, "reported", input.by || e.owner, e.reportSummary || `${out.length} artifact(s)`);
  writeLedger(db);
  return { ok: true, key, entry: e, added: out.length };
}

function recordGateLocked(key, result = {}) {
  const db = readLedger();
  const e = db.tasks[key];
  if (!e) return { ok: false, error: "unknown key " + key };
  e.gate = e.gate && typeof e.gate === "object" ? e.gate : {};
  e.gate.last = {
    pass: result.pass === true,
    exitCode: result.exitCode ?? null,
    signal: result.signal || null,
    durationMs: Number(result.durationMs) || 0,
    stdoutHash: String(result.stdoutHash || ""),
    stderrHash: String(result.stderrHash || ""),
    stdoutTail: String(result.stdoutTail || ""),
    stderrTail: String(result.stderrTail || ""),
    command: String(result.command || ""),
    cwd: String(result.cwd || ""),
    evidencePath: String(result.evidencePath || ""),
    at: result.at || nowIso(),
  };
  e.updatedAt = nowIso();
  pushEvent(e, "gate", result.by || e.owner, e.gate.last.pass ? "pass" : `fail (exit ${e.gate.last.exitCode})`);
  writeLedger(db);
  return { ok: true, key, entry: e };
}

function acceptTaskLocked(key, input = {}) {
  const db = readLedger();
  const e = db.tasks[key];
  if (!e) return { ok: false, error: "unknown key " + key };
  if (e.state === "done") return { ok: true, already: true, key, entry: e };
  if (e.state !== "reported") return { ok: false, error: "cannot accept from state " + e.state };
  const note = String(input.note || "").slice(0, 500);
  const force = input.force === true;
  if (!(e.gate && e.gate.last && e.gate.last.pass === true) && !force) {
    return { ok: false, error: "gate not passed; run gate or use --force with --note" };
  }
  if (force && !note) return { ok: false, error: "--force requires --note" };
  const at = nowIso();
  e.state = "done";
  e.acceptedAt = at;
  e.acceptedBy = String(input.by || "you");
  delete e.blockReason;
  e.reviews = Array.isArray(e.reviews) ? e.reviews : [];
  e.reviews.push({ by: String(input.by || "you"), verdict: "pass", note, at });
  e.updatedAt = at;
  pushEvent(e, "accepted", e.acceptedBy, force ? "forced: " + note : note);
  writeLedger(db);
  return { ok: true, key, entry: e };
}

function rejectTaskLocked(key, input = {}) {
  const db = readLedger();
  const e = db.tasks[key];
  if (!e) return { ok: false, error: "unknown key " + key };
  if (!["reported", "blocked"].includes(e.state)) return { ok: false, error: "cannot reject from state " + e.state };
  const note = String(input.note || "").slice(0, 500);
  if (!note) return { ok: false, error: "reject requires --note" };
  const at = nowIso();
  e.state = "blocked";
  e.blockReason = note;
  e.reviews = Array.isArray(e.reviews) ? e.reviews : [];
  e.reviews.push({ by: String(input.by || "you"), verdict: "fail", note, at });
  e.updatedAt = at;
  pushEvent(e, "rejected", input.by || "you", note);
  writeLedger(db);
  return { ok: true, key, entry: e };
}

export function listTasks({ projectId = "", all = true } = {}) {
  const db = readLedger();
  return Object.entries(db.tasks)
    .filter(([, e]) => !projectId || e.projectId === projectId || e.roomId === projectId)
    .filter(([, e]) => all || !TERMINAL.has(e.state))
    .map(([key, e]) => ({ key, ...e }))
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

export function controlCounts(db = readLedger()) {
  const tasks = Object.values(db.tasks);
  const byState = {};
  const byProject = {};
  let active = 0;
  for (const e of tasks) {
    byState[e.state] = (byState[e.state] || 0) + 1;
    const pid = e.projectId || e.roomId || "local";
    byProject[pid] = (byProject[pid] || 0) + 1;
    if (ACTIVE.has(e.state)) active++;
  }
  return { all: tasks.length, active, byState, byProject };
}

// 对外接口：所有写操作走同一把跨进程锁（桌面端与 QQ 端会话共写台账）。
export function claim(roomId, taskId, seq, extra = {}) { return withLedgerLock(() => claimLocked(roomId, taskId, seq, extra)); }
export function setState(key, state, patch = {}) { return withLedgerLock(() => setStateLocked(key, state, patch)); }
export function promote() { return withLedgerLock(() => promoteLocked()); }
export function fail(key, reason = '') { return withLedgerLock(() => failLocked(key, reason)); }
export function watchdog(opts = {}) { return withLedgerLock(() => watchdogLocked(opts)); }
export function addReview(key, opts = {}) { return withLedgerLock(() => addReviewLocked(key, opts)); }
export function markInterrupted() { return withLedgerLock(() => markInterruptedLocked()); }

export function createTask(input = {}) { return withLedgerLock(() => createTaskLocked(input)); }
export function startTask(key, input = {}) { return withLedgerLock(() => startTaskLocked(key, input)); }
export function reportTask(key, input = {}) { return withLedgerLock(() => reportTaskLocked(key, input)); }
export function recordGate(key, result = {}) { return withLedgerLock(() => recordGateLocked(key, result)); }
export function acceptTask(key, input = {}) { return withLedgerLock(() => acceptTaskLocked(key, input)); }
export function rejectTask(key, input = {}) { return withLedgerLock(() => rejectTaskLocked(key, input)); }
export function getTask(key) { return readLedger().tasks[key] || null; }
