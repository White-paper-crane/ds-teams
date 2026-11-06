// 唤醒治理服务端测试（docs/wake-governance.md §9 服务端部分）。
// 运行：node --test tests/wake.test.mjs —— 全部用例跑在隔离实例上
// （临时数据目录 + 临时端口 + 小 patrol + 环境变量小限额），不动真实 8792。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeApi(base, key, people) {
  return async function api(method, p, body) {
    if (body && body.who && !body.key) body = { ...body, key: (people[body.who] || {}).key };
    const sep = p.includes("?") ? "&" : "?";
    const res = await fetch(`${base}${p}${sep}k=${encodeURIComponent(key)}`, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch {}
    return { status: res.status, data };
  };
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

// 隔离实例：临时数据目录 + 临时台账 + 快 patrol；env 可加 WAKE_* 环境变量覆盖。
async function startEphemeral(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ds-teams-wake-"));
  const dataDir = path.join(dir, "data");
  const ledger = path.join(dir, "ledger.json");
  const port = await freePort();
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      DS_TEAMS_PORT: String(port),
      DS_TEAMS_LEDGER: ledger,
      DS_TEAMS_DATA_DIR: dataDir,
      DS_TEAMS_PATROL_MS: "400",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  const keyFile = path.join(dataDir, "key.txt");
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    if (child.exitCode !== null) throw new Error(`隔离实例提前退出(${child.exitCode}): ${log.slice(-800)}`);
    if (fs.existsSync(keyFile)) {
      try {
        const key = fs.readFileSync(keyFile, "utf8").trim();
        const res = await fetch(`${base}/api/health?k=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(2000) });
        if (res.status === 200) {
          const people = JSON.parse(fs.readFileSync(path.join(dataDir, "people.json"), "utf8"));
          return {
            base, key, people, ledger, dir, dataDir, child,
            kill() { try { child.kill(); } catch {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
          };
        }
      } catch {}
    }
    await sleep(200);
  }
  try { child.kill(); } catch {}
  throw new Error(`隔离实例启动超时: ${log.slice(-800)}`);
}

function today() {
  const n = new Date();
  const y = n.getFullYear();
  const m = String(n.getMonth() + 1).padStart(2, "0");
  const d = String(n.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

test("admit：放行签发 wakeId、计数、同 (who,seq) 幂等不增计数", async () => {
  const inst = await startEphemeral();
  const eapi = makeApi(inst.base, inst.key, inst.people);
  try {
    const a1 = await eapi("POST", "/api/wake/admit", { who: "me", seq: 10, roomId: "room-test", kind: "text" });
    assert.equal(a1.status, 200);
    assert.equal(a1.data.ok, true);
    assert.equal(a1.data.allow, true);
    assert.match(a1.data.wakeId, /^w-10-me-[0-9a-f]{4}$/, "wakeId 形如 w-<seq>-<who>-<4hex>");
    assert.deepEqual(a1.data.budget, { used: 1, limit: 200 });
    assert.equal(a1.data.highContextAge, false);

    // 同一 (who,seq) 再 admit：返回既有 wakeId，计数不增
    const a2 = await eapi("POST", "/api/wake/admit", { who: "me", seq: 10, roomId: "room-test", kind: "text" });
    assert.equal(a2.status, 200);
    assert.equal(a2.data.allow, true);
    assert.equal(a2.data.wakeId, a1.data.wakeId, "幂等返回既有 wakeId");
    assert.deepEqual(a2.data.budget, { used: 1, limit: 200 }, "重复 tick 不重复计数");

    // 另一端同 seq 独立计数
    const a3 = await eapi("POST", "/api/wake/admit", { who: "daman", seq: 10, roomId: "room-test", kind: "text" });
    assert.equal(a3.data.allow, true);
    assert.notEqual(a3.data.wakeId, a1.data.wakeId);
    assert.deepEqual(a3.data.budget, { used: 1, limit: 200 });

    const st = await eapi("GET", "/api/wake/state");
    assert.equal(st.status, 200);
    assert.equal(st.data.days[st.data.day].me.count, 1);
    assert.equal(st.data.days[st.data.day].daman.count, 1);
    assert.equal(st.data.days[st.data.day].me.blocked, 0);
    assert.equal(st.data.injectTotals.me, 1);
    assert.equal(st.data.injectTotals.daman, 1);
  } finally {
    inst.kill();
  }
});

test("限额：WAKE_DAILY_LIMIT 小值 → 用尽后 allow:false/COUNT 且 blocked++，0 放行", async () => {
  const inst = await startEphemeral({ WAKE_DAILY_LIMIT: "2" });
  const eapi = makeApi(inst.base, inst.key, inst.people);
  try {
    const a1 = await eapi("POST", "/api/wake/admit", { who: "me", seq: 1, roomId: "r", kind: "text" });
    assert.equal(a1.data.allow, true);
    assert.deepEqual(a1.data.budget, { used: 1, limit: 2 });
    const a2 = await eapi("POST", "/api/wake/admit", { who: "me", seq: 2, roomId: "r", kind: "text" });
    assert.equal(a2.data.allow, true);
    assert.deepEqual(a2.data.budget, { used: 2, limit: 2 });

    // 用尽：第三次被拒，计数不增、blocked++
    const a3 = await eapi("POST", "/api/wake/admit", { who: "me", seq: 3, roomId: "r", kind: "text" });
    assert.equal(a3.status, 200);
    assert.equal(a3.data.ok, true);
    assert.equal(a3.data.allow, false);
    assert.equal(a3.data.reason, "COUNT");
    assert.deepEqual(a3.data.budget, { used: 2, limit: 2 }, "被拒不虚增 used");

    // 被拒的同 (who,seq) 重复 admit 幂等：仍是 COUNT，blocked 不重复累加
    const a4 = await eapi("POST", "/api/wake/admit", { who: "me", seq: 3, roomId: "r", kind: "text" });
    assert.equal(a4.data.allow, false);
    assert.equal(a4.data.reason, "COUNT");

    // 另一端的预算独立，不受 me 用尽影响
    const a5 = await eapi("POST", "/api/wake/admit", { who: "daman", seq: 9, roomId: "r", kind: "text" });
    assert.equal(a5.data.allow, true);

    const st = await eapi("GET", "/api/wake/state");
    assert.equal(st.data.days[st.data.day].me.count, 2, "放行计数停在 limit");
    assert.equal(st.data.days[st.data.day].me.blocked, 1, "被拒一次 blocked=1");
    assert.equal(st.data.injectTotals.me, 2);
  } finally {
    inst.kill();
  }
});

test("settle：合法回填 / 幂等先到先得 / 跨 who 拒绝 / 未知 wakeId 404 / 非法 outcome 400", async () => {
  const inst = await startEphemeral();
  const eapi = makeApi(inst.base, inst.key, inst.people);
  try {
    const a = await eapi("POST", "/api/wake/admit", { who: "me", seq: 20, roomId: "r", kind: "text" });
    const wakeId = a.data.wakeId;

    const s1 = await eapi("POST", "/api/wake/settle", { who: "me", wakeId, outcome: "REPLIED" });
    assert.equal(s1.status, 200);
    assert.equal(s1.data.ok, true);

    // 幂等：已存在不覆盖（先到先得）
    const s2 = await eapi("POST", "/api/wake/settle", { who: "me", wakeId, outcome: "NO_REPLY" });
    assert.equal(s2.status, 200);
    assert.equal(s2.data.ok, true);
    const st = await eapi("GET", "/api/wake/state");
    const w = st.data.wakes.find((x) => x.wakeId === wakeId);
    assert.equal(w.outcome, "REPLIED", "第二次回填不覆盖第一次");
    assert.ok(w.outcomeAt, "回填时间已记");

    // 跨 who：daman 不能回填 me 的 wake
    const s3 = await eapi("POST", "/api/wake/settle", { who: "daman", wakeId, outcome: "REPLIED" });
    assert.equal(s3.status, 403);
    assert.ok(/not your wake/.test(String(s3.data.error)));

    // 未知 wakeId → 404
    const s4 = await eapi("POST", "/api/wake/settle", { who: "me", wakeId: "w-1-me-dead", outcome: "REPLIED" });
    assert.equal(s4.status, 404);

    // 非法 outcome → 400
    const s5 = await eapi("POST", "/api/wake/settle", { who: "me", wakeId, outcome: "BOGUS" });
    assert.equal(s5.status, 400);
    assert.ok(/outcome must be one of/.test(String(s5.data.error)));

    // 错成员 key → 403；you 不是桥接端 → 400
    assert.equal((await eapi("POST", "/api/wake/settle", { who: "me", key: "deadbeef", wakeId, outcome: "REPLIED" })).status, 403);
    assert.equal((await eapi("POST", "/api/wake/settle", { who: "you", wakeId, outcome: "REPLIED" })).status, 400);
  } finally {
    inst.kill();
  }
});

test("nudge：seq<=0 不做幂等，每次新 wakeId 且计预算", async () => {
  const inst = await startEphemeral();
  const eapi = makeApi(inst.base, inst.key, inst.people);
  try {
    const n1 = await eapi("POST", "/api/wake/admit", { who: "me", seq: -1, roomId: "r", kind: "nudge" });
    assert.equal(n1.data.allow, true);
    assert.match(n1.data.wakeId, /^w--1-me-[0-9a-f]{4}$/);
    assert.deepEqual(n1.data.budget, { used: 1, limit: 200 });

    const n2 = await eapi("POST", "/api/wake/admit", { who: "me", seq: -1, roomId: "r", kind: "nudge" });
    assert.equal(n2.data.allow, true);
    assert.notEqual(n2.data.wakeId, n1.data.wakeId, "nudge 每次签发新 wakeId");
    assert.deepEqual(n2.data.budget, { used: 2, limit: 200 }, "nudge 同样计预算");

    const st = await eapi("GET", "/api/wake/state");
    assert.equal(st.data.days[st.data.day].me.count, 2);
    assert.equal(st.data.injectTotals.me, 2);
  } finally {
    inst.kill();
  }
});

test("highContextAge：injectTotals 达阈值后 admit 响应与 state/bridge status 标记", async () => {
  const inst = await startEphemeral({ WAKE_CONTEXT_AGE_THRESHOLD: "2" });
  const eapi = makeApi(inst.base, inst.key, inst.people);
  try {
    const a1 = await eapi("POST", "/api/wake/admit", { who: "me", seq: 1, roomId: "r", kind: "text" });
    assert.equal(a1.data.highContextAge, false, "1 次未达阈值");
    const a2 = await eapi("POST", "/api/wake/admit", { who: "me", seq: 2, roomId: "r", kind: "text" });
    assert.equal(a2.data.highContextAge, true, "累计达阈值 → HIGH_CONTEXT_AGE");

    const st = await eapi("GET", "/api/wake/state");
    assert.equal(st.data.highContextAge.me, true);
    assert.equal(st.data.highContextAge.daman, false);
    assert.equal(st.data.injectTotals.me, 2);

    const bs = await eapi("GET", "/api/bridge/status");
    assert.equal(bs.data.wake.highContextAge.me, true);
    assert.equal(bs.data.wake.highContextAge.daman, false);
    assert.equal(bs.data.wake.injectTotals.me, 2);
  } finally {
    inst.kill();
  }
});

test("GET /api/wake/state：契约形状 / date 参数 / 坏 date 400 / 平台鉴权 401", async () => {
  const inst = await startEphemeral();
  const eapi = makeApi(inst.base, inst.key, inst.people);
  try {
    await eapi("POST", "/api/wake/admit", { who: "me", seq: 30, roomId: "r", kind: "text" });
    await eapi("POST", "/api/wake/admit", { who: "daman", seq: 31, roomId: "r", kind: "text" });
    await eapi("POST", "/api/wake/settle", { who: "me", wakeId: "w-30-me-0000", outcome: "REPLIED" }).catch(() => {}); // 未知 id，仅确认不炸

    const st = await eapi("GET", "/api/wake/state");
    assert.equal(st.status, 200);
    assert.equal(st.data.ok, true);
    assert.equal(st.data.day, today(), "day 默认今天 YYYY-MM-DD");
    assert.equal(typeof st.data.days, "object");
    assert.deepEqual(st.data.injectTotals, { me: 1, daman: 1 });
    assert.equal(typeof st.data.highContextAge.me, "boolean");
    assert.equal(typeof st.data.highContextAge.daman, "boolean");
    // token 软阈值：1 次唤醒 × 40000/回合，只估算不阻断
    assert.deepEqual(st.data.softTokens.me, { est: 40000, limit: 8000000, over: false });
    assert.deepEqual(st.data.softTokens.daman, { est: 40000, limit: 8000000, over: false });
    assert.ok(Array.isArray(st.data.wakes));
    assert.ok(st.data.wakes.length <= 50);
    const seqs = st.data.wakes.map((w) => w.at);
    const sortedDesc = [...seqs].sort((a, b) => b.localeCompare(a));
    assert.deepEqual(seqs, sortedDesc, "wakes 按 at 倒序");
    // 两条 admit 都进了 wakes（me 先 admit，倒序里 daman 的 31 在前）
    assert.equal(st.data.wakes.length, 2);
    assert.equal(st.data.wakes[0].seq, 31);
    assert.equal(st.data.wakes[1].seq, 30);

    // 指定日期：返回该 day（可能无数据 → 全 0）
    const st2 = await eapi("GET", "/api/wake/state?date=2026-01-01");
    assert.equal(st2.status, 200);
    assert.equal(st2.data.day, "2026-01-01");
    assert.deepEqual(st2.data.days["2026-01-01"].me, { count: 0, blocked: 0 });

    // 坏 date → 400
    const st3 = await eapi("GET", "/api/wake/state?date=not-a-date");
    assert.equal(st3.status, 400);

    // 平台鉴权：不带 k → 401
    const raw = await fetch(`${inst.base}/api/wake/state`);
    assert.equal(raw.status, 401, "平台 ?k= 必填");
  } finally {
    inst.kill();
  }
});

test("bridge/status 增补 wake 字段（injectTotals/highContextAge/today used+limit+blocked）", async () => {
  const inst = await startEphemeral({ WAKE_DAILY_LIMIT: "5" });
  const eapi = makeApi(inst.base, inst.key, inst.people);
  try {
    const bs0 = await eapi("GET", "/api/bridge/status");
    assert.equal(bs0.status, 200);
    assert.deepEqual(bs0.data.wake.injectTotals, { me: 0, daman: 0 });
    assert.deepEqual(bs0.data.wake.highContextAge, { me: false, daman: false });
    assert.deepEqual(bs0.data.wake.today.me, { used: 0, limit: 5, blocked: 0 });
    assert.deepEqual(bs0.data.wake.today.daman, { used: 0, limit: 5, blocked: 0 });

    await eapi("POST", "/api/wake/admit", { who: "me", seq: 40, roomId: "r", kind: "text" });
    for (let i = 41; i <= 44; i++) await eapi("POST", "/api/wake/admit", { who: "me", seq: i, roomId: "r", kind: "text" });
    await eapi("POST", "/api/wake/admit", { who: "me", seq: 45, roomId: "r", kind: "text" }); // 第 6 次：被阻

    const bs1 = await eapi("GET", "/api/bridge/status");
    assert.deepEqual(bs1.data.wake.today.me, { used: 5, limit: 5, blocked: 1 });
    assert.equal(bs1.data.wake.injectTotals.me, 5);
    assert.deepEqual(bs1.data.wake.softTokens.me, { est: 200000, limit: 8000000, over: false });

    // 台账落盘：data/wake-state.json 存在且 schema 含 injectTotals/days/wakes
    const fp = path.join(inst.dataDir, "wake-state.json");
    assert.ok(fs.existsSync(fp), "wake-state.json 已落盘");
    const disk = JSON.parse(fs.readFileSync(fp, "utf8"));
    assert.equal(typeof disk.injectTotals, "object");
    assert.equal(typeof disk.days, "object");
    assert.equal(typeof disk.wakes, "object");
    assert.equal(disk.injectTotals.me, 5);
    assert.ok(Object.keys(disk.wakes).length <= 500, "wakes 上限 500");
  } finally {
    inst.kill();
  }
});

test("admit 路由校验：who/key/seq/kind 非法入参全拒且不计数", async () => {
  const inst = await startEphemeral();
  const eapi = makeApi(inst.base, inst.key, inst.people);
  try {
    assert.equal((await eapi("POST", "/api/wake/admit", { who: "you", seq: 1, roomId: "r" })).status, 400, "you 不是桥接端");
    assert.equal((await eapi("POST", "/api/wake/admit", { who: "me", key: "deadbeef", seq: 1, roomId: "r" })).status, 403, "错成员 key");
    assert.equal((await eapi("POST", "/api/wake/admit", { who: "me", roomId: "r" })).status, 400, "缺 seq");
    assert.equal((await eapi("POST", "/api/wake/admit", { who: "me", seq: 1.5, roomId: "r" })).status, 400, "小数 seq");
    assert.equal((await eapi("POST", "/api/wake/admit", { who: "me", seq: "abc", roomId: "r" })).status, 400, "非数字 seq");
    assert.equal((await eapi("POST", "/api/wake/admit", { who: "me", seq: 1, roomId: "r", kind: "bogus" })).status, 400, "未知 kind");

    const st = await eapi("GET", "/api/wake/state");
    assert.equal(st.data.injectTotals.me, 0, "全部拒绝路径不写台账");
    assert.ok(st.data.wakes.length === 0);
  } finally {
    inst.kill();
  }
});

test("sweepStale：断桥遗留 wake 按房间消息证据补 REPLIED/NO_REPLY（纯函数，注入假读写）", async () => {
  const { sweepStale } = await import("../wake-lib.mjs");
  const now = Date.parse("2026-11-04T12:00:00.000Z");
  const mk = (id, at, extra = {}) => ({
    wakeId: id, at, who: "me", seq: 100, roomId: "room-x", kind: "text",
    allow: true, blockReason: null, outcome: null, outcomeAt: null, ...extra,
  });
  const db = {
    injectTotals: { me: 3, daman: 0 },
    days: {},
    wakes: {
      "w-replied": mk("w-replied", new Date(now - 600_000).toISOString()),
      "w-silent": mk("w-silent", new Date(now - 600_000).toISOString(), { seq: 500 }),
      "w-late": mk("w-late", new Date(now - 600_000).toISOString(), { seq: 900 }),
      "w-fresh": mk("w-fresh", new Date(now - 5_000).toISOString(), { seq: 1000 }),
      "w-done": mk("w-done", new Date(now - 600_000).toISOString(), { seq: 1100, outcome: "REPLIED" }),
      "w-blocked": mk("w-blocked", new Date(now - 600_000).toISOString(), { seq: 1200, allow: false }),
    },
  };
  const msgs = [
    { who: "me", seq: 101, ts: new Date(now - 599_000).toISOString(), roomId: "room-x" },   // w-replied：窗内 → REPLIED
    { who: "daman", seq: 101, ts: new Date(now - 599_000).toISOString(), roomId: "room-x" }, // 别的端不算
    { who: "me", seq: 901, ts: new Date(now - 400_000).toISOString(), roomId: "room-x" },   // w-late：超窗 → NO_REPLY
    { who: "me", seq: 1001, ts: new Date(now - 1_000).toISOString(), roomId: "room-x" },    // w-fresh：窗口未到，不动
  ];
  let written = null;
  const reaped = sweepStale({
    now,
    windowMs: 90_000,
    graceMs: 0,
    lookup: () => msgs,
    read: () => JSON.parse(JSON.stringify(db)),
    write: (d) => { written = d; },
  });
  const got = Object.fromEntries(reaped.map((x) => [x.wakeId, x.outcome]));
  assert.deepEqual(got, { "w-replied": "REPLIED", "w-silent": "NO_REPLY", "w-late": "NO_REPLY" });
  assert.equal(reaped.length, 3, "已回填 / 未到窗口 / 被阻的条目不处理");
  assert.ok(written, "有回收才落盘");
  assert.equal(written.wakes["w-replied"].outcome, "REPLIED");
  assert.equal(written.wakes["w-replied"].reaped, true);
  assert.equal(written.wakes["w-done"].outcome, "REPLIED", "先到先得不覆盖");
  assert.equal(written.wakes["w-fresh"].outcome, null);

  // 无遗留时不落盘
  let wrote = false;
  const none = sweepStale({ now, windowMs: 90_000, graceMs: 0, lookup: () => [], read: () => ({ injectTotals: {}, days: {}, wakes: {} }), write: () => { wrote = true; } });
  assert.deepEqual(none, []);
  assert.equal(wrote, false, "空转不写盘");
});

test("patrol 兜底回收：窗口过后仍未回填的 wake 自动落 NO_REPLY", async () => {
  const inst = await startEphemeral({ WAKE_OUTCOME_WINDOW_MS: "300", WAKE_REAP_GRACE_MS: "0" });
  const eapi = makeApi(inst.base, inst.key, inst.people);
  try {
    const a = await eapi("POST", "/api/wake/admit", { who: "me", seq: 70, roomId: "room-nope", kind: "text" });
    assert.equal(a.data.allow, true);
    const wid = a.data.wakeId;

    let hit = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      const st = await eapi("GET", "/api/wake/state");
      hit = (st.data.wakes || []).find((w) => w.wakeId === wid);
      if (hit && hit.outcome) break;
      await sleep(300);
    }
    assert.ok(hit, "wake 在 state 里可见");
    assert.equal(hit.outcome, "NO_REPLY", "无房内输出 → 兜底 NO_REPLY");
    assert.equal(hit.reaped, true, "标记为兜底回收");
    assert.ok(hit.outcomeAt, "回填时间戳");
  } finally {
    inst.kill();
  }
});
