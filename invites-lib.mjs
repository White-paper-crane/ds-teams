// 邀请链接内核（规格三.1）：一人一链、用完即废、认名不认人、被踢即死。
//
// 为什么自己写：调研过 Discord / Matrix / Mattermost / Rocket.Chat，
// 「退出后链接空出、后来者输同样昵称就能继承」没有任何现成实现——
// 它们要么把码永久复用（Discord），要么按账号 ID 邀（Matrix）。
// 所以这里只把「决策」做成纯函数，落盘与会话留在 server.mjs。
//
// 三条铁律（调研踩坑结论）：
// 1. token 熵 ≥ 128 bit，别用 8 位 hex（可被枚举）。
// 2. 消费必须原子：判完状态立刻写回，中间不许 await。
// 3. 同名继承必须重签底层 key，只让链接「空出来」等于把身份白送。
import crypto from "node:crypto";

export const NAME_MAX = 20;
export const STATUS = { OPEN: "open", USED: "used", DEAD: "dead" };

/** 邀请 token：16 字节 base64url ≈ 128 bit 熵。 */
export function newToken() {
  return crypto.randomBytes(16).toString("base64url");
}

/** 成员 key 与 people.json 同格式：12 位 hex。 */
export function newKey() {
  return crypto.randomBytes(6).toString("hex");
}

/**
 * 昵称规整。认名不认人的前提是名字可比对，所以：
 * 去首尾空白、把连续空白压成一个、去掉控制字符，长度 1..20。
 */
export function normalizeName(raw) {
  const s = String(raw == null ? "" : raw)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return { ok: false, error: "请输入昵称" };
  if ([...s].length > NAME_MAX) return { ok: false, error: `昵称最长 ${NAME_MAX} 个字` };
  if (/[\\/<>]/.test(s)) return { ok: false, error: "昵称不能包含 \\ / < >" };
  return { ok: true, name: s };
}

/** 一条邀请还能不能被点开。 */
export function canClaim(invite, room) {
  if (!invite) return { ok: false, code: 404, error: "邀请链接不存在" };
  if (invite.status === STATUS.DEAD) return { ok: false, code: 410, error: "这个邀请已作废（持有人被移出房间）" };
  if (!room) return { ok: false, code: 404, error: "房间不存在" };
  if (room.status !== "open") return { ok: false, code: 409, error: "房间已解散，邀请失效" };
  return { ok: true };
}

/**
 * 认名不认人的核心判定。纯函数：只看传入的 people/room/名字，不碰磁盘。
 *
 * @returns {{kind:"busy"}|{kind:"inherit",person:object}|{kind:"new"}}
 *   busy    = 这名正被本房某个在册的人用着，必须换个名字
 *   inherit = 座位空着（上一任主动退出），同名可以继承这个身份（调用方必须重签 key）
 *   new     = 全新的人，调用方创建 person
 */
export function resolveSeat({ people, room, name, token }) {
  const list = Object.values(people || {}).filter((p) => p && p.status === "active");
  const members = new Set(room.members || []);
  const inv = (room.invites || {})[token] || null;

  // 1) 同一 token 的原持有人回来（刷新丢 key / 换设备）：允许重签，身份不换。
  //    前提是他此刻不在 members 里——在册就说明名字被别人用着，走 busy。
  if (inv && inv.status === STATUS.USED && inv.holder) {
    const p = people[inv.holder];
    if (p && p.status === "active" && p.name === name && !members.has(p.id)) {
      return { kind: "inherit", person: p, sameToken: true };
    }
  }

  // 2) 名字已被本房在册的人占着 → 拒绝，提示改名字
  const taken = list.find((p) => p.name === name && members.has(p.id));
  if (taken) return { kind: "busy", person: taken };

  // 3) 座位空出：本邀请的原座位名相同，且原持有人已不在房里 → 继承同一个 id。
  //    releaseInvite 会把 holder 挪到 releasedBy，两个都要认。
  if (inv && inv.seatName === name) {
    const prevId = inv.releasedBy || inv.holder;
    const prev = prevId ? people[prevId] : null;
    if (prev && prev.status === "active" && !members.has(prev.id)) {
      return { kind: "inherit", person: prev, previous: prevId };
    }
  }

  // 4) 全局同名但不在本房的人：允许（不同房间可以有同名的人，规格一：多房间隔离）
  return { kind: "new" };
}

/** 绑定成功后的邀请记录（调用方负责落盘）。 */
export function bindInvite(invite, person, now = Date.now()) {
  invite.status = STATUS.USED;
  invite.holder = person.id;
  invite.seatName = person.name;
  invite.usedAt = new Date(now).toISOString();
  invite.leftAt = null;
  return invite;
}

/** 主动退出：链接「空出」，座位名保留，后来者输同样昵称即可继承。 */
export function releaseInvite(invite, now = Date.now()) {
  if (!invite) return invite;
  invite.status = STATUS.OPEN;
  invite.leftAt = new Date(now).toISOString();
  invite.releasedBy = invite.holder;
  invite.holder = null;
  return invite;
}

/** 被踢：邀请直接报废，不能再用（要进人只能重新生成）。 */
export function killInvitesOf(room, personId, reason = "kicked", now = Date.now()) {
  const dead = [];
  for (const inv of Object.values(room.invites || {})) {
    if (inv.holder !== personId) continue;
    inv.status = STATUS.DEAD;
    inv.deadAt = new Date(now).toISOString();
    inv.deadReason = reason;
    dead.push(inv.token);
  }
  return dead;
}

/** 黑名单条目：认名不认人 → 黑名单就落在「名字 + 房号 + 时间」，不落 key。 */
export function blacklistEntry(name, roomId, by, now = Date.now()) {
  return { name, roomId, by, at: new Date(now).toISOString() };
}

export function isBlacklisted(room, name) {
  return (room.blacklist || []).some((e) => (typeof e === "string" ? e === name : e && e.name === name));
}

/**
 * 归档前清场：人名、ID、角色、邀请有效性等「非消息记录」一律不进归档文件。
 * 用户 2026-11-05：「解散归档就应该删去那些人名 id 和链接有效性等等非消息记录」。
 * 消息本身保留（审计要看的是说过什么），但它不再关联任何活身份。
 */
export function scrubRoomForArchive(room) {
  const keep = [
    "id", "title", "status", "createdAt", "closedAt", "closedBy", "archivedAt",
    "rules", "note", "projectId", "schema",
  ];
  const out = {};
  for (const k of keep) if (room[k] !== undefined) out[k] = room[k];
  out.members = [];
  out.roles = {};
  out.muted = [];
  out.invites = {};
  out.blacklist = [];
  out.owner = "";
  out.floor = null;
  out.pendingClose = null;
  out.scrubbed = true;
  out.scrubbedAt = new Date().toISOString();
  return out;
}

/** 归档后，这些人的 person 记录该不该跟着删：仅因本邀请进过这间房、且不在别的活房。 */
export function peopleToPurge(people, archivedRoom, liveRooms) {
  const ids = new Set((archivedRoom.__formerMembers || []).map(String));
  // 被踢的人早已不在 members 里，但邀请记录还留着 holder → 一并算作「这间房带进来的人」。
  for (const inv of Object.values(archivedRoom.invites || {})) {
    if (inv && inv.holder) ids.add(String(inv.holder));
    if (inv && inv.releasedBy) ids.add(String(inv.releasedBy));
  }
  const stillUsed = new Set();
  for (const r of liveRooms || []) for (const m of r.members || []) stillUsed.add(m);
  const out = [];
  for (const id of ids) {
    const p = people[id];
    if (!p) continue;
    if (p.createdVia !== "invite") continue; // 只清邀请进来的临时身份，不动 you/me/daman
    if (stillUsed.has(id)) continue;
    out.push(id);
  }
  return out;
}
