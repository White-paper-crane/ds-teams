// ds-teams · GET /api/health 与健康快照纯函数测试（零依赖，node 原生 fetch）
// 运行：node tests/health.test.mjs
// 覆盖：鉴权（无 k / 错 k → 401）、字段齐全、lag＝最新 seq－游标、归档文件缺失不崩、任务完成度。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildHealth, readBridgeCursor, readArchivedSessions, DEFAULT_WORKSPACE_FILE } from "../scripts/health-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.DS_TEAMS_URL || "http://127.0.0.1:8792").replace(/\/+$/, "");
const KEY = (process.env.DS_TEAMS_KEY || fs.readFileSync(path.join(ROOT, "data", "key.txt"), "utf8")).trim();

let passed = 0;
const failures = [];
let current = "";

function section(name) {
  current = name;
  console.log(`\n== ${name} ==`);
}
function check(name, cond, actual) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push({ detail: `${current} / ${name}`, actual });
    console.log(`  FAIL  ${name}`);
    console.log(`        实际: ${fmt(actual)}`);
  }
}
function fmt(v) {
  try { return JSON.stringify(v)?.slice(0, 600) ?? String(v); } catch { return String(v); }
}
function isNum(v) { return typeof v === "number" && Number.isFinite(v); }

async function health(k = KEY) {
  const url = `${BASE}/api/health${k ? `?k=${encodeURIComponent(k)}` : ""}`;
  const res = await fetch(url);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
  return { status: res.status, data };
}
async function stateSeq() {
  const res = await fetch(`${BASE}/api/state?since=999999999&k=${encodeURIComponent(KEY)}`);
  const data = await res.json();
  return Number(data.seq);
}

const REQUIRED_ROOM_KEYS = ["id", "title", "status", "idleSeconds", "floor", "lastSeq", "lastWho", "lastKind", "lastAt"];
const cursorOf = (name) => readBridgeCursor(path.join(ROOT, "data"), name).cursor;

try {
  section("1. 鉴权：无 k / 错 k → 401");
  let r = await health("");
  check("无 k HTTP 401", r.status === 401, { status: r.status, body: r.data });
  check("无 k 返回 JSON ok=false", r.data?.ok === false, r.data);
  check("无 k 错误信息 unauthorized", r.data?.error === "unauthorized", r.data);

  r = await health("deadbeef00");
  check("错 k HTTP 401", r.status === 401, { status: r.status, body: r.data });
  check("错 k 不返回房间数据", !Array.isArray(r.data?.rooms), r.data);

  section("2. 带 k → 200，字段齐全");
  r = await health();
  check("带 k HTTP 200", r.status === 200, { status: r.status, body: r.data });
  check("ok=true", r.data?.ok === true, r.data);
  check("at 是合法 ISO 时间", typeof r.data?.at === "string" && !Number.isNaN(Date.parse(r.data.at)), r.data?.at);
  check("rooms 是数组", Array.isArray(r.data?.rooms), r.data?.rooms);

  const rooms = Array.isArray(r.data?.rooms) ? r.data.rooms : [];
  check("至少有 1 个房间可校验", rooms.length >= 1, rooms.length);
  let roomShape = true;
  let floorShape = true;
  let tasksShape = true;
  for (const room of rooms) {
    for (const k of REQUIRED_ROOM_KEYS) if (!(k in room)) roomShape = false;
    if (!(isNum(room.idleSeconds) && room.idleSeconds >= 0)) roomShape = false;
    if (!(room.floor === null || (room.floor && typeof room.floor.holder === "string" && "expiresAt" in room.floor))) floorShape = false;
    if (!(room.tasks && isNum(room.tasks.total) && isNum(room.tasks.done) && Array.isArray(room.tasks.open))) tasksShape = false;
  }
  check(`每个房间含 ${REQUIRED_ROOM_KEYS.join("/")}`, roomShape, rooms.map((x) => Object.keys(x)));
  check("floor 为 null 或 {holder,expiresAt}", floorShape, rooms.map((x) => x.floor));
  check("tasks 附带 {total,done,open}（healthcheck 判卡住用）", tasksShape, rooms.map((x) => x.tasks));

  const bridges = r.data?.bridges || {};
  check("bridges 含 me / daman", !!bridges.me && !!bridges.daman, bridges);
  for (const name of ["me", "daman"]) {
    const b = bridges[name] || {};
    check(`bridges.${name}.cursor 是非负整数`, Number.isInteger(b.cursor) && b.cursor >= 0, b);
    check(`bridges.${name}.lag 是非负整数`, Number.isInteger(b.lag) && b.lag >= 0, b);
  }
  check("archived.sessions 是数组", Array.isArray(r.data?.archived?.sessions), r.data?.archived);

  const archivedFile = readArchivedSessions(DEFAULT_WORKSPACE_FILE);
  check("archived 与 workspace.json 的 global.archivedSessionIds 一致",
    JSON.stringify(r.data?.archived?.sessions) === JSON.stringify(archivedFile),
    { api: r.data?.archived?.sessions, file: archivedFile });

  section("3. lag = 最新 seq − 游标（对照 /api/state 与游标文件）");
  const seqBefore = await stateSeq();
  const cursorBefore = { me: cursorOf("me"), daman: cursorOf("daman") };
  const h = await health();
  const seqAfter = await stateSeq();
  const cursorAfter = { me: cursorOf("me"), daman: cursorOf("daman") };
  for (const name of ["me", "daman"]) {
    // 两次读数之间可能进新消息（seq 变大）、桥接也可能推进游标（游标变大），两个量各取区间：
    // lag = seq − cursor 必落在 [seqBefore − cursorAfter, seqAfter − cursorBefore]，两端同向变化也不会翻转。
    const lo = Math.max(0, seqBefore - cursorAfter[name]);
    const hi = Math.max(0, seqAfter - cursorBefore[name]);
    const lag = h.data?.bridges?.[name]?.lag;
    check(`${name} lag 落在 [${lo},${hi}]`, isNum(lag) && lag >= lo && lag <= hi,
      { lag, cursorBefore: cursorBefore[name], cursorAfter: cursorAfter[name], seqBefore, seqAfter });
  }

  section("4. 纯函数：游标缺文件、归档缺文件、任务 done 判定");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ds-teams-health-"));
  fs.writeFileSync(path.join(tmp, "bridge-me-cursor.json"), JSON.stringify({ seq: 7, at: 123 }));
  fs.writeFileSync(path.join(tmp, "bridge-daman-cursor.json"), JSON.stringify({ seq: 12, at: 456 }));

  const now = Date.parse("2026-11-03T12:00:00.000Z");
  const fakeDb = {
    seq: 10,
    rooms: [
      { id: "r1", title: "测试房", status: "open", createdAt: "2026-11-03T11:50:00.000Z",
        floor: { holder: "me", expiresAt: "2026-11-03T12:01:30.000Z" } },
      { id: "r2", title: "过期话筒", status: "open", createdAt: "2026-11-03T11:50:00.000Z",
        floor: { holder: "daman", expiresAt: "2026-11-03T11:59:00.000Z" } },
    ],
    messages: [
      { seq: 9, roomId: "r1", who: "me", kind: "text", text: "干活", ts: "2026-11-03T11:58:00.000Z" },
      { seq: 10, roomId: "r1", who: "you", kind: "task", taskId: "T1", text: "任务一", ts: "2026-11-03T11:59:00.000Z" },
    ],
  };
  const missingWorkspace = path.join(tmp, "no-such-workspace.json");
  const built = buildHealth({ db: fakeDb, dataDir: tmp, workspaceFile: missingWorkspace, ledger: {}, now });

  check("me lag：10-7=3", built.bridges.me.lag === 3, built.bridges);
  check("daman 游标 12 > 最新 10，lag 收敛为 0", built.bridges.daman.lag === 0, built.bridges);
  check("归档文件缺失时 sessions=[] 且不抛错", Array.isArray(built.archived.sessions) && built.archived.sessions.length === 0, built.archived);
  check("缺归档文件时接口整体仍 ok", built.ok === true && built.rooms.length === 2, built);

  const r1 = built.rooms.find((x) => x.id === "r1");
  check("idle 按最后一条实质消息算（11:59 任务 → 60s）", r1?.idleSeconds === 60, r1?.idleSeconds);
  check("未完成任务进 tasks.open", r1?.tasks?.total === 1 && r1.tasks.done === 0 && r1.tasks.open[0] === "T1", r1?.tasks);
  check("有效话筒保留 holder/expiresAt", r1?.floor?.holder === "me", r1?.floor);
  const r2 = built.rooms.find((x) => x.id === "r2");
  check("过期话筒返回 null", r2?.floor === null, r2?.floor);
  check("无消息房间 idle 退回建群时间", r2?.idleSeconds === 600, r2?.idleSeconds);

  const doneBuilt = buildHealth({
    db: {
      seq: 11,
      rooms: [{ id: "r3", title: "收尾房", status: "open", createdAt: "2026-11-03T11:50:00.000Z", floor: null }],
      messages: [
        { seq: 10, roomId: "r3", who: "you", kind: "task", taskId: "T2", text: "任务二", ts: "2026-11-03T11:56:00.000Z" },
        { seq: 11, roomId: "r3", who: "me", kind: "confirm", taskId: "T2", text: "done", ts: "2026-11-03T11:57:00.000Z" },
      ],
    },
    dataDir: path.join(tmp, "missing-dir"),
    workspaceFile: missingWorkspace,
    ledger: { "r3::T2": { state: "reviewed" } },
    now,
  });
  check("游标目录缺失时 cursor=0、lag=最新 seq", doneBuilt.bridges.me.cursor === 0 && doneBuilt.bridges.me.lag === 11, doneBuilt.bridges);
  check("confirm done 的任务算完成", doneBuilt.rooms[0].tasks.done === 1 && doneBuilt.rooms[0].tasks.open.length === 0, doneBuilt.rooms[0].tasks);

  const wsFile = path.join(tmp, "workspace.json");
  fs.writeFileSync(wsFile, JSON.stringify({ global: { archivedSessionIds: ["s1", "s2", 3, null] } }));
  check("归档列表只保留字符串 id", JSON.stringify(readArchivedSessions(wsFile)) === JSON.stringify(["s1", "s2"]), readArchivedSessions(wsFile));
} catch (err) {
  failures.push({ detail: "未捕获异常", actual: err?.stack || String(err) });
  console.log(`\n!! 运行异常: ${err?.stack || err}`);
}

console.log(`\n===== 汇总 =====`);
console.log(`通过: ${passed}  失败: ${failures.length}`);
if (failures.length) {
  console.log(`\n失败详情:`);
  for (const f of failures) console.log(`- ${f.detail}\n  实际: ${fmt(f.actual)}`);
  process.exitCode = 1;
} else {
  console.log("全部通过");
}
