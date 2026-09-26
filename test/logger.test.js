"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { createLogger, redact, ALLOWED_FIELDS } = require("../bot/logger");
const { fakeToken, fakeNotionToken, fakePageId, dashedId, tempDir, captureStream } = require("./helpers");

function readLines(file) {
  return fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

test("writes only allow-listed structured fields", () => {
  const dir = tempDir();
  const out = captureStream();
  const logger = createLogger({ dir, stdout: out });
  logger.log({
    event: "command",
    command: "start",
    result: "ok",
    error_class: "none",
    duration_ms: 12.4,
    authorized: true,
    text: "secret message content",
    user_id: 700000001,
    url: "https://example.invalid/path",
    env: { A: "b" },
  });
  const [record] = readLines(path.join(dir, "bot.log"));
  assert.deepStrictEqual(Object.keys(record).sort(), ["timestamp", ...ALLOWED_FIELDS].sort());
  assert.strictEqual(record.duration_ms, 12);
  assert.strictEqual(record.authorized, true);
  assert.ok(!JSON.stringify(record).includes("secret message content"));
  assert.ok(!JSON.stringify(record).includes("700000001"));
  assert.strictEqual(out.text().trim(), JSON.stringify(record), "stdout echo differs from file");
});

test("redacts configured secrets and token-shaped strings", () => {
  const token = fakeToken();
  const dir = tempDir();
  const out = captureStream();
  const logger = createLogger({ dir, secrets: [token], stdout: out });
  logger.log({ event: `leak ${token}`, result: `https://api.telegram.org/bot${token}/getUpdates`, error_class: token });
  const raw = fs.readFileSync(path.join(dir, "bot.log"), "utf8");
  assert.ok(!raw.includes(token), "token written to log file");
  assert.ok(!out.text().includes(token), "token written to stdout");
  assert.ok(raw.includes("[REDACTED]"));

  const otherShape = fakeToken();
  assert.ok(!redact(`x ${otherShape} y`).includes(otherShape), "unknown token-shaped string not redacted");
});

test("falls back to stdout when the log directory is not writable", () => {
  const base = tempDir();
  const blocker = path.join(base, "a-file");
  fs.writeFileSync(blocker, "x");
  const out = captureStream();
  const logger = createLogger({ dir: path.join(blocker, "logs"), stdout: out });
  logger.log({ event: "startup", result: "ok" });
  assert.strictEqual(logger.isFileWritable(), false);
  assert.match(out.text(), /log_file_unwritable/);
  assert.match(out.text(), /"event":"startup"/);
  assert.ok(!out.text().includes(base), "path revealed");
});

test("redacts Notion tokens and Notion IDs even when not passed as known secrets", () => {
  const ntn = fakeNotionToken();
  const legacy = `secret_${"Ab1".repeat(10)}`;
  const id = fakePageId();
  for (const value of [ntn, legacy, id, dashedId(id), dashedId(id).toUpperCase()]) {
    const out = redact(`before ${value} after`);
    assert.ok(!out.includes(value), "Notion value not redacted");
    assert.match(out, /^before \[REDACTED\] after$/);
  }
});

test("known Notion secrets never reach the log file or stdout", () => {
  const token = fakeNotionToken();
  const id = fakePageId();
  const dir = tempDir();
  const out = captureStream();
  const logger = createLogger({ dir, secrets: [token, id, dashedId(id)], stdout: out });
  logger.log({ event: `ds ${dashedId(id)}`, result: `root ${id}`, error_class: token });
  const raw = fs.readFileSync(path.join(dir, "bot.log"), "utf8") + out.text();
  assert.ok(!raw.includes(token), "Notion token logged");
  assert.ok(!raw.includes(id) && !raw.includes(dashedId(id)), "Notion ID logged");
});

test("ordinary log values are not altered by Notion redaction", () => {
  for (const value of ["api_error_409", "notion_timeout", "status", "stale_updates", "dropped", "SIGTERM"]) {
    assert.strictEqual(redact(value), value);
  }
});
