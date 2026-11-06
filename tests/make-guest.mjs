import fs from "node:fs";
// 造一个受邀成员，用来验「新人能不能发言 / 能不能被授予管理员」。
// 用法：node tests/make-guest.mjs <roomId> <nickname>
const BASE = (process.env.DS_TEAMS_URL || "http://127.0.0.1:8792").replace(/\/+$/, "");
const KEY = (process.env.DS_TEAMS_KEY || fs.readFileSync(new URL("../data/key.txt", import.meta.url), "utf8")).trim();
const [roomId = "room-89399a", nick = "真人丙"] = process.argv.slice(2);

const j = async (p, opt = {}) => {
  const url = p.includes("?") ? `${BASE}${p}&k=${KEY}` : `${BASE}${p}?k=${KEY}`;
  const res = await fetch(url, {
    method: opt.method || "GET",
    headers: { "content-type": "application/json", "x-ds-client": "1", ...(opt.headers || {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  return { status: res.status, data, setCookie: res.headers.get("set-cookie") || "" };
};

const owner = { who: "you" }; // key 从 data/people.json 自动补
const inv = await j(`/api/rooms/${roomId}/invite`, { method: "POST", body: owner });
if (!inv.data.ok) { console.log("生成邀请失败", inv.status, inv.data); process.exit(1); }
const token = inv.data.token;
const claim = await j(`/api/invite/${token}/claim`, { method: "POST", body: { name: nick, password: "gs123456" } });
if (!claim.data.ok) { console.log("领取失败", claim.status, claim.data); process.exit(1); }
const sid = (claim.setCookie.match(/sid=([^;]+)/) || [])[1] || "";
const guest = { who: claim.data.id, key: claim.data.key || "" };
const say = await j(`/api/rooms/${roomId}/say`, {
  method: "POST",
  headers: sid ? { cookie: `sid=${sid}` } : {},
  body: { text: `我是${nick}，第一次进来发言。` },
});
console.log(JSON.stringify({
  token,
  guestId: claim.data.id,
  guestName: claim.data.name,
  sid: sid ? sid.slice(0, 8) + "…" : "",
  sidFull: sid,
  say: { status: say.status, ok: say.data.ok, seq: say.data.message && say.data.message.seq, error: say.data.error },
}, null, 1));
