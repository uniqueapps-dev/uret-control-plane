"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const util = require("util");
const { spawn } = require("child_process");
const { createBot } = require("../bot/index");
const { createLogger } = require("../bot/logger");
const { createSessionStore } = require("../bot/session");
const { createTelegramClient, TelegramError } = require("../bot/telegram");
const { HELP_TEXT, CANCEL_TEXT } = require("../bot/commands");
const { APIResponseError, RequestTimeoutError } = require("@notionhq/client");
const { createNotionReader } = require("../bot/notion");
const { AUTHORIZED_ID, OTHER_ID, fakeToken, fakeNotionToken, fakePageId, dashedId, tempDir, message, captureStream, fakeTelegramFetch, waitFor } = require("./helpers");

function setup(t, { getUpdatesResponses, sendMessageResponse, notion = null, router, secrets = [] } = {}) {
  const token = fakeToken();
  const base = tempDir();
  const out = captureStream();
  const fake = fakeTelegramFetch({ getUpdatesResponses, sendMessageResponse });
  const logger = createLogger({ dir: path.join(base, "logs"), secrets: [token, ...secrets], stdout: out });
  const sessions = createSessionStore();
  const config = { allowedUserId: String(AUTHORIZED_ID) };
  const bot = createBot({
    config,
    configStatus: { TELEGRAM_BOT_TOKEN: "valid", TELEGRAM_ALLOWED_USER_ID: "valid" },
    telegram: createTelegramClient({ token, fetchImpl: fake.fetchImpl }),
    logger,
    sessions,
    notion,
    router,
    logDir: path.join(base, "logs"),
    retryDelayMs: 5,
  });
  // Always stop the bot, even when an assertion fails, so a failing test
  // cannot leave a pending long poll that keeps the test process alive.
  t.after(() => bot.stop());
  const logText = () => {
    const file = path.join(base, "logs", "bot.log");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  };
  const logRecords = () => logText().trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const sent = () => fake.calls.filter((c) => c.method === "sendMessage");
  return { token, base, out, fake, bot, sessions, logText, logRecords, sent };
}

const ok = (result) => ({ ok: true, result });

// Waits for the polling loop to end on its own, but never longer than `ms`:
// if a fatal error were wrongly retried, the test fails instead of hanging
// (t.after() then stops the bot).
const settleWithin = (promise, ms = 1000) => Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);

test("drops queued updates at startup, then routes only authorized private messages", async (t) => {
  const stale = message({ updateId: 50, text: "/start" });
  const ctx = setup(t, {
    getUpdatesResponses: [
      ok([stale]),
      ok([
        message({ updateId: 51, text: "/help" }),
        message({ updateId: 52, fromId: OTHER_ID, text: "/health private text from stranger" }),
        message({ updateId: 53, chatType: "group", chatId: -100555, text: "/health" }),
        message({ updateId: 54, text: "/health" }),
        message({ updateId: 55, text: "/cancel" }),
        message({ updateId: 56, text: "some private note" }),
      ]),
    ],
  });
  ctx.sessions.set(AUTHORIZED_ID, { step: "placeholder" });

  const running = ctx.bot.start();
  await waitFor(() => ctx.sent().length >= 4);
  await ctx.bot.stop();
  await running;

  const polls = ctx.fake.calls.filter((c) => c.method === "getUpdates");
  assert.deepStrictEqual(polls[0].body, { timeout: 0, allowed_updates: ["message"], offset: -1, limit: 1 });
  assert.strictEqual(polls[1].body.offset, 51, "stale update 50 was not skipped");
  assert.strictEqual(polls[2].body.offset, 57, "offset not advanced past handled updates");

  const replies = ctx.sent().map((c) => c.body);
  assert.ok(replies.every((r) => r.chat_id === AUTHORIZED_ID), "replied to an unauthorized chat");
  assert.strictEqual(replies[0].text, HELP_TEXT);
  assert.match(replies[1].text, /Notion configuration: NOT OK/);
  assert.match(replies[1].text, /Hermes: Not used \/ isolated legacy system/);
  assert.strictEqual(replies[2].text, CANCEL_TEXT);
  assert.match(replies[3].text, /Unknown command/);
  assert.strictEqual(ctx.sessions.get(AUTHORIZED_ID), null, "/cancel did not clear the session");

  const records = ctx.logRecords();
  assert.strictEqual(records.filter((r) => r.authorized === false && r.result === "ignored").length, 2);
  assert.deepStrictEqual(
    records.filter((r) => r.event === "command").map((r) => r.command),
    ["help", "health", "cancel", "unknown"]
  );
  const everything = ctx.logText() + ctx.out.text();
  for (const secretish of [ctx.token, "stranger", "some private note", String(OTHER_ID), String(AUTHORIZED_ID), "/health"]) {
    assert.ok(!everything.includes(secretish), `log contains sensitive value (${secretish === ctx.token ? "token" : "message data"})`);
  }
});

test("no external call other than the reply is made for /cancel", async (t) => {
  const ctx = setup(t, { getUpdatesResponses: [ok([]), ok([message({ updateId: 1, text: "/cancel" })])] });
  const running = ctx.bot.start();
  await waitFor(() => ctx.sent().length >= 1);
  await ctx.bot.stop();
  await running;
  const methods = new Set(ctx.fake.calls.map((c) => c.method));
  assert.deepStrictEqual([...methods].sort(), ["getUpdates", "sendMessage"]);
  assert.ok(ctx.fake.calls.every((c) => c.url.startsWith("https://api.telegram.org/bot")), "call to another host");
});

test("network errors are logged by class only and never expose the token", async (t) => {
  const token = fakeToken();
  const failing = new Error(`request to https://api.telegram.org/bot${token}/getUpdates failed`);
  failing.cause = { url: `https://api.telegram.org/bot${token}/getUpdates` };
  const ctx = setup(t, { getUpdatesResponses: [ok([]), failing, ok([message({ updateId: 1, text: "/help" })])] });

  const running = ctx.bot.start();
  await waitFor(() => ctx.sent().length >= 1);
  await ctx.bot.stop();
  await running;

  const pollError = ctx.logRecords().find((r) => r.event === "poll");
  assert.deepStrictEqual({ result: pollError.result, error_class: pollError.error_class }, { result: "error", error_class: "network" });
  const everything = ctx.logText() + ctx.out.text();
  assert.ok(!everything.includes(token) && !everything.includes(ctx.token), "token leaked into logs");
});

test("TelegramError exposes no URL, cause or token", async () => {
  const token = fakeToken();
  const client = createTelegramClient({
    token,
    fetchImpl: async (url) => {
      throw Object.assign(new Error(`boom ${url}`), { cause: new Error(url) });
    },
  });
  let caught;
  try {
    await client.sendMessage(1, "hi");
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof TelegramError);
  assert.strictEqual(caught.errorClass, "network");
  assert.strictEqual(caught.cause, undefined);
  for (const view of [String(caught), caught.stack, JSON.stringify(caught), util.inspect(caught, { showHidden: true, depth: 5 })]) {
    assert.ok(!view.includes(token), "token visible in error representation");
    assert.ok(!view.includes("api.telegram.org"), "URL visible in error representation");
  }
});

test("Telegram API errors carry only the numeric error code", async () => {
  const client = createTelegramClient({
    token: fakeToken(),
    fetchImpl: async () => ({ status: 400, json: async () => ({ ok: false, error_code: 400, description: "Bad Request: chat not found" }) }),
  });
  await assert.rejects(client.sendMessage(1, "hi"), (err) => {
    assert.strictEqual(err.errorClass, "api_error");
    assert.strictEqual(err.errorCode, 400);
    assert.ok(!err.message.includes("chat not found"));
    return true;
  });
});

test("a rejected token (401) stops polling instead of retrying forever", async (t) => {
  const ctx = setup(t, { getUpdatesResponses: [{ ok: false, error_code: 401, description: "Unauthorized" }] });
  await settleWithin(ctx.bot.start());
  assert.strictEqual(ctx.bot.isRunning(), false);
  assert.strictEqual(ctx.bot.fatalError().errorCode, 401);
  assert.ok(ctx.logRecords().some((r) => r.result === "fatal" && r.error_class === "api_error_401"));
  assert.strictEqual(ctx.sent().length, 0);
});

// Conflict body that echoes the request URL, to prove nothing from it escapes.
function conflict(token) {
  return { ok: false, error_code: 409, description: `Conflict: terminated by other getUpdates request (bot${token})` };
}

test("a 409 conflict during polling is fatal: polling stops with no retry", async (t) => {
  const token = fakeToken();
  const ctx = setup(t, { getUpdatesResponses: [ok([]), conflict(token)] });
  await settleWithin(ctx.bot.start());
  assert.strictEqual(ctx.bot.isRunning(), false);
  assert.strictEqual(ctx.bot.fatalError().errorCode, 409);
  assert.strictEqual(ctx.fake.calls.filter((c) => c.method === "getUpdates").length, 2, "retried after 409");
  const records = ctx.logRecords();
  assert.ok(records.some((r) => r.event === "polling" && r.result === "fatal" && r.error_class === "api_error_409"));
  assert.ok(!records.some((r) => r.event === "poll" && r.result === "error"), "409 treated as retryable");
  const everything = ctx.logText() + ctx.out.text();
  assert.ok(!everything.includes(token) && !everything.includes(ctx.token), "token leaked");
  assert.ok(!everything.includes("Conflict"), "Telegram error description logged");
});

test("a 409 conflict while dropping stale updates at startup is also fatal", async (t) => {
  const ctx = setup(t, { getUpdatesResponses: [conflict(fakeToken())] });
  await settleWithin(ctx.bot.start());
  assert.strictEqual(ctx.bot.isRunning(), false);
  assert.strictEqual(ctx.bot.fatalError().errorCode, 409);
  assert.strictEqual(ctx.fake.calls.length, 1, "retried after 409");
});

test("stop() ends an in-flight long poll promptly and handles nothing afterwards", async (t) => {
  const ctx = setup(t, { getUpdatesResponses: [ok([])] });
  const running = ctx.bot.start();
  await waitFor(() => ctx.fake.calls.length >= 2);
  const started = Date.now();
  await ctx.bot.stop();
  await running;
  assert.ok(Date.now() - started < 1000, "stop took too long");
  assert.strictEqual(ctx.bot.isRunning(), false);
  await ctx.bot.handleUpdate(message({ updateId: 9, text: "/help" }));
  assert.strictEqual(ctx.sent().length, 0, "handled an update after stop");
  assert.ok(ctx.logRecords().some((r) => r.event === "polling" && r.result === "stopped"));
});

// Runs the real entry point as a separate process, with fetch stubbed by a
// preload module (no network), from a temporary copy of bot/ so its logs/
// directory is created outside the repository. With `conflict`, the first long
// poll answers 409; otherwise the process is sent `signalName` once polling.
function runEntryPoint({ signalName, conflict = false, env = {} }) {
  const base = tempDir();
  fs.cpSync(path.join(__dirname, "..", "bot"), path.join(base, "bot"), { recursive: true });
  // Lets the copy resolve @notionhq/client when Notion is configured.
  fs.symlinkSync(path.join(__dirname, "..", "node_modules"), path.join(base, "node_modules"), "dir");
  const token = fakeToken();
  const preload = path.join(base, "stub-fetch.js");
  fs.writeFileSync(
    preload,
    `globalThis.fetch = async (url, init) => {
       if (!url.startsWith("https://api.telegram.org/")) throw new Error("unexpected request");
       const method = url.slice(url.lastIndexOf("/") + 1);
       if (method === "getUpdates" && JSON.parse(init.body).offset === -1) {
         return { status: 200, json: async () => ({ ok: true, result: [] }) };
       }
       if (${conflict} && method === "getUpdates") {
         return { status: 409, json: async () => ({ ok: false, error_code: 409, description: "Conflict " + url }) };
       }
       return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted " + url)), { once: true }));
     };\n`
  );
  const child = spawn(process.execPath, ["-r", preload, path.join(base, "bot", "index.js")], {
    env: { PATH: process.env.PATH, TELEGRAM_BOT_TOKEN: token, TELEGRAM_ALLOWED_USER_ID: String(AUTHORIZED_ID), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("entry point did not stop"));
    }, 10000);
    const poll = setInterval(() => {
      if (signalName && output.includes('"result":"started"')) {
        clearInterval(poll);
        child.kill(signalName);
      }
    }, 20);
    child.on("exit", (code) => {
      clearTimeout(timer);
      clearInterval(poll);
      const logFile = path.join(base, "logs", "bot.log");
      resolve({ code, output, token, log: fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "" });
    });
  });
}

for (const signalName of ["SIGINT", "SIGTERM"]) {
  test(`the entry point shuts down cleanly on ${signalName}`, async () => {
    const { code, output, token, log } = await runEntryPoint({ signalName });
    assert.strictEqual(code, 0, "non-zero exit code");
    assert.match(log, new RegExp(`"event":"shutdown","result":"${signalName}"`));
    assert.match(log, /"event":"polling","result":"stopped"/);
    assert.ok(!output.includes(token) && !log.includes(token), "token leaked");
  });
}

test("the entry point exits non-zero on a 409 conflict without leaking the token", async () => {
  const { code, output, token, log } = await runEntryPoint({ conflict: true });
  assert.strictEqual(code, 1, "expected exit code 1");
  assert.match(output, /another process is already receiving updates for this bot token/);
  assert.match(log, /"event":"polling","result":"fatal","error_class":"api_error_409"/);
  assert.doesNotMatch(log, /"event":"poll","result":"error"/, "409 was retried");
  assert.ok(!output.includes(token) && !log.includes(token), "token leaked");
  assert.ok(!output.includes("api.telegram.org") && !output.includes("Conflict"), "URL or Telegram description printed");
});

// --- Phase 2A: Notion commands end to end ------------------------------------------

const TITLE = "URET – Opportunities";
const rt = (text) => [{ type: "text", plain_text: text }];

function schemaProperties() {
  const p = (id, type, extra = {}) => ({ id, type, [type]: extra });
  return {
    "URET ID": p("uid", "rich_text"),
    Name: p("title", "title"),
    Status: p("stat", "select", { options: ["Idea", "Active", "Parked", "Done"].map((name) => ({ name })) }),
    "Asset type": p("asst", "multi_select", { options: [] }),
    "Project / Asset": p("proj", "rich_text"),
    "Problem summary": p("prob", "rich_text"),
    "Target users": p("user", "rich_text"),
    "Success metrics": p("metr", "rich_text"),
    "Next action": p("next", "rich_text"),
    Created: p("crtd", "created_time"),
    "Last updated": p("edtd", "last_edited_time"),
    Specs: p("spec", "relation"),
    Releases: p("rels", "relation"),
  };
}

// A minimal fake Notion client (four read methods only) behind the real adapter.
function fakeNotion({ onList, onQuery } = {}) {
  const root = fakePageId();
  const dbId = fakePageId();
  const dsId = fakePageId();
  const calls = [];
  const client = {
    blocks: {
      children: {
        list: async (args) => {
          calls.push("blocks.children.list");
          if (onList) return onList(args);
          return { results: [{ object: "block", id: dbId, type: "child_database", child_database: { title: TITLE } }], has_more: false };
        },
      },
    },
    databases: {
      retrieve: async () => {
        calls.push("databases.retrieve");
        return { object: "database", id: dbId, in_trash: false, parent: { type: "page_id", page_id: dashedId(root) }, data_sources: [{ id: dsId }] };
      },
    },
    dataSources: {
      retrieve: async () => {
        calls.push("dataSources.retrieve");
        return { object: "data_source", id: dsId, in_trash: false, title: rt(TITLE), database_parent: { type: "page_id", page_id: root }, properties: schemaProperties() };
      },
      query: async (args) => {
        calls.push("dataSources.query");
        return onQuery ? onQuery(args) : { results: [], has_more: false };
      },
    },
  };
  const reader = createNotionReader({ client, rootPageId: root });
  return { root, dbId, dsId, calls, reader, secrets: [root, dashedId(root), dbId, dsId, dashedId(dsId)] };
}

const statusPage = (name, extra = {}) => ({ object: "page", in_trash: false, properties: { Status: { type: "select", select: { name } } }, ...extra });
const opportunityPage = {
  object: "page",
  in_trash: false,
  url: "https://www.notion.so/example",
  properties: {
    "URET ID": { type: "rich_text", rich_text: rt("OPP-001") },
    Name: { type: "title", title: rt("URET Control Plane Setup") },
    Status: { type: "select", select: { name: "Active" } },
  },
};

// Adapter stand-in that records calls; a counting spy for "must not be called".
function spyNotion() {
  const calls = [];
  const record = (method) => async () => {
    calls.push(method);
    throw new Error("adapter must not be called");
  };
  return { calls, countByStatus: record("countByStatus"), findByUretId: record("findByUretId"), health: record("health") };
}

async function runCommands(t, texts, options = {}) {
  const updates = texts.map((text, i) => message({ updateId: 100 + i, text }));
  const ctx = setup(t, { getUpdatesResponses: [ok([]), ok(updates)], ...options });
  const running = ctx.bot.start();
  await waitFor(() => ctx.sent().length >= texts.length);
  await ctx.bot.stop();
  await running;
  return ctx;
}

test("/status, /show and /health work end to end through the real read-only adapter", async (t) => {
  const n = fakeNotion({
    onQuery: (args) =>
      args.filter
        ? { results: [opportunityPage], has_more: false }
        : { results: [statusPage("Idea"), statusPage("Idea"), statusPage("Done"), statusPage("Weird", { in_trash: true })], has_more: false },
  });
  const ctx = await runCommands(t, ["/status", "/show opp-1", "/health"], { notion: n.reader, secrets: n.secrets });
  const replies = ctx.sent().map((c) => c.body.text);
  assert.strictEqual(replies[0], "Notion: Connected\nTotal: 3\nIdea: 2\nActive: 0\nParked: 0\nDone: 1");
  assert.match(replies[1], /^URET ID: OPP-001\nName: URET Control Plane Setup\nStatus: Active\n/);
  assert.match(replies[1], /Notion link: https:\/\/www\.notion\.so\/example$/);
  assert.match(replies[2], /Notion configuration: OK\nNotion reachable: OK\nOpportunities source: OK\nOpportunities schema: OK/);
  assert.strictEqual(n.calls.filter((c) => c === "blocks.children.list").length, 1, "discovery not remembered");
  const lookup = ctx.logRecords().filter((r) => r.event === "command").map((r) => [r.command, r.result]);
  assert.deepStrictEqual(lookup, [["status", "ok"], ["show", "ok"], ["health", "ok"]]);
});

test("unauthorized /status never reaches the Notion adapter", async (t) => {
  const spy = spyNotion();
  const ctx = setup(t, {
    notion: spy,
    getUpdatesResponses: [ok([]), ok([message({ updateId: 1, fromId: OTHER_ID, text: "/status" }), message({ updateId: 2, fromId: OTHER_ID, text: "/show OPP-1" }), message({ updateId: 3, fromId: OTHER_ID, text: "/health" }), message({ updateId: 4, text: "/help" })])],
  });
  const running = ctx.bot.start();
  await waitFor(() => ctx.sent().length >= 1);
  await ctx.bot.stop();
  await running;
  assert.deepStrictEqual(spy.calls, []);
  assert.strictEqual(ctx.sent().length, 1, "replied to an unauthorized user");
  assert.strictEqual(ctx.logRecords().filter((r) => r.authorized === false).length, 3);
});

test("/status from a group or channel never reaches the Notion adapter", async (t) => {
  const spy = spyNotion();
  const ctx = setup(t, {
    notion: spy,
    getUpdatesResponses: [
      ok([]),
      ok([
        message({ updateId: 1, chatType: "group", chatId: -100111, text: "/status" }),
        message({ updateId: 2, chatType: "supergroup", chatId: -100222, text: "/show OPP-1" }),
        message({ updateId: 3, chatType: "channel", chatId: -100333, text: "/health" }),
        message({ updateId: 4, text: "/help" }),
      ]),
    ],
  });
  const running = ctx.bot.start();
  await waitFor(() => ctx.sent().length >= 1);
  await ctx.bot.stop();
  await running;
  assert.deepStrictEqual(spy.calls, []);
  assert.deepStrictEqual(ctx.sent().map((c) => c.body.chat_id), [AUTHORIZED_ID]);
});

test("a Notion timeout produces one safe Unavailable reply and no retry", async (t) => {
  const n = fakeNotion({
    onQuery: () => {
      throw new RequestTimeoutError();
    },
  });
  const ctx = await runCommands(t, ["/status"], { notion: n.reader, secrets: n.secrets });
  assert.deepStrictEqual(ctx.sent().map((c) => c.body.text), ["Notion: Unavailable"]);
  assert.strictEqual(n.calls.filter((c) => c === "dataSources.query").length, 1, "retried");
  const record = ctx.logRecords().find((r) => r.event === "command");
  assert.deepStrictEqual([record.command, record.result, record.error_class], ["status", "error", "notion_timeout"]);
});

test("shutdown during a slow Notion read completes quickly and sends no reply", async (t) => {
  const n = fakeNotion({ onList: () => new Promise(() => {}) }); // never answers
  const ctx = setup(t, { notion: n.reader, getUpdatesResponses: [ok([]), ok([message({ updateId: 1, text: "/status" })])] });
  const running = ctx.bot.start();
  await waitFor(() => n.calls.includes("blocks.children.list"));
  const started = Date.now();
  // Bounded wait: if the stop signal did not reach the Notion read, this fails
  // instead of hanging the suite.
  const stopped = await settleWithin(ctx.bot.stop().then(() => running).then(() => "stopped"), 2000);
  assert.strictEqual(stopped, "stopped", "stop() did not complete");
  assert.ok(Date.now() - started < 1000, `stop took ${Date.now() - started} ms`);
  assert.strictEqual(ctx.sent().length, 0, "replied during shutdown");
  const record = ctx.logRecords().find((r) => r.event === "command");
  assert.deepStrictEqual([record.command, record.result, record.error_class], ["status", "aborted", "notion_aborted"]);
});

test("Telegram 401, 404 and 409 stay fatal with Notion configured, and Notion is never read", async (t) => {
  for (const code of [401, 404, 409]) {
    const spy = spyNotion();
    const ctx = setup(t, { notion: spy, getUpdatesResponses: [ok([]), { ok: false, error_code: code, description: "x" }] });
    await settleWithin(ctx.bot.start());
    assert.strictEqual(ctx.bot.isRunning(), false, `${code} not fatal`);
    assert.strictEqual(ctx.bot.fatalError().errorCode, code);
    assert.strictEqual(ctx.fake.calls.filter((c) => c.method === "getUpdates").length, 2, `${code} retried`);
    assert.deepStrictEqual(spy.calls, []);
  }
});

test("no command ever sends [object Promise] or an empty reply", async (t) => {
  const n = fakeNotion({ onQuery: (args) => (args.filter ? { results: [], has_more: false } : { results: [statusPage("Idea")], has_more: false }) });
  const texts = ["/start", "/help", "/cancel", "/status", "/show", "/show OPP-7", "/show nope", "/health", "/unknown", "hello"];
  for (const notion of [null, n.reader]) {
    const ctx = await runCommands(t, texts, { notion });
    const replies = ctx.sent().map((c) => c.body.text);
    assert.strictEqual(replies.length, texts.length);
    for (const reply of replies) {
      assert.strictEqual(typeof reply, "string");
      assert.ok(reply.trim() !== "" && !reply.includes("[object Promise]") && reply !== "Internal error.", reply);
    }
  }
});

test("a non-text reply or an unexpected error becomes 'Internal error.'", async (t) => {
  const badRouter = { route: async () => ({ command: "start", reply: Promise.resolve("late") }) };
  const first = await runCommands(t, ["/start"], { router: badRouter });
  assert.deepStrictEqual(first.sent().map((c) => c.body.text), ["Internal error."]);
  assert.strictEqual(first.logRecords().find((r) => r.event === "command").error_class, "internal_error");

  const throwingAdapter = { countByStatus: async () => { throw new TypeError("bug with details"); }, findByUretId: async () => ({}), health: async () => ({}) };
  const second = await runCommands(t, ["/status"], { notion: throwingAdapter });
  assert.deepStrictEqual(second.sent().map((c) => c.body.text), ["Internal error."]);
  const record = second.logRecords().find((r) => r.event === "command");
  assert.deepStrictEqual([record.result, record.error_class], ["error", "internal_error"]);
  assert.doesNotMatch(second.logText() + second.out.text(), /bug with details/);
});

test("no Notion token, ID or raw Notion error text reaches replies or logs", async (t) => {
  const notionToken = fakeNotionToken();
  let failing = true;
  const n = fakeNotion({
    onQuery: () => {
      if (failing) {
        const secrets = `${notionToken} ${n.root} ${n.dsId} req-SECRET`;
        throw new APIResponseError({ code: "unauthorized", status: 401, message: `denied ${secrets}`, headers: { authorization: `Bearer ${notionToken}` }, rawBodyText: secrets, request_id: "req-SECRET" });
      }
      return { results: [opportunityPage], has_more: false };
    },
  });
  const ctx = await runCommands(t, ["/status", "/show OPP-1", "/health"], { notion: n.reader, secrets: [notionToken, ...n.secrets] });
  const everything = ctx.logText() + ctx.out.text() + ctx.sent().map((c) => c.body.text).join("\n");
  for (const secret of [notionToken, ...n.secrets, "req-SECRET", "denied", "Bearer"]) {
    assert.ok(!everything.includes(secret), "sensitive Notion value leaked");
  }
  assert.deepStrictEqual(ctx.sent().slice(0, 2).map((c) => c.body.text), ["Notion: Access problem", "Notion: Access problem"]);
});

test("the entry point starts with a malformed Notion config and names only variables and states", async () => {
  const badToken = "ntn_bad value with spaces";
  const { code, output, log } = await runEntryPoint({ signalName: "SIGTERM", env: { NOTION_TOKEN: badToken, URET_ROOT_PAGE_ID: "not-an-id" } });
  assert.strictEqual(code, 0);
  assert.match(output, /Notion configuration: NOT OK\n {2}NOTION_TOKEN: malformed\n {2}URET_ROOT_PAGE_ID: malformed/);
  assert.ok(!output.includes(badToken) && !output.includes("not-an-id"), "config value printed");
  assert.match(log, /"event":"notion_config","result":"not_ok"/);
});

test("the entry point starts with a valid Notion config without reading Notion until a command needs it", async () => {
  const notionToken = fakeNotionToken();
  const root = fakePageId();
  const { code, output, log } = await runEntryPoint({ signalName: "SIGTERM", env: { NOTION_TOKEN: notionToken, URET_ROOT_PAGE_ID: dashedId(root) } });
  assert.strictEqual(code, 0);
  assert.match(log, /"event":"notion_config","result":"ok"/);
  assert.doesNotMatch(output, /unexpected request/, "Notion was contacted at startup");
  for (const secret of [notionToken, root, dashedId(root)]) assert.ok(!output.includes(secret) && !log.includes(secret), "secret leaked");
});
