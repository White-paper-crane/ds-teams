#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = path.join(ROOT, 'progress.md');

const COLUMNS = ['id', '任务', 'owner', '状态', '证据', '下一步', '心跳(UTC)', '黄灯'];
const STATUSES = ['todo', 'doing', 'blocked', 'done'];
const YELLOW_MS = 10 * 60 * 1000;

const die = (msg) => {
  console.error(`[progress] ${msg}`);
  process.exit(1);
};

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

const isSeparator = (line) => /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line.trim());

const esc = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();

const canon = (h) => {
  const s = h
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/\s+/g, '')
    .replace(/[?？]/g, '');
  return s === '心跳' || s === '心跳UTC' ? '心跳(UTC)' : s;
};

function cellWidth(str) {
  let w = 0;
  for (const ch of String(str)) {
    const c = ch.codePointAt(0);
    const wide =
      c >= 0x1100 &&
      (c <= 0x115f ||
        c === 0x2329 ||
        c === 0x232a ||
        (c >= 0x2e80 && c <= 0xa4cf) ||
        (c >= 0xac00 && c <= 0xd7a3) ||
        (c >= 0xf900 && c <= 0xfaff) ||
        (c >= 0xfe30 && c <= 0xfe6f) ||
        (c >= 0xff00 && c <= 0xff60) ||
        (c >= 0xffe0 && c <= 0xffe6));
    w += wide ? 2 : 1;
  }
  return w;
}

const pad = (str, width) => String(str) + ' '.repeat(Math.max(0, width - cellWidth(str)));

const colWidths = (doc) => doc.keys.map((_, i) =>
  Math.max(3, cellWidth(doc.display[i]), ...doc.rows.map((r) => cellWidth(r[doc.keys[i]] ?? ''))));
const rowLine = (widths) => (cells) => `| ${cells.map((c, i) => pad(c, widths[i])).join(' | ')} |`;
const ruleLine = (widths) => `|${widths.map((w) => ` ${'-'.repeat(w)} `).join('|')}|`;

function load() {
  let text;
  try {
    text = readFileSync(FILE, 'utf8');
  } catch (e) {
    die(`读不到 ${FILE}：${e.message}`);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/);

  let headerIdx = -1;
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].trim().startsWith('|')) continue;
    const cells = splitRow(lines[i]);
    if (cells[0].toLowerCase() !== 'id') continue;
    if (!isSeparator(lines[i + 1])) continue;
    headerIdx = i;
    break;
  }
  if (headerIdx === -1) die('progress.md 里找不到以 | id | 开头的账本表格');

  const display = splitRow(lines[headerIdx]);
  const keys = display.map(canon);
  const missing = COLUMNS.filter((c) => !keys.includes(c));
  if (missing.length) die(`账本缺列：${missing.join(' / ')}`);

  let endIdx = headerIdx + 2;
  const rows = [];
  while (endIdx < lines.length && lines[endIdx].trim().startsWith('|')) {
    const cells = splitRow(lines[endIdx]);
    const row = {};
    keys.forEach((k, i) => (row[k] = cells[i] ?? ''));
    rows.push(row);
    endIdx++;
  }
  return { lines, headerIdx, endIdx, display, keys, rows };
}

function save(doc) {
  const widths = colWidths(doc);
  const line = rowLine(widths);
  const table = [
    line(doc.display),
    ruleLine(widths),
    ...doc.rows.map((r) => line(doc.keys.map((k) => esc(r[k] ?? '')))),
  ];
  const out = [...doc.lines.slice(0, doc.headerIdx), ...table, ...doc.lines.slice(doc.endIdx)].join('\n');
  writeFileSync(FILE, out, 'utf8');
}

function parseHeartbeat(value) {
  const s = String(value ?? '').trim();
  if (!s) return NaN;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Date.parse(`${s}T00:00:00Z`);
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(s)) return Date.parse(`${s.replace(' ', 'T')}:00Z`);
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(s)) return Date.parse(`${s.replace(' ', 'T')}Z`);
  return Date.parse(s);
}

const nowUtc = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

function yellowOf(row, now = Date.now()) {
  if (String(row['状态'] ?? '').trim().toLowerCase() !== 'doing') return 'NO';
  const t = parseHeartbeat(row['心跳(UTC)']);
  return Number.isFinite(t) && now - t <= YELLOW_MS ? 'NO' : 'YES';
}

const isBlockedReason = (row) => /^\s*阻塞[:：]/.test(String(row['下一步'] ?? ''));

function freshRow(values) {
  const row = Object.fromEntries(COLUMNS.map((c) => [c, '']));
  Object.assign(row, values);
  row['心跳(UTC)'] = nowUtc();
  row['黄灯'] = yellowOf(row);
  return row;
}

function parseFlags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = args[++i];
      if (val === undefined || val.startsWith('--')) die(`参数 --${key} 缺少值`);
      out[key] = val;
    } else {
      out._.push(a);
    }
  }
  return out;
}

const usage = () => {
  console.log(`用法：
  node scripts/progress.mjs list
  node scripts/progress.mjs set <id> [--status todo|doing|blocked|done] [--owner 谁] [--task 任务]
                                [--next 下一步] [--evidence 证据] [--reason 阻塞原因]
  node scripts/progress.mjs add <id> --task "任务" --owner 谁 [--status todo]
                                [--next 下一步] [--evidence 证据] [--reason 阻塞原因]`);
};

function cmdList() {
  const doc = load();
  const now = Date.now();
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of doc.rows) {
    const s = String(r['状态']).toLowerCase();
    if (counts[s] !== undefined) counts[s]++;
  }

  const widths = colWidths(doc);
  const line = rowLine(widths);

  console.log(
    `节点账本：${doc.rows.length} 行（` +
      `todo ${counts.todo} / doing ${counts.doing} / blocked ${counts.blocked} / done ${counts.done}）` +
      ' · 黄灯按当前时间实时算',
  );
  console.log(line(doc.display));
  console.log(ruleLine(widths));
  for (const r of doc.rows) {
    const cells = doc.keys.map((k) => (k === '黄灯' ? yellowOf(r, now) : r[k] ?? ''));
    console.log(line(cells));
  }

  const yellow = doc.rows.filter((r) => yellowOf(r, now) === 'YES');
  console.log('');
  if (!yellow.length) {
    console.log('黄灯节点：无');
  } else {
    console.log(`黄灯节点：${yellow.length} 个（doing 且心跳超过 10 分钟，需在群里点名）`);
    for (const r of yellow) {
      const t = parseHeartbeat(r['心跳(UTC)']);
      const mins = Number.isFinite(t) ? Math.floor((now - t) / 60000) : '?';
      console.log(`- ${r.id} ${r['任务']}（owner=${r.owner}，心跳 ${r['心跳(UTC)']}，已 ${mins} 分钟）`);
    }
  }

  const noReason = doc.rows.filter(
    (r) => String(r['状态']).toLowerCase() === 'blocked' && !isBlockedReason(r),
  );
  for (const r of noReason) console.log(`⚠ ${r.id} 状态 blocked 但没写阻塞原因`);
}

function cmdSet(argv) {
  const flags = parseFlags(argv);
  const id = flags._[0];
  if (!id) die('set 需要节点 id');
  const doc = load();
  const row = doc.rows.find((r) => r.id === id);
  if (!row) die(`账本里没有 id=${id}`);

  const status = flags.status ? flags.status.toLowerCase() : null;
  if (status && !STATUSES.includes(status)) die(`状态只能是 ${STATUSES.join(' / ')}`);

  const FIELD = { owner: 'owner', task: '任务', next: '下一步', evidence: '证据' };
  for (const k of Object.keys(FIELD)) {
    if (flags[k] !== undefined) row[FIELD[k]] = flags[k];
  }
  if (flags.reason !== undefined) row['下一步'] = `阻塞：${flags.reason}`;
  if (status) row['状态'] = status;
  if (status && status !== 'blocked' && flags.next === undefined && isBlockedReason(row)) {
    row['下一步'] = '';
  }
  if (row['状态'] === 'blocked' && !isBlockedReason(row)) {
    die('blocked 必须写阻塞原因：--reason "卡在哪"');
  }
  row['心跳(UTC)'] = nowUtc();
  row['黄灯'] = yellowOf(row);
  save(doc);
  console.log(`✅ set ${id} → ${row['状态']} · owner=${row.owner} · 心跳=${row['心跳(UTC)']} · 黄灯=${row['黄灯']}`);
}

function cmdAdd(argv) {
  const flags = parseFlags(argv);
  const id = flags._[0];
  if (!id) die('add 需要节点 id');
  if (!flags.task) die('add 需要 --task "任务"');
  if (!flags.owner) die('add 需要 --owner 谁');
  const doc = load();
  if (doc.rows.some((r) => r.id === id)) die(`id=${id} 已存在`);

  const status = (flags.status ?? 'todo').toLowerCase();
  if (!STATUSES.includes(status)) die(`状态只能是 ${STATUSES.join(' / ')}`);

  const row = freshRow({
    id,
    任务: flags.task,
    owner: flags.owner,
    状态: status,
    证据: flags.evidence ?? '',
    下一步: flags.reason !== undefined ? `阻塞：${flags.reason}` : flags.next ?? '',
  });
  if (status === 'blocked' && flags.reason === undefined) {
    die('blocked 必须写阻塞原因：--reason "卡在哪"');
  }
  doc.rows.push(row);
  save(doc);
  console.log(`✅ add ${id} · ${status} · owner=${row.owner} · 心跳=${row['心跳(UTC)']}`);
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'list':
    cmdList();
    break;
  case 'set':
    cmdSet(rest);
    break;
  case 'add':
    cmdAdd(rest);
    break;
  case undefined:
  case '-h':
  case '--help':
  case 'help':
    usage();
    break;
  default:
    die(`未知命令 ${cmd}`);
}
