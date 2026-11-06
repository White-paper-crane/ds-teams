// 会议室服务端测试（docs/meeting-room.md §7）。
// 运行：node --test tests/meeting.test.mjs —— 全部用例跑在隔离实例上
// （临时数据目录 + 临时端口 + 小 patrol），不动真实 8792。
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

async function startEphemeral(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ds-teams-meeting-"));
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

// 建房（declaredBy 必须与 key 对上；这里手传 key，不依赖 body.who 注入）
async function createRoom(inst, declaredBy, title) {
  const api = makeApi(inst.base, inst.key, inst.people);
  const res = await api("POST", "/api/rooms", { declaredBy, key: inst.people[declaredBy].key, title });
  assert.equal(res.status, 200, "建房失败: " + JSON.stringify(res.data));
  return res.data.room;
}

async function roomMessages(inst, roomId) {
  const api = makeApi(inst.base, inst.key, inst.people);
  // 房间详情现在按身份过滤（不是成员就 403），测试用小满（agent）身份读
  const k = encodeURIComponent((inst.people.me || {}).key || "");
  const res = await api("GET", `/api/rooms/${roomId}?who=me&key=${k}`);
  return res.data.messages || [];
}

test("report 开议题：me 交 report → 议题 open、reviewer=daman；--noreview 不开", async () => {
  const inst = await startEphemeral();
  const api = makeApi(inst.base, inst.key, inst.people);
  try {
    const room = await createRoom(inst, "me", "会议室测试A");
    const r1 = await api("POST", `/api/rooms/${room.id}/report`, {
      who: "me", taskId: "t1", title: "方案一", summary: "结论：A 方案可行，证据见 links。",
    });
    assert.equal(r1.status, 200);
    const reportSeq = r1.data.message.seq;

    const st = await api("GET", `/api/meeting/state?roomId=${room.id}`);
    assert.equal(st.status, 200);
    assert.equal(st.data.issues.length, 1, "report 落库即开议题");
    const issue = st.data.issues[0];
    assert.equal(issue.author, "me");
    assert.equal(issue.reviewer, "daman", "评审方是对端");
    assert.equal(issue.reportSeq, reportSeq);
    assert.equal(issue.status, "open");
    assert.equal(issue.rounds.length, 1);
    assert.equal(issue.rounds[0].verdict, "open");

    // --noreview：交活不触发评审
    const r2 = await api("POST", `/api/rooms/${room.id}/report`, {
      who: "me", taskId: "t2", title: "日志归档", summary: "只留档。", noreview: true,
    });
    assert.equal(r2.status, 200);
    const st2 = await api("GET", `/api/meeting/state?roomId=${room.id}`);
    assert.equal(st2.data.issues.length, 1, "--noreview 不开新议题");
  } finally {
    inst.kill();
  }
});

test("review 收敛：issues 记轮次保持 open；pass 收敛并发 system 卡", async () => {
  const inst = await startEphemeral();
  const api = makeApi(inst.base, inst.key, inst.people);
  try {
    const room = await createRoom(inst, "me", "会议室测试B");
    await api("POST", `/api/rooms/${room.id}/report`, { who: "me", taskId: "t1", title: "方案一", summary: "结论 A。" });

    const v1 = await api("POST", `/api/rooms/${room.id}/review`, { who: "daman", text: "第 3 行事实有误，应改 X。", verdict: "issues" });
    assert.equal(v1.status, 200);
    let st = await api("GET", `/api/meeting/state?roomId=${room.id}`);
    assert.equal(st.data.issues[0].status, "open", "issues 后仍 open 等修订");
    assert.equal(st.data.issues[0].rounds.length, 2);
    assert.equal(st.data.issues[0].rounds[1].verdict, "issues");

    const v2 = await api("POST", `/api/rooms/${room.id}/review`, { who: "daman", text: "评审通过", verdict: "pass" });
    assert.equal(v2.status, 200);
    st = await api("GET", `/api/meeting/state?roomId=${room.id}`);
    assert.equal(st.data.issues[0].status, "converged");
    assert.equal(st.data.issues[0].closedBy, "pass");

    const msgs = await roomMessages(inst, room.id);
    const sysLine = msgs.find((m) => m.kind === "system" && /评审收敛/.test(String(m.text || "")));
    assert.ok(sysLine, "pass 收敛写 system 卡");
    assert.match(String(sysLine.text), /评审通过/);
  } finally {
    inst.kill();
  }
});

test("沉默收敛：report 的 wake settle NO_REPLY → 议题 silent 收敛 + system 卡", async () => {
  const inst = await startEphemeral();
  const api = makeApi(inst.base, inst.key, inst.people);
  try {
    const room = await createRoom(inst, "me", "会议室测试C");
    const r1 = await api("POST", `/api/rooms/${room.id}/report`, { who: "me", taskId: "t1", title: "方案一", summary: "结论 A。" });
    const reportSeq = r1.data.message.seq;

    // 模拟桥接：对 report 卡 admit（kind=report、seq=卡 seq）→ 90s 无输出 → settle NO_REPLY
    const adm = await api("POST", "/api/wake/admit", { who: "daman", seq: reportSeq, roomId: room.id, kind: "report" });
    assert.equal(adm.data.allow, true);
    const wakeId = adm.data.wakeId;

    const s1 = await api("POST", "/api/wake/settle", { who: "daman", wakeId, outcome: "NO_REPLY" });
    assert.equal(s1.status, 200);

    const st = await api("GET", `/api/meeting/state?roomId=${room.id}`);
    assert.equal(st.data.issues[0].status, "converged");
    assert.equal(st.data.issues[0].closedBy, "silent");

    const msgs = await roomMessages(inst, room.id);
    const sysLine = msgs.find((m) => m.kind === "system" && /评审收敛/.test(String(m.text || "")));
    assert.ok(sysLine, "沉默收敛写 system 卡");
    assert.match(String(sysLine.text), /未提意见/);
  } finally {
    inst.kill();
  }
});

test("roundCap：连续 issues 达到 3 轮后仍 issues → cap 收敛并提示群主", async () => {
  const inst = await startEphemeral();
  const api = makeApi(inst.base, inst.key, inst.people);
  try {
    const room = await createRoom(inst, "me", "会议室测试D");
    await api("POST", `/api/rooms/${room.id}/report`, { who: "me", taskId: "t1", title: "方案一", summary: "结论 A。" });

    for (let i = 1; i <= 3; i++) {
      const v = await api("POST", `/api/rooms/${room.id}/review`, { who: "daman", text: `第 ${i} 次意见`, verdict: "issues" });
      assert.equal(v.status, 200);
      const st = await api("GET", `/api/meeting/state?roomId=${room.id}`);
      if (i < 3) assert.equal(st.data.issues[0].status, "open", `第 ${i} 轮仍 open`);
      else {
        assert.equal(st.data.issues[0].status, "converged", "第 3 轮 issues 触发 cap");
        assert.equal(st.data.issues[0].closedBy, "cap");
      }
    }
    const msgs = await roomMessages(inst, room.id);
    const sysLine = msgs.find((m) => m.kind === "system" && /请群主裁决/.test(String(m.text || "")));
    assert.ok(sysLine, "cap 收敛提示群主裁决");
  } finally {
    inst.kill();
  }
});

test("修订再交：同 taskId 重交 report → 旧议题 superseded、新议题开审；异 taskId 不互相影响", async () => {
  const inst = await startEphemeral();
  const api = makeApi(inst.base, inst.key, inst.people);
  try {
    const room = await createRoom(inst, "me", "会议室测试F");
    await api("POST", `/api/rooms/${room.id}/report`, { who: "me", taskId: "t1", title: "方案一", summary: "初版。" });
    await api("POST", `/api/rooms/${room.id}/review`, { who: "daman", text: "初版有误。", verdict: "issues" });

    // 修订重交同 taskId → 旧议题 superseded、新议题 open
    const r2 = await api("POST", `/api/rooms/${room.id}/report`, { who: "me", taskId: "t1", title: "方案一（修订）", summary: "修订版。" });
    assert.equal(r2.status, 200);
    let st = await api("GET", `/api/meeting/state?roomId=${room.id}`);
    assert.equal(st.data.issues.length, 2, "修订重交产生新议题，旧议题仍在台账");
    const [fresh, old] = st.data.issues; // 按更新倒序
    assert.equal(fresh.status, "open");
    assert.equal(fresh.taskId, "t1");
    assert.equal(old.status, "superseded");
    assert.equal(old.closedBy, "superseded");

    // 修订版被 pass → 只收敛修订议题
    const v = await api("POST", `/api/rooms/${room.id}/review`, { who: "daman", text: "修订到位，通过。", verdict: "pass" });
    assert.equal(v.status, 200);
    st = await api("GET", `/api/meeting/state?roomId=${room.id}`);
    const t1fresh = st.data.issues.find((i) => i.taskId === "t1" && i.status === "converged");
    assert.ok(t1fresh, "修订议题 pass 收敛");
    assert.equal(t1fresh.closedBy, "pass");

    // 异 taskId 不影响已 open 的议题
    await api("POST", `/api/rooms/${room.id}/report`, { who: "me", taskId: "t2", title: "方案二", summary: "另一个任务。" });
    st = await api("GET", `/api/meeting/state?roomId=${room.id}`);
    const openOnes = st.data.issues.filter((i) => i.status === "open");
    assert.equal(openOnes.length, 1, "只余 t2 新议题 open");

    // 评审 verdict 命中最新 open 议题（t2）
    await api("POST", `/api/rooms/${room.id}/review`, { who: "daman", text: "t2 也过。", verdict: "pass" });
    st = await api("GET", `/api/meeting/state?roomId=${room.id}`);
    const t2c = st.data.issues.find((i) => i.taskId === "t2");
    assert.equal(t2c.status, "converged");
    assert.equal(t2c.closedBy, "pass");
  } finally {
    inst.kill();
  }
});

test("越权与校验：bad verdict 400；群主 report 不开议题；close 后议题 abort", async () => {
  const inst = await startEphemeral();
  const api = makeApi(inst.base, inst.key, inst.people);
  try {
    const room = await createRoom(inst, "me", "会议室测试E");
    await api("POST", `/api/rooms/${room.id}/report`, { who: "me", taskId: "t1", title: "方案一", summary: "结论 A。" });

    const bad = await api("POST", `/api/rooms/${room.id}/review`, { who: "daman", text: "x", verdict: "maybe" });
    assert.equal(bad.status, 400, "非法 verdict 400");

    // 群主（you）交 report 不开议题
    await api("POST", `/api/rooms/${room.id}/report`, { who: "you", taskId: "t2", title: "群主备忘", summary: "仅存档。" });
    const st = await api("GET", `/api/meeting/state?roomId=${room.id}`);
    assert.equal(st.data.issues.length, 1, "群主 report 不触发评审");

    // 群主解散 → open 议题 abort
    const close = await api("POST", `/api/rooms/${room.id}/close`, { who: "you" });
    assert.equal(close.status, 200);
    const st2 = await api("GET", `/api/meeting/state?roomId=${room.id}`);
    assert.equal(st2.data.issues[0].status, "aborted");
    assert.equal(st2.data.issues[0].closedBy, "room-closed");
  } finally {
    inst.kill();
  }
});
