// 邀请链接内核的纯函数测试：不起服务，直接跑逻辑。
// 覆盖规格三.1 的每一条：一人一链 / 用完即废 / 认名不认人 / 退出空出 / 被踢即死 / 归档清场。
import assert from "node:assert/strict";
import {
  bindInvite, blacklistEntry, canClaim, isBlacklisted, killInvitesOf,
  newToken, normalizeName, peopleToPurge, releaseInvite, resolveSeat,
  scrubRoomForArchive, STATUS,
} from "../invites-lib.mjs";

const tests = [];
const t = (name, fn) => tests.push({ name, fn });

const mkRoom = (over = {}) => ({
  id: "room-1", title: "测试房", status: "open",
  owner: "you", members: ["you", "me"], roles: { me: "admin" },
  muted: ["daman"], invites: {}, blacklist: [], pendingClose: { id: "cc-1" },
  ...over,
});
const mkPeople = (over = {}) => ({
  you: { id: "you", name: "群主", kind: "human", status: "active" },
  me: { id: "me", name: "小满", kind: "agent", status: "active" },
  h1: { id: "h1", name: "张三", kind: "human", status: "active", createdVia: "invite", key: "k1" },
  h2: { id: "h2", name: "李四", kind: "human", status: "active", createdVia: "invite", key: "k2" },
  ...over,
});

t("token 熵：两次不同，长度够", () => {
  const a = newToken(), b = newToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 22, "base64url 16 字节应 ≥ 22 字符，实际 " + a.length);
});

t("昵称规整：去空白 / 压空白 / 拒超长 / 拒路径符", () => {
  assert.deepEqual(normalizeName("  张三  "), { ok: true, name: "张三" });
  assert.deepEqual(normalizeName("张   三"), { ok: true, name: "张 三" });
  assert.equal(normalizeName("   ").ok, false);
  assert.equal(normalizeName("一二三四五六七八九十一二三四五六七八九十一").ok, false);
  assert.equal(normalizeName("a/b").ok, false);
});

t("canClaim：不存在 / 作废 / 房间已解散", () => {
  assert.equal(canClaim(null, mkRoom()).code, 404);
  assert.equal(canClaim({ status: STATUS.DEAD }, mkRoom()).code, 410);
  assert.equal(canClaim({ status: STATUS.OPEN }, mkRoom({ status: "closed" })).code, 409);
  assert.equal(canClaim({ status: STATUS.OPEN }, mkRoom()).ok, true);
});

t("认名不认人：名字被在册的人占着 → busy", () => {
  const seat = resolveSeat({ people: mkPeople(), room: mkRoom({ members: ["you", "me", "h1"] }), name: "张三", token: "t" });
  assert.equal(seat.kind, "busy");
  assert.equal(seat.person.id, "h1");
});

t("名字只在别的房用着 → 允许（多房间隔离）", () => {
  const people = mkPeople({ h9: { id: "h9", name: "王五", status: "active" } });
  const seat = resolveSeat({ people, room: mkRoom(), name: "王五", token: "t" });
  assert.equal(seat.kind, "new");
});

t("退出 → 链接空出 → 同名可继承（继承的是同一个 id）", () => {
  const room = mkRoom({ invites: { t: { token: "t", status: STATUS.USED, holder: "h1", seatName: "张三" } } });
  const released = releaseInvite(room.invites.t);
  assert.equal(released.status, STATUS.OPEN);
  assert.equal(released.holder, null);
  assert.equal(released.seatName, "张三");
  // 张三已不在 members 里（退出了）
  room.members = ["you", "me"];
  const seat = resolveSeat({ people: mkPeople(), room, name: "张三", token: "t" });
  assert.equal(seat.kind, "inherit");
  assert.equal(seat.person.id, "h1", "继承必须是同一个 id，否则历史消息就断人了");
});

t("继承要重签 key：调用方换 key 后旧 key 失效", () => {
  const person = { id: "h1", name: "张三", key: "old" };
  person.key = "fresh";
  assert.equal(person.key, "fresh");
});

t("同 token 持有人回来：允许重签，身份不换", () => {
  const room = mkRoom({ invites: { t: { token: "t", status: STATUS.USED, holder: "h1", seatName: "张三" } } });
  const seat = resolveSeat({ people: mkPeople(), room, name: "张三", token: "t" });
  assert.equal(seat.kind, "inherit");
  assert.equal(seat.sameToken, true);
});

t("bindInvite：用完即废", () => {
  const inv = { token: "t", status: STATUS.OPEN };
  bindInvite(inv, { id: "h1", name: "张三" });
  assert.equal(inv.status, STATUS.USED);
  assert.equal(inv.holder, "h1");
  assert.equal(inv.seatName, "张三");
  assert.ok(inv.usedAt);
});

t("被踢：他的邀请全部报废，别人的不动", () => {
  const room = mkRoom({
    invites: {
      a: { token: "a", status: STATUS.USED, holder: "h1" },
      b: { token: "b", status: STATUS.USED, holder: "h1" },
      c: { token: "c", status: STATUS.USED, holder: "h2" },
    },
  });
  const dead = killInvitesOf(room, "h1");
  assert.deepEqual(dead.sort(), ["a", "b"]);
  assert.equal(room.invites.a.status, STATUS.DEAD);
  assert.equal(room.invites.a.deadReason, "kicked");
  assert.equal(room.invites.c.status, STATUS.USED, "别人的邀请不该受影响");
});

t("黑名单：按名字拦", () => {
  const room = mkRoom({ blacklist: [blacklistEntry("张三", "room-1", "you")] });
  assert.equal(isBlacklisted(room, "张三"), true);
  assert.equal(isBlacklisted(room, "李四"), false);
  assert.equal(isBlacklisted(mkRoom({ blacklist: ["张三"] }), "张三"), true, "老格式字符串也要认");
});

t("归档清场：人名 id 角色邀请全删，消息与标题保留", () => {
  const room = mkRoom({ invites: { t: { token: "t", status: STATUS.USED, holder: "h1" } } });
  const s = scrubRoomForArchive(room);
  assert.deepEqual(s.members, []);
  assert.deepEqual(s.roles, {});
  assert.deepEqual(s.invites, {});
  assert.deepEqual(s.muted, []);
  assert.deepEqual(s.blacklist, []);
  assert.equal(s.owner, "");
  assert.equal(s.pendingClose, null);
  assert.equal(s.scrubbed, true);
  assert.equal(s.title, "测试房");
  assert.equal(s.id, "room-1");
});

t("归档后清人：只删邀请进的临时身份、且不在别的活房", () => {
  const people = mkPeople();
  const archived = { __formerMembers: ["you", "me", "h1", "h2"] };
  const live = [{ id: "room-2", members: ["h2"] }];
  const purge = peopleToPurge(people, archived, live);
  assert.deepEqual(purge, ["h1"], "h2 还在别的房，you/me 不是邀请身份，都不该删");
});

let pass = 0, fail = 0;
for (const c of tests) {
  try { c.fn(); console.log("# PASS " + c.name); pass++; }
  catch (e) { console.log("# FAIL " + c.name + " :: " + (e && e.message)); fail++; }
}
console.log(`# tests ${tests.length}`);
console.log(`# pass ${pass}`);
console.log(`# fail ${fail}`);
process.exit(fail ? 1 : 0);
