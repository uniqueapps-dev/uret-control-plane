"use strict";

// /status with the Phase 4 "Active work" section.

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { createRouter } = require("../bot/commands");
const { createSessionStore } = require("../bot/session");
const opp = require("../bot/opportunities");
const { tempDir, fakePageId } = require("./helpers");

const COUNTS = { outcome: "counts", total: 12, counts: { Idea: 4, Active: 3, Parked: 2, Done: 3 } };
const COUNTS_TEXT = "Notion: Connected\nTotal: 12\nIdea: 4\nActive: 3\nParked: 2\nDone: 3";

const labelled = (label) => Object.assign(new Error(`Notion read failed (${label})`), { label });

/**
 * Fake read adapter. `items` are the active Work Packages (in Notion's order);
 * `specs[pageId]` and `evidence[pageId]` answer the per-item reads.
 */
function fakeReader({ count = COUNTS, items = [], more = false, specs = {}, evidence = {}, onActive, onLinked, onEvidence } = {}) {
  const calls = [];
  return {
    calls,
    countByStatus: async (opts) => {
      calls.push({ method: "countByStatus", opts });
      if (typeof count === "function") return count();
      return count;
    },
    listActiveWork: async (opts) => {
      calls.push({ method: "listActiveWork", opts });
      if (onActive) return onActive();
      return { items, more };
    },
    findLinkedUretIds: async (type, relation, pageId, opts) => {
      calls.push({ method: "findLinkedUretIds", type, relation, pageId, opts });
      if (onLinked) return onLinked(pageId);
      return specs[pageId] || { uretIds: [], more: false };
    },
    countEvidenceForWP: async (pageId, opts) => {
      calls.push({ method: "countEvidenceForWP", pageId, opts });
      if (onEvidence) return onEvidence(pageId);
      return evidence[pageId] || { count: 0, incomplete: false };
    },
  };
}

function statusOf(reader, extra = {}) {
  const router = createRouter({
    sessions: createSessionStore(),
    configStatus: { TELEGRAM_BOT_TOKEN: "valid", TELEGRAM_ALLOWED_USER_ID: "valid" },
    logDir: path.join(tempDir(), "logs"),
    notion: reader,
  });
  return router.route({ text: "/status", chatId: 1, ...extra });
}

const item = (uretId, title) => ({ uretId, title, pageId: fakePageId() });

// --- Output format ------------------------------------------------------------------------

test("/status adds the active work after the counts, in the locked format", async () => {
  const a = item("WP-002", "Harden Bike Tracker prototype");
  const b = item("WP-003", "PBSRx offline mode");
  const reader = fakeReader({
    items: [a, b],
    specs: { [a.pageId]: { uretIds: ["SPEC-002"], more: false }, [b.pageId]: { uretIds: ["SPEC-003"], more: false } },
    evidence: { [a.pageId]: { count: 1, incomplete: false } },
  });
  const out = await statusOf(reader);
  assert.strictEqual(out.command, "status");
  assert.strictEqual(out.label, undefined);
  assert.strictEqual(
    out.reply,
    [
      COUNTS_TEXT,
      "",
      "Active work:",
      "• WP-002 — Harden Bike Tracker prototype",
      "  Spec: SPEC-002",
      "  Evidence: 1",
      "• WP-003 — PBSRx offline mode",
      "  Spec: SPEC-003",
      "  Evidence: 0",
    ].join("\n")
  );
});

test("no active Work Packages: 'Active work: None'", async () => {
  const out = await statusOf(fakeReader());
  assert.strictEqual(out.reply, `${COUNTS_TEXT}\n\nActive work: None`);
});

test("each Work Package's Spec and evidence are read by its page, through the right relation", async () => {
  const a = item("WP-002", "A");
  const b = item("WP-003", "B");
  const reader = fakeReader({ items: [a, b] });
  const signal = new AbortController().signal;
  await statusOf(reader, { signal });
  assert.deepStrictEqual(
    reader.calls.map((c) => [c.method, c.type, c.relation, c.pageId]),
    [
      ["countByStatus", undefined, undefined, undefined],
      ["listActiveWork", undefined, undefined, undefined],
      ["findLinkedUretIds", "spec", "Work packages", a.pageId],
      ["countEvidenceForWP", undefined, undefined, a.pageId],
      ["findLinkedUretIds", "spec", "Work packages", b.pageId],
      ["countEvidenceForWP", undefined, undefined, b.pageId],
    ]
  );
  for (const call of reader.calls) assert.strictEqual(call.opts.signal, signal, `${call.method}: stop signal not passed`);
});

test("evidence counts are shown per Work Package; a cut-short count shows '+'", async () => {
  const items = [item("WP-001", "One"), item("WP-002", "Two"), item("WP-003", "Three")];
  const evidence = {
    [items[0].pageId]: { count: 4, incomplete: false },
    [items[1].pageId]: { count: 1000, incomplete: true },
  };
  const out = await statusOf(fakeReader({ items, evidence }));
  assert.deepStrictEqual(out.reply.split("\n").filter((l) => l.startsWith("  Evidence:")), ["  Evidence: 4", "  Evidence: 1000+", "  Evidence: 0"]);
});

test("the order is the adapter's (most recently edited first), never re-sorted", async () => {
  const items = [item("WP-010", "Edited just now"), item("WP-002", "Edited yesterday"), item("WP-007", "Edited last week")];
  const out = await statusOf(fakeReader({ items }));
  assert.deepStrictEqual(out.reply.split("\n").filter((l) => l.startsWith("• ")).map((l) => l.slice(2, 8)), ["WP-010", "WP-002", "WP-007"]);
});

test("at most five are shown; when Notion has more, the section says so", async () => {
  const items = Array.from({ length: 5 }, (_, i) => item(`WP-00${i + 1}`, `Work ${i + 1}`));
  const out = await statusOf(fakeReader({ items, more: true }));
  const lines = out.reply.split("\n");
  assert.strictEqual(lines.filter((l) => l.startsWith("• ")).length, 5);
  assert.strictEqual(lines[lines.length - 1], "More active work in Notion.");
  const exact = await statusOf(fakeReader({ items, more: false }));
  assert.doesNotMatch(exact.reply, /More active work/);
});

test("missing Spec, several Specs, and an empty URET ID or title", async () => {
  const a = item("WP-001", "No spec");
  const b = item("WP-002", "Two specs");
  const c = item("", "");
  const reader = fakeReader({ items: [a, b, c], specs: { [b.pageId]: { uretIds: ["SPEC-001", "SPEC-002"], more: true } } });
  const out = await statusOf(reader);
  assert.match(out.reply, /• WP-001 — No spec\n {2}Spec: —\n/);
  assert.match(out.reply, /• WP-002 — Two specs\n {2}Spec: SPEC-001, SPEC-002, …\n/);
  assert.match(out.reply, /• — — —\n {2}Spec: —\n {2}Evidence: 0$/);
});

// --- With the other count outcomes, and on failures --------------------------------------------

test("active work also follows the data-integrity and incomplete texts", async () => {
  const a = item("WP-002", "Harden");
  const integrity = await statusOf(fakeReader({ count: { outcome: "data_integrity", total: 3, counts: {} }, items: [a] }));
  assert.match(integrity.reply, new RegExp(`^${opp.STATUS_INTEGRITY_TEXT}\n\nActive work:\n• WP-002 — Harden\n`));
  assert.strictEqual(integrity.label, "notion_data_integrity");
  const incomplete = await statusOf(fakeReader({ count: { outcome: "incomplete", total: 1000, counts: {} } }));
  assert.strictEqual(incomplete.reply, `${opp.STATUS_INCOMPLETE_TEXT}\n\nActive work: None`);
});

test("if the counts fail, the reply is only the Notion text and no active work is read", async () => {
  const reader = fakeReader({
    count: () => {
      throw labelled("notion_timeout");
    },
  });
  const out = await statusOf(reader);
  assert.deepStrictEqual([out.reply, out.label], ["Notion: Unavailable", "notion_timeout"]);
  assert.deepStrictEqual(reader.calls.map((c) => c.method), ["countByStatus"]);
});

test("if active work cannot be read, the counts stand and the section says unavailable", async () => {
  const failures = [
    { onActive: () => { throw labelled("notion_source_not_found"); } },
    { items: [item("WP-002", "A")], onLinked: () => { throw labelled("notion_timeout"); } },
    { items: [item("WP-002", "A")], onEvidence: () => { throw labelled("notion_schema_invalid"); } },
  ];
  const labels = ["notion_source_not_found", "notion_timeout", "notion_schema_invalid"];
  for (const [i, opts] of failures.entries()) {
    const out = await statusOf(fakeReader(opts));
    assert.deepStrictEqual([out.reply, out.label], [`${COUNTS_TEXT}\n\nActive work: unavailable`, labels[i]]);
  }
});

test("the integrity label wins over an active-work failure label", async () => {
  const out = await statusOf(fakeReader({ count: { outcome: "data_integrity", total: 1, counts: {} }, onActive: () => { throw labelled("notion_timeout"); } }));
  assert.deepStrictEqual([out.reply, out.label], [`${opp.STATUS_INTEGRITY_TEXT}\n\nActive work: unavailable`, "notion_data_integrity"]);
});

test("an abort or an unlabelled error during the active-work read propagates", async () => {
  for (const error of [labelled("notion_aborted"), new TypeError("bug")]) {
    const reader = fakeReader({ onActive: () => { throw error; } });
    await assert.rejects(statusOf(reader), (err) => err === error);
  }
});

test("the section formatter on its own", () => {
  assert.strictEqual(opp.buildActiveWorkSection({ items: [], more: true }), "Active work: None");
  assert.strictEqual(opp.buildActiveWorkSection(undefined), "Active work: None");
  assert.strictEqual(opp.evidenceText({ count: 2, incomplete: false }), "2");
  assert.strictEqual(opp.evidenceText({ count: 1000, incomplete: true }), "1000+");
  assert.strictEqual(opp.evidenceText(undefined), "0");
  assert.strictEqual(opp.ACTIVE_WORK_UNAVAILABLE, "Active work: unavailable");
});
