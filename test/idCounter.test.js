"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const ids = require("../bot/idCounter");
const { REAL_COUNTER_FILE, tempCounterFile, forbidRealCounterFile } = require("./helpers");

// This file must never touch the repository's real counter file.
forbidRealCounterFile();

const START = { OPP: 1, SPEC: 0, WP: 0, EVD: 0, REL: 0 };

// A temporary counter file; the repository's real file is never touched.
const counterFile = (content = START) => tempCounterFile(content);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

// Fake read adapter: IDs in `existing` are found; `trashed` are found and
// trashed; `duplicates` are duplicated; everything else is not found.
function fakeReader({ existing = [], trashed = [], duplicates = [], fail, delayMs = 0 } = {}) {
  const calls = [];
  return {
    calls,
    findByUretId: async (type, id, opts) => {
      calls.push({ type, id, opts });
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (fail) throw fail;
      if (duplicates.includes(id)) return { result: "duplicate", page: null, trashed: false };
      if (existing.includes(id) || trashed.includes(id)) return { result: "found", page: {}, trashed: trashed.includes(id) };
      return { result: "not_found", page: null, trashed: false };
    },
  };
}

const labelled = (label) => Object.assign(new Error(`Notion read failed (${label})`), { label });

async function rejectsWithReason(promise, reason) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof ids.IdCounterError, `unexpected ${err && err.name}`);
    assert.strictEqual(err.label, "id_counter_failed");
    assert.strictEqual(err.reason, reason);
    return true;
  });
}

test("the default counter file is the repository's counter file", () => {
  assert.strictEqual(ids.DEFAULT_FILE, REAL_COUNTER_FILE);
  assert.strictEqual(path.dirname(ids.DEFAULT_FILE), path.join(__dirname, ".."));
});

test("reserveNextId increments and returns zero-padded IDs", async () => {
  const file = counterFile();
  const reader = fakeReader();
  assert.strictEqual(await ids.reserveNextId("opp", reader, { file }), "OPP-002");
  assert.strictEqual(await ids.reserveNextId("opp", reader, { file }), "OPP-003");
  assert.strictEqual(ids.readCounter("opp", { file }), 3);
  assert.deepStrictEqual(reader.calls.map((c) => [c.type, c.id]), [["opp", "OPP-002"], ["opp", "OPP-003"]]);
});

test("each type has its own counter", async () => {
  const file = counterFile();
  const reader = fakeReader();
  assert.strictEqual(await ids.reserveNextId("spec", reader, { file }), "SPEC-001");
  assert.strictEqual(await ids.reserveNextId("wp", reader, { file }), "WP-001");
  assert.strictEqual(await ids.reserveNextId("spec", reader, { file }), "SPEC-002");
  assert.strictEqual(await ids.reserveNextId("evd", reader, { file }), "EVD-001");
  assert.strictEqual(await ids.reserveNextId("rel", reader, { file }), "REL-001");
  assert.deepStrictEqual(readJson(file), { OPP: 1, SPEC: 2, WP: 1, EVD: 1, REL: 1 });
});

test("numbers above 999 keep growing", async () => {
  const file = counterFile({ ...START, OPP: 999 });
  assert.strictEqual(await ids.reserveNextId("opp", fakeReader(), { file }), "OPP-1000");
});

test("IDs that already exist in Notion are skipped, never reissued", async () => {
  const file = counterFile();
  const reader = fakeReader({ existing: ["OPP-002"], trashed: ["OPP-003"], duplicates: ["OPP-004"] });
  assert.strictEqual(await ids.reserveNextId("opp", reader, { file }), "OPP-005");
  assert.deepStrictEqual(reader.calls.map((c) => c.id), ["OPP-002", "OPP-003", "OPP-004", "OPP-005"]);
  assert.strictEqual(ids.readCounter("opp", { file }), 5);
});

test("a counter reset (for example after git checkout) cannot produce a duplicate", async () => {
  const file = counterFile({ ...START, OPP: 0 });
  const reader = fakeReader({ existing: ["OPP-001", "OPP-002", "OPP-003"] });
  assert.strictEqual(await ids.reserveNextId("opp", reader, { file }), "OPP-004");
});

test("no rollback: a reserved ID stays consumed even if it is never used", async () => {
  const file = counterFile();
  const reader = fakeReader();
  const first = await ids.reserveNextId("opp", reader, { file });
  // The caller's Notion create fails here; nothing is given back.
  const second = await ids.reserveNextId("opp", reader, { file });
  assert.deepStrictEqual([first, second], ["OPP-002", "OPP-003"]);
});

test("if Notion cannot be checked, nothing is reserved and the Notion error passes through", async () => {
  for (const label of ["notion_timeout", "notion_unavailable", "notion_unauthorized", "notion_source_not_found"]) {
    const file = counterFile();
    const before = fs.readFileSync(file, "utf8");
    const reader = fakeReader({ fail: labelled(label) });
    await assert.rejects(ids.reserveNextId("opp", reader, { file }), (err) => err.label === label);
    assert.strictEqual(fs.readFileSync(file, "utf8"), before, "counter changed without a verified ID");
    assert.strictEqual(fs.existsSync(`${file}.lock`), false, "lock not released");
  }
});

test("too many existing IDs in a row stops the search without writing", async () => {
  const file = counterFile();
  const reader = { calls: 0, findByUretId: async () => { reader.calls++; return { result: "found", page: {} }; } };
  await rejectsWithReason(ids.reserveNextId("opp", reader, { file }), "too_many_existing");
  assert.strictEqual(reader.calls, ids.MAX_SKIPS + 1);
  assert.deepStrictEqual(readJson(file), START);
});

test("concurrent reservations never share an ID: the second is refused while locked", async () => {
  const file = counterFile();
  const reader = fakeReader({ delayMs: 30 });
  const results = await Promise.allSettled([ids.reserveNextId("opp", reader, { file }), ids.reserveNextId("opp", reader, { file })]);
  assert.deepStrictEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.strictEqual(results.find((r) => r.status === "fulfilled").value, "OPP-002");
  assert.strictEqual(results.find((r) => r.status === "rejected").reason.reason, "locked");
  assert.strictEqual(await ids.reserveNextId("opp", reader, { file }), "OPP-003", "lock not released");
});

test("an existing lock (another run) is respected and left in place", async () => {
  const file = counterFile();
  fs.writeFileSync(`${file}.lock`, "12345 other run\n");
  const reader = fakeReader();
  await rejectsWithReason(ids.reserveNextId("opp", reader, { file }), "locked");
  assert.strictEqual(reader.calls.length, 0, "Notion checked without the lock");
  assert.strictEqual(fs.readFileSync(`${file}.lock`, "utf8"), "12345 other run\n", "someone else's lock was removed");
  assert.deepStrictEqual(readJson(file), START);
});

test("unknown types are refused before any lock, file or Notion access", async () => {
  const file = counterFile();
  const reader = fakeReader();
  for (const type of ["OPP", "spec2", "", undefined, "constructor", "__proto__"]) {
    await rejectsWithReason(ids.reserveNextId(type, reader, { file }), "unknown_type");
    assert.throws(() => ids.readCounter(type, { file }), (err) => err.reason === "unknown_type");
  }
  assert.strictEqual(reader.calls.length, 0);
  assert.strictEqual(fs.existsSync(`${file}.lock`), false);
});

test("a missing reader is refused", async () => {
  await rejectsWithReason(ids.reserveNextId("opp", null, { file: counterFile() }), "no_reader");
});

test("invalid counter files are refused and left untouched", async () => {
  const cases = [
    ["{not json", "unreadable"],
    ["[1,2]", "invalid"],
    [JSON.stringify({ ...START, OPP: -1 }), "invalid"],
    [JSON.stringify({ ...START, SPEC: 1.5 }), "invalid"],
    [JSON.stringify({ ...START, WP: "3" }), "invalid"],
  ];
  for (const [content, reason] of cases) {
    const file = counterFile(content);
    const reader = fakeReader();
    await rejectsWithReason(ids.reserveNextId("opp", reader, { file }), reason);
    assert.strictEqual(fs.readFileSync(file, "utf8"), content);
    assert.strictEqual(reader.calls.length, 0);
    assert.strictEqual(fs.existsSync(`${file}.lock`), false);
  }
});

test("a missing file or key counts as zero, as in the setup script", async () => {
  const missing = tempCounterFile(null);
  assert.strictEqual(await ids.reserveNextId("opp", fakeReader({ existing: ["OPP-001"] }), { file: missing }), "OPP-002");
  assert.deepStrictEqual(readJson(missing), { OPP: 2, SPEC: 0, WP: 0, EVD: 0, REL: 0 });
  const noRel = counterFile({ OPP: 1, SPEC: 0, WP: 0, EVD: 0 });
  assert.strictEqual(await ids.reserveNextId("rel", fakeReader(), { file: noRel }), "REL-001");
});

test("writes are atomic: same format, no temp file left, original kept if the write fails", async () => {
  const file = counterFile();
  await ids.reserveNextId("spec", fakeReader(), { file });
  assert.strictEqual(fs.readFileSync(file, "utf8"), JSON.stringify({ ...START, SPEC: 1 }, null, 2) + "\n");
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);

  // Block the temp file path so the write cannot happen.
  const blocked = counterFile();
  fs.mkdirSync(`${blocked}.${process.pid}.tmp`);
  const before = fs.readFileSync(blocked, "utf8");
  await rejectsWithReason(ids.reserveNextId("opp", fakeReader(), { file: blocked }), "write_failed");
  assert.strictEqual(fs.readFileSync(blocked, "utf8"), before, "original changed by a failed write");
  assert.strictEqual(fs.existsSync(`${blocked}.lock`), false, "lock not released after a failed write");
});

test("the stop signal is passed to every Notion check", async () => {
  const file = counterFile();
  const reader = fakeReader({ existing: ["OPP-002"] });
  const signal = new AbortController().signal;
  await ids.reserveNextId("opp", reader, { file, signal });
  assert.ok(reader.calls.length === 2 && reader.calls.every((c) => c.opts.signal === signal));
});

test("an aborted Notion check leaves the counter unchanged and releases the lock", async () => {
  const file = counterFile();
  await assert.rejects(ids.reserveNextId("opp", fakeReader({ fail: labelled("notion_aborted") }), { file }), (err) => err.label === "notion_aborted");
  assert.deepStrictEqual(readJson(file), START);
  assert.strictEqual(fs.existsSync(`${file}.lock`), false);
});
