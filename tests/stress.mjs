// ds-teams 房间消息压测（零依赖，Node >= 20，内置 fetch）
// 用法：node tests/stress.mjs [--base http://127.0.0.1:8792] [--key <k>] [--n 100] [--conc 10]
// 行为：新建临时房间 → 并发发 N 条 stress-<i> → GET since=0 全量校验 → 打印一行 JSON。
// 不关闭房间。结果 JSON 走 stdout，诊断/房间 id 走 stderr。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
function readSafe(p) {
  try { return fs.readFileSync(p, "utf8").trim(); } catch { return ""; }
}
function flag(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? String(process.argv[i + 1] ?? dflt) : dflt;
}

const PORT = readSafe(path.join(DATA, "port.txt")) || "8792";
const BASE = (flag("base", "") || process.env.DS_TEAMS_BASE || `http://127.0.0.1:${PORT}`).replace(/\/+$/, "");
const KEY = flag("key", "") || process.env.DS_TEAMS_KEY || readSafe(path.join(DATA, "key.txt"));
const N = Math.max(1, Number(flag("n", "100")) || 100);
const CONC = Math.max(1, Math.min(N, Number(flag("conc", "10")) || 10));
const TIMEOUT_MS = 15_000;

function localStamp(d = new Date()) {
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
const r2 = (x) => Math.round(x * 100) / 100;

async function api(method, pathname, body) {
  // 写接口与建群接口都要 who/declaredBy 与 key 匹配，测试里自动补
  const authed = body?.who || body?.declaredBy;
  if (authed && !body.key) {
    const ppl = JSON.parse(readSafe(path.join(DATA, "people.json")) || "{}");
    body = { ...body, key: (ppl[authed] || {}).key };
  }
  const url = `${BASE}${pathname}${pathname.includes("?") ? "&" : "?"}k=${encodeURIComponent(KEY)}`;
  const t0 = performance.now();
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  const ms = performance.now() - t0;
  let data = null;
  try { data = JSON.parse(text); } catch {}
  // 房间类接口成功时带 ok:true；GET 列表接口不带 ok 字段，按 HTTP 状态判断
  const ok = res.ok && (data === null || data.ok !== false);
  return { status: res.status, ok, data, ms, raw: text };
}

// 1) 新建临时房间
const title = `压测-${localStamp()}`;
const created = await api("POST", "/api/rooms", { title, creator: "you", declaredBy: "me" });
const roomId = created.data?.room?.id;
if (!created.ok || !roomId) {
  console.error(`创建房间失败：HTTP ${created.status} ${created.raw.slice(0, 500)}`);
  console.log(JSON.stringify({ sent: 0, got: 0, missing: [], dup: [], ordered: false, maxLatencyMs: 0, p95LatencyMs: 0, ok: false }));
  process.exit(2);
}

// 2) 并发发 N 条（并发 CONC），逐条测延迟
const latencies = [];
const sendErrors = [];
let sent = 0;
let cursor = 0;
async function sender() {
  for (;;) {
    const i = ++cursor;
    if (i > N) return;
    const text = `stress-${i}`;
    try {
      const r = await api("POST", `/api/rooms/${roomId}/say`, { who: "you", text });
      latencies.push(r.ms);
      if (r.status === 200 && r.data?.ok === true) sent++;
      else sendErrors.push(`#${i} HTTP ${r.status} ${r.raw.slice(0, 200)}`);
    } catch (e) {
      sendErrors.push(`#${i} ${e?.name || "Error"}: ${e?.message || e}`);
    }
  }
}
await Promise.all(Array.from({ length: CONC }, sender));

// 3) 拉全量并校验
const fetched = await api("GET", `/api/rooms/${roomId}/messages?since=0`);
const all = Array.isArray(fetched.data?.messages) ? fetched.data.messages : [];
const RE = /^stress-(\d+)$/;
const counts = new Map(); // 序号 -> 出现次数
for (const m of all) {
  if (!m || m.kind !== "text" || m.who !== "you") continue;
  const mm = RE.exec(String(m.text ?? ""));
  if (!mm) continue;
  const idx = Number(mm[1]);
  if (idx < 1 || idx > N) continue;
  counts.set(idx, (counts.get(idx) || 0) + 1);
}
const got = [...counts.values()].reduce((a, b) => a + b, 0);
const missing = [];
for (let i = 1; i <= N; i++) if (!counts.has(i)) missing.push(i);
const dup = [...counts.entries()].filter(([, c]) => c > 1).map(([i]) => i).sort((a, b) => a - b);

let ordered = true;
for (let i = 1; i < all.length; i++) {
  if (!(Number(all[i]?.seq) > Number(all[i - 1]?.seq))) { ordered = false; break; }
}

// 4) 汇总
const sorted = latencies.slice().sort((a, b) => a - b);
const maxLatencyMs = sorted.length ? r2(sorted[sorted.length - 1]) : 0;
const p95LatencyMs = sorted.length ? r2(sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]) : 0;
const ok = sent === N && got === N && missing.length === 0 && dup.length === 0 && ordered && fetched.ok;

const result = { sent, got, missing, dup, ordered, maxLatencyMs, p95LatencyMs, ok };
console.log(JSON.stringify(result));

// 5) 房间保留不关闭；房间 id 与诊断走 stderr
console.error(`roomId=${roomId}`);
console.error(`roomUrl=${BASE}/?k=${KEY}`);
console.error(`title=${title} httpStatus=${fetched.status} messagesTotal=${all.length} stressMatched=${got}`);
if (sendErrors.length) console.error(`sendErrors(${sendErrors.length})=${JSON.stringify(sendErrors.slice(0, 10))}`);
process.exitCode = ok ? 0 : 1;
