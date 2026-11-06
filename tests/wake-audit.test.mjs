// wake-audit 对账核心纯函数夹具测试（零依赖，不读真实 .dsh / 服务端 / 任何真实文件）。
// 运行：node --test tests/wake-audit.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSessionTurns, normalizeWakes, buildDayView, reconcileDay, discoverMeSession } from "../tools/wake-audit.mjs";

const DAY = "2026-11-04";

function wake(over = {}) {
  return {
    wakeId: "w-1-daman-0001", at: DAY + "T09:00:00+08:00", who: "daman", seq: 100,
    roomId: "r1", kind: "text", allow: true, blockReason: null, outcome: null, outcomeAt: null, ...over,
  };
}

test("差值零 → exitCode 0", () => {
  const view = buildDayView({ wakes: [wake({}), wake({ wakeId: "w-2-me-0002", who: "me" })] }, DAY);
  const rec = reconcileDay({ date: DAY, view, turnDeltaBySide: { me: 1, daman: 1 } });
  assert.equal(rec.injectCount, 2);
  assert.equal(rec.turnDelta, 2);
  assert.equal(rec.diff, 0);
  assert.equal(rec.exitCode, 0);
});

test("inject > turnDelta → exitCode 1，列疑似丢失注入样本", () => {
  const wakes = [wake({}), wake({ wakeId: "w-2-me-0002", who: "me" }), wake({ wakeId: "w-3-daman-0003" })];
  const view = buildDayView({ wakes }, DAY);
  const rec = reconcileDay({ date: DAY, view, turnDeltaBySide: { me: 1, daman: 0 } });
  assert.equal(rec.injectCount, 3);
  assert.equal(rec.diff, 2);
  assert.equal(rec.exitCode, 1);
  assert.equal(rec.samples.length, 3);
  for (const s of rec.samples) {
    assert.ok(s.wakeId && s.at && s.who, "样本要带 wakeId/at/who");
    assert.equal(typeof s.seq, "number");
  }
});

test("turnDelta > inject → exitCode 1，列疑似未归因唤醒样本", () => {
  const view = buildDayView({ wakes: [wake({})] }, DAY);
  const rec = reconcileDay({ date: DAY, view, turnDeltaBySide: { me: 2, daman: 1 } });
  assert.equal(rec.injectCount, 1);
  assert.equal(rec.diff, -2);
  assert.equal(rec.exitCode, 1);
  assert.equal(rec.samples.length, 1);
});

test("turns 字段缺失 → 显式报错（不猜）", () => {
  const r = parseSessionTurns(JSON.stringify({ record: { rows: { sessionStats: { val: { steps: 5 } } } } }), "daman");
  assert.ok(r.error);
  assert.match(r.error, /turns 字段缺失/);
});

test("实测形状（record.rows.sessionStats）+ 旧形状（顶层 turns/usage）解析", () => {
  const cur = parseSessionTurns(JSON.stringify({
    version: 7,
    record: {
      identity: { createdAt: Date.now() },
      rows: {
        sessionStats: { val: { turns: 397, steps: 2561, lastTurn: 418 } },
        tokenUsage: { val: { totals: { cacheReadTokens: 123 } } },
      },
    },
  }), "daman");
  assert.equal(cur.turns, 397);
  assert.equal(cur.steps, 2561);
  assert.equal(cur.cacheRead, 123);
  assert.equal(cur.error, undefined);
  const old = parseSessionTurns(JSON.stringify({ turns: 348, steps: 2391, usage: { cacheRead: 42 } }), "me");
  assert.equal(old.turns, 348);
  assert.equal(old.steps, 2391);
  assert.equal(old.cacheRead, 42);
});

test("outcome 分布 / days 兜底（wakes 窗口被 500 条上限裁掉）", () => {
  const state = {
    days: { [DAY]: { me: { count: 2, blocked: 1 }, daman: { count: 1, blocked: 0 } } },
    wakes: [
      wake({ wakeId: "w-1-me-0001", who: "me", outcome: "REPLIED" }),
      wake({ wakeId: "w-2-me-0002", who: "me", allow: false, blockReason: "COUNT" }),
    ],
  };
  const view = buildDayView(state, DAY);
  assert.equal(view.injectCount, 3);      // days 快照兜底（wakes 窗口只 2 条）
  assert.equal(view.blockedCount, 1);
  assert.equal(view.fromDays, true);
  assert.equal(view.outcomes.REPLIED, 1);
  assert.equal(view.outcomes["未回填"], 0);
});

test("wakes 映射形态归一化 + 未回填统计", () => {
  const state = {
    wakes: {
      "w-1": wake({ wakeId: "w-1", outcome: null }),
      "w-2": wake({ wakeId: "w-2", who: "me", outcome: "MONOLOGUE" }),
    },
  };
  const view = buildDayView(state, DAY);
  assert.equal(view.injectCount, 2);
  assert.equal(view.outcomes["未回填"], 1);
  assert.equal(view.outcomes.MONOLOGUE, 1);
  assert.equal(normalizeWakes([{ wakeId: "x" }]).length, 1);
});

test("单端不可测 → 该端跳过不猜，可测端正常", () => {
  const view = buildDayView({ wakes: [wake({}), wake({ wakeId: "w-2-me-0002", who: "me" })] }, DAY);
  const rec = reconcileDay({ date: DAY, view, turnDeltaBySide: { me: 1, daman: null } });
  assert.equal(rec.bySide.me.diff, 0);
  assert.equal(rec.bySide.daman.diff, null);
  assert.ok(rec.notes.some((n) => n.includes("daman")), "不可测端要有说明");
  assert.equal(rec.exitCode, 0);
});

test("两端都不可测 → exitCode 0 但标注", () => {
  const view = buildDayView({ wakes: [] }, DAY);
  const rec = reconcileDay({ date: DAY, view, turnDeltaBySide: { me: null, daman: null } });
  assert.equal(rec.turnDelta, null);
  assert.equal(rec.exitCode, 0);
  assert.equal(rec.notes.length, 2);
});

test("剩余预算 / HIGH_CONTEXT_AGE 从 injectTotals 推导", () => {
  const state = { injectTotals: { me: 520, daman: 10 }, wakes: [wake({})] };
  const view = buildDayView(state, DAY);
  const rec = reconcileDay({ date: DAY, view, turnDeltaBySide: { me: 1, daman: 0 } });
  assert.equal(rec.remainingBudget, 199);
  assert.equal(view.highContextAge.me, true);
  assert.equal(view.highContextAge.daman, false);
});

test("小满会话发现：平铺文件按 mtime 最新；目录形态也支持；没有则 null", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-audit-"));
  try {
    assert.equal(discoverMeSession(dir), null);
    const a = path.join(dir, "onebot-private-0000000000-aaa.json");
    const b = path.join(dir, "onebot-private-0000000000-bbb.json");
    fs.writeFileSync(a, "{}");
    fs.writeFileSync(b, "{}");
    fs.utimesSync(a, new Date(), new Date(Date.now() - 5000));
    fs.utimesSync(b, new Date(), new Date());
    assert.equal(discoverMeSession(dir), b);
    const d = path.join(dir, "onebot-private-0000000000-ccc");
    fs.mkdirSync(d);
    const inner = path.join(d, "onebot-private-0000000000-ccc.json");
    fs.writeFileSync(inner, "{}");
    fs.utimesSync(inner, new Date(), new Date(Date.now() + 1000));
    assert.equal(discoverMeSession(dir), inner);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
