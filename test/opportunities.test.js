"use strict";

const test = require("node:test");
const assert = require("node:assert");
const opp = require("../bot/opportunities");

// --- URET ID normalisation --------------------------------------------------

test("valid URET IDs normalise to canonical OPP-NNN", () => {
  const cases = {
    "opp-1": "OPP-001",
    "OPP-1": "OPP-001",
    "opp-001": "OPP-001",
    "OPP-001": "OPP-001",
    "Opp-42": "OPP-042",
    "OPP-0042": "OPP-042",
    "OPP-999": "OPP-999",
    "OPP-1000": "OPP-1000",
    "opp-01000": "OPP-1000",
    "  OPP-7  ": "OPP-007",
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.strictEqual(opp.normalizeUretId(input), expected, input);
  }
});

test("invalid URET IDs are rejected", () => {
  const invalid = [
    "OPP-0",
    "OPP-000",
    "SPEC-1",
    "WP-1",
    "pharmacy",
    "",
    "   ",
    "OPP-",
    "OPP1",
    "OPP 1",
    "OPP - 1",
    "OPP-1 extra",
    "OPP-1a",
    "OPP--1",
    "OPP-+1",
    "OPP-1.5",
    "OPP-١",
    "xOPP-1",
  ];
  for (const input of invalid) {
    assert.strictEqual(opp.normalizeUretId(input), null, JSON.stringify(input));
  }
  for (const input of [undefined, null, 1, {}, ["OPP-1"]]) {
    assert.strictEqual(opp.normalizeUretId(input), null);
  }
});

test("usage and invalid-ID texts are exact", () => {
  assert.strictEqual(opp.SHOW_USAGE, "Usage: /show <URET-ID>\nExamples: /show OPP-001, /show SPEC-001");
  assert.strictEqual(opp.INVALID_ID_TEXT, "Invalid URET ID. Examples: /show OPP-001, /show SPEC-001");
  assert.strictEqual(opp.notFoundText("OPP-001"), "Not found: OPP-001");
  assert.strictEqual(opp.duplicateText("OPP-001"), "Notion: Data integrity problem\nDuplicate URET ID: OPP-001");
});

// --- Truncation --------------------------------------------------------------

test("text up to 300 characters is returned unchanged", () => {
  for (const length of [0, 1, 299, 300]) {
    const text = "a".repeat(length);
    assert.strictEqual(opp.truncate(text), text);
  }
});

test("long text is cut at the last whitespace between 200 and 299, with an ellipsis", () => {
  const text = "word ".repeat(100); // 500 characters
  const out = opp.truncate(text);
  assert.ok(out.endsWith("…"));
  assert.ok(out.length <= 300, `too long: ${out.length}`);
  const kept = out.slice(0, -1);
  assert.ok(kept.length >= 200, "cut before character 200");
  assert.ok(text.startsWith(kept), "not a prefix of the original");
  assert.match(text[kept.length], /\s/, "not cut at a word boundary");
  assert.ok(!/\s$/.test(kept), "trailing whitespace kept");
  assert.strictEqual(out, `${"word ".repeat(59)}word…`);
});

test("long text with no whitespace in range is cut at 299 characters plus ellipsis", () => {
  assert.strictEqual(opp.truncate("x".repeat(400)), `${"x".repeat(299)}…`);
  // Only whitespace is before 200: still a hard cut.
  const early = `${"a".repeat(150)} ${"b".repeat(300)}`;
  assert.strictEqual(opp.truncate(early), `${early.slice(0, 299)}…`);
  // Whitespace only at index 300 is outside the range.
  const late = `${"a".repeat(300)} ${"b".repeat(50)}`;
  assert.strictEqual(opp.truncate(late), `${"a".repeat(299)}…`);
});

test("whitespace exactly at index 299 or 200 is used as the cut", () => {
  assert.strictEqual(opp.truncate(`${"a".repeat(299)} ${"b".repeat(50)}`), `${"a".repeat(299)}…`);
  assert.strictEqual(opp.truncate(`${"a".repeat(200)} ${"b".repeat(200)}`), `${"a".repeat(200)}…`);
  assert.strictEqual(opp.truncate(`${"a".repeat(250)}\n${"b".repeat(200)}`), `${"a".repeat(250)}…`);
});

test("truncation never exceeds 300 characters and never splits an emoji", () => {
  const out = opp.truncate("😀".repeat(400));
  assert.strictEqual(Array.from(out).length, 300);
  assert.doesNotMatch(out, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, "split surrogate pair");
  for (const text of ["word ".repeat(100), "x".repeat(1000), `${"a ".repeat(99)}${"b".repeat(400)}`]) {
    assert.ok(Array.from(opp.truncate(text)).length <= 300);
  }
});

test("truncation is deterministic", () => {
  const text = "The quick brown fox jumps over the lazy dog. ".repeat(20);
  const first = opp.truncate(text);
  for (let i = 0; i < 5; i++) assert.strictEqual(opp.truncate(text), first);
});

// --- Value formatting ---------------------------------------------------------

const rt = (...parts) => parts.map((plain_text) => ({ type: "text", plain_text, text: { content: plain_text } }));

test("empty values display as an em dash", () => {
  assert.strictEqual(opp.formatText(""), "—");
  assert.strictEqual(opp.formatText("   "), "—");
  assert.strictEqual(opp.formatText(undefined), "—");
  assert.strictEqual(opp.formatProperty({ type: "rich_text", rich_text: [] }), "—");
  assert.strictEqual(opp.formatProperty({ type: "title", title: [] }), "—");
  assert.strictEqual(opp.formatProperty({ type: "select", select: null }), "—");
  assert.strictEqual(opp.formatProperty({ type: "multi_select", multi_select: [] }), "—");
  assert.strictEqual(opp.formatProperty({ type: "created_time", created_time: "" }), "—");
  assert.strictEqual(opp.formatProperty(undefined), "—");
  assert.strictEqual(opp.formatProperty({ type: "people", people: [] }), "—");
});

test("rich text is concatenated plain text, trimmed and truncated", () => {
  assert.strictEqual(opp.richTextToPlain(rt("Hello ", "world")), "Hello world");
  assert.strictEqual(opp.formatProperty({ type: "rich_text", rich_text: rt("  padded  ") }), "padded");
  const long = { type: "rich_text", rich_text: rt("x".repeat(500)) };
  assert.strictEqual(opp.formatProperty(long), `${"x".repeat(299)}…`);
  assert.strictEqual(opp.richTextToPlain(undefined), "");
});

test("multi-select shows comma-separated names", () => {
  const prop = { type: "multi_select", multi_select: [{ name: "App/PWA" }, { name: "Ebook" }] };
  assert.strictEqual(opp.formatProperty(prop), "App/PWA, Ebook");
  assert.strictEqual(opp.formatMultiSelect(undefined), "—");
});

test("dates are shown in UTC", () => {
  assert.strictEqual(opp.formatDate("2026-09-26T08:15:00.000Z"), "2026-09-26 08:15 UTC");
  assert.strictEqual(opp.formatDate("2026-09-26T08:15:00.000+02:00"), "2026-09-26 06:15 UTC");
  assert.strictEqual(opp.formatDate("not a date"), "—");
  assert.strictEqual(opp.formatProperty({ type: "last_edited_time", last_edited_time: "2026-01-02T03:04:00.000Z" }), "2026-01-02 03:04 UTC");
});

// --- Link line and /show ---------------------------------------------------------

test("link line uses the page URL when provided, otherwise unavailable", () => {
  assert.strictEqual(opp.linkLine({ url: "https://www.notion.so/example" }), "Notion link: https://www.notion.so/example");
  for (const page of [{}, { url: "" }, { url: "   " }, { url: null }, null, undefined]) {
    assert.strictEqual(opp.linkLine(page), "Notion link: unavailable");
  }
});

function samplePage(overrides = {}) {
  return {
    object: "page",
    in_trash: false,
    url: "https://www.notion.so/example",
    properties: {
      "URET ID": { type: "rich_text", rich_text: rt("OPP-001") },
      Name: { type: "title", title: rt("URET Control Plane Setup") },
      Status: { type: "select", select: { name: "Active" } },
      "Asset type": { type: "multi_select", multi_select: [{ name: "App/PWA" }] },
      "Project / Asset": { type: "rich_text", rich_text: rt("URET") },
      "Problem summary": { type: "rich_text", rich_text: [] },
      "Target users": { type: "rich_text", rich_text: rt("Operator") },
      "Success metrics": { type: "rich_text", rich_text: rt("Five databases") },
      "Next action": { type: "rich_text", rich_text: rt("Research myself") },
      Created: { type: "created_time", created_time: "2026-09-20T10:00:00.000Z" },
      "Last updated": { type: "last_edited_time", last_edited_time: "2026-09-21T11:30:00.000Z" },
      Specs: { type: "relation", relation: [] },
    },
    ...overrides,
  };
}

test("/show reply lists the fields in the required order", () => {
  assert.strictEqual(
    opp.buildShowReply(samplePage()),
    [
      "URET ID: OPP-001",
      "Name: URET Control Plane Setup",
      "Status: Active",
      "Asset type: App/PWA",
      "Project / Asset: URET",
      "Problem summary: —",
      "Target users: Operator",
      "Success metrics: Five databases",
      "Next action: Research myself",
      "Created: 2026-09-20 10:00 UTC",
      "Last updated: 2026-09-21 11:30 UTC",
      "Notion link: https://www.notion.so/example",
    ].join("\n")
  );
});

test("/show reply without a URL says unavailable, and a trashed record is flagged first", () => {
  const noUrl = opp.buildShowReply(samplePage({ url: undefined }));
  assert.ok(noUrl.endsWith("\nNotion link: unavailable"));
  const trashed = opp.buildShowReply(samplePage({ in_trash: true })).split("\n");
  assert.strictEqual(trashed[0], "Archived/trashed record");
  assert.strictEqual(trashed[1], "URET ID: OPP-001");
  assert.ok(!opp.buildShowReply(samplePage()).includes("Archived"));
});

test("/show reply shows em dashes for missing properties and stays within Telegram's limit", () => {
  const bare = opp.buildShowReply({ properties: {} }).split("\n");
  assert.strictEqual(bare.length, 12);
  assert.ok(bare.slice(0, 11).every((line) => line.endsWith(": —")));
  const huge = samplePage();
  for (const key of ["Project / Asset", "Problem summary", "Target users", "Success metrics", "Next action"]) {
    huge.properties[key] = { type: "rich_text", rich_text: rt("y ".repeat(1000)) };
  }
  huge.properties.Name = { type: "title", title: rt("n".repeat(1000)) };
  assert.ok(opp.buildShowReply(huge).length < 4096);
});

// --- /status texts -------------------------------------------------------------

test("/status normal reply shows total and the four statuses only", () => {
  const reply = opp.buildStatusReply({ outcome: "counts", total: 7, counts: { Idea: 3, Active: 2, Parked: 1, Done: 1 } });
  assert.strictEqual(reply, "Notion: Connected\nTotal: 7\nIdea: 3\nActive: 2\nParked: 1\nDone: 1");
  assert.doesNotMatch(reply, /Other/);
  const empty = opp.buildStatusReply({ outcome: "counts", total: 0, counts: {} });
  assert.strictEqual(empty, "Notion: Connected\nTotal: 0\nIdea: 0\nActive: 0\nParked: 0\nDone: 0");
});

test("/status integrity and incomplete replies are exact and show no counts", () => {
  const integrity = opp.buildStatusReply({ outcome: "data_integrity", total: 5, counts: { Idea: 5 } });
  assert.strictEqual(integrity, "Notion: Data integrity problem\nUnexpected Opportunity status values found.");
  const incomplete = opp.buildStatusReply({ outcome: "incomplete", total: 1000, counts: { Idea: 1000 } });
  assert.strictEqual(
    incomplete,
    "Notion: Connected\nCounts: Incomplete\nAt least 1,000 records were scanned.\nUse Notion directly for the full dataset."
  );
  for (const reply of [integrity, incomplete]) assert.doesNotMatch(reply, /Total:|Idea:|Active:|Parked:|Done:|Other/);
});

test("required statuses are exactly Idea, Active, Parked, Done", () => {
  assert.deepStrictEqual(opp.REQUIRED_STATUSES, ["Idea", "Active", "Parked", "Done"]);
});
