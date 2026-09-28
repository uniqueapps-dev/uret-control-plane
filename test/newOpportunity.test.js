"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { APIResponseError, RequestTimeoutError } = require("@notionhq/client");
const { createRouter, UNKNOWN_TEXT, NOT_CONFIGURED_TEXT } = require("../bot/commands");
const { createSessionStore } = require("../bot/session");
const { createCaptureStore, FIELDS } = require("../bot/captureSession");
const flows = require("../bot/captureFlows");
const { createNotionWriter } = require("../bot/notionWrite");
const ids = require("../bot/idCounter");
const { tempDir, fakePageId, dashedId, AUTHORIZED_ID } = require("./helpers");

const MIN = 60 * 1000;
const USER = AUTHORIZED_ID;
const TITLE = "URET – Opportunities";

// Refuses anything the write adapter is not allowed to touch.
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

const options = (names) => ({ options: names.map((name) => ({ name })) });
const text = () => ({ type: "rich_text", rich_text: {} });

/**
 * Router wired like index.js: real capture store (with a test clock), real ID
 * counter on a temp file, real write adapter on a fake Notion client, and a
 * fake read adapter. `existing` URET IDs are "found" in Notion.
 */
function harness({ existing = [], onCreate, onFind, configured = true, counters = { OPP: 1, SPEC: 0, WP: 0, EVD: 0, REL: 0 } } = {}) {
  const clock = { t: 5_000_000 };
  const capture = createCaptureStore({ now: () => clock.t });
  const root = fakePageId();
  const dsId = fakePageId();
  const file = path.join(tempDir(), "uret-id-counters.json");
  fs.writeFileSync(file, JSON.stringify(counters, null, 2) + "\n");
  const calls = [];
  const dataSource = {
    object: "data_source",
    in_trash: false,
    title: [{ plain_text: TITLE }],
    database_parent: { type: "page_id", page_id: dashedId(root) },
    properties: {
      "URET ID": text(),
      Name: { type: "title", title: {} },
      Status: { type: "select", select: options(["Idea", "Active", "Parked", "Done"]) },
      "Asset type": { type: "multi_select", multi_select: options(flows.ASSET_TYPES) },
      "Project / Asset": text(),
      "Problem summary": text(),
      "Target users": text(),
      "Success metrics": text(),
      "Next action": text(),
    },
  };
  const client = guard({
    dataSources: {
      retrieve: async (args) => {
        calls.push({ method: "dataSources.retrieve", args });
        return dataSource;
      },
    },
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
      if (onFind) return onFind(type, id);
      return existing.includes(id) ? { result: "found", page: {}, trashed: false } : { result: "not_found", page: null, trashed: false };
    },
    getDataSourceId: async (type) => {
      calls.push({ method: "getDataSourceId", type });
      return dsId;
    },
  };
  const writer = createNotionWriter({ client, rootPageId: root, resolveDataSource: reader.getDataSourceId });
  const reserveId = (type, { signal } = {}) => ids.reserveNextId(type, reader, { file, signal });
  const router = createRouter({
    sessions: createSessionStore(),
    configStatus: { TELEGRAM_BOT_TOKEN: "valid", TELEGRAM_ALLOWED_USER_ID: "valid" },
    logDir: path.join(tempDir(), "logs"),
    notion: configured ? reader : null,
    writer: configured ? writer : null,
    reserveId: configured ? reserveId : null,
    capture,
  });
  const send = (t, extra = {}) => router.route({ text: t, chatId: USER, ...extra });
  const count = (method) => calls.filter((c) => c.method === method).length;
  const counter = () => JSON.parse(fs.readFileSync(file, "utf8")).OPP;
  return { router, send, calls, count, counter, capture, clock, file, dsId, dataSource };
}

const ANSWERS = ["Bike maintenance tracker", "1", "Bike Tracker", "Missed services", "Cyclists", "50 weekly users", "Create prototype brief"];

async function answerAll(h, answers = ANSWERS) {
  let out;
  for (const a of answers) out = await h.send(a);
  return out;
}

const EXPECTED_CONFIRMATION = [
  "Created OPP-002",
  "",
  "Title: Bike maintenance tracker",
  "Asset type: App/PWA",
  "Project / Asset: Bike Tracker",
  "Status: Idea",
  "Next action: Create prototype brief",
  "",
  "Stored in URET – Opportunities.",
].join("\n");

// --- Definition ----------------------------------------------------------------------

test("the flow asks the 7 locked questions, keyed like the capture store", () => {
  const flow = flows.FLOWS.new_opportunity;
  assert.deepStrictEqual(flow.questions.map((q) => q.key), FIELDS.new_opportunity);
  assert.deepStrictEqual(flow.questions.map((q) => q.label), ["Title", "Asset type", "Project / Asset", "Problem summary", "Target users", "Success metrics", "Next action"]);
  assert.deepStrictEqual(flows.ASSET_TYPES, ["App/PWA", "Ebook", "Video series", "Landing page / site", "Template"]);
});

// --- Full flow -------------------------------------------------------------------------

test("full flow: 7 questions, one ID reservation, one pages.create, the confirmation", async () => {
  const h = harness();
  const first = await h.send("/new_opportunity");
  assert.strictEqual(first.command, "new_opportunity");
  assert.strictEqual(first.reply, "New Opportunity: 7 questions. Send /cancel to stop.\n\n1/7 Title? (max 200 characters)");
  assert.strictEqual(h.calls.length, 0, "Notion touched before the answers");

  const prompts = [];
  for (const a of ANSWERS.slice(0, -1)) prompts.push((await h.send(a)).reply);
  assert.deepStrictEqual(prompts.map((p) => p.split(" ")[0]), ["2/7", "3/7", "4/7", "5/7", "6/7", "7/7"]);
  assert.match(prompts[0], /1\. App\/PWA\n2\. Ebook\n3\. Video series\n4\. Landing page \/ site\n5\. Template/);
  assert.strictEqual(h.calls.length, 0, "Notion touched before the last answer");

  const last = await h.send(ANSWERS[6]);
  assert.strictEqual(last.command, "new_opportunity");
  assert.strictEqual(last.label, undefined);
  assert.strictEqual(last.reply, EXPECTED_CONFIRMATION);
  assert.deepStrictEqual(h.calls.map((c) => c.method), ["findByUretId", "getDataSourceId", "dataSources.retrieve", "pages.create"]);
  assert.strictEqual(h.calls[0].id, "OPP-002");
  assert.strictEqual(h.counter(), 2);
  assert.strictEqual(h.capture.getActiveSession(USER), null, "session kept after success");
  assert.strictEqual(fs.existsSync(`${h.file}.lock`), false);
});

test("the created record has Status Idea and exactly the answers given", async () => {
  const h = harness();
  await h.send("/new_opportunity");
  await answerAll(h);
  const props = h.calls.find((c) => c.method === "pages.create").args.properties;
  const plain = (p) => p.rich_text.map((t) => t.text.content).join("");
  assert.deepStrictEqual(props.Status, { select: { name: "Idea" } });
  assert.strictEqual(props.Name.title[0].text.content, "Bike maintenance tracker");
  assert.strictEqual(plain(props["URET ID"]), "OPP-002");
  assert.deepStrictEqual(props["Asset type"], { multi_select: [{ name: "App/PWA" }] });
  assert.strictEqual(plain(props["Project / Asset"]), "Bike Tracker");
  assert.strictEqual(plain(props["Problem summary"]), "Missed services");
  assert.strictEqual(plain(props["Target users"]), "Cyclists");
  assert.strictEqual(plain(props["Success metrics"]), "50 weekly users");
  assert.strictEqual(plain(props["Next action"]), "Create prototype brief");
});

test("an ID that already exists in Notion is skipped", async () => {
  const h = harness({ existing: ["OPP-002", "OPP-003"] });
  await h.send("/new_opportunity");
  const out = await answerAll(h);
  assert.match(out.reply, /^Created OPP-004\n/);
  assert.strictEqual(h.counter(), 4);
});

test("asset type accepts a number or the exact name (any case); '-' leaves a free-text answer empty", async () => {
  const h = harness();
  await h.send("/new_opportunity");
  const out = await answerAll(h, ["Title", "landing page / site", "-", "-", "-", "-", "-"]);
  assert.strictEqual(
    out.reply,
    ["Created OPP-002", "", "Title: Title", "Asset type: Landing page / site", "Project / Asset: —", "Status: Idea", "Next action: —", "", "Stored in URET – Opportunities."].join("\n")
  );
  const props = h.calls.find((c) => c.method === "pages.create").args.properties;
  assert.deepStrictEqual(props["Next action"], { rich_text: [] });
});

// --- Validation --------------------------------------------------------------------------

test("an invalid asset type is rejected, the question repeated, and nothing written", async () => {
  const h = harness();
  await h.send("/new_opportunity");
  await h.send("Title");
  for (const bad of ["6", "0", "Book", "App", "1.0", "  "]) {
    const out = await h.send(bad);
    assert.match(out.reply, /^Invalid asset type\. Reply with a number from 1 to 5\.\n\n2\/7 Asset type\?/);
  }
  assert.strictEqual(h.capture.getActiveSession(USER).step, 1);
  assert.strictEqual(h.calls.length, 0);
  assert.match((await h.send("5")).reply, /^3\/7 /);
});

test("invalid titles are rejected with the reason; nothing written", async () => {
  const h = harness();
  await h.send("/new_opportunity");
  const cases = [
    ["   ", "The title cannot be empty."],
    ["x".repeat(201), "The title is too long (max 200 characters)."],
    ["line one\nline two", "The title must be a single line."],
  ];
  for (const [bad, reason] of cases) {
    assert.strictEqual((await h.send(bad)).reply, `${reason}\n\n1/7 Title? (max 200 characters)`);
  }
  assert.match((await h.send("😀".repeat(200))).reply, /^2\/7 /, "200 emoji are 200 characters");
  assert.strictEqual(h.calls.length, 0);
});

test("empty or over-long free-text answers are rejected; non-text messages are asked again", async () => {
  const h = harness();
  await h.send("/new_opportunity");
  await h.send("Title");
  await h.send("2");
  assert.strictEqual((await h.send("  ")).reply, "Please answer, or send - to leave it empty.\n\n3/7 Project / Asset? (send - to leave empty)");
  assert.match((await h.send("y".repeat(2001))).reply, /^Too long \(max 2000 characters\)\./);
  assert.match((await h.send(undefined)).reply, /^Please answer with text\.\n\n3\/7 /);
  assert.strictEqual(h.capture.getActiveSession(USER).step, 2);
  assert.strictEqual(h.calls.length, 0);
});

// --- Sessions: timeout, cancel, one at a time -------------------------------------------

test("session timeout: the expiry message is shown once and nothing is written", async () => {
  const h = harness();
  await h.send("/new_opportunity");
  await h.send("Title");
  h.clock.t += 31 * MIN;
  const out = await h.send("Ebook");
  assert.strictEqual(out.reply, "Session expired. Use /cancel to stop or /new_opportunity to restart.");
  assert.strictEqual((await h.send("more text")).reply, UNKNOWN_TEXT);
  assert.strictEqual(h.calls.length, 0);
  assert.strictEqual(h.counter(), 1);
});

test("an expired session is cleaned up on any command, and its notice survives until the next text", async () => {
  const h = harness();
  await h.send("/new_opportunity");
  h.clock.t += 31 * MIN;
  await h.send("/help");
  assert.strictEqual(h.capture.size(), 0);
  assert.match((await h.send("answer")).reply, /^Session expired\./);
});

test("/cancel during a session: no ID reserved, nothing written, session gone", async () => {
  const h = harness();
  await h.send("/new_opportunity");
  await answerAll(h, ANSWERS.slice(0, 6));
  const out = await h.send("/cancel");
  assert.strictEqual(out.command, "cancel");
  assert.strictEqual(out.reply, "Cancelled. No record created.");
  assert.strictEqual(h.calls.length, 0);
  assert.strictEqual(h.counter(), 1);
  assert.strictEqual((await h.send(ANSWERS[6])).reply, UNKNOWN_TEXT);
  assert.strictEqual((await h.send("/cancel")).reply, "No active session to cancel.");
});

test("a second /new_opportunity during a session is refused and the first continues", async () => {
  const h = harness();
  await h.send("/new_opportunity");
  await h.send("Title");
  assert.strictEqual((await h.send("/new_opportunity")).reply, "You already have an active session. Finish it or use /cancel.");
  assert.strictEqual(h.capture.getActiveSession(USER).step, 1);
});

test("other commands work during a session without disturbing it", async () => {
  const h = harness();
  await h.send("/new_opportunity");
  await h.send("Title");
  assert.strictEqual((await h.send("/help")).command, "help");
  assert.strictEqual((await h.send("/nope")).reply, UNKNOWN_TEXT);
  assert.match((await h.send("2")).reply, /^3\/7 /);
});

test("without Notion configuration no session starts", async () => {
  const h = harness({ configured: false });
  const out = await h.send("/new_opportunity");
  assert.deepStrictEqual([out.reply, out.label], [NOT_CONFIGURED_TEXT, "notion_not_configured"]);
  assert.strictEqual(h.capture.size(), 0);
  assert.strictEqual((await h.send("Title")).reply, UNKNOWN_TEXT);
});

// --- Failures ------------------------------------------------------------------------------

const apiError = (code, status) => new APIResponseError({ code, status, message: "detail", headers: {}, rawBodyText: "{}" });

test("creation failures reply with the locked texts; the session is gone either way", async () => {
  const cases = [
    [{ onCreate: () => { throw apiError("validation_error", 400); } }, "Notion write failed. Please try again.", "notion_write_failed"],
    [{ onCreate: () => { throw apiError("unauthorized", 401); } }, "Notion access problem. Check configuration.", "notion_unauthorized"],
    [{ onCreate: () => { throw apiError("rate_limited", 429); } }, "Notion is unavailable. Please try again later.", "notion_unavailable"],
    [{ onFind: () => { throw Object.assign(new Error("x"), { label: "notion_timeout" }); } }, "Notion is unavailable. Please try again later.", "notion_unavailable"],
    [{ onFind: () => { throw Object.assign(new Error("x"), { label: "notion_source_not_found" }); } }, "Notion access problem. Check configuration.", "notion_unauthorized"],
    [{ onFind: () => { throw Object.assign(new Error("x"), { label: "notion_schema_invalid" }); } }, "Notion schema problem. Cannot create record.", "notion_schema_invalid"],
  ];
  for (const [opts, reply, label] of cases) {
    const h = harness(opts);
    await h.send("/new_opportunity");
    const out = await answerAll(h);
    assert.deepStrictEqual([out.reply, out.label], [reply, label]);
    assert.strictEqual(h.capture.getActiveSession(USER), null);
    assert.strictEqual(fs.existsSync(`${h.file}.lock`), false);
  }
});

test("a chosen option missing from Notion stops the write with the schema text", async () => {
  const h = harness();
  h.dataSource.properties["Asset type"] = { type: "multi_select", multi_select: options(["App/PWA", "Ebook"]) };
  await h.send("/new_opportunity");
  const out = await answerAll(h, ["Title", "Template", "a", "b", "c", "d", "e"]);
  assert.deepStrictEqual([out.reply, out.label], ["Notion schema problem. Cannot create record.", "notion_schema_invalid"]);
  assert.strictEqual(h.count("pages.create"), 0);
  assert.strictEqual(h.counter(), 2, "the reserved ID is consumed (no rollback)");
});

test("ID allocation failure (counter locked) replies with the ID text and writes nothing", async () => {
  const h = harness();
  fs.writeFileSync(`${h.file}.lock`, "other run\n");
  await h.send("/new_opportunity");
  const out = await answerAll(h);
  assert.deepStrictEqual([out.reply, out.label], ["ID allocation failed. Please try again.", "id_counter_failed"]);
  assert.strictEqual(h.count("pages.create"), 0);
  assert.strictEqual(h.counter(), 1);
});

test("an unconfirmed create names the reserved ID; the ID is not reused", async () => {
  const h = harness({ onCreate: () => { throw new RequestTimeoutError(); } });
  await h.send("/new_opportunity");
  const out = await answerAll(h);
  assert.deepStrictEqual([out.reply, out.label], ["Notion did not confirm the write. Check Notion for OPP-002 before trying again.", "notion_write_unconfirmed"]);
  assert.strictEqual(h.counter(), 2, "reserved ID given back");
});

test("an abort (shutdown) during creation is passed on, not answered", async () => {
  const ac = new AbortController();
  const h = harness({ onCreate: () => { ac.abort(); return new Promise(() => {}); } });
  await h.send("/new_opportunity");
  for (const a of ANSWERS.slice(0, 6)) await h.send(a);
  await assert.rejects(h.send(ANSWERS[6], { signal: ac.signal }), (err) => err.label === "notion_aborted");
});

test("answers never reach the logged fields (command and label)", async () => {
  const h = harness();
  const seen = [];
  const out0 = await h.send("/new_opportunity");
  seen.push(out0.command, out0.label);
  for (const a of ANSWERS) {
    const out = await h.send(a);
    seen.push(out.command, out.label);
  }
  const logged = seen.filter(Boolean).join(" ");
  for (const a of ANSWERS.filter((x) => x.length > 1)) assert.ok(!logged.includes(a), `answer in logged fields: ${a}`);
  assert.deepStrictEqual([...new Set(seen.filter(Boolean))], ["new_opportunity"]);
});
