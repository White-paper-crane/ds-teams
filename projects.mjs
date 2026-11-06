// 项目空间（Project Space）：服务端持久层。
// 设计见 docs/project-space-设计.md。schema：data/projects/<id>/project.json + memory.jsonl + bindings.json + index.json
// 纪律：append-only 记忆、hash 幂等、supersede 链、索引可重算、写入门禁按 person key。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CLOSED as LEDGER_CLOSED } from "./protocol.mjs";

const KINDS = new Set(["rule", "decision", "fact", "task", "open-question", "summary"]);
const MAX_INDEX_BYTES = 2048;
// 双真源口径（DP-7）：dispatch 台账是任务唯一真源，项目的 activeTasks 只读派生。

export function activeTasksFromLedger(proj, ledger) {
  const projectId = proj && proj.id;
  const rooms = new Set((proj && proj.roomIds) || []);
  const raw = ledger && ledger.tasks;
  const list = Array.isArray(raw) ? raw : Object.values(raw || {});
  return list
    .filter((t) => t && ((projectId && t.projectId === projectId) || rooms.has(t.roomId)) && !LEDGER_CLOSED.has(String(t.state)))
    .map((t) => {
      const pid = t.projectId || t.roomId;
      return { id: pid + "::" + t.taskId, taskId: t.taskId, title: t.title || "", state: t.state, owner: t.assignee || t.owner || "", projectId: t.projectId || "", roomId: t.roomId || "", updatedAt: t.updatedAt || "" };
    });
}

function nowIso() { return new Date().toISOString(); }
function sha16(s) { return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16); }
function norm(s) { return String(s || "").replace(/\s+/g, " ").trim(); }

export function createProjectSpace({ dataDir, personOf, personKey, readLedger }) {
  const ROOT = path.join(dataDir, "projects");
  fs.mkdirSync(ROOT, { recursive: true });
  function safeLedger() { try { return typeof readLedger === "function" ? readLedger() : null; } catch { return null; } }

  const dirOf = (id) => path.join(ROOT, id);
  const fileOf = (id, name) => path.join(dirOf(id), name);

  function exists(id) { return /^proj-[a-z0-9-]{1,40}$/.test(id) && fs.existsSync(fileOf(id, "project.json")); }
  function readJson(file, dflt) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return dflt; } }
  function writeJson(file, obj) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }

  function getProject(id) { return exists(id) ? readJson(fileOf(id, "project.json"), null) : null; }
  function saveProject(p) { p.updatedAt = nowIso(); writeJson(fileOf(p.id, "project.json"), p); }
  function listProjects() {
    return fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory())
      .map((d) => getProject(d.name)).filter(Boolean).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  function readMem(id) {
    const f = fileOf(id, "memory.jsonl");
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
  function appendMem(id, m) { fs.appendFileSync(fileOf(id, "memory.jsonl"), JSON.stringify(m) + "\n", "utf8"); }
  function rewriteMem(id, rows) {
    const f = fileOf(id, "memory.jsonl");
    const tmp = f + ".tmp";
    fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), "utf8");
    fs.renameSync(tmp, f);
  }

  function computeIndex(p) {
    const rows = readMem(p.id).filter((m) => m.status !== "superseded");
    const byKind = (k) => rows.filter((m) => m.kind === k);
    // 规则以 memory kind=rule 为主源，project.rules 仅作旧数据兜底；按文本去重保序
    const rules = [...new Set([...byKind("rule").map((m) => m.text), ...(p.rules || []).map((r) => r.text)])];
    const openQuestions = byKind("open-question").slice(-20).map((m) => ({ id: m.id, text: m.text, owner: m.owner || m.source?.who || "" }));
    const recentDecisions = byKind("decision").slice(-10).map((m) => ({ id: m.id, text: m.text, at: m.createdAt }));
    const activeTasks = activeTasksFromLedger(p, safeLedger());
    const recent = rows.slice(-5).filter((m) => m.kind === "summary" || m.kind === "decision");
    const digest = recent.map((m) => norm(m.text).slice(0, 80)).join("；") || (p.digest || "");
    const cursor = rows.length ? rows[rows.length - 1].id : null;
    const idx = { projectId: p.id, digest, rules, openQuestions, recentDecisions, activeTasks, cursor, recomputedAt: nowIso() };
    writeJson(fileOf(p.id, "index.json"), idx);
    return idx;
  }

  // 返回体控制在 ~2KB：规则全量、未决全量（≤20）、决定 10、任务非终态
  function trimIndex(idx) {
    let out = idx;
    let s = JSON.stringify(out);
    if (s.length <= MAX_INDEX_BYTES) return out;
    out = { ...out, recentDecisions: out.recentDecisions.slice(-5), openQuestions: out.openQuestions.slice(-10) };
    s = JSON.stringify(out);
    if (s.length <= MAX_INDEX_BYTES) return out;
    return { ...out, rules: out.rules.map((r) => r.slice(0, 120)), digest: (out.digest || "").slice(0, 200) };
  }

  function canRead(p, who) { return !!(p && who && (p.accountIds || []).includes(who)); }
  function authActor(b, url, req) {
    const who = String(b.who || url.searchParams.get("who") || "");
    const key = String(b.key || url.searchParams.get("key") || req.headers["x-member-key"] || "");
    const p = personOf(who);
    if (!p || p.status !== "active") return null;
    if (!key || key !== personKey(who)) return null;
    return who;
  }

  async function handle(req, res, url, readBody, json) {
    const p = url.pathname;
    if (!p.startsWith("/api/projects")) return false;

    const body = req.method === "GET" ? {} : await readBody(req).catch(() => ({}));
    const who = authActor(body, url, req);
    if (!who) return json(res, 401, { ok: false, error: "unauthorized: who+key required" });

    // 列表 / 建项目
    if (p === "/api/projects" && req.method === "GET") {
      const all = listProjects();
      return json(res, 200, { ok: true, projects: all.filter((x) => canRead(x, who)).map((x) => ({ id: x.id, slug: x.slug, title: x.title, status: x.status, updatedAt: x.updatedAt })) });
    }
    if (p === "/api/projects" && req.method === "POST") {
      const title = String(body.title || "").trim() || "未命名项目";
      const slug = String(body.slug || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "p" + crypto.randomBytes(2).toString("hex");
      const id = "proj-" + slug;
      if (exists(id)) return json(res, 409, { ok: false, error: "project exists", id });
      const proj = {
        id, slug, title, rootPath: String(body.rootPath || ""), status: "active",
        accountIds: Array.isArray(body.accountIds) && body.accountIds.length ? body.accountIds.map(String) : ["you", "me", "daman"],
        roomIds: (Array.isArray(body.roomIds) ? body.roomIds : []).map(String),
        rules: [], createdAt: nowIso(), updatedAt: nowIso(),
      };
      fs.mkdirSync(dirOf(id), { recursive: true });
      saveProject(proj);
      computeIndex(proj);
      return json(res, 200, { ok: true, project: proj });
    }

    const m = p.match(/^\/api\/projects\/([^/]+)(?:\/(.*))?$/);
    if (!m) return json(res, 404, { ok: false, error: "not found" });
    const id = decodeURIComponent(m[1]);
    const tail = m[2] || "";
    const proj = getProject(id);
    if (!proj) return json(res, 404, { ok: false, error: "project not found" });
    if (!canRead(proj, who)) return json(res, 403, { ok: false, error: "account not in project" });

    if (tail === "" && req.method === "GET") return json(res, 200, { ok: true, project: proj });

    if (tail === "memory" && req.method === "POST") {
      const kind = String(body.kind || "fact");
      if (!KINDS.has(kind)) return json(res, 400, { ok: false, error: "bad kind: " + kind });
      if (kind === "task") return json(res, 403, { ok: false, error: "task writes rejected: dispatch ledger is the source of truth" });
      const evidence = String(body.evidence || "").trim();
      if (["rule", "decision", "fact"].includes(kind) && !evidence) {
        return json(res, 400, { ok: false, error: "evidence required for kind=" + kind });
      }
      const text = String(body.text || "").trim();
      if (!text) return json(res, 400, { ok: false, error: "text required" });
      const hash = sha16(id + "|" + kind + "|" + norm(text));
      const rows = readMem(id);
      const dup = rows.find((x) => x.hash === hash);
      if (dup) return json(res, 409, { ok: true, duplicate: true, id: dup.id, memory: dup });
      const row = {
        id: "mem-" + String(rows.length + 1).padStart(6, "0"),
        projectId: id, kind, text: norm(text),
        tags: (body.tags || []).map(String), refs: (body.refs || []).map(String),
        source: { who, end: String(body.end || ""), sessionId: String(body.sessionId || ""), evidence: String(body.evidence || "") },
        hash, status: "active", supersededBy: null, createdAt: nowIso(),
      };
      if (kind === "open-question") row.owner = String(body.owner || who);
      if (!row.source.evidence) row.confidence = "low";
      appendMem(id, row);
      computeIndex(proj);
      return json(res, 200, { ok: true, id: row.id, memory: row });
    }

    if (tail === "memory" && req.method === "GET") {
      const q = norm(url.searchParams.get("q") || "").toLowerCase();
      const kind = url.searchParams.get("kind") || "";
      const limit = Math.min(200, Number(url.searchParams.get("limit") || 50));
      const since = Date.parse(url.searchParams.get("since") || 0);
      let rows = readMem(id);
      if (kind) rows = rows.filter((x) => x.kind === kind);
      if (since) rows = rows.filter((x) => Date.parse(x.createdAt) >= since);
      if (q) rows = rows.filter((x) => (x.text || "").toLowerCase().includes(q) || (x.tags || []).some((t) => String(t).toLowerCase().includes(q)));
      rows = rows.slice(-limit);
      return json(res, 200, { ok: true, count: rows.length, memories: rows });
    }

    if (tail === "index" && req.method === "GET") return json(res, 200, { ok: true, index: trimIndex(computeIndex(proj)) });

    if (tail === "state" && req.method === "GET") {
      const idx = computeIndex(proj);
      return json(res, 200, { ok: true, state: { projectId: id, activeTasks: idx.activeTasks, openQuestions: idx.openQuestions, recentDecisions: idx.recentDecisions.slice(-5), cursor: idx.cursor } });
    }

    if (tail === "bind" && req.method === "POST") {
      const bf = fileOf(id, "bindings.json");
      const binds = readJson(bf, []);
      const end = String(body.end || "unknown");
      const endpointId = String(body.endpointId || "");
      const rec = { accountId: who, end, endpointId, projectId: id, sessionId: String(body.sessionId || ""), lastSeenAt: nowIso() };
      const i = binds.findIndex((x) => x.accountId === who && x.end === end && x.endpointId === endpointId);
      if (i >= 0) binds[i] = rec; else binds.push(rec);
      writeJson(bf, binds);
      return json(res, 200, { ok: true, binding: rec });
    }

    const sm = tail.match(/^memory\/([^/]+)\/supersede$/);
    if (sm && req.method === "POST") {
      const mid = decodeURIComponent(sm[1]);
      const rows = readMem(id);
      const old = rows.find((x) => x.id === mid);
      if (!old) return json(res, 404, { ok: false, error: "memory not found" });
      if (old.status === "superseded") return json(res, 409, { ok: false, error: "already superseded", by: old.supersededBy });
      const text = String(body.text || "").trim();
      if (!text) return json(res, 400, { ok: false, error: "text required" });
      const kind = String(body.kind || old.kind);
      const hash = sha16(id + "|" + kind + "|" + norm(text));
      const row = {
        id: "mem-" + String(rows.length + 1).padStart(6, "0"), projectId: id, kind, text: norm(text),
        tags: (body.tags || old.tags || []).map(String), refs: (body.refs || []).map(String),
        source: { who, end: String(body.end || ""), sessionId: String(body.sessionId || ""), evidence: String(body.evidence || "") },
        hash, status: "active", supersededBy: null, createdAt: nowIso(),
      };
      old.status = "superseded"; old.supersededBy = row.id;
      rows.push(row);
      rewriteMem(id, rows);
      computeIndex(proj);
      return json(res, 200, { ok: true, id: row.id, superseded: mid, memory: row });
    }

    return json(res, 404, { ok: false, error: "not found" });
  }

  return { handle, computeIndex, listProjects };
}
