import test from "node:test";
import assert from "node:assert/strict";
import { isInScope, normalizeRel, parsePorcelain } from "../scope-lib.mjs";

test("normalizeRel：反斜杠、./ 与末尾斜杠", () => {
  assert.equal(normalizeRel(".\\reports\\a.md/"), "reports/a.md");
  assert.equal(normalizeRel("./tmp/x"), "tmp/x");
});

test("parsePorcelain：修改、未跟踪、重命名取新路径", () => {
  const rows = parsePorcelain([" M control.mjs", "?? reports/new.md", "R  old/a.mjs -> new/a.mjs", ""].join("\n"));
  assert.deepEqual(rows.map((r) => r.path), ["control.mjs", "reports/new.md", "new/a.mjs"]);
});

test("isInScope：文件与目录前缀，禁止同名前缀误判", () => {
  assert.equal(isInScope("reports/a.md", ["reports"]), true);
  assert.equal(isInScope("reports", ["reports/"]), true);
  assert.equal(isInScope("reports2/a.md", ["reports"]), false);
  assert.equal(isInScope("control.mjs", ["reports"]), false);
});

test("isInScope：空 scope 一律不放行", () => {
  assert.equal(isInScope("x", []), false);
  assert.equal(isInScope("x", [""]), false);
});
