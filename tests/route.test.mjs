// 任务卡路由判据回归：assignee 优先，正文点名只作兜底（#1132 误投）。
import { isTaskForDaman } from "../dispatch-lib.mjs";

const open = { status: "open" };
const cases = [
  ["assignee=me 但正文提到大满", { kind: "task", who: "me", assignee: "me", text: "对齐大满审计意见" }, open, false],
  ["assignee=daman", { kind: "task", who: "me", assignee: "daman", text: "x" }, open, true],
  ["无 assignee + @大满", { kind: "task", who: "me", text: "@大满 看下" }, open, true],
  ["无 assignee + 无点名", { kind: "task", who: "me", text: "普通活" }, open, false],
  ["daman 自发", { kind: "task", who: "daman", assignee: "daman", text: "x" }, open, false],
  ["房间已关", { kind: "task", who: "me", assignee: "daman", text: "x" }, { status: "closed" }, false],
  ["非 task 类型", { kind: "text", who: "me", text: "@大满" }, open, false],
];

let bad = 0;
for (const [name, m, room, want] of cases) {
  const got = isTaskForDaman(m, room);
  const ok = got === want;
  if (!ok) bad++;
  console.log((ok ? "✓ " : "✗ ") + name + " → " + got);
}
console.log(`结果：${cases.length - bad} 通过 / ${bad} 失败`);
process.exit(bad ? 1 : 0);
