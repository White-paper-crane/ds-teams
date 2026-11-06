// 权限 v4 接口回归：角色、能力、解散确认闸、动不了同级。
// 用法：node tests/permission.test.mjs（服务需在 8792 跑着）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const K = fs.readFileSync(path.join(ROOT, "data", "key.txt"), "utf8").trim();
const BASE = "http://127.0.0.1:8792";

let pass = 0, fail = 0;
function ok(cond, name, extra = "") {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  <- " + extra : "")); }
}
async function api(p, opt = {}) {
  const res = await fetch(BASE + p + (p.includes("?") ? "&" : "?") + "k=" + K, {
    ...opt,
    headers: { "content-type": "application/json", "x-ds-client": "1", ...(opt.headers || {}) },
  });
  let body; try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}
const post = (p, body) => api(p, { method: "POST", body: JSON.stringify(body) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 房间详情读接口要身份（不是成员就 403）：测试统一用超管身份读
const roomDetail = (roomId) => api("/api/rooms/" + roomId + "?who=you&key=" + keyOf("you"));

const people = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "people.json"), "utf8"));
const keyOf = (id) => (people[id] || {}).key;
// 普通真人靶子：现拉一个进房，不依赖 people.json 里恰好有测试身份
let human = "";
let humanKey = "";

/** 用邀请链接现拉一个真人进房，返回 { id, key, name } */
async function pullHuman(roomId, name) {
  const inv = await post("/api/rooms/" + roomId + "/invite", { who: "you", key: keyOf("you") });
  const token = (inv.body && inv.body.invite && inv.body.invite.token) || (inv.body && inv.body.token);
  if (!token) throw new Error("invite 没返回 token：" + JSON.stringify(inv.body).slice(0, 200));
  const claim = await api("/api/invite/" + token + "/claim", {
    method: "POST",
    body: JSON.stringify({ name, password: "perm123456" }),
  });
  if (!claim.body || claim.body.ok !== true) throw new Error("claim 失败：" + JSON.stringify(claim.body).slice(0, 200));
  const id = (claim.body.person && claim.body.person.id) || claim.body.id;
  people[id] = { ...(people[id] || {}), key: claim.body.key, kind: "human", status: "active" };
  return { id, key: claim.body.key, name };
}

const created = [];
async function newRoom(title, ownerId) {
  const r = await post("/api/rooms", { title: title + "-" + Date.now(), who: "you", key: keyOf("you"), ownerId });
  created.push(r.body.room.id);
  return r.body.room;
}

/* ---------- 1. 我是谁：超管 vs 管理员 vs 成员 ---------- */
const meSuper = await api("/api/me?who=you&key=" + keyOf("you"));
ok(meSuper.body.isSuper === true, "超管 isSuper=true", JSON.stringify(meSuper.body));
ok(meSuper.body.role === "super", "超管 role=super", meSuper.body.role);
ok((meSuper.body.caps || []).includes("room.create"), "超管有 room.create");
ok((meSuper.body.caps || []).includes("room.archive"), "超管有 room.archive");

const roomA = await newRoom("[自测] 权限矩阵");
// 现拉一个真人进 roomA 当靶子（普通成员）
const pulled = await pullHuman(roomA.id, "权限测试真人-" + Date.now());
human = pulled.id;
humanKey = pulled.key;

const damanInA = await api("/api/me?who=daman&key=" + keyOf("daman") + "&roomId=" + roomA.id);
ok(damanInA.body.role === "admin", "小满/大满在房里默认 admin", damanInA.body.role);
ok(!(damanInA.body.caps || []).includes("room.close"), "管理员没有 room.close");
ok(!(damanInA.body.caps || []).includes("room.create"), "管理员没有 room.create");
ok((damanInA.body.caps || []).includes("member.kick"), "管理员有 member.kick");

const humanInA = await api("/api/me?who=" + human + "&key=" + humanKey + "&roomId=" + roomA.id);
ok(humanInA.body.role === "member", "邀请进来的真人默认 member", humanInA.body.role);
ok(!(humanInA.body.caps || []).includes("member.kick"), "普通成员没有踢人权");

// 房间可见性：受邀者只看得到自己在的房间（GET /api/rooms 按身份过滤）
const humanList = await api("/api/rooms?who=" + human + "&key=" + humanKey);
const humanRoomIds = (humanList.body && humanList.body.rooms || []).map((r) => r.id);
ok(humanRoomIds.includes(roomA.id), "受邀者列表里有自己的房间", JSON.stringify(humanRoomIds));

const wrongKey = await api("/api/me?who=daman&key=deadbeef");
ok(wrongKey.status === 403, "key 不对 → 403", String(wrongKey.status));

/* ---------- 2. 管理员不能解散、不能建房 ---------- */
const damanClose = await post("/api/rooms/" + roomA.id + "/close", { who: "daman", key: keyOf("daman") });
ok(damanClose.status === 403, "管理员解散 → 403", String(damanClose.status));

const humanCreate = await post("/api/rooms", { title: "普通人想建房-" + Date.now(), declaredBy: human, key: humanKey });
ok(humanCreate.status === 403, "普通真人建房 → 403", String(humanCreate.status));

/* ---------- 3. 管理员之间不能互踢 ---------- */
const kickAdmin = await post("/api/rooms/" + roomA.id + "/kick", { who: "daman", key: keyOf("daman"), memberId: "me" });
ok(kickAdmin.status === 403, "管理员踢管理员 → 403", String(kickAdmin.status));
const kickSuper = await post("/api/rooms/" + roomA.id + "/kick", { who: "daman", key: keyOf("daman"), memberId: "you" });
ok(kickSuper.status === 403, "管理员踢超管 → 403", String(kickSuper.status));

// 管理员踢普通成员：允许（human 已经在 roomA 里）
const kickMember = await post("/api/rooms/" + roomA.id + "/kick", { who: "daman", key: keyOf("daman"), memberId: human });
ok(kickMember.status === 200, "管理员踢普通成员 → 200", JSON.stringify(kickMember.body).slice(0, 120));

/* ---------- 4. 解散确认闸：小群主发起 → 超管 5 秒内可拒 ---------- */
const roomB = await newRoom("[自测] 解散确认闸", "daman");
ok(roomB.owner === "daman", "ownerId 生效：小群主=大满", roomB.owner);
const req1 = await post("/api/rooms/" + roomB.id + "/close", { who: "daman", key: keyOf("daman") });
ok(req1.status === 202 && req1.body.pending === true, "小群主解散 → 202 挂起等确认", String(req1.status));
const dup = await post("/api/rooms/" + roomB.id + "/close", { who: "daman", key: keyOf("daman") });
ok(dup.status === 409 || dup.status === 202, "重复发起不会叠两条 pending", String(dup.status));
// 超管在线（先刷 presence）
await api("/api/me?who=you&key=" + keyOf("you"));
const deny = await post("/api/rooms/" + roomB.id + "/close-deny", { who: "you", key: keyOf("you") });
ok(deny.status === 200 && deny.body.verdict === "denied", "超管否决 → 房间保留", JSON.stringify(deny.body).slice(0, 120));
const stillOpen = await roomDetail(roomB.id);
ok(stillOpen.body.room.status === "open", "否决后房间仍是 open", stillOpen.body.room.status);

/* ---------- 5. 超时放行（超管在线时） ---------- */
const req2 = await post("/api/rooms/" + roomB.id + "/close", { who: "daman", key: keyOf("daman") });
ok(req2.status === 202, "再次发起 → 202", String(req2.status));
await api("/api/me?who=you&key=" + keyOf("you")); // 保持超管在线
await sleep(6500);
const afterTimeout = await roomDetail(roomB.id);
ok(afterTimeout.body.room.status === "closed", "5 秒不响应 → 放行解散", afterTimeout.body.room.status);
ok(afterTimeout.body.room.pendingClose.status === "expired", "pending 记为 expired", afterTimeout.body.room.pendingClose.status);

/* ---------- 6. 设/撤管理员：只有小群主与超管 ---------- */
const roomC = await newRoom("[自测] 角色授予");
// 被踢过的真人不能再拉回同一间房（黑名单），换一间房测试授权
await post("/api/rooms/" + roomC.id + "/invite", { who: "you", key: keyOf("you"), memberId: human });
const promoteByAdmin = await post("/api/rooms/" + roomC.id + "/setRole", { who: "daman", key: keyOf("daman"), memberId: human, role: "admin" });
ok(promoteByAdmin.status === 403, "管理员不能再授权管理员 → 403", String(promoteByAdmin.status));
const promoteByOwner = await post("/api/rooms/" + roomC.id + "/setRole", { who: "you", key: keyOf("you"), memberId: human, role: "admin" });
ok(promoteByOwner.status === 200, "小群主授予管理员 → 200", JSON.stringify(promoteByOwner.body).slice(0, 120));
const humanAfter = await api("/api/me?who=" + human + "&key=" + humanKey + "&roomId=" + roomC.id);
ok(humanAfter.body.role === "admin", "授予后 role=admin", humanAfter.body.role);

/* ---------- 清理 ---------- */
for (const id of created) {
  await post("/api/rooms/" + id + "/close", { who: "you", key: keyOf("you") });
  await post("/api/rooms/" + id + "/archive", { who: "you", key: keyOf("you") });
}

console.log("\npass " + pass + " / fail " + fail);
process.exit(fail ? 1 : 0);
