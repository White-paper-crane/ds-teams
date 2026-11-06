// dsh-projectspace.mjs — 项目空间宿主工具（M2），5 个工具。
// 数据源：ds-teams 服务端 8792 的 /api/projects*（person key 鉴权）。
// 身份按 exec.agent.id 判定：含 "onebot-private" 视为 me（QQ 端小满），否则 daman（桌面端大满）。

import fs from "node:fs";
import path from "node:path";

export const name = "dsh-projectspace";
export const inject = ["tools"];

const DS = "<repo>";
const OUT = { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" }, data: { type: "string" } }, required: ["ok"] };
const jsonOut = (schema) => ({ schema, render: (_a, v) => [{ type: "text", text: typeof v?.data === "string" ? v.data : JSON.stringify(v) }] });

function log(ctx, m) {
  // 日志失败不能影响工具本身，文件写失败直接吞掉
  try { fs.appendFileSync(path.join(DS, "data", "ps-tools.log"), new Date().toISOString() + " " + m + "\n"); } catch {}
  ctx.logger?.info?.("[ps] " + m);
}

function baseUrl() {
  try {
    const p = fs.readFileSync(path.join(DS, "data", "port.txt"), "utf8").trim();
    if (p) return "http://127.0.0.1:" + p;
  } catch {}
  return "http://127.0.0.1:8792";
}

function keys() {
  try { return JSON.parse(fs.readFileSync(path.join(DS, "data", "people.json"), "utf8")); } catch { return {}; }
}

function whoFromAgent(agent) {
  const id = String(agent?.id || "");
  if (/onebot-private/i.test(id)) return "me";
  return id ? "daman" : "me";
}

async function call(who, pathname, { method = "GET", body, query } = {}) {
  const p = keys()[who];
  const key = p && p.key ? p.key : "";
  if (!key) throw new Error("no key for account " + who);
  let url = baseUrl() + pathname;
  const qs = new URLSearchParams({ who, key, ...(query || {}) });
  url += (url.includes("?") ? "&" : "?") + qs.toString();
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify({ who, key, ...body }) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  const txt = await res.text();
  let data;
  try { data = JSON.parse(txt); } catch { data = { ok: false, error: "non-json response", raw: txt.slice(0, 400) }; }
  if (!res.ok && data && data.ok === undefined) data.ok = false;
  return { status: res.status, data };
}

const params = (props, required = []) => ({ type: "object", additionalProperties: false, properties: props, required });

export function apply(ctx) {
  const register = (def) => {
    try { ctx.tools.register(def); }
    catch (e) { log("register failed " + def.name + ": " + (e?.message || e)); return; }
    log("registered " + def.name);
  };

  register({
    name: "project_open",
    description: "项目空间入口：不传 project 时列出所有项目；传 project 时返回该项目的引导索引（规则、待办、待决问题、近期决策）。新会话冷启动先用它。",
    parameters: params({ project: { type: "string", description: "项目 id 或 slug，可省略" } }),
    output: jsonOut(OUT),
    execute: async (args, exec) => {
      const who = whoFromAgent(exec?.agent);
      try {
        if (!args.project) {
          const r = await call(who, "/api/projects");
          const list = (r.data.projects || []).map((p) => `${p.id}  ${p.title}  [${p.status}]  ${p.updatedAt}`).join("\n");
          return { ok: r.data.ok !== false, data: `项目（${(r.data.projects || []).length}）：\n${list || "（空）"}` };
        }
        const [idx, st] = await Promise.all([
          call(who, `/api/projects/${encodeURIComponent(args.project)}/index`),
          call(who, `/api/projects/${encodeURIComponent(args.project)}/state`),
        ]);
        if (idx.status >= 400) return { ok: false, data: `打开失败 ${idx.status}: ${JSON.stringify(idx.data)}` };
        const i = idx.data.index || {};
        const s = st.data.state || {};
        const lines = [];
        lines.push(`项目：${args.project}`);
        lines.push(`规则（${(i.rules || []).length}）：`);
        for (const r of i.rules || []) lines.push("  - " + (r.text || r));
        lines.push(`进行中任务（${(s.activeTasks || []).length}）：`);
        for (const t of s.activeTasks || []) lines.push(`  - ${t.taskId || t.id} [${t.state || "?"}] ${t.text || ""}`);
        lines.push(`待决问题（${(s.openQuestions || []).length}）：`);
        for (const q of s.openQuestions || []) lines.push("  - " + (q.text || q));
        lines.push(`近期决策（${(s.recentDecisions || []).length}）：`);
        for (const d of s.recentDecisions || []) lines.push("  - " + (d.text || d));
        lines.push(`cursor=${i.cursor || s.cursor || "-"}`);
        return { ok: true, data: lines.join("\n") };
      } catch (e) { return { ok: false, data: "project_open 失败: " + (e?.message || e) }; }
    },
  });

  register({
    name: "project_rules",
    description: "读取项目规则（kind=rule 且 active）。动手前先读一遍，避免违反项目约定。",
    parameters: params({ project: { type: "string", description: "项目 id" } }, ["project"]),
    output: jsonOut(OUT),
    execute: async (args, exec) => {
      const who = whoFromAgent(exec?.agent);
      try {
        const r = await call(who, `/api/projects/${encodeURIComponent(args.project)}/memory`, { query: { kind: "rule", limit: "100" } });
        const rows = (r.data.memories || []).filter((m) => m.status !== "superseded");
        if (!rows.length) return { ok: true, data: `（项目 ${args.project} 暂无规则）` };
        return { ok: true, data: rows.map((m) => `- [${m.id}] ${m.text}`).join("\n") };
      } catch (e) { return { ok: false, data: "project_rules 失败: " + (e?.message || e) }; }
    },
  });

  register({
    name: "project_memory_recall",
    description: "按关键词/类型检索项目记忆。返回带 id 的条目，可用于 supersede。",
    parameters: params({
      project: { type: "string", description: "项目 id" },
      q: { type: "string", description: "关键词（可省略）" },
      kind: { type: "string", description: "rule/decision/fact/task/open-question/summary，可省略" },
      limit: { type: "number", description: "最多返回条数，默认 20" },
    }, ["project"]),
    output: jsonOut(OUT),
    execute: async (args, exec) => {
      const who = whoFromAgent(exec?.agent);
      try {
        const q = { limit: String(args.limit || 20) };
        if (args.q) q.q = args.q;
        if (args.kind) q.kind = args.kind;
        const r = await call(who, `/api/projects/${encodeURIComponent(args.project)}/memory`, { query: q });
        const rows = (r.data.memories || []).filter((m) => m.status !== "superseded");
        if (!rows.length) return { ok: true, data: "（没有命中）" };
        return {
          ok: true,
          data: rows.map((m) => `[${m.id}] ${m.kind} ${m.createdAt.slice(0, 16)} ${m.text}`).join("\n"),
        };
      } catch (e) { return { ok: false, data: "memory_recall 失败: " + (e?.message || e) }; }
    },
  });

  register({
    name: "project_memory_save",
    description: "把一条值得跨会话保留的事实/决策/规则写进项目记忆。重复内容会返回 409 与已有 id，不要重复写。",
    parameters: params({
      project: { type: "string", description: "项目 id" },
      kind: { type: "string", description: "rule/decision/fact/task/open-question/summary，默认 fact" },
      text: { type: "string", description: "一句话，可独立读懂" },
      evidence: { type: "string", description: "证据（文件路径/命令/链接），可省略" },
      taskId: { type: "string", description: "kind=task 时的任务号，可省略" },
      state: { type: "string", description: "kind=task 时的状态 todo/doing/blocked/done，可省略" },
    }, ["project", "text"]),
    output: jsonOut(OUT),
    execute: async (args, exec) => {
      const who = whoFromAgent(exec?.agent);
      try {
        const body = {
          kind: args.kind || "fact",
          text: args.text,
          evidence: args.evidence || "",
          tags: Array.isArray(args.tags) ? args.tags : [],
          end: /onebot/i.test(String(exec?.agent?.id || "")) ? "qq" : "desktop",
          sessionId: String(exec?.agent?.id || ""),
        };
        if (args.taskId) body.taskId = args.taskId;
        if (args.state) body.state = args.state;
        const r = await call(who, `/api/projects/${encodeURIComponent(args.project)}/memory`, { method: "POST", body });
        if (r.status === 409) return { ok: true, data: `已存在（未重复写入）：${r.data.id}` };
        if (r.status >= 400) return { ok: false, data: `写入失败 ${r.status}: ${JSON.stringify(r.data)}` };
        return { ok: true, data: `已写入 ${r.data.id}（${body.kind}）` };
      } catch (e) { return { ok: false, data: "memory_save 失败: " + (e?.message || e) }; }
    },
  });

  register({
    name: "project_state",
    description: "项目的紧凑状态：进行中任务、待决问题、最近决策、cursor。用于快速对齐而不拉全文。",
    parameters: params({ project: { type: "string", description: "项目 id" } }, ["project"]),
    output: jsonOut(OUT),
    execute: async (args, exec) => {
      const who = whoFromAgent(exec?.agent);
      try {
        const r = await call(who, `/api/projects/${encodeURIComponent(args.project)}/state`);
        if (r.status >= 400) return { ok: false, data: `读取失败 ${r.status}: ${JSON.stringify(r.data)}` };
        const s = r.data.state || {};
        const lines = [`项目 ${s.projectId}`];
        lines.push(`任务 ${(s.activeTasks || []).length}：` + (s.activeTasks || []).map((t) => `${t.taskId || t.id}:${t.state || "?"}`).join(", "));
        lines.push(`待决 ${(s.openQuestions || []).length}：` + (s.openQuestions || []).map((q) => q.id).join(", "));
        lines.push(`近期决策 ${(s.recentDecisions || []).length}，cursor=${s.cursor || "-"}`);
        return { ok: true, data: lines.join("\n") };
      } catch (e) { return { ok: false, data: "project_state 失败: " + (e?.message || e) }; }
    },
  });
}
