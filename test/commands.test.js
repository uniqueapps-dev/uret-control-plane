"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const {
  createRouter,
  parseCommand,
  START_TEXT,
  HELP_TEXT,
  UNKNOWN_TEXT,
  NOT_CONFIGURED_TEXT,
  NOTION_ERROR_TEXT,
} = require("../bot/commands");
const opp = require("../bot/opportunities");
const { createSessionStore } = require("../bot/session");
const { tempDir } = require("./helpers");

const VALID_STATUS = { TELEGRAM_BOT_TOKEN: "valid", TELEGRAM_ALLOWED_USER_ID: "valid" };
const ELEVEN = ["/start", "/help", "/cancel", "/status", "/show", "/health", "/new_opportunity", "/new_spec", "/new_work", "/new_evidence", "/update_status"];

// Error shaped like the adapter's NotionReadError: a fixed label only.
const labelled = (label) => Object.assign(new Error(`Notion read failed (${label})`), { label });

// Fake read-only adapter recording every call. `active` answers the /status
// active-work read (default: none), `linked` and `evidence` its per-item reads.
function fakeNotion({ count, find, health, active = { items: [], more: false }, linked = { uretIds: [], more: false }, evidence = { count: 0, incomplete: false } } = {}) {
  const calls = [];
  const answer = (value, ...args) => (typeof value === "function" ? value(...args) : value);
  return {
    calls,
    countByStatus: async (opts) => {
      calls.push({ method: "countByStatus", opts });
      return answer(count, opts);
    },
    findByUretId: async (type, id, opts) => {
      calls.push({ method: "findByUretId", type, id, opts });
      return answer(find, id, opts);
    },
    health: async (opts) => {
      calls.push({ method: "health", opts });
      return answer(health, opts);
    },
    listActiveWork: async (opts) => {
      calls.push({ method: "listActiveWork", opts });
      return answer(active, opts);
    },
    findLinkedUretIds: async (type, relation, pageId, opts) => {
      calls.push({ method: "findLinkedUretIds", type, relation, pageId, opts });
      return answer(linked, pageId, opts);
    },
    countEvidenceForWP: async (pageId, opts) => {
      calls.push({ method: "countEvidenceForWP", pageId, opts });
      return answer(evidence, pageId, opts);
    },
  };
}

function setup(overrides = {}) {
  const base = tempDir();
  const sessions = createSessionStore();
  const router = createRouter({ sessions, configStatus: VALID_STATUS, logDir: path.join(base, "logs"), ...overrides });
  return { base, sessions, router };
}

// --- Parsing and Phase 1 commands -----------------------------------------------

test("parseCommand returns the command name and the text after it", () => {
  assert.deepStrictEqual(parseCommand("/start"), { name: "start", args: "" });
  assert.deepStrictEqual(parseCommand("  /HELP  "), { name: "help", args: "" });
  assert.deepStrictEqual(parseCommand("/cancel@UretBot"), { name: "cancel", args: "" });
  assert.deepStrictEqual(parseCommand("/show OPP-1"), { name: "show", args: "OPP-1" });
  assert.deepStrictEqual(parseCommand("/show@UretBot   opp-001  "), { name: "show", args: "opp-001" });
  assert.deepStrictEqual(parseCommand("/show OPP-1 extra words"), { name: "show", args: "OPP-1 extra words" });
  assert.strictEqual(parseCommand("start"), null);
  assert.strictEqual(parseCommand("/start!"), null);
  assert.strictEqual(parseCommand(undefined), null);
});

test("/start introduces the bot and lists the eleven commands", async () => {
  const { router } = setup();
  const { command, reply } = await router.route({ text: "/start", chatId: 1 });
  assert.strictEqual(command, "start");
  assert.strictEqual(reply, START_TEXT);
  assert.match(reply, /URET Control Bot MVP v0\.1/);
  assert.match(reply, /phone-first/);
  assert.match(reply, /create new Opportunities, Specs, Work Packages and Evidence through guided questions/);
  assert.match(reply, /can change the Status of existing Opportunities, Specs and Work Packages/);
  assert.match(reply, /never deletes records or changes any other field/);
  assert.deepStrictEqual(reply.match(/^\/\w+/gm), ELEVEN);
  assert.doesNotMatch(reply, /notion|hermes|connected/i);
});

test("/help lists exactly the eleven commands", async () => {
  const { router } = setup();
  const { reply } = await router.route({ text: "/help", chatId: 1 });
  assert.strictEqual(reply, HELP_TEXT);
  assert.deepStrictEqual(reply.match(/^\/\w+/gm), ELEVEN);
  assert.match(reply, /^\/show <URET-ID> /m);
});

test("/cancel without a capture session clears the Phase 1 session and says there is nothing to cancel", async () => {
  const notion = fakeNotion();
  const { router, sessions } = setup({ notion });
  sessions.set(1, { step: "placeholder" });
  sessions.set(2, { step: "other chat" });
  const { command, reply } = await router.route({ text: "/cancel", chatId: 1 });
  assert.strictEqual(command, "cancel");
  assert.strictEqual(reply, "No active session to cancel.");
  assert.strictEqual(sessions.get(1), null);
  assert.deepStrictEqual(sessions.get(2), { step: "other chat" }, "other sessions must be untouched");
  assert.strictEqual(notion.calls.length, 0);
});

test("unknown commands and plain text only point to /help; /status and /show are known", async () => {
  const { router } = setup();
  for (const text of ["/new_opp", "/statusx", "/opportunity OPP-001", "hello", "", undefined]) {
    const { command, reply } = await router.route({ text, chatId: 1 });
    assert.strictEqual(command, "unknown");
    assert.strictEqual(reply, UNKNOWN_TEXT);
  }
  for (const [text, name] of [["/status", "status"], ["/show", "show"], ["/show OPP-001", "show"]]) {
    assert.strictEqual((await router.route({ text, chatId: 1 })).command, name);
  }
});

test("every command returns a non-empty string, never a Promise", async () => {
  const notion = fakeNotion({
    count: { outcome: "counts", total: 0, counts: {} },
    find: { result: "not_found", page: null },
    health: { reachable: "ok", sourceFound: "ok", schemaValid: "ok", label: null },
  });
  for (const configured of [null, notion]) {
    const { router } = setup({ notion: configured });
    for (const text of ["/start", "/help", "/cancel", "/status", "/show", "/show OPP-1", "/show bad", "/health", "/nope"]) {
      const pending = router.route({ text, chatId: 1 });
      assert.ok(pending instanceof Promise, "route must be asynchronous");
      const { reply } = await pending;
      assert.strictEqual(typeof reply, "string", text);
      assert.ok(reply.trim() !== "" && !reply.includes("[object Promise]"), text);
    }
  }
});

// --- /status -------------------------------------------------------------------------

test("/status without Notion configuration says only NOT OK", async () => {
  const { router } = setup();
  const out = await router.route({ text: "/status", chatId: 1 });
  assert.strictEqual(out.reply, "Notion configuration: NOT OK");
  assert.strictEqual(out.reply, NOT_CONFIGURED_TEXT);
  assert.strictEqual(out.label, "notion_not_configured");
});

test("/status shows counts, the integrity message or the incomplete message", async () => {
  const cases = [
    [{ outcome: "counts", total: 4, counts: { Idea: 1, Active: 1, Parked: 1, Done: 1 } }, "Notion: Connected\nTotal: 4\nIdea: 1\nActive: 1\nParked: 1\nDone: 1\n\nActive work: None", undefined],
    [{ outcome: "data_integrity", total: 3, counts: { Idea: 2 } }, `${opp.STATUS_INTEGRITY_TEXT}\n\nActive work: None`, "notion_data_integrity"],
    [{ outcome: "incomplete", total: 1000, counts: { Idea: 1000 } }, `${opp.STATUS_INCOMPLETE_TEXT}\n\nActive work: None`, undefined],
  ];
  for (const [result, reply, label] of cases) {
    const notion = fakeNotion({ count: result });
    const { router } = setup({ notion });
    const signal = new AbortController().signal;
    const out = await router.route({ text: "/status", chatId: 1, signal });
    assert.strictEqual(out.reply, reply);
    assert.strictEqual(out.label, label);
    assert.deepStrictEqual(notion.calls.map((c) => c.method), ["countByStatus", "listActiveWork"]);
    for (const call of notion.calls) assert.strictEqual(call.opts.signal, signal, "stop signal not passed to the read");
  }
});

test("/status maps every adapter label to its fixed text", async () => {
  const expected = {
    notion_timeout: "Notion: Unavailable",
    notion_unavailable: "Notion: Unavailable",
    notion_rate_limited: "Notion: Unavailable",
    notion_conflict: "Notion: Unavailable",
    notion_error: "Notion: Unavailable",
    notion_unauthorized: "Notion: Access problem",
    notion_forbidden: "Notion: Access problem",
    notion_not_found: "Notion: Access problem",
    notion_bad_request: "Notion: Request problem",
    notion_source_not_found: "Notion: Configuration or access problem",
    notion_source_ambiguous: "Notion: Configuration or access problem",
    notion_source_invalid: "Notion: Configuration or access problem",
    notion_schema_invalid: "Notion: Schema problem",
    notion_some_new_label: "Notion: Unavailable",
  };
  for (const [label, reply] of Object.entries(expected)) {
    const { router } = setup({
      notion: fakeNotion({
        count: () => {
          throw labelled(label);
        },
      }),
    });
    const out = await router.route({ text: "/status", chatId: 1 });
    assert.strictEqual(out.reply, reply, label);
    assert.strictEqual(out.label, label);
  }
  assert.strictEqual(NOTION_ERROR_TEXT.notion_not_configured, "Notion configuration: NOT OK");
});

test("an aborted read and an unlabelled error propagate instead of producing a reply", async () => {
  for (const error of [labelled("notion_aborted"), new TypeError("bug")]) {
    const { router } = setup({
      notion: fakeNotion({
        count: () => {
          throw error;
        },
      }),
    });
    await assert.rejects(router.route({ text: "/status", chatId: 1 }), (err) => err === error);
  }
});

// --- /show -----------------------------------------------------------------------------

const rt = (text) => [{ type: "text", plain_text: text }];
const samplePage = (extra = {}) => ({
  object: "page",
  in_trash: false,
  url: "https://www.notion.so/example",
  properties: {
    "URET ID": { type: "rich_text", rich_text: rt("OPP-001") },
    Name: { type: "title", title: rt("Setup") },
    Status: { type: "select", select: { name: "Idea" } },
  },
  ...extra,
});

test("/show with no argument returns the exact usage text and reads nothing", async () => {
  const notion = fakeNotion();
  const { router } = setup({ notion });
  for (const text of ["/show", "/show   ", "/show@UretBot"]) {
    const out = await router.route({ text, chatId: 1 });
    assert.strictEqual(out.reply, "Usage: /show <URET-ID>\nExamples: /show OPP-001, /show SPEC-001, /show WP-001");
  }
  assert.strictEqual(notion.calls.length, 0);
});

test("/show rejects malformed IDs without reading Notion", async () => {
  const notion = fakeNotion();
  const { router } = setup({ notion });
  for (const text of ["/show OPP-0", "/show SPEC-0", "/show SPC-1", "/show WP-0", "/show EVD-1", "/show REL-1", "/show pharmacy", "/show OPP-1 extra", "/show OPP1"]) {
    const out = await router.route({ text, chatId: 1 });
    assert.strictEqual(out.reply, "Invalid URET ID. Examples: /show OPP-001, /show SPEC-001, /show WP-001", text);
  }
  assert.strictEqual(notion.calls.length, 0);
});

test("/show normalises the ID before the exact lookup", async () => {
  const notion = fakeNotion({ find: { result: "not_found", page: null } });
  const { router } = setup({ notion });
  const signal = new AbortController().signal;
  for (const input of ["opp-1", "OPP-1", "opp-001", "OPP-001"]) {
    const out = await router.route({ text: `/show ${input}`, chatId: 1, signal });
    assert.strictEqual(out.reply, "Not found: OPP-001");
  }
  assert.deepStrictEqual(notion.calls.map((c) => c.id), ["OPP-001", "OPP-001", "OPP-001", "OPP-001"]);
  assert.ok(notion.calls.every((c) => c.opts.signal === signal));
});

test("/show without Notion configuration says only NOT OK (after validating the ID)", async () => {
  const { router } = setup();
  assert.strictEqual((await router.route({ text: "/show OPP-1", chatId: 1 })).reply, "Notion configuration: NOT OK");
  assert.strictEqual((await router.route({ text: "/show", chatId: 1 })).reply, opp.SHOW_USAGE);
});

test("/show reports found, duplicate and trashed records", async () => {
  const cases = [
    [{ result: "found", page: samplePage() }, opp.buildShowReply(samplePage()), undefined],
    [{ result: "duplicate", page: null }, "Notion: Data integrity problem\nDuplicate URET ID: OPP-042", "notion_duplicate_id"],
    [{ result: "found", page: samplePage({ in_trash: true }), trashed: true }, opp.buildShowReply(samplePage({ in_trash: true })), undefined],
  ];
  for (const [find, reply, label] of cases) {
    const { router } = setup({ notion: fakeNotion({ find }) });
    const out = await router.route({ text: "/show opp-42", chatId: 1 });
    assert.strictEqual(out.reply, reply);
    assert.strictEqual(out.label, label);
  }
  const trashed = await setup({ notion: fakeNotion({ find: { result: "found", page: samplePage({ in_trash: true }) } }) }).router.route({ text: "/show OPP-1", chatId: 1 });
  assert.strictEqual(trashed.reply.split("\n")[0], "Archived/trashed record");
});

test("/show maps adapter failures to fixed texts", async () => {
  const { router } = setup({
    notion: fakeNotion({
      find: () => {
        throw labelled("notion_timeout");
      },
    }),
  });
  const out = await router.route({ text: "/show OPP-1", chatId: 1 });
  assert.deepStrictEqual({ reply: out.reply, label: out.label }, { reply: "Notion: Unavailable", label: "notion_timeout" });
});

// --- /health -----------------------------------------------------------------------------

function healthText(notionLines) {
  return [
    "URET CONTROL BOT HEALTH",
    "",
    "Command handler: OK",
    "Configuration: OK",
    "Session store: OK",
    "Logs: OK",
    ...notionLines,
    "Hermes: Not used / isolated legacy system",
  ].join("\n");
}

test("/health with Notion not configured: NOT OK and the rest NOT CHECKED, no reads", async () => {
  const { router, base } = setup();
  const out = await router.route({ text: "/health", chatId: 1 });
  assert.strictEqual(
    out.reply,
    healthText(["Notion configuration: NOT OK", "Notion reachable: NOT CHECKED", "Opportunities source: NOT CHECKED", "Opportunities schema: NOT CHECKED"])
  );
  assert.strictEqual(out.label, "notion_not_configured");
  assert.doesNotMatch(out.reply, /running|supervis|Telegram|NOTION_|URET_ROOT/i, "claims too much or names variables");
  assert.ok(!out.reply.includes(base), "filesystem path revealed");
  // Only the log folder is touched, and its probe file is cleaned up.
  assert.deepStrictEqual(fs.readdirSync(base), ["logs"]);
  assert.deepStrictEqual(fs.readdirSync(path.join(base, "logs")), []);
});

test("/health reflects each adapter health result truthfully", async () => {
  const cases = [
    [{ reachable: "ok", sourceFound: "ok", schemaValid: "ok", label: null }, ["OK", "OK", "OK", "OK"], undefined],
    [{ reachable: "not_ok", sourceFound: "not_checked", schemaValid: "not_checked", label: "notion_timeout" }, ["OK", "NOT OK", "NOT CHECKED", "NOT CHECKED"], "notion_timeout"],
    [{ reachable: "ok", sourceFound: "not_ok", schemaValid: "not_checked", label: "notion_source_not_found" }, ["OK", "OK", "NOT OK", "NOT CHECKED"], "notion_source_not_found"],
    [{ reachable: "ok", sourceFound: "not_ok", schemaValid: "not_checked", label: "notion_source_ambiguous" }, ["OK", "OK", "NOT OK", "NOT CHECKED"], "notion_source_ambiguous"],
    [{ reachable: "ok", sourceFound: "ok", schemaValid: "not_ok", label: "notion_schema_invalid" }, ["OK", "OK", "OK", "NOT OK"], "notion_schema_invalid"],
  ];
  for (const [health, [config, reachable, source, schema], label] of cases) {
    const notion = fakeNotion({ health });
    const { router } = setup({ notion });
    const signal = new AbortController().signal;
    const out = await router.route({ text: "/health", chatId: 1, signal });
    assert.strictEqual(
      out.reply,
      healthText([`Notion configuration: ${config}`, `Notion reachable: ${reachable}`, `Opportunities source: ${source}`, `Opportunities schema: ${schema}`])
    );
    assert.strictEqual(out.label, label);
    assert.strictEqual(notion.calls[0].opts.signal, signal);
  }
});

test("/health treats an unexpected adapter failure as unreachable, and passes aborts through", async () => {
  const broken = setup({
    notion: fakeNotion({
      health: () => {
        throw new Error("boom with details");
      },
    }),
  });
  const out = await broken.router.route({ text: "/health", chatId: 1 });
  assert.ok(out.reply.includes("Notion reachable: NOT OK\nOpportunities source: NOT CHECKED\nOpportunities schema: NOT CHECKED"));
  assert.doesNotMatch(out.reply, /boom|details/);
  const aborting = setup({
    notion: fakeNotion({
      health: () => {
        throw labelled("notion_aborted");
      },
    }),
  });
  await assert.rejects(aborting.router.route({ text: "/health", chatId: 1 }), (err) => err.label === "notion_aborted");
});

test("/health reports local failures without revealing paths or errors", async () => {
  const base = tempDir();
  const blocker = path.join(base, "a-file");
  fs.writeFileSync(blocker, "x");
  const brokenSessions = { clear() {}, size() { throw new Error(`store failure at ${base}`); } };
  const { router } = setup({
    logDir: path.join(blocker, "logs"),
    sessions: brokenSessions,
    configStatus: { TELEGRAM_BOT_TOKEN: "valid", TELEGRAM_ALLOWED_USER_ID: "malformed" },
  });
  const { reply } = await router.route({ text: "/health", chatId: 1 });
  const lines = reply.split("\n");
  assert.ok(lines.includes("Logs: NOT WRITABLE"));
  assert.ok(lines.includes("Session store: NOT OK"));
  assert.ok(lines.includes("Configuration: NOT OK"));
  assert.ok(lines.includes("Command handler: OK"));
  assert.ok(!reply.includes(base), "filesystem path revealed");
  assert.doesNotMatch(reply, /ENOTDIR|EACCES|Error|failure|malformed|TELEGRAM_/);
});

test("the Notion configuration line is only ever OK or NOT OK", async () => {
  const configured = await setup({ notion: fakeNotion({ health: { reachable: "ok", sourceFound: "ok", schemaValid: "ok" } }) }).router.route({ text: "/health", chatId: 1 });
  const unconfigured = await setup().router.route({ text: "/health", chatId: 1 });
  for (const reply of [configured.reply, unconfigured.reply]) {
    const line = reply.split("\n").find((l) => l.startsWith("Notion configuration:"));
    assert.ok(["Notion configuration: OK", "Notion configuration: NOT OK"].includes(line), line);
    assert.doesNotMatch(reply, /NOTION_TOKEN|URET_ROOT_PAGE_ID|missing|malformed/);
  }
});
