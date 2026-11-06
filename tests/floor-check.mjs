#!/usr/bin/env node
// ds-teams · 话筒（发言权）审计 · 零依赖
//
// 用法：
//   node tests/floor-check.mjs room-5c8a80
//   node tests/floor-check.mjs room-5c8a80 --api
//   node tests/floor-check.mjs room-5c8a80 --api --base http://127.0.0.1:8792 --key <platform-key>
//   node tests/floor-check.mjs room-5c8a80 --file data/rooms.json --pretty=false
//   node tests/floor-check.mjs room-5c8a80 --strict     # 有违规时退出码 1
//
// 输出（stdout，单个 JSON）：{ room, checked, violations:[{seq, who, rule, evidence}] }
// rule ∈ 抢答 | 连发 | 未@抢话；evidence 为一句可核对的中文证据。
// 退出码：0 正常；1 --strict 且存在违规；2 参数/数据错误。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEF_FILE = path.join(ROOT, "..", "data", "rooms.json");
const DEF_KEY = path.join(ROOT, "..", "data", "key.txt");

const opt = {
  room: "room-5c8a80",
  file: DEF_FILE,
  api: false,
  base: "http://127.0.0.1:8792",
  key: "",
  lease: 90,
  burstWindow: 120,
  answerWindow: 300,
  now: null,
  pretty: true,
  strict: false,
};

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const val = () => String(argv[++i] ?? "");
  if (a === "--api") opt.api = true;
  else if (a === "--file") opt.file = val();
  else if (a === "--base") opt.base = val();
  else if (a === "--key") opt.key = val();
  else if (a === "--lease") opt.lease = Number(val());
  else if (a === "--burst-window") opt.burstWindow = Number(val());
  else if (a === "--answer-window") opt.answerWindow = Number(val());
  else if (a === "--now") opt.now = val();
  else if (a === "--pretty") opt.pretty = true;                      // 布尔开关，绝不吞下一个参数
  else if (a.startsWith("--pretty=")) opt.pretty = a.slice(9).toLowerCase() !== "false";
  else if (a === "--strict") opt.strict = true;
  else if (a === "-h" || a === "--help") { console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 14).join("\n")); process.exit(0); }
  else if (!a.startsWith("--")) opt.room = a;
  else { console.error(`未知参数：${a}`); process.exit(2); }
}

const WHO_NAME = { you: "you(群主)", me: "me(小满)", daman: "daman(大满)" };
const SPEECH = new Set(["text", "review", "confirm"]); // 发言类；progress/report/ack/task/system 是记录
const ALIASES = [
  ["群主", "you"], ["小满", "me"], ["大满", "daman"], ["群主", "you"], ["你", "you"],
  ["daman", "daman"], ["me", "me"], ["you", "you"],
];
const MENTION_SRC = "[@＠]\\s*(群主|小满|大满|群主|你(?!们)|me(?![a-z])|daman(?![a-z])|you(?![a-z]))";

function mentions(text) {
  const out = new Set();
  const re = new RegExp(MENTION_SRC, "gi");
  const s = String(text || "");
  let m;
  while ((m = re.exec(s))) {
    const hit = ALIASES.find(([n]) => n.toLowerCase() === m[1].toLowerCase());
    if (hit) out.add(hit[1]);
  }
  return out;
}

function isSupplement(text) {
  return /^\s*(【\s*补充|\[\s*补充|补充)/.test(String(text || ""));
}

function isQuestion(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return false;
  if (/[?？]/.test(s)) return true;
  if (/(吗|呢|么|嘛)\s*[。.!！…]?$/.test(s)) return true;
  if (/(是否|能否|有没有|要不要|谁|哪个|哪里|怎么|如何|为什么|多久|几点|多少|回一句|回个话|回答|回复|答复|确认一下|请确认|收到请回)/.test(s)) return true;
  return false;
}

function assignees(text, base) {
  const out = new Set(base);
  const s = String(text || "");
  for (const [name, id] of [["小满", "me"], ["大满", "daman"]]) {
    if (new RegExp(`${name}\\s*(负责|来做|去做|来答|先|处理|跟进|写|改|查)`).test(s)) out.add(id);
    if (new RegExp(`由\\s*${name}`).test(s)) out.add(id);
    if (new RegExp(`指派给\\s*${name}`).test(s)) out.add(id);
  }
  return out;
}

function names(set) {
  return [...set].map((id) => WHO_NAME[id] || id).join("、");
}

async function load() {
  if (opt.api) {
    let key = opt.key;
    if (!key) {
      try { key = fs.readFileSync(DEF_KEY, "utf8").trim(); } catch { key = ""; }
    }
    const url = `${opt.base.replace(/\/$/, "")}/api/state?k=${encodeURIComponent(key)}&since=0`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`API ${r.status}：${await r.text().catch(() => "")}`);
    const j = await r.json();
    return { rooms: j.rooms || [], messages: j.messages || [], source: url.replace(/k=[^&]*/, "k=***") };
  }
  let raw = fs.readFileSync(opt.file, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const db = JSON.parse(raw);
  return { rooms: db.rooms || [], messages: db.messages || [], source: opt.file };
}

function floorHolderAt(room, msgs, t) {
  const f = room && room.floor;
  if (!f || !f.holder) return null;
  const since = Date.parse(f.since || 0) || 0;
  if (!since || t < since) return null;
  let last = since;
  for (const m of msgs) {
    if (m.kind !== "text" || m.who !== f.holder) continue;
    const mt = Date.parse(m.ts || 0) || 0;
    if (mt <= t && mt > last) last = mt;
  }
  if (t - last >= opt.lease * 1000) return null; // 该时刻已 90s 无发言，惰性回收
  return f.holder;
}

function audit(msgs, room) {
  const violations = [];
  const seen = new Set();
  const add = (seq, who, rule, evidence) => {
    const k = `${seq}|${rule}`;
    if (seen.has(k)) return;
    // 同一句同时命中时保留更具体的规则：抢答 > 未@抢话（连发与未@抢话互斥）
    if (rule === "未@抢话" && (seen.has(`${seq}|抢答`) || seen.has(`${seq}|连发`))) return;
    seen.add(k);
    violations.push({ seq, who, rule, evidence });
  };

  let sorted = [...msgs].sort((a, b) => a.seq - b.seq);
  if (opt.now) {
    const cut = Date.parse(opt.now);
    if (!Number.isFinite(cut)) throw new Error(`--now 不是合法时间：${opt.now}`);
    sorted = sorted.filter((m) => (Date.parse(m.ts || 0) || 0) <= cut); // 回放：只看该时刻之前
  }
  const prevNonSystem = (i) => {
    for (let k = i - 1; k >= 0; k--) if (sorted[k].who !== "system" && sorted[k].kind !== "system") return sorted[k];
    return null;
  };

  // 规则 7：连发（同一 who 相邻两条发言，中间无他人消息，间隔 < burstWindow）
  const speech = sorted.filter((m) => SPEECH.has(m.kind) && m.who !== "system");
  for (let i = 1; i < speech.length; i++) {
    const a = speech[i - 1], b = speech[i];
    if (a.who !== b.who) continue;
    const gap = (Date.parse(b.ts) - Date.parse(a.ts)) / 1000;
    if (!(gap >= 0 && gap < opt.burstWindow)) continue;
    const intruder = sorted.filter((m) => m.seq > a.seq && m.seq < b.seq && m.who !== "system" && m.who !== b.who);
    if (intruder.length) continue;
    const extra = sorted.filter((m) => m.seq > a.seq && m.seq < b.seq && m.who === b.who).length;
    add(b.seq, b.who, "连发",
      `#${a.seq}→#${b.seq} 间隔 ${gap.toFixed(1)}s，中间无他人发言${extra ? `（本人另有 ${extra} 条记录）` : ""}`);
  }

  // 规则 8：抢答（问题指定了 A，B 先答）
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    if (p.who === "system" || !SPEECH.has(p.kind) || !isQuestion(p.text)) continue;
    const targets = assignees(p.text, mentions(p.text));
    if (!targets.size) continue; // 无 @、无指派 = 开放问题
    for (let j = i + 1; j < sorted.length; j++) {
      const m = sorted[j];
      if (m.who === "system") continue;
      const dt = Date.parse(m.ts) - Date.parse(p.ts);
      if (dt > opt.answerWindow * 1000) break;
      if (!SPEECH.has(m.kind) || m.who === p.who) continue;
      if (targets.has(m.who)) break; // 指定对象已答，问题关闭
      if (isSupplement(m.text)) continue; // 补充不算回答，继续等指定对象
      add(m.seq, m.who, "抢答",
        `问题 #${p.seq} 指定 ${names(targets)}，首个回答者 ${WHO_NAME[m.who] || m.who}（${(dt / 1000).toFixed(0)}s 内）`);
      break;
    }
  }

  // 规则 6：未@抢话（上一条 @ 了别人，第三方插话；或话筒被他人持有）
  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i];
    if (m.who === "system" || !SPEECH.has(m.kind)) continue;
    const p = prevNonSystem(i);
    if (!p || p.who === m.who) continue;
    const pm = mentions(p.text);
    if (pm.size && !pm.has(m.who) && !isSupplement(m.text)) {
      add(m.seq, m.who, "未@抢话",
        `#${p.seq} 点名 ${names(pm)}，${WHO_NAME[m.who] || m.who} 未被 @ 直接接话`);
    }
  }

  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i];
    if (m.who === "system" || !SPEECH.has(m.kind)) continue;
    const holder = floorHolderAt(room, sorted, Date.parse(m.ts || 0));
    if (!holder || m.who === holder) continue;
    const p = prevNonSystem(i);
    const pm = p ? mentions(p.text) : new Set();
    if (pm.has(m.who) || isSupplement(m.text)) continue; // @ 视为隐式接话权；补充合规
    add(m.seq, m.who, "未@抢话",
      `#${m.seq} 发言时话筒由 ${WHO_NAME[holder] || holder} 持有（${opt.lease}s 租约内），${WHO_NAME[m.who] || m.who} 未被 @ 插话`);
  }

  violations.sort((a, b) => a.seq - b.seq || a.rule.localeCompare(b.rule, "zh"));
  return violations;
}

try {
  const db = await load();
  const msgs = db.messages.filter((m) => m.roomId === opt.room);
  const room = db.rooms.find((r) => r.id === opt.room) || null;
  if (!room && !msgs.length) throw new Error(`房间 ${opt.room} 不存在或没有消息（数据源：${db.source}）`);
  const violations = audit(msgs, room);
  const out = { room: opt.room, checked: msgs.length, violations };
  console.log(JSON.stringify(out, null, opt.pretty ? 2 : 0));
  if (opt.strict && violations.length) process.exit(1);
} catch (e) {
  console.error(`floor-check 失败：${e && e.message ? e.message : e}`);
  process.exit(2);
}
