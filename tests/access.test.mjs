import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CAPS, RANK, can, canActOn, effectiveRole, capabilitiesOf, needsSuperConfirm, describe, isRole,
} from "../access-lib.mjs";

const superP = { id: "you", sysRole: "super" };
const meP = { id: "me", sysRole: "normal" };
const damanP = { id: "daman", sysRole: "normal" };
const hP = { id: "h-x", sysRole: "normal" };

const room = { owner: "me", roles: { daman: "admin" }, members: ["you", "me", "daman", "h-x"] };

test("超级群主在别人的房间里仍然是 super", () => {
  assert.equal(effectiveRole(superP, room), "super");
});

test("小群主 = 房间创建者", () => {
  assert.equal(effectiveRole(meP, room), "owner");
});

test("roles 里标 admin 的就是管理员，其余是成员", () => {
  assert.equal(effectiveRole(damanP, room), "admin");
  assert.equal(effectiveRole(hP, room), "member");
});

test("房间把他降级也不影响超级群主", () => {
  const downgraded = { owner: "me", roles: { you: "member" }, members: ["you", "me"] };
  assert.equal(effectiveRole(superP, downgraded), "super");
  assert.equal(can(effectiveRole(superP, downgraded), "room.close"), true);
  assert.equal(can(effectiveRole(superP, downgraded), "room.create"), true);
});

test("新建房间只有超级群主有", () => {
  assert.equal(can("super", "room.create"), true);
  assert.equal(can("owner", "room.create"), false);
  assert.equal(can("admin", "room.create"), false);
  assert.equal(can("member", "room.create"), false);
});

test("解散：小群主有，管理员和成员没有", () => {
  assert.equal(can("owner", "room.close"), true);
  assert.equal(can("admin", "room.close"), false);
  assert.equal(can("member", "room.close"), false);
});

test("归档只有超级群主", () => {
  assert.equal(can("super", "room.archive"), true);
  for (const r of ["owner", "admin", "member"]) assert.equal(can(r, "room.archive"), false);
});

test("管理员不能撤销管理员（没有 setRole）", () => {
  assert.equal(can("admin", "member.setRole"), false);
  assert.equal(can("owner", "member.setRole"), true);
  assert.equal(can("super", "member.setRole"), true);
});

test("普通成员不能拉人踢人，但能发言", () => {
  assert.equal(can("member", "member.invite"), false);
  assert.equal(can("member", "member.kick"), false);
  assert.equal(can("member", "message.say"), true);
});

test("管理员之间不能互踢，但能踢成员", () => {
  assert.equal(canActOn("admin", "admin"), false);
  assert.equal(canActOn("admin", "member"), true);
  assert.equal(canActOn("admin", "owner"), false);
  assert.equal(canActOn("admin", "super"), false);
});

test("小群主能踢管理员和成员，踢不动超级群主", () => {
  assert.equal(canActOn("owner", "admin"), true);
  assert.equal(canActOn("owner", "member"), true);
  assert.equal(canActOn("owner", "super"), false);
  assert.equal(canActOn("owner", "owner"), false, "不能踢自己");
});

test("超级群主能动任何人，包括小群主", () => {
  for (const t of ["owner", "admin", "member"]) assert.equal(canActOn("super", t), true);
  assert.equal(canActOn("super", "super"), false, "唯一超管不能被自己以外的人动，这里同角色不算更低");
});

test("小群主解散需要超管确认，超管自己解散不需要", () => {
  assert.equal(needsSuperConfirm(meP, room), true);
  assert.equal(needsSuperConfirm(superP, room), false);
  assert.equal(needsSuperConfirm(damanP, room), false);
});

test("describe 下发给 UI 的能力清单和角色一致", () => {
  const d = describe(hP, room);
  assert.equal(d.role, "member");
  assert.deepEqual(d.caps, ["message.say", "message.file"]);
  assert.deepEqual(d.canActOn, []);
  assert.equal(d.caps.includes("member.invite"), false);
});

test("CAPS 无重复，GRANTS 里没有拼错的能力名", () => {
  assert.equal(new Set(CAPS).size, CAPS.length);
  for (const role of ["owner", "admin", "member"]) {
    for (const c of capabilitiesOf(role)) {
      assert.ok(CAPS.includes(c), `未知能力 ${c}`);
      assert.notEqual(c, "room.create");
    }
  }
});

test("RANK 顺序符合 超管 > 小群主 > 管理员 > 成员", () => {
  assert.ok(RANK.super > RANK.owner);
  assert.ok(RANK.owner > RANK.admin);
  assert.ok(RANK.admin > RANK.member);
});

test("isRole 只认四个角色名", () => {
  for (const r of ["super", "owner", "admin", "member"]) assert.equal(isRole(r), true);
  for (const r of ["", "root", "OWNER", undefined, null]) assert.equal(isRole(r), false);
});
