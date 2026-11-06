// protocol.mjs 契约测试：常量、describe 输出、CLI、服务端未知 kind 400。
// 运行：node tests/protocol.test.mjs（tests/run-all.mjs 会一起跑）
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  PROTOCOL_VERSION, OWNER, ROLES, MESSAGE_KINDS, MESSAGE_KIND_SET,
  SUBSTANTIVE_KINDS, TASK_STATES, ACTIVE, TERMINAL, CLOSED, LIMITS, CAP, CLAIM,
  describe,
} from "../protocol.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROTO = path.join(ROOT, "protocol.mjs");
const SAY = path.join(ROOT, "say.mjs");
const BASE = (process.env.DS_TEAMS_URL || "http://127.0.0.1:8792").replace(/\/+$/, "");
const KEY = (process.env.DS_TEAMS_KEY || fs.readFileSync(path.join(ROOT, "data", "key.txt"), "utf8")).trim();
const PEOPLE = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "people.json"), "utf8"));

let passed = 0;
const failures = [];
function check(name, cond, actual) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push({ name, actual });
    console.log(`  FAIL  ${name}  实际: ${fmt(actual)}`);
  }
}
function fmt(v) {
  try { return JSON.stringify(v)?.slice(0, 500) ?? String(v); } catch { return String(v); }
}

async function api(method, p, body) {
  const authed = body?.who || body?.declaredBy;
  if (authed && !body.key) body = { ...body, key: (PEOPLE[authed] || {}).key };
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

function runNode(args) {
  return spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", timeout: 20_000 });
}

console.log("\n== 1. 导出与取值 ==");
check("PROTOCOL_VERSION 形如 x.y.z", /^\d+\.\d+\.\d+$/.test(PROTOCOL_VERSION), PROTOCOL_VERSION);
check("OWNER = you", OWNER === "you", OWNER);
check("ROLES = you/me/daman", JSON.stringify([...ROLES]) === JSON.stringify(["you", "me", "daman"]), [...ROLES]);
check("MESSAGE_KINDS 8 项且顺序固定",
  JSON.stringify([...MESSAGE_KINDS]) === JSON.stringify(["text", "progress", "report", "review", "task", "file", "ack", "confirm"]),
  [...MESSAGE_KINDS]);
check("MESSAGE_KIND_SET 与 MESSAGE_KINDS 同步", MESSAGE_KINDS.every((k) => MESSAGE_KIND_SET.has(k)) && MESSAGE_KIND_SET.size === MESSAGE_KINDS.length, [...MESSAGE_KIND_SET]);
check("SUBSTANTIVE_KINDS = 全部对外 kind", SUBSTANTIVE_KINDS.size === MESSAGE_KINDS.length && MESSAGE_KINDS.every((k) => SUBSTANTIVE_KINDS.has(k)), [...SUBSTANTIVE_KINDS]);
check("TASK_STATES 含 12 态", TASK_STATES.length === 12 && TASK_STATES.includes("queued") && TASK_STATES.includes("interrupted"), TASK_STATES);
check("ACTIVE 是 Set 且 4 态", ACTIVE instanceof Set && [...ACTIVE].join(",") === "claimed,spawned,running,reported", [...ACTIVE]);
check("TERMINAL 是 Set 且 5 态", TERMINAL instanceof Set && [...TERMINAL].join(",") === "done,failed,timeout,aborted,interrupted", [...TERMINAL]);
check("CLOSED 是 Set 且 4 态", CLOSED instanceof Set && [...CLOSED].join(",") === "done,aborted,reviewed,failed", [...CLOSED]);
check("ACTIVE 与 TERMINAL 不相交", [...ACTIVE].every((s) => !TERMINAL.has(s)), [...ACTIVE]);
check("LIMITS 数值", LIMITS.maxActiveTasks === 3 && LIMITS.maxActiveTasksPerRoom === 2
  && LIMITS.burstLimit === 5 && LIMITS.claimWaitMs === 2000 && LIMITS.claimRetention === 200
  && LIMITS.stallClaimedMs === 15 * 60e3 && LIMITS.stallRunMs === 45 * 60e3
  && LIMITS.stallQueuedMs === 2 * 3600e3 && LIMITS.maxAttempts === 3
  && LIMITS.staleWarnMs === 24 * 3600e3, LIMITS);
check("CLAIM 定义过期口径（无服务端 TTL，24h 仅告警）", CLAIM.ttlMs === 0 && CLAIM.staleWarnMs === 24 * 3600e3 && CLAIM.retention === 200, CLAIM);
check("CAP 派生自 LIMITS", CAP.global === 3 && CAP.room === 2, CAP);

console.log("\n== 2. describe 与 CLI ==");
const text = describe();
check("describe() 返回文本且 ≤50 行", typeof text === "string" && text.split(/\r?\n/).length <= 50, text.split(/\r?\n/).length);
check("describe() 覆盖 claim/auth", /claim/.test(text) && /auth/.test(text), text);
const obj = describe({ json: true });
check("describe({json:true}) 可序列化", typeof JSON.stringify(obj) === "string" && obj.version === PROTOCOL_VERSION, obj.version);
check("json 里 limits 与 LIMITS 一致", JSON.stringify(obj.limits) === JSON.stringify(LIMITS), obj.limits);
const cli = runNode([PROTO]);
check("node protocol.mjs 退出 0", cli.status === 0, cli.stderr);
check("CLI 文本 ≤50 行", String(cli.stdout || "").split(/\r?\n/).filter(Boolean).length <= 50, cli.stdout);
const cliJson = runNode([PROTO, "--json"]);
let parsed = null;
try { parsed = JSON.parse(cliJson.stdout); } catch {}
check("node protocol.mjs --json 可解析", cliJson.status === 0 && parsed && parsed.limits?.claimWaitMs === 2000, cliJson.stderr || cliJson.stdout);
const cliBad = runNode([PROTO, "--bogus"]);
check("未知参数 exit 2 且一行", cliBad.status === 2 && String(cliBad.stderr || "").trim().split(/\r?\n/).length === 1, cliBad.stderr);

console.log("\n== 3. say.mjs 发送前校验 ==");
const sayEmpty = runNode([SAY, "say", "room-x", "", "--who", "me"]);
check("say 空文本 exit 2", sayEmpty.status === 2, sayEmpty.status);
check("say 错误一行且指出用法", String(sayEmpty.stderr || "").trim().split(/\r?\n/).length === 1 && /缺少文本/.test(sayEmpty.stderr), sayEmpty.stderr);
const badKind = runNode([SAY, "say", "room-doesnotexist", "x", "--who", "me", "--kind", "bogus"]);
check("say --kind bogus exit 2", badKind.status === 2, badKind.status);
check("未知 --kind 一行且列出合法值", String(badKind.stderr || "").trim().split(/\r?\n/).length === 1 && /unknown kind: bogus/.test(badKind.stderr) && /allowed:/.test(badKind.stderr), badKind.stderr);
const taskNoId = runNode([SAY, "task", "room-x", "说明", "--who", "me"]);
check("task 缺 --task exit 2", taskNoId.status === 2 && /--task/.test(taskNoId.stderr), taskNoId.stderr);
const unknownCmd = runNode([SAY, "bogus", "--who", "me"]);
check("未知命令 exit 2 且列出合法值", unknownCmd.status === 2 && /合法命令/.test(unknownCmd.stderr) && /消息 kind/.test(unknownCmd.stderr), unknownCmd.stderr);

console.log("\n== 4. 服务端未知 kind 400 ==");
const uniq = `接口测试-协议kind-${Date.now()}`;
let roomId = "";
try {
  let r = await api("POST", "/api/rooms", { title: uniq, members: ["me", "daman", "you"], by: "me", declaredBy: "me" });
  check("建测试房 200", r.status === 200 && r.data?.room?.id, { status: r.status, body: r.data });
  roomId = r.data?.room?.id || "";
  if (roomId) {
    r = await api("POST", `/api/rooms/${roomId}/say`, { who: "me", kind: "bogus", text: "x" });
    check("未知 kind → 400", r.status === 400, { status: r.status, body: r.data });
    check("错误指出 unknown kind 与合法值", /unknown kind: bogus/.test(String(r.data?.error)) && /allowed:/.test(String(r.data?.error)), r.data?.error);
    r = await api("POST", `/api/rooms/${roomId}/say`, { who: "me", kind: "task", text: "x" });
    check("kind 与 action 不匹配 → 400", r.status === 400 && /not allowed for say/.test(String(r.data?.error)), { status: r.status, body: r.data });
    r = await api("POST", `/api/rooms/${roomId}/say`, { who: "me", text: "x" });
    check("不带 kind 的旧调用仍 200", r.status === 200 && r.data?.message?.kind === "text", { status: r.status, body: r.data });

    const before = await api("GET", `/api/rooms/${roomId}`);
    const beforeCount = (before.data?.messages || []).length;
    r = await api("POST", `/api/rooms/${roomId}/file`, { who: "me", kind: "bogus" });
    check("file 未知 kind → 400", r.status === 400 && /unknown kind: bogus/.test(String(r.data?.error)), { status: r.status, body: r.data });
    const after = await api("GET", `/api/rooms/${roomId}`);
    check("file 未知 kind 不落消息", (after.data?.messages || []).length === beforeCount, { before: beforeCount, after: (after.data?.messages || []).length });
    r = await api("POST", `/api/rooms/${roomId}/claim`, { who: "me", kind: "bogus", targetSeq: 1 });
    check("claim 未知 kind → 400", r.status === 400 && /unknown kind: bogus/.test(String(r.data?.error)), { status: r.status, body: r.data });
    r = await api("POST", `/api/rooms/${roomId}/close`, { who: "you", kind: "bogus" });
    check("close 未知 kind → 400", r.status === 400 && /unknown kind: bogus/.test(String(r.data?.error)), { status: r.status, body: r.data });
  }
} finally {
  if (roomId) {
    const c = await api("POST", `/api/rooms/${roomId}/close`, { who: "you" });
    check("清理：解散测试房", c.status === 200, { status: c.status, body: c.data });
  }
}

console.log(failures.length ? `\n${failures.length} FAIL / ${passed} PASS` : `\nALL PASS (${passed})`);
process.exit(failures.length ? 1 : 0);
