// room-session-lib.mjs —— 房间专属会话台账（data/room-sessions.json）的读写库。
// 2026-11-04 B1：两桥（ds-teams-bridge.mjs 大满端 / ds-teams-bridge-me.mjs 小满端）共用。
// 背景：P2 只读灰度，B1 起桥要写台账（自动建会话、归档房标记）。两端同进程（desktop-next）
// 但仍按跨进程安全写：只合并自己的 ends.<WHO> 叶子 + 写前重读 + tmp+rename 原子替换。
//
// 台账 schema（对 P2 只读版向后兼容）：
// { version: 1, enabled: true, note: "...", rooms: { <roomId>: { ends: { me: {sessionId, createdAt, status?}, daman: {...} } } } }
//   - enabled:false → 全桥回落共用会话（回滚通道，≤5s 生效）。
//   - 叶子 status: "active"（默认，缺省视为 active）|"archived"（该端已 archiveSession，房归档后标记）。
//   - 人手改文件可能带 UTF-8 BOM：读时剥掉再 JSON.parse。
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function readLedgerRaw(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

// 有效的 房间→本端会话 映射（enabled:false / 房无本端 sessionId / 叶子 archived → 不进表）。
// 两端桥内各自实现带缓存的版本（5s 缓存 + evt/log），本库提供无状态原语供单测。
export function byRoomMap(file, who) {
  const j = readLedgerRaw(file);
  const m = new Map();
  if (!j || j.enabled === false || !j.rooms || typeof j.rooms !== "object") return m;
  for (const [rid, r] of Object.entries(j.rooms)) {
    const leaf = r && r.ends && r.ends[who];
    const sid = leaf && leaf.sessionId && leaf.status !== "archived" ? String(leaf.sessionId) : "";
    if (sid) m.set(String(rid), sid);
  }
  return m;
}

// B2（2026-11-04）：按角色分模型——叶子可选字段 provider/model 覆盖桥的 FALLBACK_*。
// 返回 { sessionId, provider, model }；缺省/脏值（空串、非字符串）→ undefined，由调用方回落 FALLBACK_*。
// 口径与 byRoomMap 一致：enabled:false / 无本端 sessionId / status=archived → null（该房不走专属会话）。
export function endOpts(file, roomId, who) {
  const j = readLedgerRaw(file);
  if (!j || j.enabled === false || !j.rooms || typeof j.rooms !== "object") return null;
  const r = j.rooms[String(roomId)];
  const leaf = r && r.ends && r.ends[who];
  if (!leaf || !leaf.sessionId || leaf.status === "archived") return null;
  const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  return { sessionId: String(leaf.sessionId), provider: str(leaf.provider), model: str(leaf.model) };
}

// 原子写：tmp（带 pid+uuid 防撞）→ rename 覆盖。Windows 上 rename 到已存在目标在 Node ≥14 可行。
export function writeLedgerAtomic(file, next) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + ".tmp-" + process.pid + "-" + randomUUID().slice(0, 8);
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

// 写入/合并本端叶子：写前重读最新盘面，只动 rooms[roomId].ends[who]，其余原样保留。
// 返回写后的叶子；任何一步失败 throw（调用方吞错降级，绝不半静默）。
export function writeEnd(file, roomId, who, leaf) {
  const cur = readLedgerRaw(file) || { version: 1, enabled: true, note: "B1 auto-managed", rooms: {} };
  if (cur.enabled === false) throw new Error("ledger disabled (rollback channel)");
  if (!cur.rooms || typeof cur.rooms !== "object") cur.rooms = {};
  const rid = String(roomId);
  if (!cur.rooms[rid] || typeof cur.rooms[rid] !== "object") cur.rooms[rid] = { ends: {} };
  if (!cur.rooms[rid].ends || typeof cur.rooms[rid].ends !== "object") cur.rooms[rid].ends = {};
  cur.rooms[rid].ends[who] = { ...(cur.rooms[rid].ends[who] || {}), ...leaf };
  writeLedgerAtomic(file, cur);
  return cur.rooms[rid].ends[who];
}

// 房归档：把本端叶子标 status="archived"（会话本身由调用方 archiveSession）。
export function markEndArchived(file, roomId, who) {
  const cur = readLedgerRaw(file);
  const leaf = cur && cur.rooms && cur.rooms[roomId] && cur.rooms[roomId].ends && cur.rooms[roomId].ends[who];
  if (!leaf || !leaf.sessionId) return null;
  return writeEnd(file, roomId, who, { ...leaf, status: "archived" });
}
