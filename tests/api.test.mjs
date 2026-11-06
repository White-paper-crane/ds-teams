// ds-teams API 接口测试（零依赖，node 原生 fetch）
// 运行：node tests/api.test.mjs
// 覆盖：建群 / 四类消息读取 / 未知身份 400 / 解散后 409 / state?since 增量
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.DS_TEAMS_URL || "http://127.0.0.1:8792").replace(/\/+$/, "");
const KEY = (process.env.DS_TEAMS_KEY || fs.readFileSync(path.join(ROOT, "data", "key.txt"), "utf8")).trim();

let passed = 0;
const failures = [];
let current = "";

function section(name) {
  current = name;
  console.log(`\n== ${name} ==`);
}
function check(name, cond, actual) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    const detail = `${current} / ${name}`;
    failures.push({ detail, actual });
    console.log(`  FAIL  ${name}`);
    console.log(`        实际: ${fmt(actual)}`);
  }
}
function fmt(v) {
  try { return JSON.stringify(v)?.slice(0, 600) ?? String(v); } catch { return String(v); }
}

async function api(method, p, body) {
  // 写接口与建群接口都要 who/declaredBy 与 key 匹配，测试里自动补
  const authed = body?.who || body?.declaredBy;
  if (authed && !body.key) {
    const ppl = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "people.json"), "utf8"));
    body = { ...body, key: (ppl[authed] || {}).key };
  }
  // 房间内容按身份过滤（不是成员就 403）：GET 读房间/归档默认用小满（agent）身份
  if (method === "GET" && !/[?&](?:who|mk)=/.test(p) && /^\/api\/(?:rooms|archive)\//.test(p)) {
    p += (p.includes("?") ? "&" : "?") + "who=me&key=" + encodeURIComponent((JSON.parse(fs.readFileSync(path.join(ROOT, "data", "people.json"), "utf8")).me || {}).key || "");
  }
  const res = await fetch(`${BASE}${p}${p.includes("?") ? "&" : "?"}k=${encodeURIComponent(KEY)}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
  return { status: res.status, data };
}

const uniq = `接口测试-${Date.now()}`;

try {
  section("1. POST /api/rooms 建群");
  let r = await api("POST", "/api/rooms", { title: uniq, members: ["me", "daman", "you"], by: "me", declaredBy: "me" });
  check("建群 HTTP 200", r.status === 200, { status: r.status, body: r.data });
  check("返回 ok=true", r.data?.ok === true, r.data);
  check("返回 room.id 非空字符串", typeof r.data?.room?.id === "string" && r.data.room.id.length > 0, r.data?.room);
  check("返回 status=open", r.data?.room?.status === "open", r.data?.room);
  const roomId = r.data?.room?.id;
  if (!roomId) throw new Error("建群失败，拿不到 room.id，后续测试无法继续");

  r = await api("GET", `/api/rooms/${roomId}`);
  check("GET /api/rooms/:id 200", r.status === 200, { status: r.status, body: r.data });
  check("详情里 status=open", r.data?.room?.status === "open", r.data?.room);

  section("2. say / progress / report / review 各发一条并读回");
  const sent = {};

  r = await api("POST", `/api/rooms/${roomId}/say`, { who: "me", text: "大家好，开始干活" });
  check("say HTTP 200", r.status === 200, { status: r.status, body: r.data });
  check("say kind=text", r.data?.message?.kind === "text", r.data?.message);
  check("say text 原样返回", r.data?.message?.text === "大家好，开始干活", r.data?.message);
  sent.say = r.data?.message;

  r = await api("POST", `/api/rooms/${roomId}/progress`, { who: "me", taskId: "t-1", text: "写到一半", percent: 50 });
  check("progress HTTP 200", r.status === 200, { status: r.status, body: r.data });
  check("progress kind=progress", r.data?.message?.kind === "progress", r.data?.message);
  check("progress percent=50", r.data?.message?.percent === 50, r.data?.message);
  check("progress taskId=t-1", r.data?.message?.taskId === "t-1", r.data?.message);
  sent.progress = r.data?.message;

  r = await api("POST", `/api/rooms/${roomId}/report`, {
    who: "daman", taskId: "t-1", title: "阶段报告", status: "done",
    summary: "接口都通了", links: ["http://example.com/r1"],
  });
  check("report HTTP 200", r.status === 200, { status: r.status, body: r.data });
  check("report kind=report", r.data?.message?.kind === "report", r.data?.message);
  check("report title=阶段报告", r.data?.message?.title === "阶段报告", r.data?.message);
  check("report summary 正确", r.data?.message?.text === "接口都通了", r.data?.message);
  check("report links 保留", Array.isArray(r.data?.message?.links) && r.data.message.links[0] === "http://example.com/r1", r.data?.message);
  sent.report = r.data?.message;

  r = await api("POST", `/api/rooms/${roomId}/review`, { who: "you", target: "daman", text: "报告写清楚点" });
  check("review HTTP 200", r.status === 200, { status: r.status, body: r.data });
  check("review kind=review", r.data?.message?.kind === "review", r.data?.message);
  check("review target=daman", r.data?.message?.target === "daman", r.data?.message);
  sent.review = r.data?.message;

  r = await api("GET", `/api/rooms/${roomId}`);
  check("读回房间 HTTP 200", r.status === 200, { status: r.status, body: r.data });
  const msgs = Array.isArray(r.data?.messages) ? r.data.messages : [];
  const byKind = (k) => msgs.filter((m) => m.kind === k);
  check("读回 text 消息存在", byKind("text").some((m) => m.seq === sent.say?.seq), byKind("text"));
  check("读回 progress 消息存在", byKind("progress").some((m) => m.seq === sent.progress?.seq), byKind("progress"));
  check("读回 report 消息存在", byKind("report").some((m) => m.seq === sent.report?.seq), byKind("report"));
  check("读回 review 消息存在", byKind("review").some((m) => m.seq === sent.review?.seq), byKind("review"));
  check("reports 汇总含该报告", (r.data?.reports || []).some((m) => m.seq === sent.report?.seq), r.data?.reports);
  check("progress 汇总含该进度", (r.data?.progress || []).some((m) => m.seq === sent.progress?.seq), r.data?.progress);
  check("reviews 汇总含该互评", (r.data?.reviews || []).some((m) => m.seq === sent.review?.seq), r.data?.reviews);
  const seqs = msgs.map((m) => m.seq);
  check("消息 seq 严格递增", seqs.every((s, i) => i === 0 || s > seqs[i - 1]), seqs);

  section("3. 未知身份 400；已知身份但 key 不对 403");
  r = await api("POST", `/api/rooms/${roomId}/say`, { who: "xxx", text: "我不存在" });
  check("未知身份 say HTTP 400", r.status === 400, { status: r.status, body: r.data });
  check("错误信息为 unknown who", r.data?.error === "unknown who", r.data);
  check("ok=false", r.data?.ok === false, r.data);

  r = await api("POST", `/api/rooms/${roomId}/progress`, { who: "xxx", taskId: "t", text: "x", percent: 1 });
  check("未知身份 progress HTTP 400", r.status === 400, { status: r.status, body: r.data });

  r = await api("POST", `/api/rooms/${roomId}/say`, { who: "me", key: "deadbeef00", text: "冒充小满" });
  check("已知身份 key 错误 403", r.status === 403, { status: r.status, body: r.data });
  check("错误信息为 identity key mismatch", r.data?.error === "identity key mismatch", r.data);

  section("4. POST close 后 status=closed，再发消息 409");
  r = await api("POST", `/api/rooms/${roomId}/close`, { who: "you" });
  check("close HTTP 200", r.status === 200, { status: r.status, body: r.data });
  check("close 后 room.status=closed", r.data?.room?.status === "closed", r.data?.room);

  r = await api("GET", `/api/rooms/${roomId}`);
  check("GET 详情 status=closed", r.data?.room?.status === "closed", r.data?.room);

  r = await api("POST", `/api/rooms/${roomId}/say`, { who: "me", text: "解散后还能说话吗" });
  check("已解散 say HTTP 409", r.status === 409, { status: r.status, body: r.data });
  check("409 错误信息说明房间已关闭", /room (is not open|closed)/.test(String(r.data?.error || "")), r.data);

  r = await api("POST", `/api/rooms/${roomId}/progress`, { who: "me", taskId: "t", text: "x", percent: 1 });
  check("已解散 progress HTTP 409", r.status === 409, { status: r.status, body: r.data });

  // 房间列表现在按身份过滤（受邀者看不到没被拉进去的房间），所以要用带 who/key 的读法
  r = await api("GET", `/api/rooms?who=me&key=${encodeURIComponent((JSON.parse(fs.readFileSync(path.join(ROOT, "data", "people.json"), "utf8")).me || {}).key || "")}`);
  const listed = (r.data?.rooms || []).find((x) => x.id === roomId);
  check("房间列表仍保留该房间（数据不删）", !!listed, listed);
  check("列表里该房间 status=closed", listed?.status === "closed", listed);

  section("5. GET /api/state?since=N 增量");
  const since = sent.say?.seq;
  r = await api("GET", `/api/state?since=${since}`);
  check("state HTTP 200", r.status === 200, { status: r.status, body: r.data });
  const inc = Array.isArray(r.data?.messages) ? r.data.messages : [];
  check("state 返回 seq>since", inc.every((m) => m.seq > since), inc.map((m) => m.seq));
  check("state 不含 since 本身", !inc.some((m) => m.seq === since), inc.map((m) => m.seq));
  const incSeqs = new Set(inc.map((m) => m.seq));
  check("state 含 progress", incSeqs.has(sent.progress?.seq), inc.map((m) => m.seq));
  check("state 含 report", incSeqs.has(sent.report?.seq), inc.map((m) => m.seq));
  check("state 含 review", incSeqs.has(sent.review?.seq), inc.map((m) => m.seq));
  check("state 顶层 seq >= 最新消息 seq", Number(r.data?.seq) >= Math.max(...inc.map((m) => m.seq), since), r.data?.seq);

  r = await api("GET", `/api/state?since=${r.data?.seq}`);
  check("since=当前seq 返回空消息", Array.isArray(r.data?.messages) && r.data.messages.length === 0, r.data?.messages);

  r = await api("GET", `/api/rooms/${roomId}/messages?since=${since}`);
  check("房间增量 messages 200", r.status === 200, { status: r.status, body: r.data });
  check("房间增量只含本房间且 seq>since", (r.data?.messages || []).every((m) => m.roomId === roomId && m.seq > since), r.data?.messages);
} catch (err) {
  failures.push({ detail: "未捕获异常", actual: err?.stack || String(err) });
  console.log(`\n!! 运行异常: ${err?.stack || err}`);
}

console.log(`\n===== 汇总 =====`);
console.log(`通过: ${passed}  失败: ${failures.length}`);
if (failures.length) {
  console.log(`\n失败详情:`);
  for (const f of failures) console.log(`- ${f.detail}\n  实际: ${fmt(f.actual)}`);
  process.exitCode = 1;
} else {
  console.log("全部通过");
}
