#!/usr/bin/env node
// ds-teams · 确定性检查执行器（控制面 v2）
// 只认退出码 0 为 pass；超时/信号/非 0 都算 fail。
// 不自动修代码、不重试、不换模型；失败把 stdout/stderr 尾部交回 Lead。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = path.join(ROOT, "data", "gates");
const TAIL_BYTES = 4000;

function tail(s, n = TAIL_BYTES) {
  const text = String(s || "");
  if (text.length <= n) return text;
  return "…" + text.slice(-n);
}

function hash(s) {
  return crypto.createHash("sha256").update(String(s || "")).digest("hex");
}

function safeName(s) {
  return String(s || "gate").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
}

export function runGate({ command, cwd = ".", timeoutMs = 300_000, env = {} } = {}) {
  const cmd = String(command || "").trim();
  if (!cmd) return { pass: false, error: "no command", exitCode: null, durationMs: 0, at: new Date().toISOString() };
  const workdir = path.resolve(ROOT, String(cwd || "."));
  const started = Date.now();
  const r = spawnSync(cmd, {
    cwd: workdir,
    shell: true,
    encoding: "utf8",
    timeout: Math.max(1000, Number(timeoutMs) || 300_000),
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  const durationMs = Date.now() - started;
  const stdout = r.stdout || "";
  const stderr = r.stderr || "";
  const timedOut = !!(r.error && (r.error.code === "ETIMEDOUT" || /timed out/i.test(String(r.error.message || ""))));
  return {
    pass: !timedOut && r.status === 0,
    exitCode: r.status === null || r.status === undefined ? null : r.status,
    signal: r.signal || null,
    timedOut,
    durationMs,
    command: cmd,
    cwd: workdir,
    timeoutMs: Number(timeoutMs) || 300_000,
    stdoutHash: hash(stdout),
    stderrHash: hash(stderr),
    stdoutTail: tail(stdout),
    stderrTail: tail(stderr),
    at: new Date().toISOString(),
  };
}

export function writeEvidence(result, { projectId = "", taskId = "" } = {}) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = [projectId, taskId, stamp].filter(Boolean).map(safeName).join("-") + ".json";
  const fp = path.join(EVIDENCE_DIR, name);
  fs.writeFileSync(fp, JSON.stringify(result, null, 2), "utf8");
  return path.relative(ROOT, fp).replace(/\\/g, "/");
}

const argv = process.argv.slice(2);
const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const flag = (name, dflt = "") => {
    const i = argv.indexOf("--" + name);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
  };
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : flag("command");
  if (!command) {
    console.error("usage: node gate.mjs <command> [--cwd .] [--timeout 300000] [--json]");
    process.exit(2);
  }
  const result = runGate({
    command,
    cwd: flag("cwd", "."),
    timeoutMs: Number(flag("timeout", "300000")),
  });
  const evidencePath = writeEvidence(result, { projectId: flag("project"), taskId: flag("task") });
  const out = { ...result, evidencePath };
  console.log(JSON.stringify(out, null, 2));
  process.exit(result.pass ? 0 : 1);
}
