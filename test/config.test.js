"use strict";

const test = require("node:test");
const assert = require("node:assert");
const util = require("util");
const { spawnSync } = require("child_process");
const path = require("path");
const { loadConfig, describeStatus } = require("../bot/config");
const { fakeToken } = require("./helpers");

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
