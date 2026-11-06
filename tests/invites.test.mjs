// 邀请链接 v2 真服务测试：一人一链 / 认名不认人 / 退出空出 / 被踢即死 / 归档 scrub
// 用法：node tests/invites.test.mjs   （需要 8792 在跑）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = process.env.DS_TEAMS_BASE || "http://127.0.0.1:8792";
const KEY = fs.readFileSync(path.join(ROOT, "data", "key.txt"), "utf8").trim();
const PEOPLE = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "people.json"), "utf8"));
const keyOf = (id) => PEOPLE[id].key;

let pass = 0;
let fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  ← " + extra : "")); }
};
const api = async (p, opt = {}) => {
  const r = await fetch(BASE + p + (p.includes("?") ? "&" : "?") + "k=" + KEY, {
    ...opt,
    headers: { "content-type": "application/json", "x-ds-client": "1", ...(opt.headers || {}) },
  });
  let body = null;
  try { body = await r.json(); } catch {}
  return { status: r.status, body };
};

const stamp = Date.now();
const created = await api("/api/rooms", {
  method: "POST",
  body: JSON.stringify({ title: "邀请链接自测-" + stamp, declaredBy: "you", key: keyOf("you") }),
});
const roomId = created.body.room.id;
ok(created.status === 200, "建测试房", JSON.stringify(created.body).slice(0, 120));

// 1. 生成链接
const inv = await api(`/api/rooms/${roomId}/invite`, { method: "POST", body: JSON.stringify({ who: "you", key: keyOf("you") }) });
ok(inv.status === 200 && inv.body.token, "生成一次性邀请链接", JSON.stringify(inv.body).slice(0, 120));
const token = inv.body.token;
ok(String(inv.body.url).includes("/i/" + token), "链接指向 /i/<token>", inv.body.url);

// 2. 落地页可打开
const page = await fetch(BASE + "/i/" + token + "?k=" + KEY);
const html = await page.text();
ok(page.status === 200 && html.includes("加入房间"), "落地页 200 且是昵称页", String(page.status));

// 3. 认名不认人：输昵称入场
const c1 = await api(`/api/invite/${token}/claim`, { method: "POST", body: JSON.stringify({ name: "阿甲" }) });
ok(c1.status === 200 && c1.body.id && c1.body.key, "输昵称入场拿到身份", JSON.stringify(c1.body).slice(0, 160));
ok(c1.body.role === "member", "受邀者强制普通成员", c1.body.role);
const a1 = c1.body;

// 4. 同名再占 → 409
const c2 = await api(`/api/invite/${token}/claim`, { method: "POST", body: JSON.stringify({ name: "阿甲" }) });
ok(c2.status === 409, "同名再占被拒 409", String(c2.status));

// 5. 主动退出 → 链接空出
const lv = await api(`/api/rooms/${roomId}/leave`, { method: "POST", body: JSON.stringify({ who: a1.id, key: a1.key }) });
ok(lv.status === 200, "主动退出 200", JSON.stringify(lv.body).slice(0, 120));
const infoAfter = await api(`/api/invite/${token}`);
ok(infoAfter.body.status === "open" && infoAfter.body.seatName === "阿甲", "退出后链接空出且保留座位名", JSON.stringify(infoAfter.body));

// 6. 同昵称继承（且换新 key）
const c3 = await api(`/api/invite/${token}/claim`, { method: "POST", body: JSON.stringify({ name: "阿甲" }) });
ok(c3.status === 200 && c3.body.reclaimed === true, "同昵称继承原座位", JSON.stringify(c3.body).slice(0, 160));
ok(c3.body.id === a1.id, "继承复用同一身份 id", c3.body.id);
ok(c3.body.key !== a1.key, "继承重签底层 key（旧 key 作废）", "key 未变");
const a2 = c3.body;
const oldKeySay = await api(`/api/rooms/${roomId}/say`, { method: "POST", body: JSON.stringify({ who: a1.id, key: a1.key, text: "旧钥匙" }) });
ok(oldKeySay.status === 403, "旧 key 已失效 403", String(oldKeySay.status));

// 7. 被踢 → 链接报废 + 名字进黑名单
const kick = await api(`/api/rooms/${roomId}/kick`, { method: "POST", body: JSON.stringify({ who: "you", key: keyOf("you"), memberId: a2.id }) });
ok(kick.status === 200, "踢人成功", JSON.stringify(kick.body).slice(0, 120));
const dead = await api(`/api/invite/${token}`);
ok(dead.status === 410, "被踢后链接 410 作废", String(dead.status));
const c4 = await api(`/api/invite/${token}/claim`, { method: "POST", body: JSON.stringify({ name: "阿甲" }) });
ok(c4.status === 410, "作废链接不能再 claim", String(c4.status));

// 8. 新链接 + 黑名单名字 → 403
const inv2 = await api(`/api/rooms/${roomId}/invite`, { method: "POST", body: JSON.stringify({ who: "you", key: keyOf("you") }) });
const c5 = await api(`/api/invite/${inv2.body.token}/claim`, { method: "POST", body: JSON.stringify({ name: "阿甲" }) });
ok(c5.status === 403, "黑名单名字换新链接也进不来 403", String(c5.status));
const c6 = await api(`/api/invite/${inv2.body.token}/claim`, { method: "POST", body: JSON.stringify({ name: "阿乙" }) });
ok(c6.status === 200, "换个名字可以进", String(c6.status));

// 9. 名字校验
const bad = await api(`/api/invite/${inv2.body.token}/claim`, { method: "POST", body: JSON.stringify({ name: "  " }) });
ok(bad.status === 400, "空昵称 400", String(bad.status));

// 10. 归档 scrub：人名/id/邀请全清，消息保留
await api(`/api/rooms/${roomId}/close`, { method: "POST", body: JSON.stringify({ who: "you", key: keyOf("you") }) });
const ar = await api(`/api/rooms/${roomId}/archive`, { method: "POST", body: JSON.stringify({ who: "you", key: keyOf("you") }) });
ok(ar.status === 200, "归档 200", JSON.stringify(ar.body).slice(0, 120));
const fp = path.join(ROOT, "data", "archive", roomId + ".json");
const saved = JSON.parse(fs.readFileSync(fp, "utf8"));
ok(saved.schema === 2 && saved.room.scrubbed === true, "归档文件标记 scrubbed", String(saved.schema));
ok(Array.isArray(saved.room.members) && saved.room.members.length === 0, "归档后成员名单清空", JSON.stringify(saved.room.members));
ok(Object.keys(saved.room.invites || {}).length === 0, "归档后邀请记录清空");
ok(Object.keys(saved.room.roles || {}).length === 0, "归档后角色表清空");
ok(saved.room.owner === "", "归档后 owner 清空", String(saved.room.owner));
ok(Array.isArray(saved.messages) && saved.messages.length > 0, "消息保留供审计", String((saved.messages || []).length));
ok(!JSON.stringify(saved.room).includes("阿乙"), "归档房间记录里不含人名");
const peopleAfter = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "people.json"), "utf8"));
ok(!peopleAfter[a2.id], "邀请来的临时身份已从 people.json 清掉", a2.id);

// 11. 还原：只剩超管
const rs = await api(`/api/archive/${roomId}/restore`, { method: "POST", body: JSON.stringify({ who: "you", key: keyOf("you") }) });
ok(rs.status === 200 && rs.body.room.owner === "you", "还原后 owner 归超管", JSON.stringify(rs.body).slice(0, 120));
ok(rs.body.room.members.length === 1 && rs.body.room.members[0] === "you", "还原后只剩超管一人", JSON.stringify(rs.body.room.members));

// 清理
await api(`/api/rooms/${roomId}/close`, { method: "POST", body: JSON.stringify({ who: "you", key: keyOf("you") }) });
await api(`/api/rooms/${roomId}/archive`, { method: "POST", body: JSON.stringify({ who: "you", key: keyOf("you") }) });

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
