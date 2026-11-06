// 控制面 v2：建卡/开工/报告/gate/人审/驳回/列表。临时台账，不碰真实数据。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ds-control-"));
process.env.DS_TEAMS_LEDGER = path.join(dir, "ledger.json");
const { acceptTask, controlCounts, createTask, getTask, listTasks, recordGate, rejectTask, reportTask, startTask, taskKey } = await import("../dispatch-lib.mjs");

let fails = 0;
const ok = (name, cond, extra = "") => {
  if (!cond) { fails++; console.log("FAIL " + name + (extra ? " :: " + JSON.stringify(extra) : "")); }
  else console.log("PASS " + name);
};

const artifact = path.join(dir, "artifact.txt");
fs.writeFileSync(artifact, "hello control plane\n", "utf8");

// 1. 建卡幂等与字段
const c1 = createTask({
  projectId: "proj-test",
  taskId: "T-1",
  title: "smoke",
  acceptance: ["gate 通过", "artifact 存在"],
  writeScope: ["control.mjs"],
  gate: { command: "node -e \"process.exit(0)\"", cwd: ".", timeoutMs: 30_000 },
});
ok("create ok", c1.ok === true && c1.entry.state === "queued" && c1.entry.acceptance.length === 2, c1);
const c2 = createTask({ projectId: "proj-test", taskId: "T-1" });
ok("duplicate rejected", c2.ok === false && c2.duplicate === true, c2);

// 2. start / cap
const s1 = startTask(taskKey("proj-test", "T-1"), { assignee: "worker-a" });
ok("start claimed", s1.ok && s1.entry.state === "claimed" && s1.entry.assignee === "worker-a" && s1.entry.attempts === 1, s1);
const s1b = startTask(taskKey("proj-test", "T-1"));
ok("start idempotent while active", s1b.ok && s1b.already === true, s1b);

// 3. report 缺文件 / 成功
const miss = reportTask(taskKey("proj-test", "T-1"), { artifacts: [path.join(dir, "missing.txt")] });
ok("missing artifact rejected", miss.ok === false && /artifact missing/.test(miss.error), miss);
const rep = reportTask(taskKey("proj-test", "T-1"), { artifacts: [artifact], summary: "done" });
ok("report ok", rep.ok && rep.entry.state === "reported" && rep.entry.artifacts[0].sha256.length === 64, rep);

// 4. gate 未过不能 accept；过了才能
const early = acceptTask(taskKey("proj-test", "T-1"), { by: "you" });
ok("accept blocked before gate", early.ok === false && /gate not passed/.test(early.error), early);
recordGate(taskKey("proj-test", "T-1"), { pass: true, exitCode: 0, durationMs: 12, stdoutHash: "a", stderrHash: "b" });
const acc = acceptTask(taskKey("proj-test", "T-1"), { by: "you", note: "looks good" });
ok("accept after gate", acc.ok && acc.entry.state === "done" && acc.entry.reviews.at(-1).verdict === "pass", acc);

// 5. 驳回路径
createTask({ projectId: "proj-test", taskId: "T-2", title: "bad" });
startTask(taskKey("proj-test", "T-2"));
reportTask(taskKey("proj-test", "T-2"), { artifacts: [artifact] });
const rej = rejectTask(taskKey("proj-test", "T-2"), { by: "you", note: "gate 没跑" });
ok("reject blocked", rej.ok && rej.entry.state === "blocked" && rej.entry.reviews.at(-1).verdict === "fail", rej);
const noNote = rejectTask(taskKey("proj-test", "T-2"), { by: "you" });
ok("reject requires note", noNote.ok === false, noNote);

// 6. 列表 / 计数
const rows = listTasks({ projectId: "proj-test" });
ok("listTasks includes both", rows.length === 2 && rows.some((r) => r.taskId === "T-1" && r.state === "done"), rows);
const counts = controlCounts();
ok("controlCounts byProject", counts.byProject["proj-test"] === 2, counts);
ok("getTask", getTask(taskKey("proj-test", "T-1")).title === "smoke");

fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAIL` : "\nALL PASS");
process.exit(fails ? 1 : 0);
