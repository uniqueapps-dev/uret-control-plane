"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { createRouter, parseCommand, START_TEXT, HELP_TEXT, CANCEL_TEXT, UNKNOWN_TEXT } = require("../bot/commands");
const { createSessionStore } = require("../bot/session");
const { tempDir } = require("./helpers");

const VALID_STATUS = { TELEGRAM_BOT_TOKEN: "valid", TELEGRAM_ALLOWED_USER_ID: "valid" };

function setup(overrides = {}) {
  const base = tempDir();
  const sessions = createSessionStore();
  const router = createRouter({
    sessions,
    configStatus: VALID_STATUS,
    logDir: path.join(base, "logs"),
    runtimeDir: path.join(base, "runtime"),
    ...overrides,
  });
  return { base, sessions, router };
}

test("parseCommand recognises commands, bot mentions and arguments", () => {
  assert.strictEqual(parseCommand("/start"), "start");
  assert.strictEqual(parseCommand("  /HELP  "), "help");
  assert.strictEqual(parseCommand("/cancel@UretBot"), "cancel");
  assert.strictEqual(parseCommand("/health now"), "health");
  assert.strictEqual(parseCommand("start"), null);
  assert.strictEqual(parseCommand(undefined), null);
});

test("/start introduces the bot and lists only Phase 1 commands", () => {
  const { router } = setup();
  const { command, reply } = router.route({ text: "/start", chatId: 1 });
  assert.strictEqual(command, "start");
  assert.strictEqual(reply, START_TEXT);
  assert.match(reply, /URET Control Bot MVP v0\.1/);
  assert.match(reply, /phone-first/);
  assert.deepStrictEqual(reply.match(/^\/\w+/gm), ["/start", "/help", "/cancel", "/health"]);
  assert.doesNotMatch(reply, /notion|hermes/i);
});

test("/help lists exactly the four Phase 1 commands", () => {
  const { router } = setup();
  const { reply } = router.route({ text: "/help", chatId: 1 });
  assert.strictEqual(reply, HELP_TEXT);
  assert.deepStrictEqual(reply.match(/^\/\w+/gm), ["/start", "/help", "/cancel", "/health"]);
});

test("/cancel clears the in-memory session and confirms nothing was written", () => {
  const { router, sessions } = setup();
  sessions.set(1, { step: "placeholder" });
  sessions.set(2, { step: "other chat" });
  const { command, reply } = router.route({ text: "/cancel", chatId: 1 });
  assert.strictEqual(command, "cancel");
  assert.strictEqual(reply, CANCEL_TEXT);
  assert.match(reply, /No URET record was created or changed/);
  assert.strictEqual(sessions.get(1), null);
  assert.deepStrictEqual(sessions.get(2), { step: "other chat" }, "other sessions must be untouched");
});

test("/health reports local checks, Notion not configured and Hermes isolated", () => {
  const { router, base } = setup();
  const { command, reply } = router.route({ text: "/health", chatId: 1 });
  assert.strictEqual(command, "health");
  const lines = reply.split("\n");
  assert.ok(lines.includes("Configuration: TELEGRAM_BOT_TOKEN present, TELEGRAM_ALLOWED_USER_ID present"));
  assert.ok(lines.includes("Log directory: writable"));
  assert.ok(lines.includes("Runtime directory: writable"));
  assert.ok(lines.includes("Session store: available (in memory, 0 active)"));
  assert.ok(lines.includes("Command handlers: 4 available"));
  assert.ok(lines.includes("Notion: Not configured in Phase 1"));
  assert.ok(lines.includes("Hermes: Not used / isolated legacy system"));
  assert.match(reply, /not watched by any external supervisor/);
  assert.ok(!reply.includes(base), "filesystem path revealed");
  assert.ok(!reply.includes(require("os").tmpdir()), "temp path revealed");
  // Probe files are cleaned up.
  assert.deepStrictEqual(fs.readdirSync(path.join(base, "logs")), []);
  assert.deepStrictEqual(fs.readdirSync(path.join(base, "runtime")), []);
});

test("/health reports unwritable directories without revealing paths or errors", () => {
  const base = tempDir();
  const blocker = path.join(base, "a-file");
  fs.writeFileSync(blocker, "x");
  const { router } = setup({ logDir: path.join(blocker, "logs"), runtimeDir: path.join(blocker, "runtime") });
  const { reply } = router.route({ text: "/health", chatId: 1 });
  assert.ok(reply.includes("Log directory: not writable"));
  assert.ok(reply.includes("Runtime directory: not writable"));
  assert.ok(!reply.includes(base), "filesystem path revealed");
  assert.doesNotMatch(reply, /ENOTDIR|EACCES|Error/);
});

test("unknown commands and plain text only point to /help", () => {
  const { router } = setup();
  for (const text of ["/new_opportunity", "/status", "/show OPP-001", "hello", "", undefined]) {
    const { command, reply } = router.route({ text, chatId: 1 });
    assert.strictEqual(command, "unknown");
    assert.strictEqual(reply, UNKNOWN_TEXT);
  }
});
