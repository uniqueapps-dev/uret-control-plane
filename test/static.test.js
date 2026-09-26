"use strict";

// Static guards on the bot sources: no Notion, Hermes, AI-provider, webhook or
// server code, only Node built-in and local modules, and no dependency changes.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { builtinModules } = require("module");

const BOT_DIR = path.join(__dirname, "..", "bot");
const sources = fs
  .readdirSync(BOT_DIR)
  .filter((f) => f.endsWith(".js"))
  .map((f) => ({ file: f, text: fs.readFileSync(path.join(BOT_DIR, f), "utf8") }));

const ALLOWED_LINES = new Set(['"Notion: Not configured in Phase 1",', '"Hermes: Not used / isolated legacy system",']);

function offendingLines(pattern, exemptFiles = []) {
  const hits = [];
  for (const { file, text } of sources) {
    if (exemptFiles.includes(file)) continue;
    text.split("\n").forEach((line, i) => {
      if (pattern.test(line) && !ALLOWED_LINES.has(line.trim())) hits.push(`${file}:${i + 1}`);
    });
  }
  return hits;
}

test("bot sources exist", () => {
  assert.ok(sources.length >= 7);
});

// Phase 2A steps 1-2: config.js names the optional Notion variables, logger.js
// redacts Notion token/ID shapes and opportunities.js holds the fixed reply
// texts. None of them loads a Notion client (see the
// require guard below). This guard is replaced by the full Phase 2A
// allow-list/deny-list in step 5.
const NOTION_WORD_EXEMPT = ["config.js", "logger.js", "opportunities.js"];

test("the only Notion and Hermes references are the two /health status lines", () => {
  assert.deepStrictEqual(offendingLines(/notion/i, NOTION_WORD_EXEMPT), []);
  assert.deepStrictEqual(offendingLines(/hermes/i), []);
  const all = sources.map((s) => s.text).join("\n");
  assert.ok(all.includes("Notion: Not configured in Phase 1"));
  assert.ok(all.includes("Hermes: Not used / isolated legacy system"));
});

test("no AI provider, webhook, server, GitHub or crawler code", () => {
  const forbidden = /openai|anthropic|claude|gemini|perplexity|llm|setWebhook|webhook|createServer|listen\(|github|puppeteer|playwright|crawl/i;
  assert.deepStrictEqual(offendingLines(forbidden), []);
});

test("bot modules require only Node built-ins or local files", () => {
  const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
  for (const { file, text } of sources) {
    for (const [, name] of text.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
      assert.ok(name.startsWith("./") || builtins.has(name), `${file} requires ${name}`);
    }
    assert.doesNotMatch(text, /create-uret-databases|uret-id-counters/, `${file} references the setup script or counters`);
  }
});

test("the only network host is the Telegram Bot API", () => {
  const hosts = new Set();
  for (const { text } of sources) {
    for (const [url] of text.matchAll(/https?:\/\/[^\s"'`]+/g)) hosts.add(new URL(url).host);
  }
  assert.deepStrictEqual([...hosts], ["api.telegram.org"]);
});

test("no dependencies were added", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.deepStrictEqual(pkg.dependencies, { "@notionhq/client": "^5.26.0" });
  assert.strictEqual(pkg.devDependencies, undefined);
});

test("no source or test file contains a token-shaped literal", () => {
  const tokenShape = /\d{5,}:[A-Za-z0-9_-]{30,}/;
  const dirs = [BOT_DIR, __dirname];
  for (const dir of dirs) {
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".js"))) {
      assert.doesNotMatch(fs.readFileSync(path.join(dir, f), "utf8"), tokenShape, `${f} contains a token-shaped literal`);
    }
  }
});
