// ds-teams 命令行：给 agent 用的最小客户端（零依赖）
// 用法（--who 必填，身份不能猜）：
//   node say.mjs rooms --who me
//   node say.mjs say <roomId> "文本" --who me [--quote <seq>]
//   node say.mjs recall <roomId> <seq> --who me      （撤回自己的消息；群主可撤任何人的）
//   node say.mjs progress <roomId> --task t1 --percent 40 "一句话"
//   node say.mjs task <roomId> --task t1 [--assignee me] [--deadline ISO] "任务说明"
//   node say.mjs file <roomId> <路径> [--note "说明"] [--quote <seq>]
//   node say.mjs report <roomId> --task t1 --title "标题" --status done --links a.md,b.md "三行结论" [--noreview]
//   node say.mjs review <roomId> [--verdict pass|issues] "结论/证据/改法"
//   node say.mjs read <roomId>
//   node say.mjs memory <roomId> --text "记一条" --who me    （房间记忆；--list 查看）
//   node say.mjs new "任务名"
//   node say.mjs close <roomId>          （拒绝代群主解散；解散只能在网页操作）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MESSAGE_KINDS, OWNER } from "./protocol.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, "data");
const port = (fs.existsSync(path.join(DATA, "port.txt")) ? fs.readFileSync(path.join(DATA, "port.txt"), "utf8") : "").trim() || "8792";
const key = (fs.existsSync(path.join(DATA, "key.txt")) ? fs.readFileSync(path.join(DATA, "key.txt"), "utf8") : "").trim();
const base = `http://127.0.0.1:${port}`;

const args = process.argv.slice(2);
const WHO = (() => { const i = args.indexOf("--who"); return i >= 0 ? String(args[i + 1] || "") : ""; })();
if (!WHO) { console.error("缺少 --who <me|daman>：身份必须显式声明，猜成默认值会冒名发言。"); process.exit(2); }
if (WHO === OWNER) { console.error("拒绝：agent 不能以群主（you）身份发言；如需以你身份发，请在网页里发。"); process.exit(2); }
const MKEYS = (() => {
  try {
    const ppl = JSON.parse(fs.readFileSync(path.join(DATA, "people.json"), "utf8"));
    const out = {};
    for (const [id, p] of Object.entries(ppl)) out[id] = p.key;
    return out;
  } catch { try { return JSON.parse(fs.readFileSync(path.join(DATA, "members.json"), "utf8")); } catch { return {}; } }
})();
const cmd = args[0] || "rooms";

function flag(name, dflt = "") {
  const i = args.indexOf("--" + name);
  return i >= 0 ? String(args[i + 1] ?? dflt) : dflt;
}
function positional(n) {
  // 跳过 cmd 与所有 --flag 值
  const out = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith("--")) { i++; continue; }
    out.push(args[i]);
  }
  return out[n] ?? "";
}

// CLI 子命令 → 发送的消息 kind；发请求前先按 protocol.mjs 校验。
const CMD_KINDS = Object.freeze({
  say: "text",
  task: "task",
  progress: "progress",
  report: "report",
  review: "review",
  file: "file",
});

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

// 可选 --kind：只允许对外 8 个 kind；未给则按命令映射。
const EXPLICIT_KIND = flag("kind").trim();
if (EXPLICIT_KIND && !MESSAGE_KINDS.includes(EXPLICIT_KIND)) {
  fail(`unknown kind: ${EXPLICIT_KIND}; allowed: ${MESSAGE_KINDS.join(", ")}`);
}

function assertKind(cmdName) {
  const kind = EXPLICIT_KIND || CMD_KINDS[cmdName];
  if (!kind || !MESSAGE_KINDS.includes(kind)) {
    fail(`unknown kind: ${kind || cmdName}; allowed: ${MESSAGE_KINDS.join(", ")}`);
  }
  return kind;
}

function requireText(cmdName, value) {
  if (!String(value || "").trim()) {
    fail(`${cmdName} 缺少文本；用法：node say.mjs ${cmdName} <roomId> "文本" --who me`);
  }
}

async function call(method, p, body) {
  // 平台 key（k）只是进门；读接口还要认「看的人是谁」，不然 viewerOf 拿不到身份，
  // GET /api/rooms 直接回空列表、GET /api/rooms/<id> 回 403 not a member。
  const idq = WHO ? `&who=${encodeURIComponent(WHO)}${MKEYS[WHO] ? `&mk=${encodeURIComponent(MKEYS[WHO])}` : ""}` : "";
  const r = await fetch(`${base}${p}${p.includes("?") ? "&" : "?"}k=${key}${idq}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error(`HTTP ${r.status}`, JSON.stringify(j)); process.exit(3); }
  return j;
}

const roomId = positional(0);
const text = positional(1);

try {
  if (cmd === "rooms") {
    const j = await call("GET", "/api/rooms");
    for (const r of j.rooms) console.log(`${r.id}  [${r.status}] ${r.title}  msgs=${r.messageCount} reports=${r.reportCount}`);
  } else if (cmd === "new") {
    const j = await call("POST", "/api/rooms", { title: positional(0) || "未命名任务", by: WHO, declaredBy: WHO, key: MKEYS[WHO] });
    console.log(`created ${j.room.id}\nhttp://127.0.0.1:${port}/?k=${key}`);
  } else if (cmd === "say") {
    const kind = assertKind("say");
    requireText("say", text);
    const j = await call("POST", `/api/rooms/${roomId}/say`, { who: WHO, key: MKEYS[WHO], kind, text, quoteSeq: Number(flag("quote", "0")), msgId: flag("msgid") || "" });
    console.log(`sent #${j.message.seq}`);
  } else if (cmd === "task") {
    const kind = assertKind("task");
    const taskId = flag("task").trim();
    if (!taskId) fail("task 缺少 --task <taskId>；用法：node say.mjs task <roomId> --task t1 \"说明\" --who me");
    requireText("task", text);
    const j = await call("POST", `/api/rooms/${roomId}/task`, {
      who: WHO, key: MKEYS[WHO], kind, taskId, text,
      assignee: flag("assignee"), deadlineAt: flag("deadline"), msgId: flag("msgid") || "",
    });
    console.log(`sent #${j.message.seq}`);
  } else if (cmd === "progress") {
    const kind = assertKind("progress");
    const taskId = flag("task").trim();
    if (!taskId) fail("progress 缺少 --task <taskId>；用法：node say.mjs progress <roomId> --task t1 --percent 40 \"一句话\" --who me");
    requireText("progress", text);
    const j = await call("POST", `/api/rooms/${roomId}/progress`, { who: WHO, key: MKEYS[WHO], kind, text, taskId, percent: Number(flag("percent", "-1")) });
    console.log(`sent #${j.message.seq}`);
  } else if (cmd === "report") {
    const kind = assertKind("report");
    const taskId = flag("task").trim();
    if (!taskId) fail("report 缺少 --task <taskId>；用法：node say.mjs report <roomId> --task t1 \"结论\" --who me");
    requireText("report", text);
    const j = await call("POST", `/api/rooms/${roomId}/report`, {
      who: WHO, key: MKEYS[WHO], kind, taskId, title: flag("title", "报告"), status: flag("status", "done"),
      links: flag("links") ? flag("links").split(",").map((s) => s.trim()).filter(Boolean) : [], summary: text,
      noreview: args.includes("--noreview"), // 会议室逃生口：--noreview 交活但不触发对方评审
    });
    console.log(`sent #${j.message.seq}`);
  } else if (cmd === "review") {
    const kind = assertKind("review");
    requireText("review", text);
    const verdict = flag("verdict", "").trim();
    if (verdict && !["pass", "issues"].includes(verdict)) fail("--verdict 只接受 pass|issues；评审通过用 pass，有意见用 issues");
    const j = await call("POST", `/api/rooms/${roomId}/review`, { who: WHO, key: MKEYS[WHO], kind, target: flag("target", "all"), text, verdict });
    console.log(`sent #${j.message.seq}`);
  } else if (cmd === "file") {
    const kind = assertKind("file");
    const p = path.resolve(positional(1));
    if (!fs.existsSync(p)) { console.error("找不到文件：" + p); process.exit(2); }
    const st = fs.statSync(p);
    if (st.size > 25 * 1024 * 1024) { console.error("文件超过 25MB"); process.exit(2); }
    const ext = path.extname(p).toLowerCase();
    const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp",
      ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json", ".zip": "application/zip" };
    if (!MIME[ext]) { console.error("不支持的类型（不收视频）：" + ext); process.exit(2); }
    const data = fs.readFileSync(p).toString("base64");
    const j = await call("POST", `/api/rooms/${roomId}/file`, { who: WHO, key: MKEYS[WHO], kind, name: path.basename(p), mime: MIME[ext], data, note: flag("note"), quoteSeq: Number(flag("quote", "0")) });
    console.log(`sent #${j.message.seq} ${j.file.name} ${j.file.size}B`);
  } else if (cmd === "recall") {
    const seq = Number(positional(1));
    if (!seq) { console.error("用法：node say.mjs recall <roomId> <seq> --who me"); process.exit(2); }
    const j = await call("POST", `/api/rooms/${roomId}/recall`, { who: WHO, key: MKEYS[WHO], seq });
    console.log(`recalled #${j.message.seq}` + (j.message.recalled ? "" : "（已是撤回状态）"));
  } else if (cmd === "close") {
    // 解散只有群主能做：CLI 不提供群主身份，请群主在网页上点「解散」
    console.error("拒绝：解散只能由群主在网页上操作（say.mjs 不代群主解散房间）");
    process.exit(2);
  } else if (cmd === "read") {
    const j = await call("GET", `/api/rooms/${roomId}`);
    console.log(`# ${j.room.title} [${j.room.status}]`);
    for (const m of j.messages.slice(-25)) {
      const tag = m.kind === "text" ? "" : ` (${m.kind}${m.taskId ? " " + m.taskId : ""})`;
      const quoted = m.quote ? ` ↪#${m.quote.seq}` : "";
      const body = m.recalled ? "[已撤回]" : String(m.text).replace(/\s+/g, " ").slice(0, 200);
      console.log(`[${m.seq}] ${(m.ts || "").slice(11, 16)} ${m.who}${tag}${quoted}: ${body}`);
    }
  } else if (cmd === "memory") {
    const listMode = args.includes("--list");
    const memText = String(flag("text") || "");
    if (listMode) {
      const j = await call("GET", `/api/rooms/${roomId}/memory`);
      console.log(`# ${j.roomId} 记忆 ${j.count} 条`);
      for (const e of j.entries || []) {
        const body = String(e.text || "").replace(/\s+/g, " ").slice(0, 200);
        console.log(`[${(e.ts || "").slice(0, 19)}] ${e.by}: ${body}`);
      }
    } else {
      if (!memText.trim()) {
        console.error('memory 需要 --text "内容" 或 --list；用法：node say.mjs memory <roomId> [--text "..."] [--list] --who me');
        process.exit(2);
      }
      const j = await call("POST", `/api/rooms/${roomId}/memory`, { who: WHO, key: MKEYS[WHO], text: memText });
      console.log(`memory saved（共 ${j.count} 条）`);
    }
  } else {
    console.error(`未知命令：${cmd}；合法命令: rooms,new,say,task,progress,report,review,file,recall,close,read,memory；消息 kind: ${MESSAGE_KINDS.join(", ")}`);
    process.exit(2);
  }
} catch (e) {
  console.error("失败:", e && e.message ? e.message : e);
  process.exit(1);
}
