#!/usr/bin/env node
// 主机侧房间运维：读 data/people.json 里群主的 key，替群主执行 close / archive
//（网页 confirm 在部分内置浏览器会被吞掉，所以留这条后路）。
// 用法：node scripts/room-ops.mjs <close|archive|close-archive> <room-id>
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA = path.join(ROOT, "data");

const [action, roomId] = process.argv.slice(2);
if (!["close", "archive", "close-archive"].includes(action) || !roomId) {
  console.error("用法: node scripts/room-ops.mjs <close|archive|close-archive> <room-id>");
  process.exit(2);
}

const port = fs.readFileSync(path.join(DATA, "port.txt"), "utf8").trim();
const platformKey = fs.readFileSync(path.join(DATA, "key.txt"), "utf8").trim();
const people = JSON.parse(fs.readFileSync(path.join(DATA, "people.json"), "utf8"));
const ownerKey = people.you?.key;
if (!ownerKey) {
  console.error("data/people.json 里没有群主 you 的 key，拒绝执行");
  process.exit(3);
}

const base = `http://127.0.0.1:${port}`;

async function call(act) {
  const res = await fetch(`${base}/api/rooms/${encodeURIComponent(roomId)}/${act}?k=${platformKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ who: "you", key: ownerKey }),
  });
  const body = await res.json().catch(() => ({}));
  console.log(`${act}: HTTP ${res.status} ${JSON.stringify(body)}`);
  if (!res.ok) process.exit(1);
  return body;
}

if (action === "close" || action === "close-archive") await call("close");
if (action === "archive" || action === "close-archive") await call("archive");

const state = await (await fetch(`${base}/api/state?k=${platformKey}`)).json();
const room = (state.rooms || []).find((r) => r.id === roomId);
console.log(`state: ${room ? room.status : "不在主数据里（大概率已归档）"}`);
