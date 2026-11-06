// 项目空间 API 验收：node tests/projects.test.mjs
// 前置：node server.mjs 已在 8792 跑着；data/people.json 有 you/me/daman。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = process.env.PS_BASE || "http://127.0.0.1:8792";
const K = fs.readFileSync(path.join(ROOT, "data", "key.txt"), "utf8").trim();
const PEOPLE = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "people.json"), "utf8"));

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name + (extra ? " — " + extra : "")); } };
const api = async (method, p, { who, body, key } = {}) => {
  const u = new URL(BASE + p);
  u.searchParams.set("k", K);
  if (who) u.searchParams.set("who", who);
  if (key) u.searchParams.set("key", key);
  const r = await fetch(u, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
};

const slug = "ps-test";
const ID = "proj-" + slug;

// 复位：旧测试项目移到 trash（删除=移动）
const dir = path.join(ROOT, "data", "projects", ID);
if (fs.existsSync(dir)) {
  const trash = path.join(path.join(os.tmpdir(), "ds-teams-trash"), new Date().toISOString().slice(0, 10), "ps-test-" + Date.now());
  fs.mkdirSync(path.dirname(trash), { recursive: true });
  fs.renameSync(dir, trash);
}

console.log("== 建项目 ==");
{
  const r = await api("POST", "/api/projects", { who: "you", key: PEOPLE.you.key, body: { title: "项目空间验收", slug } });
  ok("群主建项目 200", r.status === 200 && r.j?.project?.id === ID, JSON.stringify(r.j));
  const r2 = await api("POST", "/api/projects", { who: "you", key: PEOPLE.you.key, body: { title: "重复", slug } });
  ok("同 slug 再建 409", r2.status === 409);
  const r3 = await api("POST", "/api/projects", { who: "me", key: "wrong", body: { title: "x", slug: "ps-bad" } });
  ok("person key 错 401", r3.status === 401);
  const r4 = await api("GET", "/api/projects", { who: "me", key: PEOPLE.me.key });
  ok("小满能列项目", r4.status === 200 && r4.j.projects.some((x) => x.id === ID));
}

console.log("== 写记忆 ==");
{
  const a = await api("POST", `/api/projects/${ID}/memory`, { who: "me", key: PEOPLE.me.key, body: { kind: "fact", text: "服务端口 8792，数据在 data/", tags: ["port"], evidence: "server.mjs:15" } });
  ok("写 fact 200 带 id", a.status === 200 && /^mem-\d{6}$/.test(a.j.id), JSON.stringify(a.j));
  const b = await api("POST", `/api/projects/${ID}/memory`, { who: "me", key: PEOPLE.me.key, body: { kind: "fact", text: "服务端口 8792，数据在 data/", tags: ["port"], evidence: "server.mjs:15" } });
  ok("同文本幂等 409 + 同 id", b.status === 409 && b.j.id === a.j.id, JSON.stringify(b.j));
  const c = await api("POST", `/api/projects/${ID}/memory`, { who: "me", key: PEOPLE.me.key, body: { kind: "nope", text: "x" } });
  ok("未知 kind 400", c.status === 400);
  const d = await api("POST", `/api/projects/${ID}/memory`, { who: "me", key: PEOPLE.me.key, body: { kind: "decision", text: "存储用文件不用 SQLite：单进程、可备份", evidence: "docs/project-space-设计.md:5" } });
  ok("写 decision 200", d.status === 200);
  const e = await api("POST", `/api/projects/${ID}/memory`, { who: "me", key: PEOPLE.me.key, body: { kind: "open-question", text: "记忆保留策略？", owner: "you" } });
  ok("写 open-question 200", e.status === 200);
  const f = await api("POST", `/api/projects/${ID}/memory`, { who: "me", key: PEOPLE.me.key, body: { kind: "task", text: "M1 服务端存储", state: "doing", taskId: "PS-M1" } });
  ok("写 task 被拒 403（台账才是任务真源）", f.status === 403 && /dispatch ledger/.test(JSON.stringify(f.j)), JSON.stringify(f.j));
  const f2 = await api("POST", `/api/projects/${ID}/memory`, { who: "me", key: PEOPLE.me.key, body: { kind: "fact", text: "无证据的事实" } });
  ok("fact 无 evidence 400", f2.status === 400 && /evidence required/.test(JSON.stringify(f2.j)));
  const f3 = await api("POST", `/api/projects/${ID}/memory`, { who: "me", key: PEOPLE.me.key, body: { kind: "rule", text: "任务状态只读台账" } });
  ok("rule 无 evidence 400", f3.status === 400);
  const f5 = await api("POST", `/api/projects/${ID}/memory`, { who: "me", key: PEOPLE.me.key, body: { kind: "rule", text: "任务状态只读台账", evidence: "projects.mjs activeTasksFromLedger" } });
  ok("rule 带 evidence 200", f5.status === 200);
  const f4 = await api("POST", `/api/projects/${ID}/memory`, { who: "me", key: PEOPLE.me.key, body: { kind: "summary", text: "本轮小结：M1 上线" } });
  ok("summary 可无 evidence", f4.status === 200);
  const g = await api("POST", `/api/projects/${ID}/memory`, { who: "h-nobody", key: "k", body: { kind: "fact", text: "x" } });
  ok("非成员 401", g.status === 401);
}

console.log("== 检索 / 索引 ==");
{
  const r = await api("GET", `/api/projects/${ID}/memory?q=端口&limit=10`, { who: "daman", key: PEOPLE.daman.key });
  ok("全文检索命中 1 条", r.status === 200 && r.j.count === 1 && /8792/.test(r.j.memories[0].text), JSON.stringify(r.j).slice(0, 160));
  const r2 = await api("GET", `/api/projects/${ID}/memory?kind=decision`, { who: "daman", key: PEOPLE.daman.key });
  ok("按 kind 过滤", r2.status === 200 && r2.j.count === 1 && r2.j.memories[0].kind === "decision");
  const r3 = await api("GET", `/api/projects/${ID}/index`, { who: "daman", key: PEOPLE.daman.key });
  ok("index 含未决", r3.status === 200 && r3.j.index.openQuestions.length === 1);
  ok("index.activeTasks 是台账派生（本项目未绑房间 → 空）", Array.isArray(r3.j.index.activeTasks) && r3.j.index.activeTasks.length === 0);
  ok("index.rules 来自 memory kind=rule", (r3.j.index.rules || []).includes("任务状态只读台账"), JSON.stringify(r3.j.index.rules));
  ok("index 体 ≤ 2048B", JSON.stringify(r3.j.index).length <= 2048, String(JSON.stringify(r3.j.index).length));
  const r4 = await api("GET", `/api/projects/${ID}/state`, { who: "you", key: PEOPLE.you.key });
  ok("state 返回 cursor", r4.status === 200 && /^mem-/.test(r4.j.state.cursor || ""));
}

console.log("== supersede / 绑定 ==");
{
  const before = await api("GET", `/api/projects/${ID}/index`, { who: "me", key: PEOPLE.me.key });
  const oldId = before.j.index.recentDecisions[0].id;
  const s = await api("POST", `/api/projects/${ID}/memory/${oldId}/supersede`, { who: "me", key: PEOPLE.me.key, body: { text: "存储用文件不用 SQLite（内网可换，API 不变）", evidence: "docs/project-space-设计.md:129" } });
  ok("supersede 200 带新 id", s.status === 200 && s.j.superseded === oldId);
  const after = await api("GET", `/api/projects/${ID}/index`, { who: "me", key: PEOPLE.me.key });
  ok("索引只留新决定", after.j.index.recentDecisions.length === 1 && after.j.index.recentDecisions[0].id !== oldId);
  const all = await api("GET", `/api/projects/${ID}/memory?kind=decision&limit=50`, { who: "me", key: PEOPLE.me.key });
  ok("旧条目仍在 recall（superseded 标记）", all.j.memories.some((m) => m.id === oldId && m.status === "superseded"));
  const s2 = await api("POST", `/api/projects/${ID}/memory/${oldId}/supersede`, { who: "me", key: PEOPLE.me.key, body: { text: "再取代一次" } });
  ok("重复 supersede 409", s2.status === 409);
  const bind = await api("POST", `/api/projects/${ID}/bind`, { who: "you", key: PEOPLE.you.key, body: { end: "web", endpointId: "edge-23255", sessionId: "s-x" } });
  ok("绑定 200", bind.status === 200 && bind.j.binding.end === "web");
  const bind2 = await api("POST", `/api/projects/${ID}/bind`, { who: "you", key: PEOPLE.you.key, body: { end: "web", endpointId: "edge-23255", sessionId: "s-y" } });
  ok("同键绑定覆盖不重复", bind2.status === 200);
  const binds = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "projects", ID, "bindings.json"), "utf8"));
  ok("bindings 只有 1 条", binds.length === 1 && binds[0].sessionId === "s-y");
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
