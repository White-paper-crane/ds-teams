// ds-teams · 会议室议题台账（docs/meeting-room.md）
// 零依赖。只做规则与存储：open/respond/onSilence/abortRoom/list/get。
// 数据在 data/meeting-state.json；tmp+rename 原子写；与 wake-lib.mjs 解耦（由 server 路由编排联动）。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MEETING, MEETING_VERDICT_SET } from "./protocol.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.DS_TEAMS_DATA_DIR || path.join(ROOT, "data");
const FILE = process.env.DS_TEAMS_MEETING_FILE || path.join(DATA, "meeting-state.json");
const KEEP = 200; // 议题保留条数（LRU 裁剪）

export function readState() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (j && typeof j === "object" && j.issues && typeof j.issues === "object") return j;
  } catch {}
  return { issues: {} };
}

export function writeState(db) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + ".tmp-" + crypto.randomBytes(3).toString("hex");
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, FILE);
}

function prune(db) {
  const keys = Object.keys(db.issues).sort((a, b) => String(db.issues[b].updatedAt || "").localeCompare(String(db.issues[a].updatedAt || "")));
  for (const k of keys.slice(KEEP)) delete db.issues[k];
}

// 对方：me → daman，daman → me。非桥接成员返回 null（服务端已前置校验）。
export function reviewerOf(author) {
  return author === "me" ? "daman" : author === "daman" ? "me" : null;
}

// report 卡落库即开议题。author 必须 me|daman；返回 { ok, issue }。
// 同房同作者同 taskId 的旧 open 议题记 superseded（修订再交=旧议题结案、新议题开审）。
// reportTs：报告卡落库时刻（ISO）。开题当时就固化下来 —— 延迟观测要靠它起算，
// 而消息会在归档时被清出 rooms.json（server.mjs 归档分支 filter），回查 report 卡会落空。
export function open({ roomId, author, reportSeq, reportTs = "", title = "", taskId = "", read = readState, write = writeState } = {}) {
  const reviewer = reviewerOf(author);
  if (!reviewer) return { ok: false, error: "author must be me|daman", code: 400 };
  const db = read();
  const tid = String(taskId || "");
  for (const i of Object.values(db.issues)) {
    if (i && i.roomId === roomId && i.author === author && String(i.taskId || "") === tid && i.status === "open") {
      i.status = "superseded";
      i.closedBy = "superseded";
      i.supersededAt = new Date().toISOString();
    }
  }
  const id = "mt-" + (Object.keys(db.issues).length + 1) + "-" + author + "-" + crypto.randomBytes(2).toString("hex");
  const at = new Date().toISOString();
  const issue = {
    id, roomId: String(roomId || ""), author, reviewer, reportSeq: Number(reportSeq || 0),
    reportTs: String(reportTs || ""),
    title: String(title || "").slice(0, 60), taskId: tid,
    rounds: [{ n: 1, verdict: "open", text: "", at }],
    status: "open", closedBy: null, updatedAt: at,
  };
  db.issues[id] = issue;
  prune(db);
  write(db);
  return { ok: true, issue };
}

// review 卡带 verdict 落库时记轮次；pass→收敛；issues→保持 open 等对方再交。
export function respond({ roomId, reviewer, verdict, text = "", read = readState, write = writeState } = {}) {
  if (!MEETING_VERDICT_SET.has(verdict)) return { ok: false, error: "bad verdict", code: 400 };
  const db = read();
  const openIssues = Object.values(db.issues)
    .filter((i) => i && i.roomId === roomId && i.reviewer === reviewer && i.status === "open")
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  const issue = openIssues[0];
  if (!issue) return { ok: false, error: "no open issue for this reviewer", code: 404 };
  const n = issue.rounds.length + 1;
  const round = { n, verdict, text: String(text || "").slice(0, 4000), at: new Date().toISOString() };
  issue.rounds.push(round);
  issue.updatedAt = round.at;
  if (verdict === "pass") { issue.status = "converged"; issue.closedBy = "pass"; }
  else if (issue.rounds.length - 1 >= MEETING.roundCap) { issue.status = "converged"; issue.closedBy = "cap"; }
  write(db);
  return { ok: true, issue };
}

// 评审方对 report 卡沉默（wake NO_REPLY）→ 按无意见收敛。reportSeq 命中的 open 议题才收敛。
export function onSilence({ roomId, reportSeq, reviewer, read = readState, write = writeState } = {}) {
  const db = read();
  const seq = Number(reportSeq || 0);
  const issue = Object.values(db.issues)
    .find((i) => i && i.roomId === roomId && Number(i.reportSeq) === seq && i.reviewer === reviewer && i.status === "open");
  if (!issue) return { ok: false, code: 404 };
  const round = { n: issue.rounds.length + 1, verdict: "silent", text: "", at: new Date().toISOString() };
  issue.rounds.push(round);
  issue.status = "converged";
  issue.closedBy = "silent";
  issue.updatedAt = round.at;
  write(db);
  return { ok: true, issue };
}

// 房间 close/archive → 该房全部 open 议题 abort。
export function abortRoom(roomId, { read = readState, write = writeState } = {}) {
  const db = read();
  let changed = false;
  for (const i of Object.values(db.issues)) {
    if (i && i.roomId === roomId && i.status === "open") {
      i.status = "aborted";
      i.closedBy = "room-closed";
      i.updatedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) write(db);
  return { ok: true };
}

// GET /api/meeting/state：?roomId= 过滤；缺省全部（按更新倒序）。
export function list(roomId = "", { read = readState } = {}) {
  const db = read();
  let arr = Object.values(db.issues).filter((i) => i && typeof i === "object");
  if (roomId) arr = arr.filter((i) => i.roomId === roomId);
  return arr.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

export function get(issueId, { read = readState } = {}) {
  const db = read();
  const i = db.issues[issueId];
  return i && typeof i === "object" ? i : null;
}
