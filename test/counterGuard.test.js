"use strict";

// Self-test for the real-counter guard in helpers.js.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { REAL_COUNTER_FILE, isRealCounterPath, forbidRealCounterFile, tempCounterFile, tempDir } = require("./helpers");

const guard = forbidRealCounterFile();

test("the guard recognises the real counter file, its lock and temp files, and nothing else", () => {
  assert.strictEqual(path.dirname(REAL_COUNTER_FILE), path.join(__dirname, ".."));
  for (const p of [REAL_COUNTER_FILE, `${REAL_COUNTER_FILE}.lock`, `${REAL_COUNTER_FILE}.123.tmp`, path.relative(process.cwd(), REAL_COUNTER_FILE) || REAL_COUNTER_FILE]) {
    assert.strictEqual(isRealCounterPath(p), true, p);
  }
  const temp = tempCounterFile(null);
  assert.strictEqual(path.basename(temp), path.basename(REAL_COUNTER_FILE));
  for (const p of [temp, `${temp}.lock`, `${REAL_COUNTER_FILE}x`, path.dirname(REAL_COUNTER_FILE), undefined, 3]) {
    assert.strictEqual(isRealCounterPath(p), false, String(p));
  }
});

test("a guarded fs call on the real file throws and is recorded", () => {
  const before = guard.violations.length;
  assert.throws(() => fs.readFileSync(REAL_COUNTER_FILE), /real counter file via fs\.readFileSync/);
  assert.throws(() => fs.openSync(`${REAL_COUNTER_FILE}.lock`, "wx"), /fs\.openSync/);
  assert.throws(() => fs.renameSync(path.join(tempDir(), "x"), REAL_COUNTER_FILE), /fs\.renameSync/);
  assert.deepStrictEqual(guard.violations.slice(before), ["fs.readFileSync", "fs.openSync", "fs.renameSync"]);
  // Deliberate violations in this self-test only; clear them so the final check passes.
  guard.violations.splice(before);
});

test("installing the guard twice is harmless", () => {
  assert.strictEqual(forbidRealCounterFile(), guard);
});
