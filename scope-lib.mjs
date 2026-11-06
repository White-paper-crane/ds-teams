// ds-teams · worker 写面审计（控制面 v2）
// 目的：subagent 只写任务声明的 writeScope；Lead 在 report/accept 前可复核。
// 只读 git 工作区状态，不修改文件；writeScope 为空时由调用方决定是否放行。
import { spawnSync } from "node:child_process";

export function normalizeRel(p) {
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}

export function parsePorcelain(text) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const status = raw.slice(0, 2);
    let rest = raw.slice(3).trim();
    if (status.includes("R") || status.includes("C")) {
      const idx = rest.indexOf(" -> ");
      if (idx >= 0) rest = rest.slice(idx + 4);
    }
    if (!rest) continue;
    if (rest.startsWith('"') && rest.endsWith('"')) rest = rest.slice(1, -1);
    out.push({ status, path: normalizeRel(rest) });
  }
  return out;
}

export function isInScope(file, scope) {
  const p = normalizeRel(file);
  for (const raw of Array.isArray(scope) ? scope : []) {
    const s = normalizeRel(raw);
    if (!s) continue;
    if (p === s || p.startsWith(s + "/")) return true;
  }
  return false;
}

export function auditScope(root, scope) {
  const r = spawnSync("git", ["-c", "core.quotepath=false", "status", "--porcelain"], {
    cwd: root || ".",
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  if (r.error) return { ok: false, error: String(r.error.message || r.error) };
  if (r.status !== 0) return { ok: false, error: String(r.stderr || "git status failed").trim() };
  const changed = parsePorcelain(r.stdout);
  const outside = changed.filter((x) => !isInScope(x.path, scope));
  return {
    ok: outside.length === 0,
    changed: changed.map((x) => x.path),
    outside: outside.map((x) => x.path),
    scope: (Array.isArray(scope) ? scope : []).map(normalizeRel).filter(Boolean),
  };
}
