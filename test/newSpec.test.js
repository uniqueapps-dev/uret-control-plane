"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { RequestTimeoutError } = require("@notionhq/client");
const { createRouter, UNKNOWN_TEXT, NOT_CONFIGURED_TEXT } = require("../bot/commands");
const { createSessionStore } = require("../bot/session");
const { createCaptureStore, FIELDS } = require("../bot/captureSession");
const flows = require("../bot/captureFlows");
const opp = require("../bot/opportunities");
const { createNotionWriter } = require("../bot/notionWrite");
const ids = require("../bot/idCounter");
const { tempDir, tempCounterFile, fakePageId, dashedId, AUTHORIZED_ID, forbidRealCounterFile } = require("./helpers");

// This file must never touch the repository's real counter file.
forbidRealCounterFile();

const MIN = 60 * 1000;
const USER = AUTHORIZED_ID;

function guard(target, pathSoFar = "client") {
  return new Proxy(target, {
    get(obj, prop) {
      if (typeof prop === "symbol") return undefined;
      if (!Object.prototype.hasOwnProperty.call(obj, prop)) throw new Error(`forbidden access: ${pathSoFar}.${prop}`);
      const value = obj[prop];
      return value && typeof value === "object" ? guard(value, `${pathSoFar}.${prop}`) : value;
    },
  });
}

const rt = (t) => [{ type: "text", plain_text: t, text: { content: t } }];
const text = () => ({ type: "rich_text", rich_text: {} });

/**
 * Router wired like index.js with a fake read adapter. `records` maps a URET ID
 * to its lookup result: a page object ("found"), "duplicate", or
 * { trashed: page }. Anything else is not found.
 */
function harness({ records = {}, linked = { uretIds: [], more: false }, onFind, onLinked, onCreate, configured = true } = {}) {
  const clock = { t: 9_000_000 };
  const capture = createCaptureStore({ now: () => clock.t });
  const root = fakePageId();
  const dsId = fakePageId();
  const file = tempCounterFile({ OPP: 2, SPEC: 0, WP: 0, EVD: 0, REL: 0 });
  const calls = [];
  const dataSource = {
    object: "data_source",
    in_trash: false,
    title: rt("URET – Specs"),
    database_parent: { type: "page_id", page_id: dashedId(root) },
    properties: {
      "URET ID": text(),
      Name: { type: "title", title: {} },
      Status: { type: "select", select: { options: [{ name: "Draft" }, { name: "Approved" }] } },
      Opportunity: { type: "relation", relation: {} },
      Version: text(),
      Summary: text(),
      "Scope in": text(),
      "Scope out": text(),
      Constraints: text(),
    },
  };
  const client = guard({
    dataSources: { retrieve: async () => (calls.push({ method: "dataSources.retrieve" }), dataSource) },
    pages: {
      create: async (args) => {
        calls.push({ method: "pages.create", args });
        if (onCreate) return onCreate(args);
        return { object: "page", id: fakePageId() };
      },
    },
  });
  const reader = {
    findByUretId: async (type, id, opts) => {
      calls.push({ method: "findByUretId", type, id, opts });
      if (onFind) {
        const custom = onFind(type, id, calls);
        if (custom) return custom;
      }
      const r = records[id];
      if (r === "duplicate") return { result: "duplicate", page: null, trashed: false };
      if (r && r.trashed) return { result: "found", page: r.trashed, trashed: true };
      if (r) return { result: "found", page: r, trashed: false };
      return { result: "not_found", page: null, trashed: false };
    },
    findLinkedUretIds: async (type, relation, pageId, opts) => {
      calls.push({ method: "findLinkedUretIds", type, relation, pageId, opts });
      if (onLinked) return onLinked();
      return linked;
    },
    getDataSourceId: async () => (calls.push({ method: "getDataSourceId" }), dsId),
  };
  const writer = createNotionWriter({ client, rootPageId: root, resolveDataSource: reader.getDataSourceId });
  const router = createRouter({
    sessions: createSessionStore(),
    configStatus: { TELEGRAM_BOT_TOKEN: "valid", TELEGRAM_ALLOWED_USER_ID: "valid" },
    logDir: path.join(tempDir(), "logs"),
    notion: configured ? reader : null,
    writer: configured ? writer : null,
    reserveId: configured ? (type, { signal } = {}) => ids.reserveNextId(type, reader, { file, signal }) : null,
    capture,
  });
  const send = (t, extra = {}) => router.route({ text: t, chatId: USER, ...extra });
  const methods = () => calls.map((c) => c.method);
  const count = (method) => calls.filter((c) => c.method === method).length;
  const counter = () => JSON.parse(fs.readFileSync(file, "utf8")).SPEC;
  return { send, calls, methods, count, counter, capture, clock, dataSource };
}

const oppPage = (extra = {}) => ({ object: "page", id: fakePageId(), in_trash: false, properties: {}, ...extra });
const ANSWERS = ["Bike Tracker Prototype", "v0.1", "A first cut", "Logging rides", "Sync", "Offline only"];

async function answerAll(h, answers = ANSWERS) {
  let out;
  for (const a of answers) out = await h.send(a);
  return out;
}

// --- Definition --------------------------------------------------------------------------

test("the Spec flow asks the 6 locked questions, keyed like the capture store", () => {
  const flow = flows.FLOWS.new_spec;
  assert.deepStrictEqual(flow.questions.map((q) => q.key), FIELDS.new_spec);
  assert.deepStrictEqual(flow.questions.map((q) => q.label), ["Title", "Version", "Summary", "Scope in", "Scope out", "Constraints"]);
});

// --- /new_spec full flow -------------------------------------------------------------------

test("/new_spec full flow: parent checked, 6 questions, SPEC-001 created as Draft and linked", async () => {
  const parent = oppPage();
  const h = harness({ records: { "OPP-002": parent } });
  const first = await h.send("/new_spec opp-2");
  assert.strictEqual(first.command, "new_spec");
  assert.strictEqual(first.reply, "New Spec for OPP-002: 6 questions. Send /cancel to stop.\n\n1/6 Title? (max 200 characters)");
  assert.deepStrictEqual(h.calls.map((c) => [c.method, c.type, c.id]), [["findByUretId", "opp", "OPP-002"]]);
  assert.strictEqual(h.capture.getActiveSession(USER).parentId, "OPP-002");

  const prompts = [];
  for (const a of ANSWERS.slice(0, -1)) prompts.push((await h.send(a)).reply);
  assert.deepStrictEqual(prompts.map((p) => p.split(" ")[0]), ["2/6", "3/6", "4/6", "5/6", "6/6"]);
  assert.strictEqual(prompts[0], "2/6 Version? (for example v0.1, max 50 characters)");
  assert.strictEqual(h.calls.length, 1, "Notion touched during the questions");

  const last = await h.send(ANSWERS[5]);
  assert.strictEqual(
    last.reply,
    ["Created SPEC-001", "", "Title: Bike Tracker Prototype", "Version: v0.1", "Opportunity: OPP-002", "Status: Draft", "", "Stored in URET – Specs."].join("\n")
  );
  assert.strictEqual(last.command, "new_spec");
  assert.deepStrictEqual(h.methods(), ["findByUretId", "findByUretId", "findByUretId", "getDataSourceId", "dataSources.retrieve", "pages.create"]);
  assert.deepStrictEqual([h.calls[1].type, h.calls[1].id], ["opp", "OPP-002"], "parent not checked again before creating");
  assert.deepStrictEqual([h.calls[2].type, h.calls[2].id], ["spec", "SPEC-001"]);

  const props = h.calls.find((c) => c.method === "pages.create").args.properties;
  const plain = (p) => p.rich_text.map((t) => t.text.content).join("");
  assert.deepStrictEqual(props.Status, { select: { name: "Draft" } });
  assert.deepStrictEqual(props.Opportunity, { relation: [{ id: parent.id }] });
  assert.strictEqual(plain(props["URET ID"]), "SPEC-001");
  assert.strictEqual(props.Name.title[0].text.content, "Bike Tracker Prototype");
  assert.deepStrictEqual([plain(props.Version), plain(props.Summary), plain(props["Scope in"]), plain(props["Scope out"]), plain(props.Constraints)], ANSWERS.slice(1));
  assert.strictEqual(h.counter(), 1);
  assert.strictEqual(h.capture.getActiveSession(USER), null);
});

// --- Parent checks: no session unless exactly one live parent ------------------------------

test("/new_spec without an argument, or with a non-OPP ID, shows usage and reads nothing", async () => {
  const h = harness();
  for (const t of ["/new_spec", "/new_spec   ", "/new_spec@UretBot"]) {
    assert.strictEqual((await h.send(t)).reply, "Usage: /new_spec <OPP-ID>\nExample: /new_spec OPP-001");
  }
  for (const t of ["/new_spec SPEC-001", "/new_spec OPP-0", "/new_spec bike", "/new_spec OPP-1 extra"]) {
    assert.strictEqual((await h.send(t)).reply, "Invalid Opportunity ID. Example: /new_spec OPP-001", t);
  }
  assert.strictEqual(h.calls.length, 0);
  assert.strictEqual(h.capture.size(), 0);
});

test("parent not found: no session starts", async () => {
  const h = harness();
  assert.strictEqual((await h.send("/new_spec OPP-999")).reply, "Opportunity OPP-999 not found.");
  assert.strictEqual(h.capture.size(), 0);
  assert.strictEqual((await h.send("Title")).reply, UNKNOWN_TEXT);
});

test("parent duplicated: data integrity text, no session", async () => {
  const h = harness({ records: { "OPP-002": "duplicate" } });
  const out = await h.send("/new_spec OPP-002");
  assert.deepStrictEqual([out.reply, out.label], ["Data integrity problem: multiple records found for OPP-002.", "notion_duplicate_id"]);
  assert.strictEqual(h.capture.size(), 0);
});

test("parent in the trash: no session", async () => {
  const h = harness({ records: { "OPP-002": { trashed: oppPage({ in_trash: true }) } } });
  assert.strictEqual((await h.send("/new_spec OPP-002")).reply, "Opportunity OPP-002 is in the trash.");
  assert.strictEqual(h.capture.size(), 0);
});

test("Notion failing during the parent check: fixed Notion text, no session", async () => {
  const h = harness({
    onFind: () => {
      throw Object.assign(new Error("x"), { label: "notion_timeout" });
    },
  });
  const out = await h.send("/new_spec OPP-002");
  assert.deepStrictEqual([out.reply, out.label], ["Notion: Unavailable", "notion_timeout"]);
  assert.strictEqual(h.capture.size(), 0);
});

test("parent removed before the last answer: nothing reserved or written", async () => {
  const records = { "OPP-002": oppPage() };
  const h = harness({ records });
  await h.send("/new_spec OPP-002");
  delete records["OPP-002"];
  const out = await answerAll(h);
  assert.strictEqual(out.reply, "Opportunity OPP-002 not found.");
  assert.strictEqual(h.count("pages.create"), 0);
  assert.strictEqual(h.counter(), 0, "an ID was reserved");
  assert.strictEqual(h.capture.getActiveSession(USER), null);
});

test("Notion failing during the final parent check: locked creation text", async () => {
  const h = harness({
    records: { "OPP-002": oppPage() },
    onFind: (type, id, calls) => {
      if (calls.length > 1) throw Object.assign(new Error("x"), { label: "notion_unavailable" });
      return null;
    },
  });
  await h.send("/new_spec OPP-002");
  const out = await answerAll(h);
  assert.deepStrictEqual([out.reply, out.label], ["Notion is unavailable. Please try again later.", "notion_unavailable"]);
  assert.strictEqual(h.count("pages.create"), 0);
});

// --- Validation, sessions, failures ------------------------------------------------------------

test("invalid versions are rejected; nothing written", async () => {
  const h = harness({ records: { "OPP-002": oppPage() } });
  await h.send("/new_spec OPP-002");
  await h.send("Title");
  assert.strictEqual((await h.send(" ")).reply, "The version cannot be empty.\n\n2/6 Version? (for example v0.1, max 50 characters)");
  assert.match((await h.send("v".repeat(51))).reply, /^The version is too long \(max 50 characters\)\./);
  assert.match((await h.send("v1\nv2")).reply, /^The version must be a single line\./);
  assert.strictEqual(h.capture.getActiveSession(USER).step, 1);
  assert.strictEqual(h.count("pages.create"), 0);
});

test("a /new_spec session blocks a second session in either direction", async () => {
  const h = harness({ records: { "OPP-002": oppPage() } });
  await h.send("/new_opportunity");
  assert.strictEqual((await h.send("/new_spec OPP-002")).reply, "You already have an active session. Finish it or use /cancel.");
  assert.strictEqual(h.calls.length, 0, "parent looked up while another session was active");
  await h.send("/cancel");
  await h.send("/new_spec OPP-002");
  assert.strictEqual((await h.send("/new_opportunity")).reply, "You already have an active session. Finish it or use /cancel.");
});

test("/cancel during /new_spec writes nothing", async () => {
  const h = harness({ records: { "OPP-002": oppPage() } });
  await h.send("/new_spec OPP-002");
  await answerAll(h, ANSWERS.slice(0, 5));
  assert.strictEqual((await h.send("/cancel")).reply, "Cancelled. No record created.");
  assert.deepStrictEqual(h.methods(), ["findByUretId"]);
  assert.strictEqual(h.counter(), 0);
});

test("an expired /new_spec session names /new_spec", async () => {
  const h = harness({ records: { "OPP-002": oppPage() } });
  await h.send("/new_spec OPP-002");
  h.clock.t += 31 * MIN;
  assert.strictEqual((await h.send("Title")).reply, "Session expired. Use /cancel to stop or /new_spec to restart.");
});

test("without Notion configuration /new_spec starts nothing", async () => {
  const h = harness({ configured: false });
  const out = await h.send("/new_spec OPP-002");
  assert.deepStrictEqual([out.reply, out.label], [NOT_CONFIGURED_TEXT, "notion_not_configured"]);
  assert.strictEqual(h.capture.size(), 0);
});

test("an unconfirmed Spec create names the reserved SPEC ID", async () => {
  const h = harness({
    records: { "OPP-002": oppPage() },
    onCreate: () => {
      throw new RequestTimeoutError();
    },
  });
  await h.send("/new_spec OPP-002");
  const out = await answerAll(h);
  assert.strictEqual(out.reply, "Notion did not confirm the write. Check Notion for SPEC-001 before trying again.");
});

// --- /show SPEC -----------------------------------------------------------------------------------

const specPage = (extra = {}) => ({
  object: "page",
  id: fakePageId(),
  in_trash: false,
  url: "https://www.notion.so/Bike-Tracker-Prototype-abc",
  properties: {
    "URET ID": { type: "rich_text", rich_text: rt("SPEC-001") },
    Name: { type: "title", title: rt("Bike Tracker Prototype") },
    Version: { type: "rich_text", rich_text: rt("v0.1") },
    Status: { type: "select", select: { name: "Draft" } },
    Summary: { type: "rich_text", rich_text: rt("A first cut") },
    "Scope in": { type: "rich_text", rich_text: rt("Logging rides") },
    "Scope out": { type: "rich_text", rich_text: [] },
    Constraints: { type: "rich_text", rich_text: rt("Offline only") },
  },
  ...extra,
});

test("/show SPEC-001 shows the Spec with its Opportunity by URET ID", async () => {
  const page = specPage();
  const h = harness({ records: { "SPEC-001": page }, linked: { uretIds: ["OPP-002"], more: false } });
  const out = await h.send("/show spec-1");
  assert.strictEqual(out.command, "show");
  assert.strictEqual(
    out.reply,
    [
      "SPEC-001 — Bike Tracker Prototype",
      "",
      "Version: v0.1",
      "Opportunity: OPP-002",
      "Status: Draft",
      "Summary: A first cut",
      "Scope in: Logging rides",
      "Scope out: —",
      "Constraints: Offline only",
      "",
      "Notion link: https://www.notion.so/Bike-Tracker-Prototype-abc",
    ].join("\n")
  );
  assert.deepStrictEqual(h.calls.map((c) => [c.method, c.type]), [["findByUretId", "spec"], ["findLinkedUretIds", "opp"]]);
  assert.deepStrictEqual([h.calls[1].relation, h.calls[1].pageId], ["Specs", page.id]);
});

test("/show SPEC: no linked Opportunity, several, a missing URL, and a trashed Spec", async () => {
  const none = harness({ records: { "SPEC-001": specPage({ url: undefined }) } });
  const reply = (await none.send("/show SPEC-001")).reply;
  assert.match(reply, /\nOpportunity: —\n/);
  assert.match(reply, /\nNotion link: unavailable$/);
  const many = harness({ records: { "SPEC-001": specPage() }, linked: { uretIds: ["OPP-002", "OPP-003"], more: true } });
  assert.match((await many.send("/show SPEC-001")).reply, /\nOpportunity: OPP-002, OPP-003, …\n/);
  const trashed = harness({ records: { "SPEC-001": { trashed: specPage({ in_trash: true }) } } });
  assert.match((await trashed.send("/show SPEC-001")).reply, /^Archived\/trashed record\nSPEC-001 — /);
});

test("/show SPEC-999 not found; duplicates reported; nothing linked is looked up", async () => {
  const h = harness({ records: { "SPEC-002": "duplicate" } });
  assert.strictEqual((await h.send("/show SPEC-999")).reply, "Not found: SPEC-999");
  const dup = await h.send("/show SPEC-002");
  assert.deepStrictEqual([dup.reply, dup.label], ["Notion: Data integrity problem\nDuplicate URET ID: SPEC-002", "notion_duplicate_id"]);
  assert.strictEqual(h.count("findLinkedUretIds"), 0);
});

test("/show SPEC: a failing linked lookup gives the fixed Notion text", async () => {
  const h = harness({
    records: { "SPEC-001": specPage() },
    onLinked: () => {
      throw Object.assign(new Error("x"), { label: "notion_unauthorized" });
    },
  });
  const out = await h.send("/show SPEC-001");
  assert.deepStrictEqual([out.reply, out.label], ["Notion: Access problem", "notion_unauthorized"]);
});

test("/show rejects unknown or malformed prefixes without reading Notion", async () => {
  const h = harness();
  for (const t of ["/show SPC-001", "/show SPEC-0", "/show SPEC-1a", "/show WPX-001", "/show EVD-001", "/show REL-001", "/show SPEC 1"]) {
    assert.strictEqual((await h.send(t)).reply, "Invalid URET ID. Examples: /show OPP-001, /show SPEC-001, /show WP-001", t);
  }
  assert.strictEqual(h.calls.length, 0);
});

test("/show OPP keeps its Phase 2A format and does no linked lookup", async () => {
  const h = harness({ records: { "OPP-002": oppPage({ properties: { "URET ID": { type: "rich_text", rich_text: rt("OPP-002") } } }) } });
  const reply = (await h.send("/show OPP-002")).reply;
  assert.match(reply, /^URET ID: OPP-002\nName: —\n/);
  assert.strictEqual(h.count("findLinkedUretIds"), 0);
});

test("parseShowId maps OPP, SPEC and WP to their source types", () => {
  assert.deepStrictEqual(opp.parseShowId(" spec-0042 "), { type: "spec", uretId: "SPEC-042" });
  assert.deepStrictEqual(opp.parseShowId("OPP-1000"), { type: "opp", uretId: "OPP-1000" });
  assert.deepStrictEqual(opp.parseShowId("wp-7"), { type: "wp", uretId: "WP-007" });
  for (const bad of ["EVD-1", "REL-1", "SPEC-", "SPEC-0", "", undefined, "constructor-1", "__proto__-1"]) assert.strictEqual(opp.parseShowId(bad), null, String(bad));
});

test("an abort (shutdown) during the parent check is passed on and starts no session", async () => {
  const h = harness({
    onFind: () => {
      throw Object.assign(new Error("x"), { label: "notion_aborted" });
    },
  });
  await assert.rejects(h.send("/new_spec OPP-002"), (err) => err.label === "notion_aborted");
  assert.strictEqual(h.capture.size(), 0);
});
