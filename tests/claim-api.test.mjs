// 带外声明（claim）HTTP 接口回归：先到先得、token 单调、重复幂等、不产生消息、关闭房拒写
// 运行：node --test tests/claim-api.test.mjs
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

// 不自动补平台 key：用于验证「平台 ?k= 与成员 body.key」两道鉴权各自缺失时的表现
async function rawApi(method, p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

test("claim 接口：先到先得 + 幂等 + 不产生群消息", async () => {
  const title = `claim接口回归-${Date.now()}`;
  const created = await api("POST", "/api/rooms", { who: "me", title, declaredBy: "me" });
  assert.equal(created.status, 200);
  const room = created.data.room;
  const id = room.id;
  const TARGET = Number(room.lastSeq || 0) + 1;

  try {
    const before = await api("GET", `/api/rooms/${id}/messages?since=${TARGET - 1}`);
    const beforeCount = (before.data.messages || []).length;

    const a = await api("POST", `/api/rooms/${id}/claim`, { who: "me", targetSeq: TARGET });
    assert.equal(a.status, 200);
    assert.equal(a.data.ok, true);
    assert.equal(a.data.winner, "me");
    assert.equal(typeof a.data.claim.token, "number");

    const b = await api("POST", `/api/rooms/${id}/claim`, { who: "daman", targetSeq: TARGET });
    assert.equal(b.status, 200);
    assert.ok(b.data.claim.token > a.data.claim.token, "token 必须单调递增");
    assert.equal(b.data.ok, true, "晚到者不是报错，而是静默落选");
    assert.equal(b.data.winner, "me", "晚到者不能夺权");
    assert.equal(b.data.claim.who, "daman");
    assert.equal(b.data.count, 2);

    const b2 = await api("POST", `/api/rooms/${id}/claim`, { who: "daman", targetSeq: TARGET });
    assert.equal(b2.data.duplicate, true);
    assert.equal(b2.data.claim.token, b.data.claim.token);

    const got = await api("GET", `/api/rooms/${id}/claim?targetSeq=${TARGET}`);
    assert.equal(got.data.winner, "me");
    assert.deepEqual(got.data.claims.map((c) => c.who), ["me", "daman"]);
    assert.ok(got.data.claims.every((c, i, arr) => i === 0 || arr[i - 1].token < c.token));

    const after = await api("GET", `/api/rooms/${id}/messages?since=${TARGET - 1}`);
    assert.equal((after.data.messages || []).length, beforeCount, "声明不能落成群消息");

    const noTarget = await api("POST", `/api/rooms/${id}/claim`, { who: "me" });
    assert.equal(noTarget.status, 400);

    const noWho = await api("POST", `/api/rooms/${id}/claim`, { targetSeq: TARGET + 1 });
    assert.ok([400, 403].includes(noWho.status), `缺 who 应被拒，实际 ${noWho.status}`);

    const badKey = await api("POST", `/api/rooms/${id}/claim`, { who: "me", key: "deadbeef", targetSeq: TARGET + 1 });
    assert.equal(badKey.status, 403);

    await api("POST", `/api/rooms/${id}/close`, { who: "you", key: PEOPLE.you.key });
    const closed = await api("POST", `/api/rooms/${id}/claim`, { who: "me", targetSeq: TARGET + 2 });
    assert.equal(closed.status, 409, "已关闭房间不可声明");
  } finally {
    await api("POST", `/api/rooms/${id}/archive`, { who: "you", key: PEOPLE.you.key });
    // 测试房不留归档残渣：archive 文件随删，列表即干净
    try { fs.unlinkSync(path.join(ROOT, "data", "archive", `${id}.json`)); } catch {}
  }
});

test("claim 双 key 鉴权：平台 ?k= 与成员 body.key 缺一不可", async () => {
  const title = `claim接口回归-鉴权-${Date.now()}`;
  const created = await api("POST", "/api/rooms", { who: "me", title, declaredBy: "me" });
  assert.equal(created.status, 200);
  const id = created.data.room.id;
  const TARGET = 1;
  const qk = `?k=${encodeURIComponent(KEY)}`;
  try {
    // 只有平台 key、没有成员 key：过得了全局鉴权，但过不了身份校验
    const platformOnly = await rawApi("POST", `/api/rooms/${id}/claim${qk}`, { who: "me", targetSeq: TARGET });
    assert.equal(platformOnly.status, 403, "缺成员 key 必须 403");
    assert.equal(platformOnly.data.error, "identity key mismatch");

    // 只有成员 key、没有平台 ?k=：全局鉴权先挡
    const memberOnly = await rawApi("POST", `/api/rooms/${id}/claim`, { who: "me", key: PEOPLE.me.key, targetSeq: TARGET });
    assert.equal(memberOnly.status, 401, "缺平台 key 必须 401");

    // 成员 key 与 who 不匹配：冒名必须拒
    const swapped = await rawApi("POST", `/api/rooms/${id}/claim${qk}`, { who: "me", key: PEOPLE.daman.key, targetSeq: TARGET });
    assert.equal(swapped.status, 403, "成员 key 不属于 who 必须 403");

    // 两个 key 都对：放行并成为赢家
    const ok = await api("POST", `/api/rooms/${id}/claim`, { who: "me", targetSeq: TARGET });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.ok, true);
    assert.equal(ok.data.winner, "me");
  } finally {
    await api("POST", `/api/rooms/${id}/close`, { who: "you", key: PEOPLE.you.key });
    await api("POST", `/api/rooms/${id}/archive`, { who: "you", key: PEOPLE.you.key });
    try { fs.unlinkSync(path.join(ROOT, "data", "archive", `${id}.json`)); } catch {}
  }
});

test("claim 并发：同 seq 同时 POST 两个 key，恰好一个赢家", async () => {
  const title = `claim接口回归-并发-${Date.now()}`;
  const created = await api("POST", "/api/rooms", { who: "me", title, declaredBy: "me" });
  assert.equal(created.status, 200);
  const id = created.data.room.id;
  const TARGET = 1;
  try {
    const before = await api("GET", `/api/rooms/${id}/messages?since=0`);
    const beforeCount = (before.data.messages || []).length;

    // 两个不同成员、各自成员 key + 平台 key，同一 targetSeq 同时发
    const [me, daman] = await Promise.all([
      api("POST", `/api/rooms/${id}/claim`, { who: "me", targetSeq: TARGET }),
      api("POST", `/api/rooms/${id}/claim`, { who: "daman", targetSeq: TARGET }),
    ]);
    assert.equal(me.status, 200);
    assert.equal(daman.status, 200);

    const responses = [me.data, daman.data];
    assert.ok(responses.every((d) => d.ok === true && typeof d.claim.token === "number"));
    assert.equal(new Set(responses.map((d) => d.claim.token)).size, 2, "两人各自拿到唯一 token");

    const winners = responses.filter((d) => d.winner === d.claim.who);
    assert.equal(winners.length, 1, "恰好一个赢家（winner 等于自己）");
    const loser = responses.find((d) => d.winner !== d.claim.who);
    assert.ok(loser.claim.token > winners[0].claim.token, "赢家 token 必须更小（服务端先到先得）");
    assert.equal(loser.winner, winners[0].claim.who, "输家静默落选，看到的是赢家");

    // 服务端最终视图与响应一致，且并发声明不落成群消息
    const got = await api("GET", `/api/rooms/${id}/claim?targetSeq=${TARGET}`);
    assert.equal(got.data.winner, winners[0].claim.who);
    assert.deepEqual(got.data.claims.map((c) => c.who).sort(), ["daman", "me"]);
    const after = await api("GET", `/api/rooms/${id}/messages?since=0`);
    assert.equal((after.data.messages || []).length, beforeCount, "声明不能落成群消息");
  } finally {
    await api("POST", `/api/rooms/${id}/close`, { who: "you", key: PEOPLE.you.key });
    await api("POST", `/api/rooms/${id}/archive`, { who: "you", key: PEOPLE.you.key });
    try { fs.unlinkSync(path.join(ROOT, "data", "archive", `${id}.json`)); } catch {}
  }
});
