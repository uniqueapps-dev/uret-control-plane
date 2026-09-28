"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { createRouter, UNKNOWN_TEXT, NOT_CONFIGURED_TEXT } = require("../bot/commands");
const { createSessionStore } = require("../bot/session");
const { createCaptureStore, FIELDS } = require("../bot/captureSession");
const flows = require("../bot/captureFlows");
const { createNotionWriter } = require("../bot/notionWrite");
const ids = require("../bot/idCounter");
const { tempDir, fakePageId, dashedId, AUTHORIZED_ID } = require("./helpers");

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
const select = (names) => ({ type: "select", select: { options: names.map((name) => ({ name })) } });

/**
 * Router wired like index.js with a fake read adapter. `records` maps a URET ID
 * to a page ("found"), "duplicate", or { trashed: page }; others are not found.
 */
function harness({ records = {}, linked = { uretIds: [], more: false }, onFind, onLinked, configured = true } = {}) {
  const clock = { t: 7_000_000 };
  const capture = createCaptureStore({ now: () => clock.t });
  const root = fakePageId();
  const file = path.join(tempDir(), "uret-id-counters.json");
  fs.writeFileSync(file, JSON.stringify({ OPP: 2, SPEC: 1, WP: 0, EVD: 0, REL: 0 }, null, 2) + "\n");
  const calls = [];
  const dataSource = {
    object: "data_source",
    in_trash: false,
    title: rt("URET – Work Packages"),
    database_parent: { type: "page_id", page_id: dashedId(root) },
    properties: {
      "URET ID": text(),
      Name: { type: "title", title: {} },
      Status: select(["Draft", "Ready", "In progress", "Done"]),
      Spec: { type: "relation", relation: {} },
      Type: select(flows.WORK_TYPES),
      Worker: select(flows.WORKERS),
      Summary: text(),
      Instructions: text(),
      Outputs: text(),
    },
  };
  const client = guard({
    dataSources: { retrieve: async () => (calls.push({ method: "dataSources.retrieve" }), dataSource) },
    pages: { create: async (args) => (calls.push({ method: "pages.create", args }), { object: "page", id: fakePageId() }) },
  });
  const reader = {
    findByUretId: async (type, id, opts) => {
      calls.push({ method: "findByUretId", type, id, opts });
      if (onFind) {
        const custom = onFind(type, id);
        if (custom) return custom;
      }
      const r = records[id];
      if (r === "duplicate") return { result: "duplicate", page: null, trashed: false };
      if (r && r.trashed) return { result: "found", page: r.trashed, trashed: true };
      if (r) return { result: "found", page: r, trashed: false };
      return { result: "not_found", page: null, trashed: false };
    },
    findLinkedUretIds: async (type, relation, pageId) => {
      calls.push({ method: "findLinkedUretIds", type, relation, pageId });
      if (onLinked) return onLinked();
      return linked;
    },
    getDataSourceId: async () => (calls.push({ method: "getDataSourceId" }), fakePageId()),
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
  const send = (t) => router.route({ text: t, chatId: USER });
  const methods = () => calls.map((c) => c.method);
  const count = (method) => calls.filter((c) => c.method === method).length;
  const counter = () => JSON.parse(fs.readFileSync(file, "utf8")).WP;
  const created = () => calls.find((c) => c.method === "pages.create").args.properties;
  return { send, calls, methods, count, counter, capture, clock, created };
}

const specPage = (extra = {}) => ({ object: "page", id: fakePageId(), in_trash: false, properties: {}, ...extra });
const ANSWERS = ["Harden Bike Tracker prototype", "5", "1", "Make it robust", "Add tests", "A PR"];

async function answerAll(h, answers = ANSWERS) {
  let out;
  for (const a of answers) out = await h.send(a);
  return out;
}

// --- Definition --------------------------------------------------------------------------

test("the Work Package flow asks the 6 locked questions, keyed like the capture store", () => {
  const flow = flows.FLOWS.new_work;
  assert.deepStrictEqual(flow.questions.map((q) => q.key), FIELDS.new_work);
  assert.deepStrictEqual(flow.questions.map((q) => q.label), ["Title", "Type", "Worker", "Summary", "Instructions", "Outputs"]);
  assert.deepStrictEqual(flows.WORK_TYPES, ["Prototype", "Feature", "Bug fix", "Research", "Hardening"]);
  assert.deepStrictEqual(flows.WORKERS, ["Claude Code", "Manual"]);
});

// --- /new_work full flow ---------------------------------------------------------------------

test("/new_work full flow: Spec checked, 6 questions, WP-001 created as Draft and linked", async () => {
  const parent = specPage();
  const h = harness({ records: { "SPEC-001": parent } });
  const first = await h.send("/new_work spec-1");
  assert.strictEqual(first.command, "new_work");
  assert.strictEqual(first.reply, "New Work Package for SPEC-001: 6 questions. Send /cancel to stop.\n\n1/6 Title? (max 200 characters)");
  assert.deepStrictEqual(h.calls.map((c) => [c.method, c.type, c.id]), [["findByUretId", "spec", "SPEC-001"]]);

  const prompts = [];
  for (const a of ANSWERS.slice(0, -1)) prompts.push((await h.send(a)).reply);
  assert.strictEqual(prompts[0], "2/6 Type? Reply with a number:\n1. Prototype\n2. Feature\n3. Bug fix\n4. Research\n5. Hardening");
  assert.strictEqual(prompts[1], "3/6 Worker? Reply with a number:\n1. Claude Code\n2. Manual (Emmanuel)");
  assert.deepStrictEqual(prompts.slice(2).map((p) => p.split(" ")[0]), ["4/6", "5/6", "6/6"]);
  assert.strictEqual(h.calls.length, 1, "Notion touched during the questions");

  const last = await h.send(ANSWERS[5]);
  assert.strictEqual(
    last.reply,
    [
      "Created WP-001",
      "",
      "Title: Harden Bike Tracker prototype",
      "Type: Hardening",
      "Worker: Claude Code",
      "Spec: SPEC-001",
      "Status: Draft",
      "",
      "Stored in URET – Work Packages.",
    ].join("\n")
  );
  assert.deepStrictEqual(h.methods(), ["findByUretId", "findByUretId", "findByUretId", "getDataSourceId", "dataSources.retrieve", "pages.create"]);
  assert.deepStrictEqual([h.calls[1].type, h.calls[1].id], ["spec", "SPEC-001"], "Spec not checked again before creating");
  assert.deepStrictEqual([h.calls[2].type, h.calls[2].id], ["wp", "WP-001"]);

  const props = h.created();
  const plain = (p) => p.rich_text.map((t) => t.text.content).join("");
  assert.deepStrictEqual(props.Status, { select: { name: "Draft" } });
  assert.deepStrictEqual(props.Spec, { relation: [{ id: parent.id }] });
  assert.deepStrictEqual(props.Type, { select: { name: "Hardening" } });
  assert.deepStrictEqual(props.Worker, { select: { name: "Claude Code" } });
  assert.strictEqual(plain(props["URET ID"]), "WP-001");
  assert.deepStrictEqual([plain(props.Summary), plain(props.Instructions), plain(props.Outputs)], ANSWERS.slice(3));
  assert.strictEqual(h.counter(), 1);
  assert.strictEqual(h.capture.getActiveSession(USER), null);
});

test("Worker 'Emmanuel' (any case) is stored and confirmed as Manual", async () => {
  for (const worker of ["Emmanuel", "emmanuel", " EMMANUEL "]) {
    const h = harness({ records: { "SPEC-001": specPage() } });
    await h.send("/new_work SPEC-001");
    const out = await answerAll(h, ["Title", "feature", worker, "-", "-", "-"]);
    assert.match(out.reply, /\nWorker: Manual\n/, worker);
    assert.deepStrictEqual(h.created().Worker, { select: { name: "Manual" } });
  }
});

test("Worker also accepts 2, 'Manual' and 'claude code'", async () => {
  for (const [input, stored] of [["2", "Manual"], ["manual", "Manual"], ["claude code", "Claude Code"]]) {
    const h = harness({ records: { "SPEC-001": specPage() } });
    await h.send("/new_work SPEC-001");
    await answerAll(h, ["Title", "1", input, "-", "-", "-"]);
    assert.deepStrictEqual(h.created().Worker, { select: { name: stored } }, input);
  }
});

test("invalid Type and Worker answers are rejected and asked again; nothing written", async () => {
  const h = harness({ records: { "SPEC-001": specPage() } });
  await h.send("/new_work SPEC-001");
  await h.send("Title");
  for (const bad of ["6", "Hotfix", ""]) assert.match((await h.send(bad)).reply, /^Invalid type\. Reply with a number from 1 to 5\.\n\n2\/6 Type\?/);
  await h.send("2");
  for (const bad of ["3", "Emma", "Claude", "Manual worker"]) assert.match((await h.send(bad)).reply, /^Invalid worker\. Reply with a number from 1 to 2\.\n\n3\/6 Worker\?/);
  assert.strictEqual(h.capture.getActiveSession(USER).step, 2);
  assert.strictEqual(h.count("pages.create"), 0);
});

// --- Parent checks --------------------------------------------------------------------------

test("/new_work without an argument, or with a non-SPEC ID, shows usage and reads nothing", async () => {
  const h = harness();
  assert.strictEqual((await h.send("/new_work")).reply, "Usage: /new_work <SPEC-ID>\nExample: /new_work SPEC-001");
  for (const t of ["/new_work OPP-001", "/new_work WP-001", "/new_work SPEC-0", "/new_work spec"]) {
    assert.strictEqual((await h.send(t)).reply, "Invalid Spec ID. Example: /new_work SPEC-001", t);
  }
  assert.strictEqual(h.calls.length, 0);
});

test("Spec not found: no session starts", async () => {
  const h = harness();
  assert.strictEqual((await h.send("/new_work SPEC-999")).reply, "Spec SPEC-999 not found.");
  assert.strictEqual(h.capture.size(), 0);
  assert.strictEqual((await h.send("Title")).reply, UNKNOWN_TEXT);
});

test("Spec duplicated: data integrity text, no session", async () => {
  const h = harness({ records: { "SPEC-001": "duplicate" } });
  const out = await h.send("/new_work SPEC-001");
  assert.deepStrictEqual([out.reply, out.label], ["Data integrity problem: multiple records found for SPEC-001.", "notion_duplicate_id"]);
  assert.strictEqual(h.capture.size(), 0);
});

test("Spec in the trash: no session", async () => {
  const h = harness({ records: { "SPEC-001": { trashed: specPage({ in_trash: true }) } } });
  assert.strictEqual((await h.send("/new_work SPEC-001")).reply, "Spec SPEC-001 is in the trash.");
  assert.strictEqual(h.capture.size(), 0);
});

test("Spec removed before the last answer: nothing reserved or written", async () => {
  const records = { "SPEC-001": specPage() };
  const h = harness({ records });
  await h.send("/new_work SPEC-001");
  delete records["SPEC-001"];
  assert.strictEqual((await answerAll(h)).reply, "Spec SPEC-001 not found.");
  assert.strictEqual(h.count("pages.create"), 0);
  assert.strictEqual(h.counter(), 0);
});

// --- Sessions ----------------------------------------------------------------------------------

test("/cancel, expiry and a second session behave as for the other flows", async () => {
  const h = harness({ records: { "SPEC-001": specPage(), "OPP-001": specPage() } });
  await h.send("/new_work SPEC-001");
  assert.strictEqual((await h.send("/new_spec OPP-001")).reply, "You already have an active session. Finish it or use /cancel.");
  assert.strictEqual((await h.send("/cancel")).reply, "Cancelled. No record created.");
  await h.send("/new_work SPEC-001");
  h.clock.t += 31 * MIN;
  assert.strictEqual((await h.send("Title")).reply, "Session expired. Use /cancel to stop or /new_work to restart.");
  assert.strictEqual(h.count("pages.create"), 0);
  assert.strictEqual(h.counter(), 0);
});

test("without Notion configuration /new_work starts nothing", async () => {
  const h = harness({ configured: false });
  assert.strictEqual((await h.send("/new_work SPEC-001")).reply, NOT_CONFIGURED_TEXT);
  assert.strictEqual(h.capture.size(), 0);
});

// --- /show WP ---------------------------------------------------------------------------------------

const wpPage = (extra = {}) => ({
  object: "page",
  id: fakePageId(),
  in_trash: false,
  url: "https://www.notion.so/Harden-Bike-Tracker-abc",
  properties: {
    "URET ID": { type: "rich_text", rich_text: rt("WP-001") },
    Name: { type: "title", title: rt("Harden Bike Tracker prototype") },
    Type: { type: "select", select: { name: "Hardening" } },
    Worker: { type: "select", select: { name: "Claude Code" } },
    Status: { type: "select", select: { name: "Draft" } },
    Summary: { type: "rich_text", rich_text: rt("Make it robust") },
    Instructions: { type: "rich_text", rich_text: rt("Add tests") },
    Outputs: { type: "rich_text", rich_text: [] },
  },
  ...extra,
});

test("/show WP-001 shows the Work Package with its Spec by URET ID", async () => {
  const page = wpPage();
  const h = harness({ records: { "WP-001": page }, linked: { uretIds: ["SPEC-001"], more: false } });
  const out = await h.send("/show wp-1");
  assert.strictEqual(out.command, "show");
  assert.strictEqual(
    out.reply,
    [
      "WP-001 — Harden Bike Tracker prototype",
      "",
      "Type: Hardening",
      "Worker: Claude Code",
      "Spec: SPEC-001",
      "Status: Draft",
      "Summary: Make it robust",
      "Instructions: Add tests",
      "Outputs: —",
      "",
      "Notion link: https://www.notion.so/Harden-Bike-Tracker-abc",
    ].join("\n")
  );
  assert.deepStrictEqual(h.calls.map((c) => [c.method, c.type]), [["findByUretId", "wp"], ["findLinkedUretIds", "spec"]]);
  assert.deepStrictEqual([h.calls[1].relation, h.calls[1].pageId], ["Work packages", page.id]);
});

test("/show WP: no Spec linked, a missing URL, and a trashed record", async () => {
  const none = harness({ records: { "WP-001": wpPage({ url: "" }) } });
  const reply = (await none.send("/show WP-001")).reply;
  assert.match(reply, /\nSpec: —\n/);
  assert.match(reply, /\nNotion link: unavailable$/);
  const trashed = harness({ records: { "WP-001": { trashed: wpPage({ in_trash: true }) } } });
  assert.match((await trashed.send("/show WP-001")).reply, /^Archived\/trashed record\nWP-001 — /);
});

test("/show WP-999 not found; duplicate reported; a failing Spec lookup gives the Notion text", async () => {
  const h = harness({ records: { "WP-002": "duplicate" } });
  assert.strictEqual((await h.send("/show WP-999")).reply, "Not found: WP-999");
  assert.strictEqual((await h.send("/show WP-002")).label, "notion_duplicate_id");
  assert.strictEqual(h.count("findLinkedUretIds"), 0);
  const failing = harness({
    records: { "WP-001": wpPage() },
    onLinked: () => {
      throw Object.assign(new Error("x"), { label: "notion_timeout" });
    },
  });
  assert.strictEqual((await failing.send("/show WP-001")).reply, "Notion: Unavailable");
});

test("/show rejects invalid WP IDs without reading Notion", async () => {
  const h = harness();
  for (const t of ["/show WP-0", "/show WP-", "/show WPP-001", "/show W-001", "/show WP-1b", "/show WP 1"]) {
    assert.strictEqual((await h.send(t)).reply, "Invalid URET ID. Examples: /show OPP-001, /show SPEC-001, /show WP-001", t);
  }
  assert.strictEqual(h.calls.length, 0);
});
