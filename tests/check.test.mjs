// ds-teams · check.mjs 预检 CLI 回归（零依赖，node:test）
// 只读：对本地 8792 跑 --json / 文本，断言 ok、退出码、行数上限与输出格式；不建房、不写数据。
// 服务正在重启（ECONNREFUSED）时重试 5 次、间隔 1s。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = path.join(ROOT, "check.mjs");

// extraEnv：stub 用例用独立环境变量，不能污染真实 8792 的断言
function run(args, extraEnv, timeoutMs = 45000) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    const p = spawn(process.execPath, [CHECK, ...args], {
      cwd: ROOT,
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { try { p.kill(); } catch {} finish({ code: -1, stdout, stderr: stderr + "\nTIMEOUT" }); }, timeoutMs);
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("close", (code) => finish({ code, stdout, stderr }));
    p.on("error", (e) => finish({ code: -1, stdout, stderr: stderr + String(e) }));
  });
}

// 最小 stub：只提供 check.mjs 实际读取的三个 GET；claims 用例据此造时间与已消费态。
async function withStub(fn) {
  let state = { lag: 0, claims: {}, messages: [] };
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    const send = (obj) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (p === "/api/health") return send({ ok: true, at: new Date().toISOString(), seq: 500, bridges: { me: { cursor: 500 - state.lag, lag: state.lag }, daman: { cursor: 500, lag: 0 } } });
    if (p === "/api/state") return send({ seq: 500, messages: state.messages });
    if (p === "/api/rooms") return send({ rooms: [{ id: "room-stub", title: "主房", status: "open", members: ["you", "me", "daman"], messageCount: 500, last: { who: "me", seq: 500 }, claims: state.claims }] });
    res.writeHead(404, { "content-type": "application/json" }); res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const env = { DS_TEAMS_URL: url, DS_TEAMS_KEY: "stub-key", DS_TEAMS_LEDGER: path.join(os.tmpdir(), `ds-teams-no-ledger-${process.pid}.json`) };
  try { await fn({ url, env, set: (s) => { state = { ...state, ...s }; } }); }
  finally { await new Promise((r) => server.close(r)); }
}


// 服务重启窗口：连接被拒时重跑（check.mjs 自己也会重试 5×1s）
async function runWithRetry(args) {
  let last = null;
  for (let i = 0; i < 5; i++) {
    last = await run(args);
    if (!/ECONNREFUSED/.test(last.stdout + last.stderr)) return last;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return last;
}

test("--json：ok=true、exit 0、行数 ≤30、JSON 可解析", async () => {
  const r = await runWithRetry(["--json"]);
  assert.equal(r.code, 0, `exit=${r.code}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.ok, true, `ok=${out.ok} FAIL=${JSON.stringify(out.checks.filter((c) => c.level === "FAIL"))}`);
  assert.equal(out.exitCode, 0);
  assert.equal(out.summary.FAIL, 0);
  assert.ok(Array.isArray(out.lines), "lines 应为数组");
  assert.ok(out.lines.length <= 30, `行数 ${out.lines.length} > 30`);
  assert.ok(out.lines.length >= 5, `行数 ${out.lines.length} 过少`);
  assert.ok(out.health && out.health.ok === true, "health.ok 应为 true");
});

test("默认文本：exit 0、≤30 行、每行 PASS/WARN/FAIL + 证据", async () => {
  const r = await runWithRetry([]);
  assert.equal(r.code, 0, `exit=${r.code}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
  const lines = r.stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length <= 30, `行数 ${lines.length} > 30`);
  assert.match(lines[0], /^ds-teams 体检/, "首行应为表头");
  const body = lines.slice(1);
  assert.ok(body.length >= 5, `检查行仅 ${body.length} 条`);
  for (const line of body) {
    assert.match(line, /^(PASS|WARN|FAIL) \S+ .+\S/, `格式不对：${line}`);
  }
});

test("--room 不存在的房：FAIL + exit 1，且可直接定位", async () => {
  const r = await runWithRetry(["--room", "room-does-not-exist", "--json"]);
  assert.equal(r.code, 1, `exit=${r.code}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.ok, false);
  const hit = out.checks.find((c) => c.id === "room-arg");
  assert.ok(hit, "应输出 room-arg 检查项");
  assert.equal(hit.level, "FAIL");
  assert.match(hit.text, /room-does-not-exist/);
});

test("stub：lag=100 → WARN exit 0；lag=400 → FAIL exit 1", async () => {
  await withStub(async ({ env, set }) => {
    for (const [lag, level, code] of [[100, "WARN", 0], [400, "FAIL", 1]]) {
      set({ lag, claims: {}, messages: [] });
      const r = await run(["--json", "--bridge"], env);
      assert.equal(r.code, code, `lag=${lag} exit=${r.code}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
      const out = JSON.parse(r.stdout.trim());
      const hit = out.checks.find((c) => c.id === "bridge:me");
      assert.ok(hit, `lag=${lag} 应有 bridge:me 检查项`);
      assert.equal(hit.level, level, `lag=${lag} 级别=${hit.level} text=${hit.text}`);
      assert.match(hit.text, new RegExp(`lag=${lag} 条`));
    }
  });
});

test("stub：默认不查桥接（lag=400 也不报），--bridge 才查", async () => {
  await withStub(async ({ env, set }) => {
    set({ lag: 400, claims: {}, messages: [] });
    const r = await run(["--json"], env);
    assert.equal(r.code, 0, `exit=${r.code}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.checks.some((c) => c.id === "bridge:me"), false, "默认不应有 bridge:me");
    const hit = out.checks.find((c) => c.id === "bridge");
    assert.ok(hit, "默认应有 bridge 汇总项");
    assert.equal(hit.level, "PASS");
  });
});

test("stub：单 token claim 超 24h 未消费 → WARN；winner 已发言 → 不报", async () => {
  await withStub(async ({ env, set }) => {
    const old = new Date(Date.now() - 25 * 3600e3).toISOString();
    set({ lag: 0, claims: { 4001: [{ who: "me", token: 1, at: old }] }, messages: [{ seq: 4001, who: "daman", text: "目标" }] });
    let r = await run(["--json"], env);
    assert.equal(r.code, 0, `exit=${r.code}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    let hit = JSON.parse(r.stdout.trim()).checks.find((c) => c.id === "claims");
    assert.ok(hit, "应输出 claims 检查项");
    assert.equal(hit.level, "WARN", `text=${hit.text}`);
    assert.match(hit.text, /未清（>1440min）/);

    set({ lag: 0, claims: { 4003: [{ who: "me", token: 2, at: old }] }, messages: [{ seq: 4003, who: "daman", text: "目标" }, { seq: 4004, who: "me", text: "已回" }] });
    r = await run(["--json"], env);
    assert.equal(r.code, 0, `exit=${r.code}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    hit = JSON.parse(r.stdout.trim()).checks.find((c) => c.id === "claims");
    assert.equal(hit.level, "PASS", `text=${hit.text}`);
  });
});
