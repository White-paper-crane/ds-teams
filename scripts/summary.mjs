// 统一汇报：把一个房间的消息整理成一份 markdown 汇总（节点/进度/报告/确认/违规），
// 写到 <workspace>\teams\summaries\<room>-<ts>.md ，并在 stdout 打一行摘要。
// 用法：node scripts/summary.mjs <roomId> [--base http://127.0.0.1:8792] [--key <平台key>]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const roomId = args[0];
const flag = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const BASE = flag("base", "http://127.0.0.1:8792");
const KEY = flag("key", (() => { try { return fs.readFileSync(path.join(ROOT, "data", "key.txt"), "utf8").trim(); } catch { return ""; } })());
if (!roomId) { console.error("用法: node scripts/summary.mjs <roomId>"); process.exit(2); }

const NAME = { you: "群主", me: "小满", daman: "大满", system: "系统" };
const nm = (w) => NAME[w] || w;
const hm = (iso) => { const d = new Date(iso); return isNaN(d) ? "-" : d.toLocaleTimeString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }); };

const res = await fetch(`${BASE}/api/rooms/${encodeURIComponent(roomId)}?k=${encodeURIComponent(KEY)}`);
if (!res.ok) { console.error("拉取房间失败", res.status); process.exit(1); }
const data = await res.json();
const room = data.room || {};
const msgs = (data.messages || []).slice().sort((a, b) => a.seq - b.seq);

const by = (k) => msgs.filter((m) => m.kind === k);
const tasks = by("task");
const progress = by("progress");
const reports = by("report");
const confirms = by("confirm");
const acks = by("ack");
const reviews = by("review");

const lines = [`# 任务汇总 · ${room.title || roomId}`, ""];
lines.push(`- 房间：\`${roomId}\`　状态：${room.status === "open" ? "进行中" : "已解散"}　建群方：${nm(room.createdBy)}`);
lines.push(`- 时间段：${msgs.length ? hm(msgs[0].ts) : "-"} → ${msgs.length ? hm(msgs[msgs.length - 1].ts) : "-"}　消息数：${msgs.length}`);
lines.push(`- 生成时间：${new Date().toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })}`);
lines.push("");

lines.push("## 任务卡");
if (!tasks.length) lines.push("- 无");
for (const m of tasks) lines.push(`- \`${m.taskId || "?"}\` ${m.text}　（${nm(m.who)} ${hm(m.ts)}）`);
lines.push("");

lines.push("## 回执");
if (!acks.length) lines.push("- 无");
for (const m of acks) lines.push(`- \`${m.taskId || "?"}\` ${m.text.replace(/^ACK\s+/, "")}　（${nm(m.who)} ${hm(m.ts)}）`);
lines.push("");

lines.push("## 进度");
if (!progress.length) lines.push("- 无");
for (const m of progress) lines.push(`- ${m.percent >= 0 ? m.percent + "% " : ""}${m.text}　（${nm(m.who)} ${hm(m.ts)}）`);
lines.push("");

lines.push("## 报告");
if (!reports.length) lines.push("- 无");
for (const m of reports) {
  lines.push(`- \`${m.taskId || "?"}\` ${m.title || "报告"}（${nm(m.who)} ${hm(m.ts)}）`);
  if (m.text) lines.push(`  - ${m.text.replace(/\n/g, "\n  - ")}`);
  if (m.links) lines.push(`  - 文件：${m.links}`);
}
lines.push("");

lines.push("## 互评");
if (!reviews.length) lines.push("- 无");
for (const m of reviews) lines.push(`- ${m.text}　（${nm(m.who)} ${hm(m.ts)}）`);
lines.push("");

lines.push("## 收工确认");
if (!confirms.length) lines.push("- 无（还没有人确认 done/agree）");
for (const m of confirms) lines.push(`- \`${m.taskId || "?"}\` ${m.text === "done" ? "我已完成" : "同意汇总"}　（${nm(m.who)} ${hm(m.ts)}）`);
lines.push("");

// 按 taskId 分组判定：每个任务都要双方 done + agree 才算齐
const taskIds = [...new Set([...tasks.map((m) => m.taskId || ""), ...confirms.map((m) => m.taskId || "")])].filter(Boolean);
const perTask = taskIds.map((tid) => {
  const c = confirms.filter((m) => (m.taskId || "") === tid);
  const d = new Set(c.filter((m) => m.text === "done").map((m) => m.who));
  const a = new Set(c.filter((m) => m.text === "agree").map((m) => m.who));
  // 一个任务：负责人报 done，另一方报 agree（两人不重复）
  const ok = d.size >= 1 && a.size >= 1 && new Set([...d, ...a]).size >= 2;
  return { tid, done: d, agree: a, ok };
});
const ready = perTask.length ? perTask.every((t) => t.ok) : false;
if (!perTask.length) lines.push("**可解散判定**：否（本房没有任务卡，无法判定）");
else lines.push(`**可解散判定**：${ready ? "是（每个任务双方 done + agree 齐）" : "否 — " + perTask.map((t) => `${t.tid}: done ${[...t.done].map(nm).join("、") || "无"} / agree ${[...t.agree].map(nm).join("、") || "无"}`).join("；")}`);
lines.push("");

lines.push("## 对话节选（最后 10 条）");
for (const m of msgs.filter((x) => x.kind !== "system").slice(-10)) lines.push(`- [${hm(m.ts)}] ${nm(m.who)}：${String(m.text || "").replace(/\n/g, " ").slice(0, 120)}`);

const dir = path.join(ROOT, "summaries");
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const file = path.join(dir, `${roomId}-${stamp}.md`);
fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");

console.log(JSON.stringify({ ok: true, room: roomId, file, messages: msgs.length, tasks: tasks.length, acks: acks.length, progress: progress.length, reports: reports.length, reviews: reviews.length, confirms: confirms.length, perTask: perTask.map((t) => ({ taskId: t.tid, done: [...t.done], agree: [...t.agree], ok: t.ok })), readyToClose: ready }));
