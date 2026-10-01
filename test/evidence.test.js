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
const select = (names) => ({ type: "select", select: { options: names.map((name) => ({ name })) } });

/**
 * Router wired like index.js with a fake read adapter. `records` maps a URET ID
 * to a page ("found"), "duplicate", or { trashed: page }; others are not found.
 * The counter file starts as committed after the Phase 3-5 live run.
 */
function harness({ records = {}, onFind, onCreate, configured = true, counters = { OPP: 2, SPEC: 2, WP: 2, EVD: 0, REL: 0 } } = {}) {
  const clock = { t: 3_000_000 };
  const capture = createCaptureStore({ now: () => clock.t });
  const root = fakePageId();
  const file = tempCounterFile(counters);
  const calls = [];
  // The Evidence schema as the setup script creates it (no Status).
  const dataSource = {
    object: "data_source",
    in_trash: false,
    title: rt("URET – Evidence"),
    database_parent: { type: "page_id", page_id: dashedId(root) },
    properties: {
      "URET ID": text(),
      Name: { type: "title", title: {} },
      "Work package": { type: "relation", relation: {} },
      Type: select(["Test results", "User feedback", "Research", "Metrics", "Observation"]),
      Summary: text(),
      Verdict: select(["Pass", "Fail", "Mixed", "N/A"]),
      "Evidence link": { type: "url", url: {} },
      Date: { type: "date", date: {} },
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
    getDataSourceId: async (type) => (calls.push({ method: "getDataSourceId", type }), fakePageId()),
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
  const counter = () => JSON.parse(fs.readFileSync(file, "utf8")).EVD;
  const created = () => calls.find((c) => c.method === "pages.create").args.properties;
  return { send, calls, methods, count, counter, capture, clock, created, file, dataSource };
}

const wpPage = (extra = {}) => ({ object: "page", id: fakePageId(), in_trash: false, properties: {}, ...extra });
const ANSWERS = [
  "2",
  "Prototype works on LG G8X. Expense logging is clear.",
  "1",
  "Next oil-change date needs to be more visible on home screen.\nTested on two rides.",
  "Add service card to dashboard.",
];
const plain = (prop) => prop.rich_text.map((t) => t.text.content).join("");

async function answerAll(h, answers = ANSWERS) {
  let out;
  for (const a of answers) out = await h.send(a);
  return out;
}

// --- Definition --------------------------------------------------------------------------

test("the Evidence flow asks the 5 locked questions, keyed like the capture store", () => {
  const flow = flows.FLOWS.new_evidence;
  assert.deepStrictEqual(flow.questions.map((q) => q.key), FIELDS.new_evidence);
  assert.deepStrictEqual(flow.questions.map((q) => q.label), ["Type", "Summary", "Verdict", "Details", "Next action"]);
  assert.deepStrictEqual(flows.EVIDENCE_TYPES, ["Observation", "Test results", "Research", "User feedback", "Metrics"]);
  assert.deepStrictEqual(flows.VERDICTS, ["Pass", "Fail", "Mixed", "N/A"]);
});

// --- Full flow -----------------------------------------------------------------------------

test("/new_evidence full flow: WP checked, 5 questions, Evidence created and linked", async () => {
  const parent = wpPage();
  const h = harness({ records: { "WP-002": parent } });
  const first = await h.send("/new_evidence wp-2");
  assert.strictEqual(first.command, "new_evidence");
  assert.strictEqual(
    first.reply,
    "New Evidence for WP-002: 5 questions. Send /cancel to stop.\n\n1/5 Type? Reply with a number:\n1. Observation\n2. Test results\n3. Research\n4. User feedback\n5. Metrics"
  );
  assert.deepStrictEqual(h.calls.map((c) => [c.method, c.type, c.id]), [["findByUretId", "wp", "WP-002"]]);

  const prompts = [];
  for (const a of ANSWERS.slice(0, -1)) prompts.push((await h.send(a)).reply);
  assert.deepStrictEqual(prompts, [
    "2/5 Summary? (max 500 characters)",
    "3/5 Verdict? Reply with a number:\n1. Pass\n2. Fail\n3. Mixed\n4. N/A",
    "4/5 Details? (max 2000 characters)",
    "5/5 Next action? (max 500 characters)",
  ]);
  assert.strictEqual(h.calls.length, 1, "Notion touched during the questions");

  const last = await h.send(ANSWERS[4]);
  assert.strictEqual(last.command, "new_evidence");
  assert.strictEqual(
    last.reply,
    [
      "Created EVD-001",
      "",
      "Type: Test results",
      "Verdict: Pass",
      "Work package: WP-002",
      "Summary: Prototype works on LG G8X. Expense logging is clear.",
      "",
      "Stored in URET – Evidence.",
    ].join("\n")
  );
  assert.deepStrictEqual(h.methods(), ["findByUretId", "findByUretId", "findByUretId", "getDataSourceId", "dataSources.retrieve", "pages.create"]);
  assert.deepStrictEqual([h.calls[1].type, h.calls[1].id], ["wp", "WP-002"], "Work package not checked again before creating");
  assert.deepStrictEqual([h.calls[2].type, h.calls[2].id], ["evd", "EVD-001"]);
  assert.strictEqual(h.counter(), 1);
  assert.strictEqual(h.capture.getActiveSession(USER), null);
});

test("the Evidence record: Work package relation, Type, Verdict, structured Summary, no Status", async () => {
  const parent = wpPage();
  const h = harness({ records: { "WP-002": parent } });
  await h.send("/new_evidence WP-002");
  await answerAll(h);
  const props = h.created();
  assert.deepStrictEqual(Object.keys(props).sort(), ["Name", "Summary", "Type", "URET ID", "Verdict", "Work package"]);
  assert.strictEqual(props.Status, undefined);
  assert.deepStrictEqual(props["Work package"], { relation: [{ id: parent.id }] });
  assert.deepStrictEqual(props.Type, { select: { name: "Test results" } });
  assert.deepStrictEqual(props.Verdict, { select: { name: "Pass" } });
  assert.strictEqual(plain(props["URET ID"]), "EVD-001");
  assert.strictEqual(
    plain(props.Summary),
    [
      "Prototype works on LG G8X. Expense logging is clear.",
      "",
      "Details:",
      "Next oil-change date needs to be more visible on home screen.",
      "Tested on two rides.",
      "",
      "Next action:",
      "Add service card to dashboard.",
    ].join("\n")
  );
  assert.strictEqual(props.Name.title[0].text.content, "Prototype works on LG G8X. Expense logging is clear.");
});

test("the record's Name is the summary on one line", async () => {
  const h = harness({ records: { "WP-002": wpPage() } });
  await h.send("/new_evidence WP-002");
  await answerAll(h, ["observation", "Works\non   the phone", "n/a", "Details", "Next"]);
  const props = h.created();
  assert.strictEqual(props.Name.title.map((t) => t.text.content).join(""), "Works on the phone");
  assert.deepStrictEqual(props.Type, { select: { name: "Observation" } });
  assert.deepStrictEqual(props.Verdict, { select: { name: "N/A" } });
  assert.match(plain(props.Summary), /^Works\non {3}the phone\n\nDetails:\nDetails\n\nNext action:\nNext$/);
});

test("an existing Evidence ID (the setup script's EVD-001) is skipped", async () => {
  const h = harness({
    records: { "WP-002": wpPage() },
    onFind: (type, id) => (type === "evd" && id === "EVD-001" ? { result: "found", page: {}, trashed: false } : null),
  });
  await h.send("/new_evidence WP-002");
  assert.match((await answerAll(h)).reply, /^Created EVD-002\n/);
  assert.strictEqual(h.counter(), 2);
});

// --- Validation ------------------------------------------------------------------------------

test("invalid Type and Verdict answers are rejected and asked again; nothing written", async () => {
  const h = harness({ records: { "WP-002": wpPage() } });
  await h.send("/new_evidence WP-002");
  for (const bad of ["6", "0", "Test", "results", ""]) {
    assert.match((await h.send(bad)).reply, /^Invalid type\. Reply with a number from 1 to 5\.\n\n1\/5 Type\?/);
  }
  await h.send("Metrics");
  await h.send("Summary");
  for (const bad of ["5", "Passed", "NA", "N", "ok"]) {
    assert.match((await h.send(bad)).reply, /^Invalid verdict\. Reply with a number from 1 to 4\.\n\n3\/5 Verdict\?/);
  }
  assert.strictEqual(h.capture.getActiveSession(USER).step, 2);
  assert.strictEqual(h.count("pages.create"), 0);
});

test("text answers are required (no '-' to skip) and limited: 500, 2000, 500 characters", async () => {
  const h = harness({ records: { "WP-002": wpPage() } });
  await h.send("/new_evidence WP-002");
  await h.send("1");
  assert.strictEqual((await h.send("   ")).reply, "Answer required. This field cannot be empty.\n\n2/5 Summary? (max 500 characters)");
  assert.strictEqual((await h.send(" - ")).reply, "Answer required. This field cannot be empty.\n\n2/5 Summary? (max 500 characters)");
  assert.match((await h.send("s".repeat(501))).reply, /^Too long \(max 500 characters\)\./);
  assert.match((await h.send("s".repeat(500))).reply, /^3\/5 /);
  await h.send("2");
  assert.match((await h.send("d".repeat(2001))).reply, /^Too long \(max 2000 characters\)\.\n\n4\/5 /);
  assert.match((await h.send("d".repeat(2000))).reply, /^5\/5 /);
  assert.match((await h.send("n".repeat(501))).reply, /^Too long \(max 500 characters\)\.\n\n5\/5 /);
  assert.match((await h.send(undefined)).reply, /^Please answer with text\.\n\n5\/5 /);
  assert.strictEqual(h.count("pages.create"), 0);
});

test("'-' is not accepted as an answer to any of the three text questions", async () => {
  const h = harness({ records: { "WP-002": wpPage() } });
  await h.send("/new_evidence WP-002");
  await h.send("1");
  assert.match((await h.send("-")).reply, /^Answer required\. This field cannot be empty\.\n\n2\/5 /);
  await h.send("Summary");
  await h.send("1");
  assert.match((await h.send("-")).reply, /^Answer required\. This field cannot be empty\.\n\n4\/5 /);
  await h.send("Details");
  assert.match((await h.send("-")).reply, /^Answer required\. This field cannot be empty\.\n\n5\/5 /);
  assert.strictEqual(h.capture.getActiveSession(USER).step, 4);
  assert.strictEqual(h.count("pages.create"), 0);
  assert.match((await h.send("--")).reply, /^Created EVD-001\n/, "only a bare '-' is refused");
});

test("the record's Name is cut to 200 characters; Summary keeps the full text", async () => {
  const h = harness({ records: { "WP-002": wpPage() } });
  const summary = "😀".repeat(150) + " " + "x".repeat(300);
  await h.send("/new_evidence WP-002");
  await answerAll(h, ["1", summary, "1", "Details", "Next"]);
  const props = h.created();
  const name = props.Name.title.map((t) => t.text.content).join("");
  assert.strictEqual(Array.from(name).length, 200);
  assert.strictEqual(name, "😀".repeat(150) + " " + "x".repeat(49));
  assert.ok(plain(props.Summary).startsWith(summary + "\n\nDetails:"));
});

// --- Parent checks ----------------------------------------------------------------------------

test("/new_evidence without an argument, or with a non-WP ID, shows usage and reads nothing", async () => {
  const h = harness();
  assert.strictEqual((await h.send("/new_evidence")).reply, "Usage: /new_evidence <WP-ID>\nExample: /new_evidence WP-001");
  for (const t of ["/new_evidence SPEC-001", "/new_evidence OPP-002", "/new_evidence EVD-001", "/new_evidence WP-0", "/new_evidence wp"]) {
    assert.strictEqual((await h.send(t)).reply, "Invalid Work package ID. Example: /new_evidence WP-001", t);
  }
  assert.strictEqual(h.calls.length, 0);
  assert.strictEqual(h.capture.size(), 0);
});

test("Work package not found: no session starts", async () => {
  const h = harness();
  assert.strictEqual((await h.send("/new_evidence WP-999")).reply, "Work package WP-999 not found.");
  assert.strictEqual(h.capture.size(), 0);
  assert.strictEqual((await h.send("2")).reply, UNKNOWN_TEXT);
});

test("Work package duplicated: data integrity text, no session", async () => {
  const h = harness({ records: { "WP-002": "duplicate" } });
  const out = await h.send("/new_evidence WP-002");
  assert.deepStrictEqual([out.reply, out.label], ["Data integrity problem: multiple records found for WP-002.", "notion_duplicate_id"]);
  assert.strictEqual(h.capture.size(), 0);
});

test("Work package in the trash: no session", async () => {
  const h = harness({ records: { "WP-002": { trashed: wpPage({ in_trash: true }) } } });
  assert.strictEqual((await h.send("/new_evidence WP-002")).reply, "Work package WP-002 is in the trash.");
  assert.strictEqual(h.capture.size(), 0);
});

test("Work package removed before the last answer: nothing reserved or written", async () => {
  const records = { "WP-002": wpPage() };
  const h = harness({ records });
  await h.send("/new_evidence WP-002");
  delete records["WP-002"];
  assert.strictEqual((await answerAll(h)).reply, "Work package WP-002 not found.");
  assert.strictEqual(h.count("pages.create"), 0);
  assert.strictEqual(h.counter(), 0);
});

// --- Sessions and failures -----------------------------------------------------------------------

test("session timeout: expiry message names /new_evidence; nothing written", async () => {
  const h = harness({ records: { "WP-002": wpPage() } });
  await h.send("/new_evidence WP-002");
  await h.send("1");
  h.clock.t += 31 * MIN;
  assert.strictEqual((await h.send("Summary")).reply, "Session expired. Use /cancel to stop or /new_evidence to restart.");
  assert.strictEqual(h.count("pages.create"), 0);
  assert.strictEqual(h.counter(), 0);
});

test("/cancel during /new_evidence: nothing reserved or written", async () => {
  const h = harness({ records: { "WP-002": wpPage() } });
  await h.send("/new_evidence WP-002");
  await answerAll(h, ANSWERS.slice(0, 4));
  assert.strictEqual((await h.send("/cancel")).reply, "Cancelled. No record created.");
  assert.deepStrictEqual(h.methods(), ["findByUretId"]);
  assert.strictEqual(h.counter(), 0);
  assert.strictEqual((await h.send(ANSWERS[4])).reply, UNKNOWN_TEXT);
});

test("one session at a time across all four creation commands", async () => {
  const h = harness({ records: { "WP-002": wpPage(), "SPEC-002": wpPage() } });
  await h.send("/new_evidence WP-002");
  for (const t of ["/new_opportunity", "/new_work SPEC-002", "/new_evidence WP-002"]) {
    assert.strictEqual((await h.send(t)).reply, "You already have an active session. Finish it or use /cancel.", t);
  }
  await h.send("/cancel");
  await h.send("/new_opportunity");
  assert.strictEqual((await h.send("/new_evidence WP-002")).reply, "You already have an active session. Finish it or use /cancel.");
});

test("without Notion configuration /new_evidence starts nothing", async () => {
  const h = harness({ configured: false });
  assert.strictEqual((await h.send("/new_evidence WP-002")).reply, NOT_CONFIGURED_TEXT);
  assert.strictEqual(h.capture.size(), 0);
});

test("a schema problem in Evidence stops the write with the locked text", async () => {
  const h = harness({ records: { "WP-002": wpPage() } });
  delete h.dataSource.properties.Verdict;
  await h.send("/new_evidence WP-002");
  const out = await answerAll(h);
  assert.deepStrictEqual([out.reply, out.label], ["Notion schema problem. Cannot create record.", "notion_schema_invalid"]);
  assert.strictEqual(h.count("pages.create"), 0);
});

test("an unconfirmed Evidence create names the reserved EVD ID", async () => {
  const h = harness({
    records: { "WP-002": wpPage() },
    onCreate: () => {
      throw new RequestTimeoutError();
    },
  });
  await h.send("/new_evidence WP-002");
  const out = await answerAll(h);
  assert.deepStrictEqual([out.reply, out.label], ["Notion did not confirm the write. Check Notion for EVD-001 before trying again.", "notion_write_unconfirmed"]);
});

test("answers never reach the logged fields (command and label)", async () => {
  const h = harness({ records: { "WP-002": wpPage() } });
  const seen = [];
  for (const t of ["/new_evidence WP-002", ...ANSWERS]) {
    const out = await h.send(t);
    seen.push(out.command, out.label);
  }
  assert.deepStrictEqual([...new Set(seen.filter(Boolean))], ["new_evidence"]);
});
