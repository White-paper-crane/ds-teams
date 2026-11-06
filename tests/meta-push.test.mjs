// 元信息实时推送回归：改成员/角色的操作必须往 SSE 推 event: meta（页面据此立刻重画成员条），
// 新建房间必须推 event: rooms（左栏据此立刻出现新房间）。
// 这里不看页面，只看服务端有没有把「变了」这件事推出去——页面卡住不刷新，根子就在这里。
// 运行：node --test tests/meta-push.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.DS_TEAMS_URL || "http://127.0.0.1:8792").replace(/\/+$/, "");
const KEY = (process.env.DS_TEAMS_KEY || fs.readFileSync(path.join(ROOT, "data", "key.txt"), "utf8")).trim();
const PEOPLE = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "people.json"), "utf8"));

async function api(method, p, body) {
  if (body && body.who && !body.key) body = { ...body, key: (PEOPLE[body.who] || {}).key };
  const sep = p.includes("?") ? "&" : "?";
  const res = await fetch(`${BASE}${p}${sep}k=${encodeURIComponent(KEY)}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

// 订阅 SSE，收齐窗口内的事件。返回 { events, stop }
async function listen(roomQuery, ms) {
  const ac = new AbortController();
  const res = await fetch(`${BASE}/events?k=${encodeURIComponent(KEY)}&${roomQuery}`, { signal: ac.signal });
  assert.equal(res.status, 200, "SSE 应连上");
  const events = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const name = (chunk.match(/^event: (.+)$/m) || [])[1] || "message";
          const dataLine = (chunk.match(/^data: (.+)$/m) || [])[1] || "";
          let payload = null;
          try { payload = JSON.parse(dataLine); } catch {}
          events.push({ name, payload });
        }
      }
    } catch {}
  })();
  return {
    events,
    async stop() {
      try { ac.abort(); } catch {}
      await Promise.race([pump, new Promise((r) => setTimeout(r, 300))]);
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("setRole 推 event: meta，payload 带正确 roomId", async () => {
  const made = await api("POST", "/api/rooms", { who: "you", title: `实时刷新自测-${Date.now()}` });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const id = made.data.room.id;
  const stream = await listen(`room=${id}`, 0);
  try {
    await sleep(150);
    const before = stream.events.length;
    const out = await api("POST", `/api/rooms/${id}/setRole`, { who: "you", memberId: "daman", role: "member" });
    assert.equal(out.status, 200, JSON.stringify(out.data));
    await sleep(400);
    const metas = stream.events.slice(before).filter((e) => e.name === "meta");
    assert.ok(metas.length >= 1, "设角色后必须推 event: meta，实际收到：" + stream.events.slice(before).map((e) => e.name).join(","));
    assert.equal(metas[0].payload.roomId, id);
    // reason 是逗号合并的集合：push() 会自动补上 system（系统卡也算元信息变化），
    // 手写的 setRole 再并进去，所以断言「包含」而不是「等于」。
    const reasons = String(metas[0].payload.reason || "").split(",");
    assert.ok(reasons.includes("setRole"), "reason 里要有 setRole，实际：" + metas[0].payload.reason);
  } finally {
    await stream.stop();
  }
});

test("建群推 event: rooms，且列表摘要带 memberCount", async () => {
  const stream = await listen("room=*", 0);
  try {
    await sleep(150);
    const before = stream.events.length;
    const made = await api("POST", "/api/rooms", { who: "you", title: `实时刷新建群自测-${Date.now()}` });
    assert.equal(made.status, 200, JSON.stringify(made.data));
    await sleep(400);
    const roomsEv = stream.events.slice(before).filter((e) => e.name === "rooms");
    assert.ok(roomsEv.length >= 1, "建群后必须推 event: rooms，实际收到：" + stream.events.slice(before).map((e) => e.name).join(","));
    const state = await api("GET", "/api/state");
    const summary = (state.data.rooms || []).find((x) => x.id === made.data.room.id);
    assert.ok(summary, "新房间要出现在 /api/state");
    assert.equal(summary.memberCount, made.data.room.members.length, "列表摘要要带成员数");
    assert.equal(summary.pendingCloseAt, null, "没人在申请解散时 pendingCloseAt 应为 null");
  } finally {
    await stream.stop();
  }
});

test("/events 只把 meta 推给订阅了该房的连接", async () => {
  const a = await api("POST", "/api/rooms", { who: "you", title: `实时刷新A-${Date.now()}` });
  const b = await api("POST", "/api/rooms", { who: "you", title: `实时刷新B-${Date.now()}` });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const stream = await listen(`room=${b.data.room.id}`, 0);
  try {
    await sleep(150);
    const before = stream.events.length;
    await api("POST", `/api/rooms/${a.data.room.id}/setRole`, { who: "you", memberId: "daman", role: "admin" });
    await sleep(400);
    const leaked = stream.events.slice(before).filter((e) => e.name === "meta" && e.payload?.roomId === a.data.room.id);
    assert.equal(leaked.length, 0, "别的房的 meta 不该推到这间房的连接上");
  } finally {
    await stream.stop();
  }
});