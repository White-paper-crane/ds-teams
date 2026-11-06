// room-session-lib 单测：台账读写原语（B1 2026-11-04）。
// 纯函数级：临时目录里造台账，验证 readEnd/writeEnd 原子写合并、BOM 剥离、archived 标记、enabled:false 拒写。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readLedgerRaw, byRoomMap, writeEnd, markEndArchived, endOpts } from "../room-session-lib.mjs";

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.error("FAIL: " + name); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rs-lib-"));
const file = path.join(tmp, "room-sessions.json");
const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
process.on("exit", cleanup);

// ① 空缺文件 → readLedgerRaw null、byRoomMap 空。
ok(readLedgerRaw(file) === null, "missing file -> null");
ok(byRoomMap(file, "me").size === 0, "missing file -> empty map");

// ② writeEnd 建房间叶子（自动补 version/enabled/note/rooms）。
const leaf1 = writeEnd(file, "room-a", "me", { sessionId: "session-aaa", createdAt: "t1", status: "active" });
ok(leaf1.sessionId === "session-aaa", "writeEnd returns leaf");
const j2 = readLedgerRaw(file);
ok(j2.version === 1 && j2.enabled === true, "scaffold version/enabled");
ok(j2.rooms["room-a"].ends.me.sessionId === "session-aaa", "leaf written");

// ③ 另一端写同房不同叶子：不覆盖对方（合并保留 daman）。
writeEnd(file, "room-a", "daman", { sessionId: "session-bbb", status: "active" });
const j3 = readLedgerRaw(file);
ok(j3.rooms["room-a"].ends.me.sessionId === "session-aaa", "other end write preserves me");
ok(j3.rooms["room-a"].ends.daman.sessionId === "session-bbb", "daman leaf written");

// ④ 重复写同端：merge（未给字段保留旧值）。
writeEnd(file, "room-a", "me", { status: "archived" });
const j4 = readLedgerRaw(file);
ok(j4.rooms["room-a"].ends.me.sessionId === "session-aaa", "merge keeps old fields");
ok(j4.rooms["room-a"].ends.me.status === "archived", "merge applies new fields");

// ⑤ byRoomMap：archived 叶子不进表；enabled:false 全空。
const m5 = byRoomMap(file, "me");
ok(!m5.has("room-a"), "archived leaf excluded from map");
ok(byRoomMap(file, "daman").get("room-a") === "session-bbb", "active daman leaf in map");
const j5 = JSON.parse(fs.readFileSync(file, "utf8"));
j5.enabled = false;
fs.writeFileSync(file, JSON.stringify(j5), "utf8");
ok(byRoomMap(file, "daman").size === 0, "enabled:false -> empty map");
j5.enabled = true;
fs.writeFileSync(file, JSON.stringify(j5), "utf8");

// ⑥ BOM 台账：读得到、写得回（人手用记事本改过 = 带 BOM 也能解析）。
fs.writeFileSync(file, "\uFEFF" + JSON.stringify(j5), "utf8");
ok(readLedgerRaw(file)?.rooms?.["room-a"]?.ends?.me?.sessionId === "session-aaa", "BOM stripped on read");
writeEnd(file, "room-b", "me", { sessionId: "session-ccc", status: "active" });
ok(readLedgerRaw(file).rooms["room-b"].ends.me.sessionId === "session-ccc", "write after BOM read ok");
ok(!fs.readFileSync(file, "utf8").startsWith("\uFEFF"), "rewrite drops BOM");

// ⑦ enabled:false 时 writeEnd 拒写（回滚通道保护：人手关闸后桥不得再写）。
const j7 = JSON.parse(fs.readFileSync(file, "utf8"));   // 现读（含 ⑥ 写入的 room-b）
j7.enabled = false;
fs.writeFileSync(file, JSON.stringify(j7), "utf8");
let threw = false;
try { writeEnd(file, "room-c", "me", { sessionId: "x" }); } catch { threw = true; }
ok(threw, "writeEnd throws when disabled");

// ⑧ markEndArchived：叶子存在→标 archived；不存在→null 不炸。
j7.enabled = true;
fs.writeFileSync(file, JSON.stringify(j7), "utf8");   // 重新 enable
const r8 = markEndArchived(file, "room-b", "me");
ok(r8?.status === "archived" && r8.sessionId === "session-ccc", "markEndArchived sets status");
ok(markEndArchived(file, "no-such-room", "me") === null, "markEndArchived missing room -> null");

// ⑨ 原子性烟囱：写后无 .tmp-* 残留。
const leftovers = fs.readdirSync(tmp).filter((f) => f.includes(".tmp-"));
ok(leftovers.length === 0, "no tmp leftovers");

// ⑩ 跨进程合并模拟：外部（"另一进程"）先写 room-x，本端再写 room-y，room-x 保留。
const j10 = JSON.parse(fs.readFileSync(file, "utf8"));
j10.rooms["room-x"] = { ends: { me: { sessionId: "session-x", status: "active" } } };
fs.writeFileSync(file, JSON.stringify(j10), "utf8");
writeEnd(file, "room-y", "me", { sessionId: "session-y", status: "active" });
const j10b = readLedgerRaw(file);
ok(j10b.rooms["room-x"].ends.me.sessionId === "session-x", "external room preserved");
ok(j10b.rooms["room-y"].ends.me.sessionId === "session-y", "own room written");

// ⑪ B2（2026-11-04）endOpts：按角色分模型的叶子读取（桥内 optsFor/建会话处共用这个口径）。
// 干净台账重建，避免前面用例的残留字段干扰。
const f11 = path.join(tmp, "b2.json");
writeEnd(f11, "r-plain", "me", { sessionId: "session-plain", status: "active" });
const e11a = endOpts(f11, "r-plain", "me");
ok(e11a?.sessionId === "session-plain", "endOpts returns sessionId");
ok(e11a?.provider === undefined && e11a?.model === undefined, "endOpts no override -> provider/model undefined (回落 FALLBACK)");

// 只写 model：provider 仍 undefined，由桥回落 FALLBACK_PROVIDER。
writeEnd(f11, "r-model", "me", { sessionId: "session-m", status: "active", model: "deepseek-v4.1-flash" });
const e11b = endOpts(f11, "r-model", "me");
ok(e11b?.model === "deepseek-v4.1-flash", "endOpts model override applies");
ok(e11b?.provider === undefined, "endOpts provider falls back to undefined");

// 两种都写：都用台账值（两端按角色分模型的主路径）。
writeEnd(f11, "r-both", "me", { sessionId: "session-b", status: "active", provider: "tokenrocks", model: "glm-5.3" });
const e11c = endOpts(f11, "r-both", "me");
ok(e11c?.provider === "tokenrocks" && e11c?.model === "glm-5.3", "endOpts both overrides apply");

// 脏值（空串/纯空格/数字/对象）→ undefined，不能让 resume 拿到非法 model。
writeEnd(f11, "r-dirty", "me", { sessionId: "session-d", status: "active", provider: "   ", model: 42 });
const e11d = endOpts(f11, "r-dirty", "me");
ok(e11d?.provider === undefined && e11d?.model === undefined, "endOpts dirty values -> undefined");

// 另一端（daman）不受 me 叶子影响：按 who 取值。
ok(endOpts(f11, "r-both", "daman") === null, "endOpts other end without leaf -> null");

// 不存在房 / 无 sessionId 的叶子 → null（该房不走专属会话）。
ok(endOpts(f11, "no-such-room", "me") === null, "endOpts missing room -> null");
writeEnd(f11, "r-nosid", "me", { status: "active", model: "glm-5.3" });
ok(endOpts(f11, "r-nosid", "me") === null, "endOpts leaf without sessionId -> null");

// archived 叶子 → null（B1 归档后该房回落主会话，模型覆盖同时失效）。
markEndArchived(f11, "r-both", "me");
ok(endOpts(f11, "r-both", "me") === null, "endOpts archived leaf -> null");

// 总闸 enabled:false → null（回滚通道：关闸后一律走 FALLBACK_*）。
const j11 = JSON.parse(fs.readFileSync(f11, "utf8"));
j11.enabled = false;
fs.writeFileSync(f11, JSON.stringify(j11), "utf8");
ok(endOpts(f11, "r-plain", "me") === null, "endOpts disabled ledger -> null");

// ⑫ 桥内 optsFor 同构烟囱：endOpts 的 undefined 必须靠 || 回落到 FALLBACK_*（与两端桥代码一致）。
const FALLBACK_PROVIDER = "tokenrocks", FALLBACK_MODEL = "glm-5.3";
const strOpt = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");
const optsFor = (o) => ({ provider: strOpt(o && o.provider) || FALLBACK_PROVIDER, model: strOpt(o && o.model) || FALLBACK_MODEL });
const o12 = optsFor(e11b);   // e11b = 只有 model 的叶子
ok(o12.provider === FALLBACK_PROVIDER && o12.model === "deepseek-v4.1-flash", "optsFor: model override + provider fallback");
const o12b = optsFor(null);
ok(o12b.provider === FALLBACK_PROVIDER && o12b.model === FALLBACK_MODEL, "optsFor: null -> both fallback");

console.log(`room-session-lib: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
