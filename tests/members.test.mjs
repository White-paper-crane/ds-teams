// 成员体系回归测试：people / invite / join / kick / rules / 成员校验 / 任务卡字段
// 用法：node tests/members.test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const K = fs.readFileSync(path.join(ROOT, "data", "key.txt"), "utf8").trim();
const BASE = "http://127.0.0.1:8792";

let pass = 0, fail = 0;
function ok(cond, name, extra = "") {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  ← " + extra : "")); }
}
async function api(p, opt = {}) {
  const res = await fetch(BASE + p + (p.includes("?") ? "&" : "?") + "k=" + K, {
    ...opt,
    headers: { "content-type": "application/json", "x-ds-client": "1", ...(opt.headers || {}) },
  });
  let body; try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

const people = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "people.json"), "utf8"));
const keyOf = (id) => (people[id] || {}).key;

// 测试房：由小满声明建群（声明方必须与 key 匹配）
const created = await api("/api/rooms", {
  method: "POST",
  body: JSON.stringify({ title: "成员体系自测-" + Date.now(), declaredBy: "me", key: keyOf("me") }),
});
ok(created.status === 200, "建测试房 200", JSON.stringify(created.body));
const roomId = created.body.room.id;
ok((created.body.room.members || []).includes("you"), "新房默认含群主", JSON.stringify(created.body.room.members));
const defMembers = [...(created.body.room.members || [])].sort().join(",");
ok(defMembers === "daman,me,you", "新房默认恰好三名管理员，不把自测真人塞进来", defMembers);
ok(created.body.room.owner === "you", "群主恒为 you（即使由小满声明建群）", String(created.body.room.owner));
ok(created.body.room.createdBy === "me", "createdBy 只记代建方，不影响群主", String(created.body.room.createdBy));

// 大满代建、且 members 里故意不写 you：群主仍是 you，且强制入列
const byDaman = await api("/api/rooms", {
  method: "POST",
  body: JSON.stringify({ title: "成员体系-大满代建-" + Date.now(), declaredBy: "daman", key: keyOf("daman"), members: ["me", "daman"] }),
});
ok(byDaman.status === 200, "大满代建测试房 200", JSON.stringify(byDaman.body));
ok(byDaman.body.room.owner === "you", "大满代建也把 owner 归为 you", String(byDaman.body.room.owner));
ok(byDaman.body.room.members.includes("you"), "大满代建也强制把群主加入成员", JSON.stringify(byDaman.body.room.members));
// 测完即收拾：解散 + 归档，别把测试房留在主列表里
const byDamanId = byDaman.body.room.id;
await api(`/api/rooms/${byDamanId}/close`, { method: "POST", body: JSON.stringify({ who: "you", key: keyOf("you") }) });
await api(`/api/rooms/${byDamanId}/archive`, { method: "POST", body: JSON.stringify({ who: "you", key: keyOf("you") }) });

// 开通真人身份
const p1 = await api("/api/people", { method: "POST", body: JSON.stringify({ who: "you", key: keyOf("you"), name: "自测真人", kind: "human" }) });
ok(p1.status === 200 && p1.body.key, "开通真人身份并返回一次性 key", JSON.stringify(p1.body).slice(0, 200));

// 邀请 + 入场（2026-11-05 起：一人一链、认名不认人）
const inv = await api(`/api/rooms/${roomId}/invite`, { method: "POST", body: JSON.stringify({ who: "you", key: keyOf("you") }) });
ok(inv.status === 200 && inv.body.token && inv.body.url.includes("/i/"), "生成一次性邀请链接", JSON.stringify(inv.body).slice(0, 160));
const token = inv.body.token;
const info = await api(`/api/invite/${token}`);
ok(info.status === 200 && info.body.roomId === roomId && info.body.status === "open", "邀请信息只回房名与状态", JSON.stringify(info.body).slice(0, 160));
const claim = await api(`/api/invite/${token}/claim`, { method: "POST", body: JSON.stringify({ name: "入场真人" }) });
ok(claim.status === 200 && claim.body.key && claim.body.role === "member", "输昵称入场并拿到身份", JSON.stringify(claim.body).slice(0, 200));
const hId = claim.body.id;
const hKey = claim.body.key;
const shown = await api(`/api/me?who=${encodeURIComponent(hId)}&key=${encodeURIComponent(hKey)}&roomId=${encodeURIComponent(roomId)}`);
ok(shown.body.isMember === true && shown.body.role === "member", "入场后是成员且角色为普通成员", JSON.stringify(shown.body).slice(0, 200));
const again = await api(`/api/invite/${token}/claim`, { method: "POST", body: JSON.stringify({ name: "入场真人" }) });
ok(again.status === 409, "同名再占一次被拒（409 ID 被占用）", String(again.status));

// 任务卡字段
const t1 = await api(`/api/rooms/${roomId}/task`, { method: "POST", body: JSON.stringify({ who: "me", key: keyOf("me"), taskId: "T-A", text: "带负责人", assignee: "daman", deadlineAt: "2026-11-03T00:00:00Z" }) });
ok(t1.status === 200 && t1.body.message.assignee === "daman", "任务卡落库 assignee", JSON.stringify(t1.body.message || {}).slice(0, 200));
const t2 = await api(`/api/rooms/${roomId}/task`, { method: "POST", body: JSON.stringify({ who: "me", key: keyOf("me"), taskId: "T-B", text: "非法负责人", assignee: "nobody" }) });
ok(t2.status === 400, "assignee 非成员 400", String(t2.status));

// 规则
const ru = await api(`/api/rooms/${roomId}/rules`, { method: "POST", body: JSON.stringify({ who: "you", key: keyOf("you"), rules: { quietMs: 120000, ackRequired: true, note: "自测" } }) });
ok(ru.status === 200 && ru.body.room.rules.quietMs === 120000 && ru.body.room.rules.ackRequired === true, "规则写入且 ackRequired 保持布尔", JSON.stringify(ru.body.room.rules));

// 踢人
const kick = await api(`/api/rooms/${roomId}/kick`, { method: "POST", body: JSON.stringify({ who: "you", key: keyOf("you"), memberId: hId }) });
ok(kick.status === 200 && !kick.body.room.members.includes(hId), "踢人成功");
const kickAgent = await api(`/api/rooms/${roomId}/kick`, { method: "POST", body: JSON.stringify({ who: "me", key: keyOf("me"), memberId: "you" }) });
ok(kickAgent.status === 403, "agent 不能踢人（403）", String(kickAgent.status));

// 被踢出的人不再是成员，写接口应 403
const evicted = await api(`/api/rooms/${roomId}/say`, { method: "POST", body: JSON.stringify({ who: hId, key: hKey, text: "我还在吗" }) });
ok(evicted.status === 403, "被踢者发言 403", String(evicted.status), JSON.stringify(evicted.body));

// 清理：解散 + 归档 + 删测试身份
await api(`/api/rooms/${roomId}/close`, { method: "POST", body: JSON.stringify({ who: "you", key: keyOf("you") }) });
await api(`/api/rooms/${roomId}/archive`, { method: "POST", body: JSON.stringify({ who: "you", key: keyOf("you") }) });
const ppl = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "people.json"), "utf8"));
delete ppl[hId];
fs.writeFileSync(path.join(ROOT, "data", "people.json"), JSON.stringify(ppl, null, 2));
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
