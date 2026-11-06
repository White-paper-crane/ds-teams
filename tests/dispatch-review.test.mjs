// dispatch 复核记录 + 关房条件（D1）
// 跑法：node tests/dispatch-review.test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ds-dispatch-review-"));
process.env.DS_TEAMS_LEDGER = path.join(dir, "ledger.json");

const { claim, setState, addReview, roomStatus, taskKey } = await import(
  "../dispatch-lib.mjs?t=" + Date.now()
);

let pass = 0;
let fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log("ok - " + name); }
  else { fail++; console.log("FAIL - " + name + (extra ? " :: " + extra : "")); }
}

const R = "room-test";

// 1. 一条 done 任务，未复核 -> 不能关房
claim(R, "A");
setState(taskKey(R, "A"), "done");
let st = roomStatus(R);
ok("done 但未复核：unreviewed 命中 A", st.unreviewed.includes("A"), JSON.stringify(st));
ok("done 但未复核：canClose=false", st.canClose === false);

// 2. pass 复核 -> done，可关房
let r = addReview(taskKey(R, "A"), { by: "daman", verdict: "pass", note: "过了" });
ok("pass 复核写入 ok", r.ok === true);
ok("pass 后状态 done", r.entry.state === "done", r.entry.state);
ok("复核记录含 verdict", r.entry.reviews.at(-1).verdict === "pass");
st = roomStatus(R);
ok("全部复核后 canClose=true", st.canClose === true, JSON.stringify(st));

// 3. fail 复核 -> blocked（带原因）
claim(R, "B");
setState(taskKey(R, "B"), "done");
r = addReview(taskKey(R, "B"), { verdict: "fail", note: "第三行写错" });
ok("fail 后状态 blocked", r.entry.state === "blocked", r.entry.state);
ok("fail 带 blockReason", r.entry.blockReason === "第三行写错", r.entry.blockReason);
ok("fail 意见留档", r.entry.reviews.at(-1).note === "第三行写错");
st = roomStatus(R);
ok("fail 复核后 canClose=false", st.canClose === false);
ok("pending 命中 B", st.pending.includes("B"), JSON.stringify(st.pending));

// 4. aborted 任务不挡关房
claim(R, "C");
setState(taskKey(R, "C"), "aborted");
st = roomStatus(R);
ok("aborted 不进 tasks 计数", st.tasks === 2, "tasks=" + st.tasks);
ok("aborted 不挡关房（B 仍挡）", st.pending.includes("B") && !st.pending.includes("C"));

// 5. noReview 豁免
claim(R, "D");
setState(taskKey(R, "D"), "done");
ok("D 未复核挡关房", roomStatus(R).unreviewed.includes("D"));
const dbPath = process.env.DS_TEAMS_LEDGER;
const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
db.tasks[taskKey(R, "D")].noReview = true;
fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
ok("noReview 豁免后不再挡", !roomStatus(R).unreviewed.includes("D"));

// 6. 非法 verdict / 未知 key
ok("非法 verdict 拒绝", addReview(taskKey(R, "A"), { verdict: "ok" }).ok === false);
ok("未知 key 拒绝", addReview(taskKey(R, "ZZZ"), { verdict: "pass" }).ok === false);

// 7. 空房间不能关
ok("空房间 canClose=false", roomStatus("room-empty").canClose === false);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n通过: ${pass}  失败: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
