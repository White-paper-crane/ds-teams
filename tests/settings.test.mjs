// 运行期开关单元测试：settings-lib 的默认值 / 校验 / 原子写 / 读坏文件回落。
// A3 定档（11-04）：thresholdMs → warnMs(30s 黄) + criticalMs(90s 红) + quietWindowMs(15min 节流)。
// node tests/settings.test.mjs
// 全部跑在临时目录（DS_TEAMS_SETTINGS_FILE 指过去），绝不碰 data/settings.json。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ds-teams-settings-"));
const FILE = path.join(TMP, "settings.json");
process.env.DS_TEAMS_SETTINGS_FILE = FILE;

const { DEFAULTS, readSettings, writeSettings, patchSettings } = await import("../settings-lib.mjs");

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name + (extra ? " — " + extra : "")); } };

console.log("== 默认值（A3：30s 黄 / 90s 红 / 15min 节流） ==");
ok("黄线 30s", DEFAULTS.reviewLatency.warnMs === 30000, String(DEFAULTS.reviewLatency.warnMs));
ok("红线 90s", DEFAULTS.reviewLatency.criticalMs === 90000, String(DEFAULTS.reviewLatency.criticalMs));
ok("节流窗 15min", DEFAULTS.reviewLatency.quietWindowMs === 900000, String(DEFAULTS.reviewLatency.quietWindowMs));
ok("默认开启", DEFAULTS.reviewLatency.enabled === true);
ok("黄线 < 红线", DEFAULTS.reviewLatency.warnMs < DEFAULTS.reviewLatency.criticalMs);

console.log("== 读：文件不存在时回落默认 ==");
{
  const s = readSettings();
  ok("回默认值", s.reviewLatency.enabled === true && s.reviewLatency.warnMs === 30000 && s.reviewLatency.criticalMs === 90000, JSON.stringify(s));
  ok("读不写盘", !fs.existsSync(FILE));
}

console.log("== 写：原子写 + 读回一致 ==");
{
  const w = writeSettings({ reviewLatency: { enabled: false, warnMs: 45000 } });
  ok("writeSettings 返回归一化对象", w.reviewLatency.enabled === false && w.reviewLatency.warnMs === 45000, JSON.stringify(w));
  ok("落盘存在", fs.existsSync(FILE));
  const s = readSettings();
  ok("读回一致", s.reviewLatency.enabled === false && s.reviewLatency.warnMs === 45000, JSON.stringify(s));
  const leftovers = fs.readdirSync(TMP).filter((f) => f.includes(".tmp-"));
  ok("没有残留 tmp 文件", leftovers.length === 0, leftovers.join(","));
}

console.log("== patch：合法 ==");
{
  const r = patchSettings({ reviewLatency: { enabled: true } });
  ok("只改 enabled 成功", r.ok === true && r.settings.reviewLatency.enabled === true, JSON.stringify(r));
  ok("warnMs 保持不变", r.settings.reviewLatency.warnMs === 45000, JSON.stringify(r.settings));

  const r2 = patchSettings({ reviewLatency: { criticalMs: 180000 } });
  ok("只改 criticalMs 成功", r2.ok === true && r2.settings.reviewLatency.criticalMs === 180000, JSON.stringify(r2));
  ok("enabled 保持不变", r2.settings.reviewLatency.enabled === true);

  const r3 = patchSettings({ reviewLatency: { warnMs: 150200 } });
  ok("小数向下取整", r3.ok === true && r3.settings.reviewLatency.warnMs === 150200, JSON.stringify(r3.settings));

  const edge = patchSettings({ reviewLatency: { warnMs: 1000 } });
  ok("下界 1000 接受", edge.ok === true && edge.settings.reviewLatency.warnMs === 1000);
  const edge2 = patchSettings({ reviewLatency: { quietWindowMs: 3600000 } });
  ok("上界 3600000 接受", edge2.ok === true && edge2.settings.reviewLatency.quietWindowMs === 3600000);
}

console.log("== patch：旧字段 thresholdMs 兼容（映射到 warnMs） ==");
{
  const old = patchSettings({ reviewLatency: { thresholdMs: 60000 } });
  ok("thresholdMs → warnMs", old.ok === true && old.settings.reviewLatency.warnMs === 60000, JSON.stringify(old.settings));
}

console.log("== patch：非法一律 400，且不污染已存配置 ==");
{
  const before = readSettings();
  const bad1 = patchSettings({ reviewLatency: { enabled: "yes" } });
  ok("enabled 非布尔 → 400", bad1.ok === false && bad1.code === 400, JSON.stringify(bad1));
  const bad2 = patchSettings({ reviewLatency: { warnMs: "abc" } });
  ok("warnMs 非数字 → 400", bad2.ok === false && bad2.code === 400, JSON.stringify(bad2));
  ok("400 的报错文案含区间", String(bad2.error).includes("1000..3600000"), bad2.error);
  const bad3 = patchSettings({ reviewLatency: { warnMs: 999 } });
  ok("低于下界 → 400", bad3.ok === false && bad3.code === 400);
  const bad4 = patchSettings({ reviewLatency: { warnMs: 3600001 } });
  ok("高于上界 → 400", bad4.ok === false && bad4.code === 400);
  const bad5 = patchSettings({ reviewLatency: { warnMs: null } });
  ok("null → 400", bad5.ok === false && bad5.code === 400, JSON.stringify(bad5));
  // 黄线必须 < 红线
  fs.writeFileSync(FILE, JSON.stringify({ reviewLatency: { warnMs: 45000, criticalMs: 40000, quietWindowMs: 900000, enabled: true } }), "utf8");
  const cross = patchSettings({ reviewLatency: { warnMs: 50000 } });
  ok("黄线 ≥ 红线 → 400", cross.ok === false && cross.code === 400, JSON.stringify(cross));
  fs.writeFileSync(FILE, JSON.stringify(before), "utf8");
  const after = readSettings();
  ok("非法 patch 未改动任何字段", JSON.stringify(after) === JSON.stringify(before), `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);

  const empty = patchSettings({});
  ok("空 patch 成功且无变化", empty.ok === true && JSON.stringify(empty.settings) === JSON.stringify(before));

  const junk = patchSettings({ reviewLatency: "nope" });
  ok("reviewLatency 非对象 → 忽略不报错", junk.ok === true, JSON.stringify(junk));
}

console.log("== 读坏文件：一律回落默认，不抛 ==");
{
  fs.writeFileSync(FILE, "{ 这不是 JSON", "utf8");
  const s = readSettings();
  ok("坏 JSON → 回默认", s.reviewLatency.enabled === true && s.reviewLatency.warnMs === 30000, JSON.stringify(s));

  fs.writeFileSync(FILE, JSON.stringify({ reviewLatency: { warnMs: -1, enabled: "x" } }), "utf8");
  const s2 = readSettings();
  ok("负数 warnMs 回落默认", s2.reviewLatency.warnMs === 30000, JSON.stringify(s2));
  ok("非布尔 enabled 归一成 true", s2.reviewLatency.enabled === true, JSON.stringify(s2));

  fs.writeFileSync(FILE, "", "utf8");
  const s3 = readSettings();
  ok("空文件 → 回默认", s3.reviewLatency.warnMs === 30000, JSON.stringify(s3));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
