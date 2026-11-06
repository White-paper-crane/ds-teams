// 清理测试房：测试脚本建出来的房间「先解散、再归档」，让主列表只剩真实房间。
// 用法：node tools/cleanup-test-rooms.mjs [--dry-run]
// 保留名单：room-5c8a80（协同任务规范）以及任何标题不匹配的房。归档不是删除，可在「归档」里回看/还原。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const BASE = (process.env.DS_TEAMS_URL || "http://127.0.0.1:8792").replace(/\/+$/, "");
const ADMIN_KEY = (process.env.DS_TEAMS_KEY || fs.readFileSync(path.join(ROOT, "data", "key.txt"), "utf8")).trim();
const PEOPLE = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "people.json"), "utf8"));
const KEY = PEOPLE.you.key; // 解散/归档用群主 you 的身份
const DRY = process.argv.includes("--dry-run");

// 测试脚本的标题约定（新增测试房请沿用这些前缀）
const TEST_TITLE = /^(接口测试|附件测试|引用撤回测试|成员体系|成员体系自测|C端自测|压测|路由测试|burst|dispatch|files|quote|probe|claim接口回归|dbg-|auth 自检|CLI引用验证|UI引用撤回验证|附件 UI 测试|附件测试2|v3服务端|邀请链接自测|实时刷新|待确认解散|\[自测\]|\[测试\]|工具化自测房)/;
const KEEP = new Set(["room-5c8a80"]);

async function api(method, p, body) {
  const res = await fetch(`${BASE}${p}${p.includes("?") ? "&" : "?"}k=${encodeURIComponent(ADMIN_KEY)}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify({ ...body, key: KEY }),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 200) }; }
  return { status: res.status, data };
}

// 房间列表按 viewer 过滤（超管 you 看全部），必须带 who+mk，否则返回空列表、测试房永远清不到
const list = await api("GET", `/api/rooms?who=you&mk=${encodeURIComponent(KEY)}`);
if (!list.data?.rooms) { console.error("拉房间列表失败", list.status, list.data); process.exit(1); }
const targets = list.data.rooms.filter((r) => !KEEP.has(r.id) && TEST_TITLE.test(String(r.title || "")));
console.log(`房间总数 ${list.data.rooms.length}，待清理 ${targets.length}`);
let closed = 0, archived = 0, failed = 0;
for (const r of targets) {
  if (DRY) { console.log(`  [dry] ${r.id} ${r.status} ${r.title}`); continue; }
  if (r.status === "open") {
    const c = await api("POST", `/api/rooms/${r.id}/close`, { who: "you" });
    if (c.status !== 200) { failed++; console.log(`  FAIL close ${r.id} ${JSON.stringify(c.data).slice(0, 120)}`); continue; }
    closed++;
  }
  const a = await api("POST", `/api/rooms/${r.id}/archive`, { who: "you" });
  if (a.status !== 200) { failed++; console.log(`  FAIL archive ${r.id} ${JSON.stringify(a.data).slice(0, 120)}`); continue; }
  archived++;
  for (const dir of ["memory", path.join("archive", "memory")]) {
    const fp = path.join(ROOT, "data", dir, `${r.id}.jsonl`);
    try { if (fs.existsSync(fp)) { fs.unlinkSync(fp); console.log(`  unlink memory ${r.id}.jsonl`); } } catch {}
  }
  console.log(`  archived ${r.id} ${r.title}`);
}
console.log(`完成：解散 ${closed}，归档 ${archived}，失败 ${failed}`);

// 顺手清掉测试留下的孤儿身份：不在任何活房间里、又不是 you/me/daman 的 h-* 身份。
// 只在显式传 --prune-people 时跑（run-all.mjs 会传），日常手动清理不动身份。
if (process.argv.includes("--prune-people") && !DRY) {
  const live = new Set();
  for (const r of list.data.rooms) for (const m of r.members || []) live.add(m);
  const people = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "people.json"), "utf8"));
  const orphans = Object.keys(people).filter((id) => id.startsWith("h-") && !live.has(id));
  if (orphans.length) {
    // 删除 = 移动：先落一份备份到回收站，再从 people.json 摘掉
    const day = new Date().toISOString().slice(0, 10);
    const trash = path.join(path.join(os.tmpdir(), "ds-teams-trash"), day);
    fs.mkdirSync(trash, { recursive: true });
    const fp = path.join(trash, `people-pruned-${Date.now()}.json`);
    fs.writeFileSync(fp, JSON.stringify(Object.fromEntries(orphans.map((id) => [id, people[id]])), null, 2), "utf8");
    for (const id of orphans) delete people[id];
    fs.writeFileSync(path.join(ROOT, "data", "people.json"), JSON.stringify(people, null, 2) + "\n", "utf8");
    console.log(`孤儿身份 ${orphans.length} 个已移入回收站：${fp}`);
  } else {
    console.log("孤儿身份 0 个");
  }
}

if (failed) process.exitCode = 1;
