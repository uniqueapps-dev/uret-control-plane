"use strict";

// Static guards on the bot sources (Phase 2A final rules, with Phase 3-5 interim
// changes marked below):
// - only bot/notion.js loads the Notion SDK, and it may call only four reads;
// - bot/notionWrite.js (step 5) also loads it, and may call only pages.create
//   (exactly once) and dataSources.retrieve / databases.retrieve;
// - no page API, generic request, search or mutation call anywhere in bot/
//   (standard Map/Set methods on locally created collections are allowed);
// - no other URET data source, no ID allocation, no setup-script use;
// - no AI provider, webhook, server, GitHub or crawler code;
// - only Node built-ins or local files, only the Telegram host, no new dependencies;
// - no token- or ID-shaped literals.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { builtinModules } = require("module");

const BOT_DIR = path.join(__dirname, "..", "bot");

// Removes /* */ and // comments so code rules ignore prose. "://" in URLs is kept.
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

const sources = fs
  .readdirSync(BOT_DIR)
  .filter((f) => f.endsWith(".js"))
  .map((f) => {
    const text = fs.readFileSync(path.join(BOT_DIR, f), "utf8");
    return { file: f, text, code: stripComments(text) };
  });

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

const SDK = "@notionhq/client";
const ADAPTER_FILE = "notion.js";
const PERMITTED_CLIENT_CALLS = ["blocks.children.list", "databases.retrieve", "dataSources.retrieve", "dataSources.query"];
// Phase 3-5 step 5 (interim, finalised in step 10): the write adapter.
const WRITER_FILE = "notionWrite.js";
const WRITER_CLIENT_CALLS = ["pages.create", "dataSources.retrieve", "databases.retrieve"];
const WRITER_CREATE_CALL = /\bclient\s*\.\s*pages\s*\.\s*create\s*\(/g;
// Phase 1 transport, authorization and session modules stay free of Notion.
const NOTION_FREE_FILES = ["auth.js", "session.js", "telegram.js"];

/**
 * Forbidden call patterns in code (comments removed). Returns violations.
 * .update( / .delete( are allowed only on a variable the same file creates
 * as a Map, Set, WeakMap or WeakSet (for example session.js's Map).
 */
function forbiddenCalls(code) {
  const violations = [];
  const rules = [
    [/\bpages\s*\./g, "page API"],
    [/\.\s*request\s*\(/g, "generic request"],
    [/\bsearch\s*\(|\.\s*search\b/g, "search"],
    [/\.\s*(?:create|append|move)\s*\(/g, "mutation"],
    [/updateMarkdown/g, "mutation"],
  ];
  for (const [pattern, kind] of rules) {
    for (const m of code.matchAll(pattern)) violations.push(`${kind} at line ${lineOf(code, m.index)}`);
  }
  const collections = new Set(
    [...code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+(?:Map|Set|WeakMap|WeakSet)\s*\(/g)].map((m) => m[1])
  );
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*|\)|\])\s*\.\s*(update|delete)\s*\(/g)) {
    if (!collections.has(m[1])) violations.push(`mutation .${m[2]}( on ${m[1]} at line ${lineOf(code, m.index)}`);
  }
  return violations;
}

/**
 * Notion client use. In the adapter every `client.<chain>` must be one of the
 * four permitted reads and must be called; bracket access and aliasing are
 * forbidden. Everywhere else `client.` / `client[` must not appear at all.
 */
function clientViolations(code, isAdapter, permitted = PERMITTED_CLIENT_CALLS) {
  const violations = [];
  if (/\bclient\s*\[/.test(code)) violations.push("bracket access on client");
  if (/(?:=|\(|,|\.\.\.)\s*client\s*(?:[;,)}\]]|$)/m.test(code)) violations.push("client aliased or passed on");
  for (const m of code.matchAll(/\bclient((?:\s*\.\s*[A-Za-z_$][\w$]*)+)/g)) {
    const chain = m[1].replace(/\s/g, "").slice(1);
    if (!isAdapter) {
      violations.push(`client.${chain} outside the adapter`);
      continue;
    }
    const called = /^\s*\(/.test(code.slice(m.index + m[0].length));
    if (!permitted.includes(chain) || !called) violations.push(`client.${chain} at line ${lineOf(code, m.index)}`);
  }
  return violations;
}

// --- Self-tests: the checkers catch what they claim to --------------------------

test("guard self-test: forbidden calls are detected, built-in collections are allowed", () => {
  const bad = [
    "client.pages.create({})",
    "notion.pages.retrieve({})",
    "client.request({ path: 'x' })",
    "client.search({ query: 'x' })",
    "search({})",
    "client.databases.update({})",
    "client.dataSources.create({})",
    "client.blocks.children.append({})",
    "client.pages.move({})",
    "client.pages.updateMarkdown({})",
    "cache.delete(key)",
    "store.update(1)",
    "getThing().delete(1)",
  ];
  for (const snippet of bad) assert.ok(forbiddenCalls(snippet).length > 0, `not detected: ${snippet}`);
  const good = [
    "const sessions = new Map(); sessions.delete(key);",
    "let seen = new Set(); seen.delete(1);",
    "client.dataSources.query({})",
    "const pageCount = 1; const hits = [];",
  ];
  for (const snippet of good) assert.deepStrictEqual(forbiddenCalls(snippet), [], `false positive: ${snippet}`);
});

test("guard self-test: client use outside the allow-list is detected", () => {
  const bad = [
    "client.pages.retrieve({})",
    "client.search({})",
    "client.request({})",
    "client.databases.update({})",
    "client.blocks.children.append({})",
    "client['pages'].create({})",
    "const c = client;",
    "helper(client)",
    "const x = client.dataSources.query;",
    "client.users.list({})",
  ];
  for (const snippet of bad) assert.ok(clientViolations(snippet, true).length > 0, `not detected: ${snippet}`);
  for (const call of PERMITTED_CLIENT_CALLS) assert.deepStrictEqual(clientViolations(`client.${call}({})`, true), [], call);
  assert.deepStrictEqual(clientViolations("function f({ client, rootPageId }) {}", true), []);
  assert.ok(clientViolations("client.dataSources.query({})", false).length > 0, "client use outside the adapter not detected");
});

test("guard self-test: comments are ignored for code rules but URLs survive", () => {
  assert.strictEqual(stripComments("a(); // client.pages.create()").trim(), "a();");
  assert.strictEqual(stripComments("/* search( */ b();").trim(), "b();");
  assert.strictEqual(stripComments('const u = "https://example.invalid/x";'), 'const u = "https://example.invalid/x";');
});

// --- Notion SDK boundary ------------------------------------------------------------

test("bot sources exist", () => {
  assert.ok(sources.length >= 10);
  assert.ok(sources.some((s) => s.file === ADAPTER_FILE));
});

test("only bot/notion.js loads the Notion SDK; only index.js loads the adapter", () => {
  const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
  for (const { file, code } of sources) {
    assert.doesNotMatch(code, /\bimport\s*\(/, `${file} uses a dynamic import`);
    for (const [, name] of code.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
      if (name === SDK) {
        assert.ok([ADAPTER_FILE, WRITER_FILE].includes(file), `${file} loads the Notion SDK; only ${ADAPTER_FILE} and ${WRITER_FILE} may`);
      } else if (name === "./notion" || name === "./notionWrite") {
        assert.strictEqual(file, "index.js", `${file} loads the adapter; only index.js wires it`);
      } else {
        assert.ok(name.startsWith("./") || builtins.has(name), `${file} requires ${name}`);
      }
    }
  }
  const adapter = sources.find((s) => s.file === ADAPTER_FILE);
  assert.match(adapter.code, /require\(\s*["']@notionhq\/client["']\s*\)/, "adapter does not load the SDK");
});

test("the adapter calls only the four permitted Notion reads", () => {
  const adapter = sources.find((s) => s.file === ADAPTER_FILE);
  assert.deepStrictEqual(clientViolations(adapter.code, true), []);
  const used = new Set([...adapter.code.matchAll(/\bclient((?:\s*\.\s*[A-Za-z_$][\w$]*)+)\s*\(/g)].map((m) => m[1].replace(/\s/g, "").slice(1)));
  assert.deepStrictEqual([...used].sort(), [...PERMITTED_CLIENT_CALLS].sort());
});

test("the write adapter calls only pages.create (once), dataSources.retrieve and databases.retrieve", () => {
  const writer = sources.find((s) => s.file === WRITER_FILE);
  assert.ok(writer, "notionWrite.js missing");
  assert.deepStrictEqual(clientViolations(writer.code, true, WRITER_CLIENT_CALLS), []);
  assert.strictEqual([...writer.code.matchAll(WRITER_CREATE_CALL)].length, 1, "pages.create must appear exactly once");
  assert.deepStrictEqual(forbiddenCalls(writer.code.replace(WRITER_CREATE_CALL, "client.PAGES_CREATE(")), []);
});

test("no other bot file touches a Notion client", () => {
  for (const { file, code } of sources) {
    if (file === ADAPTER_FILE || file === WRITER_FILE) continue;
    assert.deepStrictEqual(clientViolations(code, false), [], file);
  }
});

test("no page API, generic request, search or mutation call anywhere in bot/ (the writer's one create aside)", () => {
  for (const { file, code } of sources) {
    if (file === WRITER_FILE) continue; // checked above, with only its single pages.create exempt
    assert.deepStrictEqual(forbiddenCalls(code), [], file);
  }
});

// --- Scope ------------------------------------------------------------------------------

// Phase 3-5 steps 1 and 5 (interim, finalised in step 10): the read adapter
// knows all five URET data sources; the write adapter the three it creates in.
test("other URET data source titles appear only in the Notion adapters", () => {
  const otherSources = /URET\s*[‐-―-]\s*(?:Specs|Work Packages|Evidence|Releases)\b/;
  const notCreatable = /URET\s*[‐-―-]\s*(?:Evidence|Releases)\b/;
  for (const { file, text } of sources) {
    if (file === ADAPTER_FILE) continue;
    assert.doesNotMatch(text, file === WRITER_FILE ? notCreatable : otherSources, file);
  }
});

// Phase 3-5 steps 3 and 6 (interim, finalised in step 10): only bot/idCounter.js
// may refer to the counter file; /new_opportunity is now a command; the
// setup script is never used.
const ID_COUNTER_FILE = "idCounter.js";
test("no setup-script use; the counter file only in idCounter.js", () => {
  for (const { file, text } of sources) {
    assert.doesNotMatch(text, /nextUretId|create-uret-databases/, file);
    if (file !== ID_COUNTER_FILE) assert.doesNotMatch(text, /uret-id-counters/, file);
  }
  assert.ok(sources.some((s) => s.file === ID_COUNTER_FILE), "idCounter.js missing");
});

test("Phase 1 transport, authorization and session modules do not reference Notion", () => {
  for (const { file, text } of sources.filter((s) => NOTION_FREE_FILES.includes(s.file))) {
    assert.doesNotMatch(text, /notion/i, file);
  }
});

test("Hermes appears only in the /health line", () => {
  const allowed = '"Hermes: Not used / isolated legacy system",';
  for (const { file, text } of sources) {
    text.split("\n").forEach((line, i) => {
      if (/hermes/i.test(line)) assert.strictEqual(line.trim(), allowed, `${file}:${i + 1}`);
    });
  }
  assert.ok(sources.find((s) => s.file === "health.js").text.includes(allowed));
});

test("no AI provider, webhook, server, GitHub or crawler code", () => {
  const forbidden = /openai|anthropic|claude|gemini|perplexity|llm|setWebhook|webhook|createServer|listen\(|github|puppeteer|playwright|crawl/i;
  for (const { file, text } of sources) {
    text.split("\n").forEach((line, i) => assert.doesNotMatch(line, forbidden, `${file}:${i + 1}`));
  }
});

test("the only network host written in bot/ is the Telegram Bot API", () => {
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

test("no source or test file contains a token- or ID-shaped literal", () => {
  const shapes = [
    [/\d{5,}:[A-Za-z0-9_-]{30,}/, "Telegram token"],
    [/(?:ntn|secret)_[A-Za-z0-9]{16,}/, "Notion token"],
    [/\b[0-9a-f]{32}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, "Notion ID"],
  ];
  for (const dir of [BOT_DIR, __dirname]) {
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".js"))) {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      for (const [shape, kind] of shapes) assert.doesNotMatch(text, shape, `${f} contains a ${kind}-shaped literal`);
    }
  }
});
