// gate runner：只认退出码 0；记录 hash/尾部/证据文件。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGate, writeEvidence } from "../gate.mjs";

let fails = 0;
const ok = (name, cond, extra = "") => {
  if (!cond) { fails++; console.log("FAIL " + name + (extra ? " :: " + JSON.stringify(extra) : "")); }
  else console.log("PASS " + name);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ds-gate-"));

const pass = runGate({ command: "node -e \"console.log('gate-ok')\"", cwd: dir, timeoutMs: 30_000 });
ok("exit 0 pass", pass.pass === true && pass.exitCode === 0 && pass.stdoutTail.includes("gate-ok"), pass);
ok("stdout hash", typeof pass.stdoutHash === "string" && pass.stdoutHash.length === 64);

const fail = runGate({ command: "node -e \"console.error('gate-bad'); process.exit(7)\"", cwd: dir, timeoutMs: 30_000 });
ok("exit 7 fail", fail.pass === false && fail.exitCode === 7 && fail.stderrTail.includes("gate-bad"), fail);

const none = runGate({ command: "" });
ok("empty command fail", none.pass === false && /no command/.test(none.error), none);

const ev = writeEvidence(pass, { projectId: "proj-test", taskId: "T-gate" });
const evAbs = path.resolve(process.cwd(), ev);
ok("evidence file written", fs.existsSync(evAbs), ev);
if (fs.existsSync(evAbs)) fs.rmSync(evAbs, { force: true });

fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAIL` : "\nALL PASS");
process.exit(fails ? 1 : 0);
