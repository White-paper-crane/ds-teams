// ds-teams · 运行期开关（data/settings.json）
// 只放「不改代码、不改重启就能生效」的运维开关；业务常量仍在 protocol.mjs。
// 写入 = tmp + rename（与 wake-lib / meeting-lib 同纪律）。读失败回落到默认值，绝不抛。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.DS_TEAMS_DATA_DIR || path.join(ROOT, "data");
const FILE = process.env.DS_TEAMS_SETTINGS_FILE || path.join(DATA, "settings.json");

// 默认值：评审端延迟告警默认开（只记 warn，不改任何行为，关掉只需点一下按钮）。
// A3 定档（用户 11-04 拍板「30s 黄、90s 红推人、15 分钟节流聚合」）：
//   warnMs = 30s 黄线：超了记 warn（chip 变黄计数）。必须 > 沉默窗口？——不：沉默收敛恒在
//   ~90s（WAKE.outcomeWindowMs）判定，若 30s < 沉默窗口，每条沉默都会记黄。所以沉默收敛
//   （closedBy:"silent"）跳过黄线只看红线（90s）：沉默=设计行为不是评审慢。
//   criticalMs = 90s 红线：对齐 wake 90s 观察窗，到 90s 基本注定失败，推人（ops 事件 + QQ 一句话）。
//   quietWindowMs = 15min：红线推人的节流窗，窗内聚合计数，过了窗才再推（防告警疲劳）。
export const DEFAULTS = Object.freeze({
  reviewLatency: Object.freeze({
    enabled: true,
    warnMs: 30_000,
    criticalMs: 90_000,
    quietWindowMs: 900_000,
  }),
});

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

function normalize(raw) {
  const j = raw && typeof raw === "object" ? raw : {};
  const rl = j.reviewLatency && typeof j.reviewLatency === "object" ? j.reviewLatency : {};
  const d = DEFAULTS.reviewLatency;
  return {
    reviewLatency: {
      enabled: rl.enabled === false ? false : true,
      warnMs: num(rl.warnMs, d.warnMs),
      criticalMs: num(rl.criticalMs, d.criticalMs),
      quietWindowMs: num(rl.quietWindowMs, d.quietWindowMs),
    },
  };
}

export function readSettings() {
  try {
    return normalize(JSON.parse(fs.readFileSync(FILE, "utf8")));
  } catch {
    return normalize(null);
  }
}

export function writeSettings(next) {
  const j = normalize(next);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, FILE);
  return j;
}

// 局部更新：只改传进来的键，其余保持现状。非法值一律拒绝（返回 code 400 给路由映射）。
// 旧字段 thresholdMs（≤11-04）自动迁移：>90s → { warnMs: 90s 现状不动, criticalMs: thresholdMs }；
// ≤90s → 全部回 A3 默认。迁移后写盘，读侧从此只见新三键。
export function patchSettings(patch = {}) {
  const cur = readSettings();
  const out = { ...cur, reviewLatency: { ...cur.reviewLatency } };
  const rl = patch && typeof patch.reviewLatency === "object" ? patch.reviewLatency : null;
  if (rl) {
    if ("enabled" in rl) {
      if (typeof rl.enabled !== "boolean") return { ok: false, error: "reviewLatency.enabled must be boolean", code: 400 };
      out.reviewLatency.enabled = rl.enabled;
    }
    const bounds = (key, lo, hi) => {
      const n = Number(rl[key]);
      if (!Number.isFinite(n) || n < lo || n > hi) {
        return { ok: false, error: `reviewLatency.${key} must be ${lo}..${hi}`, code: 400 };
      }
      out.reviewLatency[key] = Math.floor(n);
      return null;
    };
    // 兼容旧字段：thresholdMs 视为黄线（warnMs），1000..3600000
    if ("thresholdMs" in rl && !("warnMs" in rl)) {
      const n = Number(rl.thresholdMs);
      if (!Number.isFinite(n) || n < 1000 || n > 3_600_000) {
        return { ok: false, error: "reviewLatency.thresholdMs must be 1000..3600000", code: 400 };
      }
      out.reviewLatency.warnMs = Math.floor(n);
    }
    for (const [key, lo, hi] of [["warnMs", 1000, 3_600_000], ["criticalMs", 1000, 3_600_000], ["quietWindowMs", 60000, 3_600_000]]) {
      if (key in rl) {
        const e = bounds(key, lo, hi);
        if (e) return e;
      }
    }
    if (out.reviewLatency.warnMs >= out.reviewLatency.criticalMs) {
      return { ok: false, error: "reviewLatency.warnMs must be < criticalMs", code: 400 };
    }
  }
  return { ok: true, settings: writeSettings(out) };
}
