// 双真源（DP-7）单元测试：项目 activeTasks 只从 dispatch 台账派生。node tests/projects-ledger.test.mjs
import { activeTasksFromLedger } from "../projects.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name + (extra ? " — " + extra : "")); } };

const ledger = {
  version: 1,
  tasks: {
    "room-a::T1": { roomId: "room-a", taskId: "T1", assignee: "me", state: "done" },
    "room-a::T2": { roomId: "room-a", taskId: "T2", assignee: "daman", state: "running" },
    "room-a::T3": { roomId: "room-a", taskId: "T3", assignee: "me", state: "reviewed" },
    "room-a::T4": { roomId: "room-a", taskId: "T4", assignee: "me", state: "claimed" },
    "room-b::T5": { roomId: "room-b", taskId: "T5", assignee: "me", state: "running" },
  },
};

console.log("== activeTasksFromLedger ==");
{
  const out = activeTasksFromLedger({ id: "proj-x", roomIds: ["room-a"] }, ledger);
  ok("只留本项目的非终态任务", out.length === 2 && out.every((t) => t.roomId === "room-a"), JSON.stringify(out));
  ok("done/aborted/reviewed/failed 视为已收口", !out.some((t) => ["T1", "T3"].includes(t.taskId)));
  ok("running/claimed 保留并带 owner", out.some((t) => t.taskId === "T2" && t.owner === "daman") && out.some((t) => t.taskId === "T4"));

  const empty = activeTasksFromLedger({ id: "proj-y", roomIds: [] }, ledger);
  ok("未绑房间 → 空", Array.isArray(empty) && empty.length === 0);

  const none = activeTasksFromLedger({ id: "proj-z" }, ledger);
  ok("缺 roomIds 字段 → 空", Array.isArray(none) && none.length === 0);

  const asArray = activeTasksFromLedger({ roomIds: ["room-b"] }, { tasks: Object.values(ledger.tasks) });
  ok("台账以数组形式给出也兼容", asArray.length === 1 && asArray[0].taskId === "T5");

  const closed = activeTasksFromLedger({ roomIds: ["room-a"] }, { tasks: { k: { roomId: "room-a", taskId: "T9", state: "aborted" } } });
  ok("aborted 不收", closed.length === 0);

  const bad = activeTasksFromLedger({ roomIds: ["room-a"] }, null);
  ok("台账缺失不抛错", Array.isArray(bad) && bad.length === 0);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
