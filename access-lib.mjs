// 权限内核（纯函数，零依赖，可单测）。
//
// 设计口径（2026-11-05 群主定，见 方案-权限v4.md）：
//   系统级角色 sysRole：super（超级群主，唯一）/ normal（其余一切人）
//   房间级角色 roomRole：owner（小群主＝房间创建者）/ admin / member
//   有效角色 effective = super 永远压过房间角色（超级群主在哪个房间都是满血）
//
// 为什么单独成文件：原来权限判断散在每个路由里写 `if (who !== OWNER)`，一共 9 处，
// 加一个角色就要改 9 个地方，漏一处就是一个洞。现在只有这一张表是真源，
// 服务端只问「这个人这个动作能不能做」，UI 只问「服务端说我能做哪些」。

/** 能力清单：新增权限先在这里加名字，再在 GRANTS 里分配。 */
export const CAPS = Object.freeze([
  "room.create",      // 新建房间
  "room.close",       // 解散房间（小群主需超管确认，见 needsConfirm）
  "room.archive",     // 归档（超管专属，房间里不再给入口）
  "room.restore",     // 还原归档
  "room.rules",       // 改房间规则
  "room.settings",    // 改房间设置
  "member.invite",    // 拉人 / 生成邀请链接
  "member.kick",      // 踢人
  "member.mute",      // 禁言
  "member.setRole",   // 设/撤管理员
  "member.transfer",  // 转让小群主
  "message.say",      // 发言
  "message.file",     // 发文件
  "message.recallAny",// 撤回别人的消息
  "memory.write",     // 写房间记忆
  "task.write",       // 派活/改项目状态
  "people.create",    // 开通新身份
]);

/** 角色权重。只用来做「能不能动这个人」的比较，不参与能力判断。 */
export const RANK = Object.freeze({ super: 100, owner: 80, admin: 50, member: 10 });

/** 每个角色拥有哪些能力。`*` 只给 super。 */
const GRANTS = Object.freeze({
  // 超级群主：满血。房间里被降级也不影响。
  super: Object.freeze(["*"]),
  // 小群主：本房最高，但没有「新建房间」（那是超管专属）。
  owner: Object.freeze([
    "room.close", "room.rules", "room.settings",
    "member.invite", "member.kick", "member.mute", "member.setRole", "member.transfer",
    "message.say", "message.file", "message.recallAny",
    "memory.write", "task.write",
  ]),
  // 管理员：日常管理，不能建房、不能解散、不能动别的管理员。
  admin: Object.freeze([
    "room.rules",
    "member.invite", "member.kick", "member.mute",
    "message.say", "message.file", "message.recallAny",
    "memory.write", "task.write",
  ]),
  // 普通成员：只读 + 发言。
  member: Object.freeze([
    "message.say", "message.file",
  ]),
});

/** 角色是否合法。 */
export function isRole(role) {
  return Object.prototype.hasOwnProperty.call(GRANTS, role);
}

/**
 * 算一个人在某个房间里的有效角色。
 * @param {{id?:string, sysRole?:string}} person 人（sysRole==='super' 即超级群主）
 * @param {{owner?:string, roles?:Record<string,string>, members?:string[]}} room 房间
 * @returns {"super"|"owner"|"admin"|"member"}
 */
export function effectiveRole(person, room) {
  if (!person || !person.id) return "member";
  // 超级群主压过一切：哪怕房间把他降成 member，也是满血。
  if (person.sysRole === "super") return "super";
  if (room) {
    if (room.owner === person.id) return "owner";
    const r = room.roles && room.roles[person.id];
    if (r === "admin") return "admin";
  }
  return "member";
}

/** 某个角色有没有某个能力。 */
export function can(role, cap) {
  const g = GRANTS[role];
  if (!g) return false;
  if (g.includes("*")) return true;
  return g.includes(cap);
}

/** 该角色能不能对「这个角色的人」执行管理动作。 */
export function canActOn(actorRole, targetRole) {
  if (!isRole(actorRole) || !isRole(targetRole)) return false;
  // 谁都动不了超级群主。
  if (targetRole === "super") return false;
  // 超级群主能动任何人。
  if (actorRole === "super") return true;
  // 其余：只能动权重严格更低的人（管理员不能互踢，小群主不能踢自己）。
  return RANK[actorRole] > RANK[targetRole];
}

/** 该角色能做的全部能力，给前端渲染按钮用。 */
export function capabilitiesOf(role) {
  return CAPS.filter((c) => can(role, c));
}

/**
 * 这个动作要不要走「超级群主 5 秒确认」。
 * 只有小群主发起解散才要；超级群主自己解散、或者房间的小群主本来就是超管，直接放行。
 */
export function needsSuperConfirm(actorPerson, room) {
  const actorRole = effectiveRole(actorPerson, room);
  if (actorRole === "super") return false;
  if (!room) return false;
  // 房间的小群主就是超级群主本人 → 他发起时 actorRole 已经是 super，走不到这里。
  return actorRole === "owner";
}

/**
 * 一次性算清「这个人在这间房能干什么」，直接下发给 UI。
 * UI 不再自己判断 `who === 'you'`——那是上一轮「我不是群主」整类 bug 的根。
 * @returns {{role:string, caps:string[], canActOn:string[]}}
 */
export function describe(person, room) {
  const role = effectiveRole(person, room);
  const caps = capabilitiesOf(role);
  const canActOnRoles = ["super", "owner", "admin", "member"].filter((t) => canActOn(role, t));
  return { role, caps, canActOn: canActOnRoles };
}
