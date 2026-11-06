// 一键隧道：起 cloudflared quick tunnel，把公网 URL 记到 data/tunnel-url.txt。
// 用法：node scripts/tunnel.mjs [start|status|stop]
// quick tunnel 每次重启 URL 会变；需要固定域名得用 cloudflared 命名隧道 + 自己的域名。
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA = path.join(ROOT, "data");
const PID_FILE = path.join(DATA, "tunnel.pid");
const URL_FILE = path.join(DATA, "tunnel-url.txt");
// URL 之外还记启动时间与进程，入口页 /entry 靠它判断现状。
const META_FILE = path.join(DATA, "tunnel.json");
const LOG = path.join(DATA, "tunnel.log");
const ERR = path.join(DATA, "tunnel.log.err");

const read = (p, d = "") => { try { return fs.readFileSync(p, "utf8").trim(); } catch { return d; } };
const port = read(path.join(DATA, "port.txt")) || "8792";
const key = read(path.join(DATA, "key.txt"));
const linkOf = (url) => (key ? `${url}/?k=${key}` : url);

function cloudflaredBin() {
  const cands = [process.env.CLOUDFLARED, path.join(process.env.TEMP || "", "cloudflared.exe"), "cloudflared"];
  for (const c of cands) {
    if (!c) continue;
    if (c.includes(path.sep) && !fs.existsSync(c)) continue;
    return c;
  }
  return null;
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function findRunning() {
  const pid = Number(read(PID_FILE));
  if (pid && alive(pid)) return pid;
  try {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq cloudflared.exe", "/FO", "CSV", "/NH"], { encoding: "utf8" });
    const m = out.match(/"cloudflared\.exe","(\d+)"/i);
    if (m) return Number(m[1]);
  } catch {}
  return 0;
}
function urlFromLog() {
  // quick tunnel 的 URL 打在 stderr（cloudflared 把 INF 日志写 stderr），两边都扫。
  const t = read(LOG) + "\n" + read(ERR);
  const all = [...t.matchAll(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/gi)].map((m) => m[0]);
  return all.length ? all[all.length - 1] : "";
}
function writeMeta(url, pid, startedAt) {
  const body = { url, link: linkOf(url), pid, startedAt: startedAt || Date.now(), writtenAt: Date.now(), mode: "quick" };
  fs.writeFileSync(META_FILE, JSON.stringify(body, null, 2));
  return body;
}
function stop() {
  const pid = findRunning();
  if (!pid) { console.log("隧道没在跑"); for (const f of [PID_FILE, URL_FILE, META_FILE]) fs.rmSync(f, { force: true }); return; }
  try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
  for (const f of [PID_FILE, URL_FILE, META_FILE]) fs.rmSync(f, { force: true });
  console.log(`已停隧道 pid=${pid}`);
}
// 等待窗口：本机到 api.trycloudflare.com 常要 20s+ 才回，30s 极易误判失败。
const WAIT_MS = Number(process.env.TUNNEL_WAIT_MS || 180_000);

async function start() {
  const running = findRunning();
  if (running) {
    let url = read(URL_FILE) || urlFromLog();
    // 进程在但 URL 还没落盘（刚起没多久）：等，不要立刻报「没有链接」
    const t0 = Date.now();
    while (!url && alive(running) && Date.now() - t0 < WAIT_MS) {
      await new Promise((r) => setTimeout(r, 1000));
      url = urlFromLog();
    }
    if (url && !fs.existsSync(URL_FILE)) fs.writeFileSync(URL_FILE, url);
    if (url) {
      const old = (() => { try { return JSON.parse(read(META_FILE)); } catch { return null; } })();
      writeMeta(url, running, old && old.url === url ? old.startedAt : Date.now());
    }
    console.log(`隧道已在跑 pid=${running}`);
    if (url) console.log(url.startsWith("https://") ? linkOf(url) : url);
    else console.error(`进程在但 ${WAIT_MS / 1000}s 内没拿到 URL，看 data/tunnel.log.err`);
    return;
  }
  const bin = cloudflaredBin();
  if (!bin) { console.error("找不到 cloudflared：设 CLOUDFLARED=<路径>，或把 cloudflared.exe 放到 %TEMP% 或 PATH"); process.exit(1); }
  fs.writeFileSync(LOG, "");
  fs.writeFileSync(ERR, "");
  const out = fs.openSync(LOG, "a"), err = fs.openSync(ERR, "a");
  const child = spawn(bin, ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate", "--protocol", "http2"], {
    detached: true, stdio: ["ignore", out, err], windowsHide: true,
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  const started = Date.now();
  while (Date.now() - started < WAIT_MS) {
    await new Promise((r) => setTimeout(r, 500));
    const url = urlFromLog();
    if (url) {
      fs.writeFileSync(URL_FILE, url);
      writeMeta(url, child.pid, started);
      console.log(`隧道已起 pid=${child.pid}`);
      console.log(linkOf(url));
      return;
    }
    if (!alive(child.pid)) break;
  }
  console.error(`${WAIT_MS / 1000} 秒内没拿到公网 URL，看 data/tunnel.log.err`);
  process.exit(1);
}
function status() {
  const pid = findRunning();
  const url = read(URL_FILE) || urlFromLog();
  if (!pid) { console.log("隧道没在跑"); if (url) console.log("上次 URL: " + linkOf(url)); return; }
  console.log(`隧道在跑 pid=${pid} → ${url ? linkOf(url) : "URL 未知"}`);
}
const cmd = process.argv[2] || "start";
if (cmd === "stop") stop();
else if (cmd === "status") status();
else if (cmd === "start") await start();
else { console.error("用法: node scripts/tunnel.mjs [start|status|stop]"); process.exit(2); }
