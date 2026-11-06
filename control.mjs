#!/usr/bin/env node
// ds-teams · 单控制面 CLI（控制面 v2）
// 与 dispatch.mjs 共用 data/dispatch-state.json；不新建第二份任务账本。
// 用法：
//   node control.mjs create <projectId> [taskId] --title "..." --acceptance "..." --gate "..." --cwd .
//   node control.mjs start  <projectId> <taskId> [--assignee worker]
//   node control.mjs run    <projectId> <taskId>
//   node control.mjs report <projectId> <taskId> --artifact path [--summary "..."]
//   node control.mjs gate   <projectId> <taskId>
//   node control.mjs accept <projectId> <taskId> [--by you] [--note "..."] [--force]
//   node control.mjs reject <projectId> <taskId> --by you --note "..."
//   node control.mjs brief  <projectId> <taskId>        # 生成隔离 worker 的 prompt
//   node control.mjs scope  <projectId> <taskId> [--cwd .]  # 审计写面越界
//   node control.mjs show   <projectId> <taskId>
//   node control.mjs list   [--project proj-ds-teams] [--active]
//   node control.mjs counts
import crypto from "node:crypto";
import {
  acceptTask,
  controlCounts,
  createTask,
  getTask,
  listTasks,
  recordGate,
  rejectTask,
  reportTask,
  setState,
  startTask,
  taskKey,
} from "./dispatch-lib.mjs";
import { runGate, writeEvidence } from "./gate.mjs";
import { auditScope } from "./scope-lib.mjs";
import { CAP } from "./protocol.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name, dflt = "") => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const flags = (name) => {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--" + name && argv[i + 1] !== undefined) out.push(argv[i + 1]);
  }
  return out;
};
const pos = argv.slice(1).filter((a, i, arr) => !a.startsWith("--") && !(i > 0 && arr[i - 1].startsWith("--")));
const die = (msg) => { console.error(msg); process.exit(2); };

function keyFromPos() {
  const [projectId, taskId] = pos;
  if (!projectId) die("missing projectId/taskId");
  if (projectId.includes("::") && !taskId) return projectId;
  if (!taskId) die("missing taskId");
  return taskKey(projectId, taskId);
}

function print(obj, code = 0) {
  console.log(JSON.stringify(obj, null, 2));
  process.exit(code);
}

if (cmd === "create") {
  const [projectId, givenId] = pos;
  if (!projectId) die("usage: create <projectId> [taskId] --title ...");
  const taskId = givenId || ("T-" + new Date().toISOString().replace(/\D/g, "").slice(0, 14) + "-" + crypto.randomBytes(2).toString("hex"));
  const gateCommand = flag("gate");
  const r = createTask({
    projectId,
    taskId,
    title: flag("title", taskId),
    acceptance: flags("acceptance"),
    writeScope: flags("scope"),
    owner: flag("owner", "lead"),
    assignee: flag("assignee", "lead"),
    gate: gateCommand ? { command: gateCommand, cwd: flag("cwd", "."), timeoutMs: Number(flag("timeout", "300000")) } : null,
  });
  print(r, r.duplicate ? 3 : r.ok ? 0 : 2);
} else if (cmd === "start") {
  const key = keyFromPos();
  const owner = flag("owner");
  const assignee = flag("assignee");
  const r = startTask(key, { ...(owner ? { owner } : {}), ...(assignee ? { assignee } : {}) });
  print(r, r.ok ? 0 : 2);
} else if (cmd === "run") {
  const key = keyFromPos();
  const r = setState(key, "running", { by: flag("by", "lead") });
  print(r, r.ok ? 0 : 2);
} else if (cmd === "report") {
  const key = keyFromPos();
  const r = reportTask(key, { artifacts: flags("artifact"), summary: flag("summary"), by: flag("by", "lead") });
  print(r, r.ok ? 0 : 2);
} else if (cmd === "gate") {
  const key = keyFromPos();
  const e = getTask(key);
  if (!e) print({ ok: false, error: "unknown key " + key }, 3);
  if (!e.gate || !e.gate.command) print({ ok: false, error: "task has no gate.command" }, 2);
  const result = runGate({ command: e.gate.command, cwd: e.gate.cwd, timeoutMs: e.gate.timeoutMs, env: { DS_TEAMS_TASK_KEY: key } });
  result.evidencePath = writeEvidence(result, { projectId: e.projectId || e.roomId, taskId: e.taskId });
  const r = recordGate(key, { ...result, by: flag("by", "lead") });
  print({ ok: r.ok, pass: result.pass, gate: result, entry: r.entry }, result.pass ? 0 : 1);
} else if (cmd === "accept") {
  const key = keyFromPos();
  const r = acceptTask(key, { by: flag("by", "you"), note: flag("note"), force: argv.includes("--force") });
  print(r, r.ok ? 0 : 2);
} else if (cmd === "reject") {
  const key = keyFromPos();
  const r = rejectTask(key, { by: flag("by", "you"), note: flag("note") });
  print(r, r.ok ? 0 : 2);
} else if (cmd === "brief") {
  const key = keyFromPos();
  const e = getTask(key);
  if (!e) print({ ok: false, error: "not found" }, 3);
  const acceptance = Array.isArray(e.acceptance) ? e.acceptance : [];
  const scope = Array.isArray(e.writeScope) ? e.writeScope : [];
  const lines = [
    "你是隔离 worker，不是 Lead。",
    "任务: " + key,
    "标题: " + (e.title || e.taskId),
    "项目: " + (e.projectId || e.roomId || ""),
    "",
    "验收标准:",
    ...(acceptance.length ? acceptance.map((x, i) => String(i + 1) + ". " + x) : ["（未声明；先向 Lead 要）"]),
    "",
    "只允许写:",
    ...(scope.length ? scope.map((x) => "- " + x) : ["（未声明；默认只读，先向 Lead 要写面）"]),
    "",
    "禁止:",
    "- 改 writeScope 外的文件、共享文件、其他任务的文件",
    "- 嵌套派 agent 或自建团队",
    "- 直接改 data/dispatch-state.json / 任务台账",
    "- 通过房间消息回传；产物写文件",
    "",
    "gate: " + (e.gate && e.gate.command ? e.gate.command : "（无）"),
    "完成后: 运行 gate（如有），用 control.mjs report 交回 artifact 路径；只返回路径、gate 结果、风险。",
  ];
  const text = lines.join("\n");
  if (argv.includes("--json")) print({ ok: true, key, brief: text });
  console.log(text);
  process.exit(0);
} else if (cmd === "scope") {
  const key = keyFromPos();
  const e = getTask(key);
  if (!e) print({ ok: false, error: "not found" }, 3);
  const scope = Array.isArray(e.writeScope) ? e.writeScope : [];
  if (!scope.length) print({ ok: false, key, error: "task has no writeScope; cannot certify isolation" }, 2);
  const r = auditScope(flag("cwd", (e.gate && e.gate.cwd) || "."), scope);
  print({ ok: r.ok, key, ...r }, r.ok ? 0 : 1);
} else if (cmd === "show") {
  const key = keyFromPos();
  const e = getTask(key);
  if (!e) print({ ok: false, error: "not found" }, 3);
  print({ ok: true, entry: e });
} else if (cmd === "list") {
  const projectId = flag("project");
  const tasks = listTasks({ projectId, all: !argv.includes("--active") });
  print({ ok: true, counts: controlCounts(), tasks }, 0);
} else if (cmd === "counts") {
  print({ ok: true, cap: CAP, ...controlCounts() }, 0);
} else {
  die("usage: create|start|run|report|gate|accept|reject|brief|scope|show|list|counts");
}
