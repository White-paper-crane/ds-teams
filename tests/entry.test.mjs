// ds-teams · 入口页 /entry 与隧道快照 /api/tunnel（零依赖，node 原生 fetch）
// 运行：node tests/entry.test.mjs
// 覆盖：鉴权（401/200）、页面关键文案、快照字段、旧 URL 文件的兜底形状、alive 与 startedAt 类型。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.DS_TEAMS_URL || "http://127.0.0.1:8792").replace(/\/+$/, "");
const KEY = (process.env.DS_TEAMS_KEY || fs.readFileSync(path.join(ROOT, "data", "key.txt"), "utf8")).trim();

let passed = 0;
const failures = [];
let current = "";

function section(name) {
  current = name;
  console.log(`\n== ${name} ==`);
}
function check(name, cond, actual) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push({ detail: `${current} / ${name}`, actual });
    console.log(`  FAIL  ${name}`);
    console.log(`        实际: ${fmt(actual)}`);
  }
}
function fmt(v) {
  try { return JSON.stringify(v)?.slice(0, 600) ?? String(v); } catch { return String(v); }
}

async function get(p, k = KEY) {
  const url = `${BASE}${p}${k ? (p.includes("?") ? "&" : "?") + `k=${encodeURIComponent(k)}` : ""}`;
  const res = await fetch(url, { redirect: "manual" });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, text, data };
}

section("1. /entry 鉴权");
{
  const r = await get("/entry", "");
  check("无 k 返回 401", r.status === 401, { status: r.status, body: r.text.slice(0, 120) });
  const ok = await get("/entry");
  check("带 k 返回 200", ok.status === 200, { status: ok.status });
  check("页面含标题「ds-teams 入口」", ok.text.includes("ds-teams 入口"), ok.text.slice(0, 80));
  check("页面含固定地址提示 127.0.0.1:8792/entry", ok.text.includes("127.0.0.1:8792/entry"), ok.text.slice(0, 200));
  check("页面自带 5 秒轮询", /setInterval\(load,\s*5000\)/.test(ok.text), ok.text.match(/setInterval\([^)]*\)/)?.[0]);
  check("页面不直接内联 key", !ok.text.includes(`k=${KEY}`) || ok.text.includes("/api/tunnel"), true);
}

section("2. /api/tunnel 鉴权");
{
  const r = await get("/api/tunnel", "");
  check("无 k 返回 401 JSON", r.status === 401 && r.data?.ok === false, { status: r.status, data: r.data });
}

section("3. /api/tunnel 快照形状");
{
  const r = await get("/api/tunnel");
  check("200 且 ok=true", r.status === 200 && r.data?.ok === true, { status: r.status, data: r.data });
  check("含 hasTunnel 布尔", typeof r.data?.hasTunnel === "boolean", r.data);
  if (r.data?.hasTunnel) {
    check("link 是 https URL", /^https:\/\/[^\s]+/.test(String(r.data.link)), r.data?.link);
    check("link 带 ?k= 钥匙", /[?&]k=/.test(String(r.data.link)), r.data?.link);
    check("alive 是布尔", typeof r.data.alive === "boolean", r.data?.alive);
    check("startedAt / ageMs 是数字", Number.isFinite(r.data.startedAt) && Number.isFinite(r.data.ageMs), { startedAt: r.data?.startedAt, ageMs: r.data?.ageMs });
    check("url 不含错误日志里的 api.trycloudflare.com", !String(r.data.url).includes("api.trycloudflare.com"), r.data?.url);
  } else {
    check("没有隧道时给 hint", typeof r.data?.hint === "string" && r.data.hint.length > 0, r.data);
  }
}

section("4. 旧数据兜底（裸 tunnel-url.txt）");
{
  // 不写盘：只验证接口在「有 hasTunnel 但无 pid」时给出提示字段，而不是 500。
  const r = await get("/api/tunnel");
  const okShape = r.status === 200 && (!r.data?.hasTunnel || r.data?.pid >= 0);
  check("无快照/旧文件时仍是 200 而不是 500", okShape, { status: r.status, data: r.data });
}

console.log(`\n通过 ${passed} 条，失败 ${failures.length} 条`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f.detail}：${fmt(f.actual)}`);
  process.exit(1);
}
