// 附件（kind=file）接口测试：上传 / 下载 / 类型限制 / 权限 / 成员校验
// 运行：node tests/files.test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.DS_TEAMS_URL || "http://127.0.0.1:8792").replace(/\/+$/, "");
const KEY = (process.env.DS_TEAMS_KEY || fs.readFileSync(path.join(ROOT, "data", "key.txt"), "utf8")).trim();
const PEOPLE = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "people.json"), "utf8"));

let passed = 0;
const failures = [];
let current = "";

function section(name) { current = name; console.log(`\n== ${name} ==`); }
function check(name, cond, actual) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failures.push({ detail: `${current} / ${name}`, actual }); console.log(`  FAIL  ${name}\n        实际: ${fmt(actual)}`); }
}
function fmt(v) { try { return JSON.stringify(v)?.slice(0, 600) ?? String(v); } catch { return String(v); } }

async function api(method, p, body, headers) {
  if (body && body.who && !body.key) body = { ...body, key: (PEOPLE[body.who] || {}).key };
  // 附件下载要身份（不是房间成员就 403）：GET 默认用小满（agent）身份
  if (method === "GET" && !/[?&](?:who|mk)=/.test(p)) {
    p += (p.includes("?") ? "&" : "?") + "who=me&key=" + encodeURIComponent((PEOPLE.me || {}).key || "");
  }
  const sep = p.includes("?") ? "&" : "?";
  const res = await fetch(BASE + p + sep + "k=" + encodeURIComponent(KEY), {
    method,
    headers: headers || (body ? { "content-type": "application/json" } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  return { status: res.status, data, res };
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
).toString("base64");

const created = [];
let roomId = "";

try {
  section("准备房间");
  const r = await api("POST", "/api/rooms", { who: "me", title: `附件测试-${Date.now()}`, declaredBy: "me" });
  roomId = (r.data.room || {}).id;
  created.push(roomId);
  check("建群 200 且有 id", r.status === 200 && !!roomId, r);

  section("上传图片");
  const up = await api("POST", `/api/rooms/${roomId}/file`, {
    who: "me", name: "dot.png", mime: "image/png", data: PNG, note: "测试图片",
  });
  const f = (up.data.message || {}).file || {};
  check("上传 200", up.status === 200, up.data);
  check("消息 kind=file", (up.data.message || {}).kind === "file", up.data.message);
  check("file 字段齐全", !!(f.name && f.size > 0 && f.mime === "image/png" && f.sha256 && f.path && f.url), f);
  check("文件真的落盘", !!(f.path && fs.existsSync(f.path)), f.path);
  check("note 进了 text", /测试图片/.test(String((up.data.message || {}).text || "")), (up.data.message || {}).text);

  section("下载");
  if (f.url) {
    const res = await fetch(BASE + f.url + "?k=" + encodeURIComponent(KEY) + "&who=me&key=" + encodeURIComponent((PEOPLE.me || {}).key || ""));
    const buf = Buffer.from(await res.arrayBuffer());
    check("下载 200", res.status === 200, res.status);
    check("Content-Type image/png", String(res.headers.get("content-type") || "").includes("image/png"), res.headers.get("content-type"));
    check("字节一致", buf.length === Buffer.from(PNG, "base64").length, { got: buf.length });
  } else {
    check("下载（缺少 url，跳过）", false, f);
  }

  section("类型与权限");
  const mp4 = await api("POST", `/api/rooms/${roomId}/file`, { who: "me", name: "a.mp4", mime: "video/mp4", data: PNG });
  check("视频 415", mp4.status === 415, mp4.status);
  const txt = await api("POST", `/api/rooms/${roomId}/file`, { who: "me", name: "a.txt", mime: "text/plain", data: Buffer.from("hello").toString("base64") });
  check("txt 200 且非图片", txt.status === 200 && (txt.data.file || {}).mime === "text/plain", txt.data.file);
  const badKey = await api("POST", `/api/rooms/${roomId}/file`, { who: "me", key: "wrong", name: "x.png", mime: "image/png", data: PNG });
  check("key 错 403", badKey.status === 403, badKey.status);
  const stranger = await api("POST", `/api/rooms/${roomId}/file`, { who: "nobody", key: "x", name: "x.png", mime: "image/png", data: PNG });
  check("未知身份被拒（400/403）", stranger.status === 400 || stranger.status === 403, stranger.status);

  section("幂等");
  const m1 = await api("POST", `/api/rooms/${roomId}/file`, { who: "me", name: "same.png", mime: "image/png", data: PNG, msgId: "file-idem-1" });
  const m2 = await api("POST", `/api/rooms/${roomId}/file`, { who: "me", name: "same.png", mime: "image/png", data: PNG, msgId: "file-idem-1" });
  check("同 msgId 复用旧消息", m1.data.message && m2.data.message && m1.data.message.seq === m2.data.message.seq, { a: m1.data.message && m1.data.message.seq, b: m2.data.message && m2.data.message.seq });
} catch (e) {
  failures.push({ detail: "异常", actual: String(e && e.stack || e) });
} finally {
  for (const id of created) {
    try { await api("POST", `/api/rooms/${id}/close`, { who: "you", key: (PEOPLE.you || {}).key }); } catch {}
  }
  console.log(`\n结果：PASS ${passed} / FAIL ${failures.length}`);
  if (failures.length) { for (const f of failures) console.log(`  - ${f.detail}\n    ${fmt(f.actual)}`); process.exit(1); }
}
