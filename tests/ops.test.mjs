// 运维观测事件单元测试：ops-lib 的 warn 落盘 / tail 倒序与过滤 / 坏行容错 / 目录自建。
// node tests/ops.test.mjs
// 全部跑在临时目录（DS_TEAMS_OPS_FILE 指过去），绝不碰 data/ops-events.jsonl。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 注意：ops-lib 在模块加载时就读取 DS_TEAMS_OPS_FILE，所以必须先设环境变量再 import。
// 父目录故意不存在：连带验证 warn 的 mkdirSync(recursive) 自建目录。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ds-teams-ops-"));
const FILE = path.join(TMP, "nested", "ops-events.jsonl");
process.env.DS_TEAMS_OPS_FILE = FILE;

const { warn, tail, _internals } = await import("../ops-lib.mjs");

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name + (extra ? " — " + extra : "")); } };

const lines = () => fs.readFileSync(FILE, "utf8").split(/\r?\n/).filter(Boolean);

console.log("== 路径：环境变量生效，没指到真实 data/ ==");
ok("_internals.FILE 等于 DS_TEAMS_OPS_FILE", _internals.FILE === process.env.DS_TEAMS_OPS_FILE, `${_internals.FILE} vs ${process.env.DS_TEAMS_OPS_FILE}`);
ok("路径在临时目录内", _internals.FILE.startsWith(TMP), _internals.FILE);
ok("不是真实 data/ops-events.jsonl", !_internals.FILE.replace(/\\/g, "/").endsWith("/ds-teams/data/ops-events.jsonl"), _internals.FILE);

console.log("== tail：文件不存在时返回 []，不抛 ==");
{
  ok("文件确实还不存在（前置条件）", !fs.existsSync(FILE));
  let threw = false, r;
  try { r = tail(10); } catch { threw = true; }
  ok("不抛异常", !threw);
  ok("返回空数组", Array.isArray(r) && r.length === 0, JSON.stringify(r));
  ok("读不建文件", !fs.existsSync(FILE));
}

console.log("== warn：目录不存在也能自建 ==");
{
  // warn 内部 try/catch 全吞，所以「不抛」不能单独作为断言，必须验文件真的落盘。
  let threw = false, rec;
  try { rec = warn("REVIEW_LATENCY", { roomId: "room-t1", latencyMs: 130000, thresholdMs: 120000 }); } catch { threw = true; }
  ok("不抛异常", !threw);
  ok("目录被自建", fs.existsSync(path.dirname(FILE)), path.dirname(FILE));
  ok("文件被创建", fs.existsSync(FILE));
  ok("返回对象 code 正确", rec && rec.code === "REVIEW_LATENCY", JSON.stringify(rec));
  ok("返回对象 level=warn", rec && rec.level === "warn", JSON.stringify(rec));
  ok("返回对象 at 是 ISO 串", rec && typeof rec.at === "string" && new Date(rec.at).toISOString() === rec.at, String(rec && rec.at));
  ok("返回对象透传 fields", rec && rec.roomId === "room-t1" && rec.latencyMs === 130000 && rec.thresholdMs === 120000, JSON.stringify(rec));
  ok("落盘恰好一行", lines().length === 1, String(lines().length));
  const disk = JSON.parse(lines()[0]);
  ok("返回对象与落盘内容一致", JSON.stringify(disk) === JSON.stringify(rec), `${JSON.stringify(disk)} vs ${JSON.stringify(rec)}`);
  ok("落盘也是合法 JSON 且以换行结尾", fs.readFileSync(FILE, "utf8").endsWith("\n"));
}

console.log("== warn：多字段透传（会议室/评审场景的那几个键）==");
{
  const rec = warn("REVIEW_SILENT", { roomId: "room-t2", issueId: "mt-1-me-x", reviewer: "daman", closedBy: "silent", title: "标题", round: 2 });
  ok("返回齐全", rec.issueId === "mt-1-me-x" && rec.reviewer === "daman" && rec.closedBy === "silent" && rec.title === "标题" && rec.round === 2, JSON.stringify(rec));
  const disk = JSON.parse(lines().at(-1));
  ok("落盘齐全", disk.issueId === "mt-1-me-x" && disk.round === 2 && disk.roomId === "room-t2", JSON.stringify(disk));
}

console.log("== tail：倒序 + n 生效 ==");
{
  const rec = warn("ROOM_ARCHIVE", { roomId: "room-t3", title: "第三个", round: 1 });
  const all = tail(50);
  ok("三行都读到", all.length === 3, String(all.length));
  ok("最后写入的在数组第一个", all[0].code === "ROOM_ARCHIVE" && all[0].roomId === "room-t3", JSON.stringify(all[0]));
  ok("最早写入的在数组最后", all[2].code === "REVIEW_LATENCY" && all[2].roomId === "room-t1", JSON.stringify(all[2]));
  const two = tail(2);
  ok("n=2 只回 2 条", two.length === 2, String(two.length));
  ok("n=2 取最新两条", two[0].roomId === "room-t3" && two[1].roomId === "room-t2", JSON.stringify(two.map((x) => x.roomId)));
  ok("n=1 只回最新一条", tail(1).length === 1 && tail(1)[0].roomId === "room-t3");
  ok("n 超过总数时全给", tail(999).length === 3, String(tail(999).length));
  ok("n=0 返回空", tail(0).length === 0);
}

console.log("== tail：按 code 过滤 ==");
{
  warn("REVIEW_LATENCY", { roomId: "room-t4", latencyMs: 99000, thresholdMs: 90000 });
  const f = tail(50, { code: "REVIEW_LATENCY" });
  ok("只回该 code", f.length === 2 && f.every((x) => x.code === "REVIEW_LATENCY"), JSON.stringify(f.map((x) => x.code)));
  ok("过滤后仍倒序", f[0].roomId === "room-t4" && f[1].roomId === "room-t1", JSON.stringify(f.map((x) => x.roomId)));
  const none = tail(50, { code: "NO_SUCH_CODE" });
  ok("不匹配的 code 不返回", Array.isArray(none) && none.length === 0, JSON.stringify(none));
  ok("空 code 不过滤", tail(50, { code: "" }).length === 4, String(tail(50, { code: "" }).length));
  ok("过滤不写盘", lines().length === 4, String(lines().length));
}

console.log("== tail：坏行容错 ==");
{
  fs.appendFileSync(FILE, "这不是 JSON，是被人手写进去的垃圾行\n", "utf8");
  warn("ROOM_ARCHIVE", { roomId: "room-t5" });
  ok("文件里确实有坏行", lines().length === 6, String(lines().length));

  let threw = false, all;
  try { all = tail(50); } catch { threw = true; }
  ok("遇到坏行不抛", !threw);
  ok("坏行被跳过，只回合法记录", all.length === 5, String(all.length));
  ok("坏行不在结果里", all.every((x) => typeof x.code === "string"), JSON.stringify(all.map((x) => x.code)));
  ok("最新一条仍排第一（坏行之后写入的）", all[0].roomId === "room-t5", JSON.stringify(all[0]));

  // 坏行 + 过滤也不会让过滤结果变空或抛
  const f = tail(50, { code: "REVIEW_LATENCY" });
  ok("带过滤时坏行同样被跳过", f.length === 2, String(f.length));

  // warn 自己写进去的行必须永远是合法 JSON（坏行是外部污染，不是 warn 的锅）
  ok("warn 写入的行全部可解析", lines().filter((l) => l.startsWith("{")).every((l) => { try { JSON.parse(l); return true; } catch { return false; } }));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
