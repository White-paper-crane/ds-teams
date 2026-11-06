// dispatch 限额/排队/看门狗/重试 夹具：用临时台账跑，不碰 data/dispatch-state.json
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ds-disp-"));
process.env.DS_TEAMS_LEDGER = path.join(dir, "ledger.json");
const { claim, promote, watchdog, fail, counts, readLedger, writeLedger, taskKey, CAP, setState } = await import("../dispatch-lib.mjs");

let fails = 0;
const ok = (name, cond, extra = "") => { if (!cond) { fails++; console.log("FAIL " + name + (extra ? " :: " + JSON.stringify(extra) : "")); } else console.log("PASS " + name); };

// 1. 同房间上限 2
ok("cap 说明", CAP.global === 3 && CAP.room === 2);
const a1 = claim("rA", "T1", 1), a2 = claim("rA", "T2", 2);
ok("前两张 claimed", a1.entry.state === "claimed" && a2.entry.state === "claimed");
const a3 = claim("rA", "T3", 3);
ok("第 3 张排队 queued", a3.queued === true && a3.entry.state === "queued" && a3.entry.queuePos === 1);
const b1 = claim("rB", "T1", 4);
ok("别的房还能 claim", b1.entry.state === "claimed");
const b2 = claim("rB", "T2", 5);
const b3 = claim("rB", "T3", 6);
ok("全局满 3 后继续排队", b2.entry.state === "queued" && b3.entry.state === "queued", { b2: b2.entry.state, b3: b3.entry.state });
ok("计数：global=3", counts().global === 3, counts());

// 2. promote 按 sourceSeq 顺序、受限额
const promoted0 = promote();
ok("名额满时不 promote", promoted0.length === 0, promoted0);
setState(taskKey("rA", "T1"), "done");
const promoted = promote();
ok("空出一个名额后 promote 一张", promoted.length === 1 && promoted[0] === taskKey("rA", "T3"), promoted);
ok("promote 后状态 claimed", readLedger().tasks[taskKey("rA", "T3")].state === "claimed");
ok("rB 的排队仍受房间限额", readLedger().tasks[taskKey("rB", "T3")].state === "queued");

// 3. watchdog：过期 deadline 与 claimed 卡住
const db = readLedger();
db.tasks[taskKey("rB", "T1")].deadlineAt = new Date(Date.now() - 1000).toISOString();
db.tasks[taskKey("rA", "T3")].updatedAt = new Date(Date.now() - 10 * 60e3).toISOString();
writeLedger(db);
const wd = watchdog({ claimedMs: 5 * 60e3, runMs: 45 * 60e3 });
const reasons = Object.fromEntries(wd.map((x) => [x.key, x.reason]));
ok("deadline 过期 → timeout", reasons[taskKey("rB", "T1")] === "deadline passed", reasons);
ok("claimed 10 分钟 → timeout", reasons[taskKey("rA", "T3")] === "claimed but never spawned", reasons);
ok("排队中的任务不受 claimed 规则影响", readLedger().tasks[taskKey("rB", "T2")].state === "queued");

// 4. spawn 失败重试：3 次内回 queued，超过标 failed
const f1 = fail(taskKey("rA", "T3"), "spawn boom");
ok("第一次失败回 queued", f1.retry === true && f1.state === "queued" && f1.attempts === 2, f1);
fail(taskKey("rA", "T3"), "spawn boom");
const f3 = fail(taskKey("rA", "T3"), "spawn boom");
ok("第三次失败标 failed", f3.retry === false && f3.state === "failed" && f3.attempts === 4, f3);

fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAIL` : "\nALL PASS");
process.exit(fails ? 1 : 0);
