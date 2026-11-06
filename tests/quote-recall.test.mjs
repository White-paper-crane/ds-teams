// 引用 / 撤回 API 测试（零依赖，node 原生 fetch）
// 运行：node tests/quote-recall.test.mjs
// 覆盖：say 带 quoteSeq / 引用不存在 400 / 撤回自己 200 / 撤回别人 403（群主除外）/
//       重复撤回 already / 系统消息不可撤 / 已撤回不可被引用 / 已撤回不进报告统计 / 解散后 409
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
    failures.push({ detail: `${current} / ${name}`, actual });
    console.log(`  FAIL  ${name}`);
    console.log(`        实际: ${JSON.stringify(actual)?.slice(0, 600)}`);
  }
}

async function api(method, p, body) {
  const authed = body?.who || body?.declaredBy;
  if (authed && !body.key) {
    const ppl = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "people.json"), "utf8"));
    body = { ...body, key: (ppl[authed] || {}).key };
  }
  // 房间内容按身份过滤（不是成员就 403）：GET 读房间默认用超管身份
  if (method === "GET" && !/[?&](?:who|mk)=/.test(p) && /^\/api\/(?:rooms|archive)\//.test(p)) {
    const ppl = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "people.json"), "utf8"));
    p += (p.includes("?") ? "&" : "?") + "who=you&key=" + encodeURIComponent((ppl.you || {}).key || "");
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

const roomTitle = `引用撤回测试-${Date.now()}`;

try {
  section("1. 建群");
  let r = await api("POST", "/api/rooms", { title: roomTitle, members: ["me", "you", "daman"], by: "me", declaredBy: "me" });
  check("建群 HTTP 200", r.status === 200, { status: r.status, body: r.data });
  const roomId = r.data?.room?.id;
  check("拿到 room.id", typeof roomId === "string" && roomId.length > 0, r.data?.room);
  if (!roomId) throw new Error("建群失败，后续测试无法继续");

  section("2. say 带 quoteSeq 引用原文");
  r = await api("POST", `/api/rooms/${roomId}/say`, { who: "you", text: "原始消息：看这个" });
  check("原消息发送 200", r.status === 200, { status: r.status, body: r.data });
  const origin = r.data?.message;
  check("原消息有 seq", typeof origin?.seq === "number" && origin.seq > 0, origin);

  r = await api("POST", `/api/rooms/${roomId}/say`, { who: "me", text: "收到，我看看", quoteSeq: origin.seq });
  check("引用消息发送 200", r.status === 200, { status: r.status, body: r.data });
  const quoted = r.data?.message;
  check("引用者带 quote 对象", quoted?.quote?.seq === origin.seq, quoted);
  check("quote 记下被引用者 who", quoted?.quote?.who === "you", quoted?.quote);
  check("quote 记下被引用文本", String(quoted?.quote?.text || "").includes("原始消息"), quoted?.quote);

  r = await api("GET", `/api/rooms/${roomId}`);
  const got = (r.data?.messages || []).find((m) => m.seq === quoted?.seq);
  check("GET 读回仍带 quote", got?.quote?.seq === origin.seq, got);

  section("3. 引用不存在 / 已撤回的消息 → 400");
  r = await api("POST", `/api/rooms/${roomId}/say`, { who: "me", text: "引用幽灵", quoteSeq: 999999 });
  check("引用不存在 400", r.status === 400, { status: r.status, body: r.data });

  section("4. 撤回权限");
  // 权限 v4（2026-11-05）：管理员也能撤回别人的消息（规格二.2「删消息」），
  // 原来这里断言 403 是旧口径「只有群主能撤任何人的」，已作废。
  r = await api("POST", `/api/rooms/${roomId}/say`, { who: "me", text: "这条是小满的" });
  const mine = r.data?.message;
  r = await api("POST", `/api/rooms/${roomId}/recall`, { who: "daman", seq: mine.seq });
  check("管理员撤别人的消息 200（权限 v4）", r.status === 200, { status: r.status, body: r.data });
  check("管理员撤回记 recalledBy=daman", r.data?.message?.recalledBy === "daman", r.data?.message);

  r = await api("POST", `/api/rooms/${roomId}/say`, { who: "me", text: "第二条，留给群主撤" });
  const second = r.data?.message;
  r = await api("POST", `/api/rooms/${roomId}/recall`, { who: "you", seq: second.seq });
  check("群主(you)撤小满的消息 200", r.status === 200, { status: r.status, body: r.data });
  check("撤回后 recalled=true", r.data?.message?.recalled === true, r.data?.message);
  check("撤回后正文清空", r.data?.message?.text === "", r.data?.message);
  check("记下 recalledBy=you", r.data?.message?.recalledBy === "you", r.data?.message);

  r = await api("POST", `/api/rooms/${roomId}/say`, { who: "me", text: "引用已撤回的", quoteSeq: mine.seq });
  check("引用已撤回消息 400", r.status === 400, { status: r.status, body: r.data });

  section("5. 撤回自己的消息 + 重复撤回");
  r = await api("POST", `/api/rooms/${roomId}/say`, { who: "daman", text: "大满自己的话" });
  const own = r.data?.message;
  r = await api("POST", `/api/rooms/${roomId}/recall`, { who: "daman", seq: own.seq });
  check("撤回自己的消息 200", r.status === 200, { status: r.status, body: r.data });
  check("再次撤回返回 already=true", (await api("POST", `/api/rooms/${roomId}/recall`, { who: "daman", seq: own.seq })).data?.already === true, null);

  section("6. 系统消息不可撤回");
  const sys = (await api("GET", `/api/rooms/${roomId}`)).data?.messages?.find((m) => m.kind === "system");
  check("房间里存在 system 消息", !!sys, sys);
  if (sys) {
    r = await api("POST", `/api/rooms/${roomId}/recall`, { who: "you", seq: sys.seq });
    check("撤回系统消息 400", r.status === 400, { status: r.status, body: r.data });
  }

  section("7. 已撤回的报告不进报告统计");
  r = await api("POST", `/api/rooms/${roomId}/report`, { who: "me", text: "一份报告", status: "done" });
  const rep = r.data?.message;
  check("报告发送 200", r.status === 200, { status: r.status, body: r.data });
  const listOne = async () => {
    const ppl = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "people.json"), "utf8"));
    const q = "?who=you&key=" + encodeURIComponent((ppl.you || {}).key || "");
    return (await api("GET", "/api/rooms" + q)).data?.rooms?.find((x) => x.id === roomId);
  };
  let rs = await api("GET", `/api/rooms/${roomId}`);
  check("报告数=1", (await listOne())?.reportCount === 1, await listOne());
  r = await api("POST", `/api/rooms/${roomId}/recall`, { who: "me", seq: rep.seq });
  check("报告撤回 200", r.status === 200, { status: r.status, body: r.data });
  rs = await api("GET", `/api/rooms/${roomId}`);
  check("撤回后报告数=0", (await listOne())?.reportCount === 0, await listOne());
  check("撤回后 reports 数组为空", (rs.data?.reports || []).length === 0, rs.data?.reports);

  section("8. 解散后不可撤回");
  r = await api("POST", `/api/rooms/${roomId}/close`, { who: "you" });
  check("解散 200", r.status === 200, { status: r.status, body: r.data });
  r = await api("POST", `/api/rooms/${roomId}/recall`, { who: "you", seq: origin.seq });
  check("解散后撤回 409", r.status === 409, { status: r.status, body: r.data });
} catch (e) {
  failures.push({ detail: "未捕获异常", actual: String(e && e.stack ? e.stack : e) });
  console.error("\n未捕获异常:", e);
}

console.log(`\n结果：${passed} 通过，${failures.length} 失败`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.detail}: ${JSON.stringify(f.actual)?.slice(0, 300)}`);
  process.exitCode = 1;
}
