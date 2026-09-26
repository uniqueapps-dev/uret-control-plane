"use strict";

const test = require("node:test");
const assert = require("node:assert");
const util = require("util");
const { spawnSync } = require("child_process");
const path = require("path");
const { loadConfig, describeStatus, describeNotionStatus, notionConfigLine, secretValues } = require("../bot/config");
const { fakeToken, fakeNotionToken, fakePageId, dashedId } = require("./helpers");

const ENTRY = path.join(__dirname, "..", "bot", "index.js");

test("missing token is reported as missing", () => {
  const { ok, status } = loadConfig({ TELEGRAM_ALLOWED_USER_ID: "12345" });
  assert.strictEqual(ok, false);
  assert.strictEqual(status.TELEGRAM_BOT_TOKEN, "missing");
  assert.strictEqual(status.TELEGRAM_ALLOWED_USER_ID, "valid");
});

test("missing or blank user ID is reported as missing", () => {
  assert.strictEqual(loadConfig({ TELEGRAM_BOT_TOKEN: fakeToken() }).status.TELEGRAM_ALLOWED_USER_ID, "missing");
  assert.strictEqual(
    loadConfig({ TELEGRAM_BOT_TOKEN: fakeToken(), TELEGRAM_ALLOWED_USER_ID: "   " }).status.TELEGRAM_ALLOWED_USER_ID,
    "missing"
  );
});

test("non-numeric, negative, zero or fractional user IDs are malformed", () => {
  for (const bad of ["abc", "-5", "0", "12.5", "12 34", "@someone", "1e5"]) {
    const { ok, status } = loadConfig({ TELEGRAM_BOT_TOKEN: fakeToken(), TELEGRAM_ALLOWED_USER_ID: bad });
    assert.strictEqual(ok, false, `accepted ${JSON.stringify(bad)}`);
    assert.strictEqual(status.TELEGRAM_ALLOWED_USER_ID, "malformed", `not malformed: ${JSON.stringify(bad)}`);
  }
});

test("malformed token is reported as malformed", () => {
  for (const bad of ["abc", "123:short", "no-colon-at-all-but-long-enough-to-pass"]) {
    assert.strictEqual(loadConfig({ TELEGRAM_BOT_TOKEN: bad, TELEGRAM_ALLOWED_USER_ID: "1" }).status.TELEGRAM_BOT_TOKEN, "malformed");
  }
});

test("valid configuration is accepted and the token is hidden from serialisation", () => {
  const token = fakeToken();
  const { ok, status, config } = loadConfig({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_ALLOWED_USER_ID: "700000001" });
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(status, { TELEGRAM_BOT_TOKEN: "valid", TELEGRAM_ALLOWED_USER_ID: "valid" });
  assert.strictEqual(config.allowedUserId, "700000001");
  assert.ok(config.botToken === token, "token not available to the client");
  assert.ok(!JSON.stringify(config).includes(token), "token visible in JSON");
  assert.ok(!util.inspect(config).includes(token), "token visible in util.inspect");
  assert.ok(!describeStatus(status).join("\n").includes(token), "token visible in status lines");
});

test("the bot refuses to start with missing or malformed configuration and prints no values", () => {
  const token = fakeToken();
  const cases = [
    {},
    { TELEGRAM_BOT_TOKEN: token },
    { TELEGRAM_BOT_TOKEN: token, TELEGRAM_ALLOWED_USER_ID: "not-a-number" },
    { TELEGRAM_BOT_TOKEN: `${token}!bad`, TELEGRAM_ALLOWED_USER_ID: "700000001" },
  ];
  for (const extraEnv of cases) {
    const env = { PATH: process.env.PATH, ...extraEnv };
    const result = spawnSync(process.execPath, [ENTRY], { env, encoding: "utf8", timeout: 10000 });
    const output = result.stdout + result.stderr;
    assert.strictEqual(result.status, 1, "expected exit code 1");
    assert.match(output, /configuration invalid/);
    assert.ok(!output.includes(token), "token printed");
    assert.ok(!output.includes("not-a-number"), "user ID value printed");
  }
});

// --- Optional Notion configuration -----------------------------------------

function telegramEnv() {
  return { TELEGRAM_BOT_TOKEN: fakeToken(), TELEGRAM_ALLOWED_USER_ID: "700000001" };
}

test("without Notion variables, Notion is off and the bot can still start", () => {
  const { ok, notion, config } = loadConfig(telegramEnv());
  assert.strictEqual(ok, true);
  assert.strictEqual(notion.state, "off");
  assert.deepStrictEqual(notion.status, { NOTION_TOKEN: "missing", URET_ROOT_PAGE_ID: "missing" });
  assert.strictEqual(config.notionConfigured, false);
  assert.strictEqual(config.notionToken, undefined);
  assert.strictEqual(config.rootPageId, undefined);
  assert.strictEqual(notionConfigLine(config), "Notion configuration: NOT OK");
});

test("a partial Notion configuration is NOT OK but the bot can still start", () => {
  const cases = [
    [{ NOTION_TOKEN: fakeNotionToken() }, { NOTION_TOKEN: "valid", URET_ROOT_PAGE_ID: "missing" }],
    [{ URET_ROOT_PAGE_ID: fakePageId() }, { NOTION_TOKEN: "missing", URET_ROOT_PAGE_ID: "valid" }],
  ];
  for (const [extra, expected] of cases) {
    const { ok, notion, config } = loadConfig({ ...telegramEnv(), ...extra });
    assert.strictEqual(ok, true);
    assert.strictEqual(notion.state, "not_ok");
    assert.deepStrictEqual(notion.status, expected);
    assert.strictEqual(config.notionConfigured, false);
  }
});

test("malformed Notion tokens are rejected", () => {
  const bad = [
    "abc",
    "ntn_short",
    `token_${"a".repeat(30)}`,
    `ntn_${"a".repeat(10)} ${"b".repeat(10)}`,
    fakeToken(),
  ];
  for (const token of bad) {
    const { notion, config } = loadConfig({ ...telegramEnv(), NOTION_TOKEN: token, URET_ROOT_PAGE_ID: fakePageId() });
    assert.strictEqual(notion.status.NOTION_TOKEN, "malformed", "accepted a malformed token");
    assert.strictEqual(notion.state, "not_ok");
    assert.strictEqual(config.notionConfigured, false);
  }
  const legacy = `secret_${"A1".repeat(12)}`;
  assert.strictEqual(loadConfig({ ...telegramEnv(), NOTION_TOKEN: legacy }).notion.status.NOTION_TOKEN, "valid");
});

test("malformed root page IDs are rejected", () => {
  const id = fakePageId();
  const bad = [id.slice(1), `${id}0`, id.replace(/./, "g"), `${id.slice(0, 8)}-${id.slice(8)}`, "not-a-page-id"];
  for (const rootId of bad) {
    const { notion } = loadConfig({ ...telegramEnv(), NOTION_TOKEN: fakeNotionToken(), URET_ROOT_PAGE_ID: rootId });
    assert.strictEqual(notion.status.URET_ROOT_PAGE_ID, "malformed", `accepted ${rootId}`);
    assert.strictEqual(notion.state, "not_ok");
  }
});

test("a valid Notion configuration is OK, in plain or dashed ID form", () => {
  const id = fakePageId();
  for (const rootId of [id, dashedId(id), dashedId(id).toUpperCase()]) {
    const token = fakeNotionToken();
    const { ok, notion, config } = loadConfig({ ...telegramEnv(), NOTION_TOKEN: token, URET_ROOT_PAGE_ID: rootId });
    assert.strictEqual(ok, true);
    assert.strictEqual(notion.state, "ok");
    assert.strictEqual(config.notionConfigured, true);
    assert.ok(config.notionToken === token, "token not available to the adapter");
    assert.ok(config.rootPageId === id, "root page ID not normalised");
    assert.strictEqual(notionConfigLine(config), "Notion configuration: OK");
  }
});

test("Notion token and root page ID are hidden from printed or saved config", () => {
  const token = fakeNotionToken();
  const id = fakePageId();
  const { config, notion } = loadConfig({ ...telegramEnv(), NOTION_TOKEN: token, URET_ROOT_PAGE_ID: dashedId(id) });
  for (const view of [JSON.stringify(config), util.inspect(config), String(config), describeNotionStatus(notion).join("\n")]) {
    assert.ok(!view.includes(token), "Notion token visible");
    assert.ok(!view.includes(id) && !view.includes(dashedId(id)), "root page ID visible");
  }
  assert.deepStrictEqual(describeNotionStatus(notion), ["NOTION_TOKEN: valid", "URET_ROOT_PAGE_ID: valid"]);
});

test("the Telegram configuration status is unchanged by Notion variables", () => {
  const { status } = loadConfig({ ...telegramEnv(), NOTION_TOKEN: "bad", URET_ROOT_PAGE_ID: "bad" });
  assert.deepStrictEqual(status, { TELEGRAM_BOT_TOKEN: "valid", TELEGRAM_ALLOWED_USER_ID: "valid" });
});

test("invalid Telegram config still prevents start even with valid Notion config", () => {
  const { ok, notion, config } = loadConfig({ NOTION_TOKEN: fakeNotionToken(), URET_ROOT_PAGE_ID: fakePageId() });
  assert.strictEqual(ok, false);
  assert.strictEqual(config, null);
  assert.strictEqual(notion.state, "ok");
});

test("secretValues lists every secret for redaction, including both root ID forms", () => {
  const botToken = fakeToken();
  const token = fakeNotionToken();
  const id = fakePageId();
  const { config } = loadConfig({ TELEGRAM_BOT_TOKEN: botToken, TELEGRAM_ALLOWED_USER_ID: "1", NOTION_TOKEN: token, URET_ROOT_PAGE_ID: id });
  const secrets = secretValues(config);
  for (const expected of [botToken, token, id, dashedId(id)]) {
    assert.ok(secrets.includes(expected), "secret missing from redaction list");
  }
  assert.deepStrictEqual(secretValues(loadConfig(telegramEnv()).config).length, 1);
  assert.deepStrictEqual(secretValues(null), []);
});
