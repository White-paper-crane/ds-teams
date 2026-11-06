// 压测：连发 N 条，校验无丢失、无重复、顺序正确。
// 用法: node scripts/stress-100.mjs <roomId> [count] [tag]
// 每条正文带唯一 tag，同一房间可重复跑：校验只认本次 tag 的 N 条。
import fs from "node:fs";
const PORT = (fs.existsSync(new URL("../data/port.txt", import.meta.url)) ? fs.readFileSync(new URL("../data/port.txt", import.meta.url), "utf8") : "").trim() || "8792";
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = fs.readFileSync(new URL("../data/key.txt", import.meta.url), "utf8").trim();
const PKEY = JSON.parse(fs.readFileSync(new URL("../data/people.json", import.meta.url), "utf8")).you.key;
const room = process.argv[2];
if (!room) { console.error("用法: node scripts/stress-100.mjs <roomId> [count] [tag]"); process.exit(2); }
const N = Number(process.argv[3] || 100);
const TAG = process.argv[4] || `S${Date.now().toString(36)}`;
const RE = new RegExp(`^压测 ${TAG} #(\\d+)$`);

const url = (p) => `${BASE}${p}${p.includes("?") ? "&" : "?"}k=${KEY}`;

const t0 = Date.now();
const lat = [];
let fails = 0;
for (let i = 1; i <= N; i++) {
  const s = Date.now();
  const r = await fetch(url(`/api/rooms/${room}/say`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ who: "you", key: PKEY, text: `压测 ${TAG} #${i}` }),
  });
  if (!r.ok) fails++;
  lat.push(Date.now() - s);
}
const sendMs = Date.now() - t0;

const st = await (await fetch(url(`/api/rooms/${room}/messages?since=0`))).json();
const mine = st.messages.filter((m) => RE.test(m.text || ""));
const nums = mine.map((m) => Number(m.text.match(RE)[1]));

const dup = nums.length - new Set(nums).size;
const sorted = nums.every((v, i) => i === 0 || v >= nums[i - 1]);
const missing = [];
for (let i = 1; i <= N; i++) if (!nums.includes(i)) missing.push(i);

lat.sort((a, b) => a - b);
const p50 = lat[Math.floor(N * 0.5)], p95 = lat[Math.floor(N * 0.95)];

console.log(JSON.stringify({
  room, tag: TAG, n: N, sentOk: N - fails, sendFails: fails,
  received: nums.length, dup, sorted, missing: missing.slice(0, 10), missingCount: missing.length,
  totalMs: sendMs, avgMs: Math.round(sendMs / N), p50, p95, maxMs: lat[lat.length - 1],
  verdict: fails === 0 && missing.length === 0 && dup === 0 && sorted && nums.length === N ? "PASS" : "FAIL",
}, null, 2));
