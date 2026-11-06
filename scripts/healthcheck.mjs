#!/usr/bin/env node
// ds-teams · 健康巡检 CLI（零依赖）
// 用法：node scripts/healthcheck.mjs [--json]
// 卡住判据：open 房间 idle>180s 且还有未完成任务，或桥接 lag>20。退出码 0 正常 / 1 卡住 / 2 请求或配置失败。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const BASE = (process.env.DS_TEAMS_URL || "http://127.0.0.1:8792").replace(/\/+$/, "");
const IDLE_LIMIT = 180;   // 秒
const LAG_LIMIT = 20;     // 条

const argv = new Set(process.argv.slice(2));
if (argv.has("-h") || argv.has("--help")) {
  console.log("用法：node scripts/healthcheck.mjs [--json]");
  console.log("  检查 open 房间静默（>180s 且有未完成任务）与桥接游标落后（>20 条）；有问题退出码 1。");
  console.log("  环境变量：DS_TEAMS_URL（默认 http://127.0.0.1:8792）、DS_TEAMS_KEY（默认读 data/key.txt）");
  process.exit(0);
}
const asJson = argv.has("--json");

function die(msg) {
  console.error(`[healthcheck] ${msg}`);
  process.exit(2);
}

function readKey() {
  if (process.env.DS_TEAMS_KEY) return process.env.DS_TEAMS_KEY.trim();
  try { return fs.readFileSync(path.join(ROOT, "data", "key.txt"), "utf8").trim(); }
  catch { return ""; }
}

// 本地时间 HH:MM:SS；时间戳无效就原样返回
function clock(iso) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "-";
  return new Date(t).toLocaleTimeString("zh-CN", { hour12: false });
}

function fmtFloor(floor) {
  if (!floor || !floor.holder) return "空闲";
  return `${floor.holder}@${clock(floor.expiresAt)}`;
}

// 卡住原因：返回人类可读的数组，空数组＝正常
function findProblems(data) {
  const problems = [];
  for (const r of data.rooms || []) {
    if (r.status !== "open") continue;
    const openTasks = (r.tasks && Array.isArray(r.tasks.open)) ? r.tasks.open : [];
    if (Number(r.idleSeconds) > IDLE_LIMIT && openTasks.length > 0) {
      problems.push(`房间「${r.title}」(${r.id}) 已静默 ${r.idleSeconds}s，还有 ${openTasks.length} 个未完成任务：${openTasks.join(" / ")}`);
    }
  }
  for (const name of ["me", "daman"]) {
    const b = data.bridges && data.bridges[name];
    if (b && Number(b.lag) > LAG_LIMIT) {
      problems.push(`桥接 ${name} 落后 ${b.lag} 条（cursor=${b.cursor}，阈值 ${LAG_LIMIT}）`);
    }
  }
  return problems;
}

function printHuman(data, problems) {
  console.log(`ds-teams 健康检查 · ${data.at}`);
  for (const r of data.rooms || []) {
    const taskBit = r.tasks && r.tasks.total > 0 ? ` / 任务 ${r.tasks.done}/${r.tasks.total}` : "";
    console.log(`[${r.status}] ${r.title} / idle ${r.idleSeconds}s / 话筒 ${fmtFloor(r.floor)} / 最后 ${r.lastWho || "-"} ${r.lastKind || "-"} #${r.lastSeq || 0}${taskBit}`);
  }
  const b = data.bridges || {};
  const one = (name) => `${name} cursor=${b[name] ? b[name].cursor : "-"} lag=${b[name] ? b[name].lag : "-"}`;
  console.log(`桥接：${one("me")} / ${one("daman")}`);
  console.log(`归档会话：${(data.archived && data.archived.sessions || []).length} 个`);
  if (problems.length) {
    console.log("\n卡住原因：");
    for (const p of problems) console.log(`- ${p}`);
  } else {
    console.log("\n状态正常");
  }
}

const key = readKey();
if (!key) die("找不到平台 key：设 DS_TEAMS_KEY 或确认 data/key.txt 存在");

let res;
try {
  res = await fetch(`${BASE}/api/health?k=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(8000) });
} catch (e) {
  die(`请求 ${BASE}/api/health 失败：${(e && e.message) || e}`);
}

const text = await res.text();
let data;
try { data = JSON.parse(text); } catch { data = null; }
if (!res.ok || !data || data.ok !== true) {
  die(`健康接口返回 ${res.status}：${(data && data.error) || text.slice(0, 200) || "空响应"}`);
}

const problems = findProblems(data);
if (asJson) {
  // stdout 保持纯 JSON，原因也一并给机器读
  console.log(JSON.stringify({ ...data, problems }, null, 2));
} else {
  printHuman(data, problems);
}
process.exitCode = problems.length ? 1 : 0;
