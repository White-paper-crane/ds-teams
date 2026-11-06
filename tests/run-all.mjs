// 全量测试 + 自动收拾测试房。
// 用法：node tests/run-all.mjs
//  1) 跑 tests/*.test.mjs（逐个文件传给 node --test）
//  2) 不管成败，都跑 tools/cleanup-test-rooms.mjs，把测试房解散归档，主列表保持干净
// 退出码沿用测试结果；清理失败但测试通过时只警告。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = fs.readdirSync(path.join(ROOT, "tests"))
  .filter((f) => f.endsWith(".test.mjs"))
  .sort()
  .map((f) => path.join("tests", f));

const test = spawnSync(process.execPath, ["--test", ...files], { cwd: ROOT, stdio: "inherit" });
const cleanup = spawnSync(process.execPath, [path.join("tools", "cleanup-test-rooms.mjs"), "--prune-people"], { cwd: ROOT, stdio: "inherit" });
if (test.status === 0 && cleanup.status !== 0) console.warn("\n[注意] 测试通过，但测试房清理失败");
process.exit(test.status ?? 1);
