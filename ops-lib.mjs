// ds-teams · 运维观测事件（data/ops-events.jsonl）
// 只记「值得人看一眼」的异常，不改任何业务行为：warn 只写文件 + 进 /api/ops/events，不阻断、不抛。
// 一行一个 JSON：{at, level, code, roomId, ...}
// 与 bridge-*.log 的分工：那边是端侧注入调试，这边是服务端可判定的运行期异常。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.DS_TEAMS_DATA_DIR || path.join(ROOT, "data");
const FILE = process.env.DS_TEAMS_OPS_FILE || path.join(DATA, "ops-events.jsonl");

// 只保留最近这么多行，超了就地裁剪（避免无限长：warn 是低频事件，2MB 足够回溯几周）。
const MAX_BYTES = 2 * 1024 * 1024;

export function warn(code, fields = {}) {
  const rec = { at: new Date().toISOString(), level: "warn", code: String(code || "WARN"), ...fields };
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.appendFileSync(FILE, JSON.stringify(rec) + "\n", "utf8");
    trim();
  } catch {
    // 记不下来也不能影响主流程
  }
  return rec;
}

function trim() {
  try {
    const st = fs.statSync(FILE);
    if (st.size <= MAX_BYTES) return;
    const lines = fs.readFileSync(FILE, "utf8").split(/\r?\n/).filter(Boolean).slice(-2000);
    const tmp = FILE + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, lines.join("\n") + "\n", "utf8");
    fs.renameSync(tmp, FILE);
  } catch {}
}

// 最近 n 条（倒序），供 /api/ops/events 与 check.mjs 用。
export function tail(n = 50, { code = "" } = {}) {
  let lines = [];
  try {
    lines = fs.readFileSync(FILE, "utf8").split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    let rec;
    try { rec = JSON.parse(lines[i]); } catch { continue; }
    if (!rec || (code && rec.code !== code)) continue;
    out.push(rec);
  }
  return out;
}

export const _internals = { FILE };
