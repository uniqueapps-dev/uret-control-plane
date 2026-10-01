"use strict";

// Back-to-back creation through the real router, capture store, ID counter
// (temporary file) and write adapter, against a stateful fake Notion that
// keeps every created page. Later commands and /show see earlier records.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { createRouter } = require("../bot/commands");
const { createSessionStore } = require("../bot/session");
const { createCaptureStore } = require("../bot/captureSession");
const flows = require("../bot/captureFlows");
const { createNotionWriter } = require("../bot/notionWrite");
const ids = require("../bot/idCounter");
const { tempDir, tempCounterFile, fakePageId, dashedId, AUTHORIZED_ID, forbidRealCounterFile } = require("./helpers");

// This file must never touch the repository's real counter file.
forbidRealCounterFile();

const USER = AUTHORIZED_ID;
const TITLES = { opp: "URET – Opportunities", spec: "URET – Specs", wp: "URET – Work Packages", evd: "URET – Evidence" };
// Reverse side of each two-way relation: source type -> property -> [child type, child property].
const REVERSE = { opp: { Specs: ["spec", "Opportunity"] }, spec: { "Work packages": ["wp", "Spec"] }, wp: { Evidence: ["evd", "Work package"] } };

const text = () => ({ type: "rich_text", rich_text: {} });
const select = (names) => ({ type: "select", select: { options: names.map((name) => ({ name })) } });

function schema(type) {
  const common = { "URET ID": text(), Name: { type: "title", title: {} } };
  if (type === "opp") {
    return {
      ...common,
      Status: select(["Idea", "Active", "Parked", "Done"]),
      "Asset type": { type: "multi_select", multi_select: { options: flows.ASSET_TYPES.map((name) => ({ name })) } },
      "Project / Asset": text(),
      "Problem summary": text(),
      "Target users": text(),
      "Success metrics": text(),
      "Next action": text(),
    };
  }
  if (type === "evd") {
    return { ...common, "Work package": { type: "relation", relation: {} }, Type: select(flows.EVIDENCE_TYPES), Summary: text(), Verdict: select(flows.VERDICTS) };
  }
  if (type === "spec") {
    return { ...common, Status: select(["Draft"]), Opportunity: { type: "relation", relation: {} }, Version: text(), Summary: text(), "Scope in": text(), "Scope out": text(), Constraints: text() };
  }
  return {
    ...common,
    Status: select(["Draft"]),
    Spec: { type: "relation", relation: {} },
    Type: select(flows.WORK_TYPES),
    Worker: select(flows.WORKERS),
    Summary: text(),
    Instructions: text(),
    Outputs: text(),
  };
}

// Created properties (write shape) -> page properties (read shape).
function readShape(properties) {
  const out = {};
  const rt = (items) => items.map((i) => ({ type: "text", plain_text: i.text.content, text: i.text }));
  for (const [name, value] of Object.entries(properties)) {
    if (value.title) out[name] = { type: "title", title: rt(value.title) };
    else if (value.rich_text) out[name] = { type: "rich_text", rich_text: rt(value.rich_text) };
    else if (value.select) out[name] = { type: "select", select: value.select };
    else if (value.multi_select) out[name] = { type: "multi_select", multi_select: value.multi_select };
    else if (value.relation) out[name] = { type: "relation", relation: value.relation };
  }
  return out;
}

function workspace({ counters = { OPP: 1, SPEC: 0, WP: 0, EVD: 0, REL: 0 }, existing = [] } = {}) {
  const root = fakePageId();
  const dsIds = { opp: fakePageId(), spec: fakePageId(), wp: fakePageId(), evd: fakePageId() };
  const typeOfDs = Object.fromEntries(Object.entries(dsIds).map(([t, id]) => [id, t]));
  const pages = []; // { type, uretId, page }
  for (const uretId of existing) {
    const type = { OPP: "opp", SPEC: "spec", WP: "wp", EVD: "evd" }[uretId.split("-")[0]];
    pages.push({ type, uretId, page: { object: "page", id: fakePageId(), in_trash: false, properties: readShape({ "URET ID": { rich_text: [{ text: { content: uretId } }] } }) } });
  }
  const file = tempCounterFile(counters);
  const creates = [];

  const client = {
    dataSources: {
      retrieve: async ({ data_source_id }) => {
        const type = typeOfDs[data_source_id];
        return { object: "data_source", in_trash: false, title: [{ plain_text: TITLES[type] }], database_parent: { type: "page_id", page_id: dashedId(root) }, properties: schema(type) };
      },
    },
    pages: {
      create: async ({ parent, properties }) => {
        const type = typeOfDs[parent.data_source_id];
        const uretId = properties["URET ID"].rich_text.map((t) => t.text.content).join("");
        const page = { object: "page", id: fakePageId(), in_trash: false, url: `https://www.notion.so/${uretId}`, properties: readShape(properties) };
        pages.push({ type, uretId, page });
        creates.push({ type, uretId });
        return page;
      },
    },
  };
  const reader = {
    findByUretId: async (type, uretId) => {
      const hits = pages.filter((p) => p.type === type && p.uretId === uretId);
      if (hits.length === 0) return { result: "not_found", page: null, trashed: false };
      if (hits.length > 1) return { result: "duplicate", page: null, trashed: false };
      return { result: "found", page: hits[0].page, trashed: false };
    },
    findLinkedUretIds: async (type, relation, pageId) => {
      const [childType, childProp] = REVERSE[type][relation];
      const child = pages.find((p) => p.type === childType && p.page.id === pageId);
      const linkedIds = child && child.page.properties[childProp] ? child.page.properties[childProp].relation.map((r) => r.id) : [];
      const uretIds = pages.filter((p) => p.type === type && linkedIds.includes(p.page.id)).map((p) => p.uretId);
      return { uretIds, more: false };
    },
    // Evidence counts from the stored pages (Evidence links to Work Packages).
    countEvidenceForWP: async (wpPageId) => {
      const linkedTo = (p, prop, id) => ((p.page.properties[prop] || {}).relation || []).some((r) => r.id === id);
      return { count: pages.filter((p) => p.type === "evd" && linkedTo(p, "Work package", wpPageId)).length, incomplete: false };
    },
    countEvidenceForSpec: async (specPageId) => {
      const linkedTo = (p, prop, id) => ((p.page.properties[prop] || {}).relation || []).some((r) => r.id === id);
      const wps = pages.filter((p) => p.type === "wp" && linkedTo(p, "Spec", specPageId)).map((p) => p.page.id);
      return { count: pages.filter((p) => p.type === "evd" && wps.some((id) => linkedTo(p, "Work package", id))).length, incomplete: false };
    },
    getDataSourceId: async (type) => dsIds[type],
  };
  const writer = createNotionWriter({ client, rootPageId: root, resolveDataSource: reader.getDataSourceId });
  const router = createRouter({
    sessions: createSessionStore(),
    configStatus: { TELEGRAM_BOT_TOKEN: "valid", TELEGRAM_ALLOWED_USER_ID: "valid" },
    logDir: path.join(tempDir(), "logs"),
    notion: reader,
    writer,
    reserveId: (type, { signal } = {}) => ids.reserveNextId(type, reader, { file, signal }),
    capture: createCaptureStore(),
  });
  const send = (t) => router.route({ text: t, chatId: USER });
  const counters_ = () => JSON.parse(fs.readFileSync(file, "utf8"));
  const pageOf = (uretId) => pages.find((p) => p.uretId === uretId).page;
  return { send, pages, creates, counters: counters_, pageOf };
}

async function run(ws, start, answers) {
  const first = await ws.send(start);
  assert.doesNotMatch(first.reply, /not found|problem|already/i, `${start}: ${first.reply}`);
  let out;
  for (const a of answers) out = await ws.send(a);
  return out.reply;
}

const OPP = (title) => [title, "1", "Project", "Problem", "Users", "Metrics", "Next"];
const SPEC = (title) => [title, "v0.1", "Summary", "In", "Out", "None"];
const WORK = (title) => [title, "2", "Emmanuel", "Summary", "Do it", "A PR"];

test("two /new_opportunity runs in a row allocate different, consecutive IDs", async () => {
  const ws = workspace();
  assert.match(await run(ws, "/new_opportunity", OPP("First")), /^Created OPP-002\n\nTitle: First\n/);
  assert.match(await run(ws, "/new_opportunity", OPP("Second")), /^Created OPP-003\n\nTitle: Second\n/);
  assert.deepStrictEqual(ws.creates, [{ type: "opp", uretId: "OPP-002" }, { type: "opp", uretId: "OPP-003" }]);
  assert.notStrictEqual(ws.pageOf("OPP-002").id, ws.pageOf("OPP-003").id);
  assert.deepStrictEqual(ws.counters(), { OPP: 3, SPEC: 0, WP: 0, EVD: 0, REL: 0 });
});

test("the full chain: a new Opportunity, a Spec for it, a Work Package for that Spec", async () => {
  const ws = workspace();
  assert.match(await run(ws, "/new_opportunity", OPP("Bike tracker")), /^Created OPP-002\n/);
  assert.match(await run(ws, "/new_spec OPP-002", SPEC("Bike spec")), /^Created SPEC-001\n[\s\S]*\nOpportunity: OPP-002\n/);
  assert.match(await run(ws, "/new_work SPEC-001", WORK("Bike work")), /^Created WP-001\n[\s\S]*\nWorker: Manual\nSpec: SPEC-001\n/);

  assert.deepStrictEqual(ws.pageOf("SPEC-001").properties.Opportunity.relation, [{ id: ws.pageOf("OPP-002").id }]);
  assert.deepStrictEqual(ws.pageOf("WP-001").properties.Spec.relation, [{ id: ws.pageOf("SPEC-001").id }]);
  assert.deepStrictEqual(ws.counters(), { OPP: 2, SPEC: 1, WP: 1, EVD: 0, REL: 0 });

  // The created records read back through /show.
  assert.match((await ws.send("/show OPP-002")).reply, /^URET ID: OPP-002\nName: Bike tracker\nStatus: Idea\nAsset type: App\/PWA\n/);
  assert.match((await ws.send("/show SPEC-001")).reply, /^SPEC-001 — Bike spec\n\nVersion: v0\.1\nOpportunity: OPP-002\nStatus: Draft\n/);
  assert.match((await ws.send("/show WP-001")).reply, /^WP-001 — Bike work\n\nType: Feature\nWorker: Manual\nSpec: SPEC-001\nStatus: Draft\n/);
});

test("two Specs for the same Opportunity, then a Work Package for each", async () => {
  const ws = workspace({ existing: ["OPP-001"] });
  assert.match(await run(ws, "/new_spec OPP-001", SPEC("A")), /^Created SPEC-001\n/);
  assert.match(await run(ws, "/new_spec OPP-001", SPEC("B")), /^Created SPEC-002\n/);
  assert.match(await run(ws, "/new_work SPEC-002", WORK("For B")), /^Created WP-001\n[\s\S]*\nSpec: SPEC-002\n/);
  assert.match(await run(ws, "/new_work SPEC-001", WORK("For A")), /^Created WP-002\n[\s\S]*\nSpec: SPEC-001\n/);
  assert.deepStrictEqual(ws.pageOf("WP-001").properties.Spec.relation, [{ id: ws.pageOf("SPEC-002").id }]);
  assert.deepStrictEqual(ws.counters(), { OPP: 1, SPEC: 2, WP: 2, EVD: 0, REL: 0 });
});

test("a counter behind Notion (reset by git checkout) skips existing IDs across runs", async () => {
  const ws = workspace({ counters: { OPP: 0, SPEC: 0, WP: 0, EVD: 0, REL: 0 }, existing: ["OPP-001", "OPP-002"] });
  assert.match(await run(ws, "/new_opportunity", OPP("X")), /^Created OPP-003\n/);
  assert.match(await run(ws, "/new_opportunity", OPP("Y")), /^Created OPP-004\n/);
  assert.strictEqual(ws.pages.filter((p) => p.uretId === "OPP-003").length, 1);
});

test("a Spec cannot be created for an Opportunity that does not exist yet; the next ID is still free", async () => {
  const ws = workspace();
  assert.strictEqual((await ws.send("/new_spec OPP-002")).reply, "Opportunity OPP-002 not found.");
  await run(ws, "/new_opportunity", OPP("Now it exists"));
  assert.match(await run(ws, "/new_spec OPP-002", SPEC("Linked")), /^Created SPEC-001\n/);
});

// --- Phase 4: Evidence round trip -------------------------------------------------------------

const EVIDENCE = (summary) => ["2", summary, "1", "Expense logging is clear.\nTested on two rides.", "Add service card to dashboard."];

test("Evidence round trip: /new_evidence, then /show EVD reads the sections back and the counts rise", async () => {
  const ws = workspace({ counters: { OPP: 1, SPEC: 0, WP: 0, EVD: 0, REL: 0 } });
  await run(ws, "/new_opportunity", OPP("Bike tracker"));
  await run(ws, "/new_spec OPP-002", SPEC("Bike spec"));
  await run(ws, "/new_work SPEC-001", WORK("Bike work"));
  assert.match((await ws.send("/show WP-001")).reply, /\nStatus: Draft\nEvidence: 0\n/);

  assert.match(await run(ws, "/new_evidence WP-001", EVIDENCE("Prototype works on LG G8X.")), /^Created EVD-001\n\nType: Test results\nVerdict: Pass\nWork package: WP-001\n/);
  assert.match(await run(ws, "/new_evidence wp-1", EVIDENCE("Second test.")), /^Created EVD-002\n/);

  assert.strictEqual(
    (await ws.send("/show EVD-001")).reply,
    [
      "EVD-001 — Prototype works on LG G8X.",
      "",
      "Type: Test results",
      "Verdict: Pass",
      "Work package: WP-001",
      "Summary: Prototype works on LG G8X.",
      "Details: Expense logging is clear.\nTested on two rides.",
      "Next action: Add service card to dashboard.",
      "",
      "Notion link: https://www.notion.so/EVD-001",
    ].join("\n")
  );
  assert.match((await ws.send("/show WP-001")).reply, /\nStatus: Draft\nEvidence: 2\n/);
  assert.match((await ws.send("/show SPEC-001")).reply, /\nStatus: Draft\nEvidence: 2\n/);
  assert.deepStrictEqual(ws.counters(), { OPP: 2, SPEC: 1, WP: 1, EVD: 2, REL: 0 });
});
