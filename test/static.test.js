"use strict";

// Static guards on the bot sources (final rules, Phase 3-5; Phase 4 status update):
//
// Notion boundary
// - only bot/notion.js and bot/notionWrite.js load the Notion SDK, and only
//   bot/index.js loads those adapters and the ID counter;
// - bot/notion.js calls exactly four reads: blocks.children.list,
//   databases.retrieve, dataSources.retrieve, dataSources.query;
// - bot/notionWrite.js calls exactly pages.create (written once),
//   pages.update (written once, with a Status-only payload) and
//   dataSources.retrieve;
// - no other file touches a Notion client;
// - nowhere in bot/: any other page API (pages.update / delete / move / ...),
//   client.request, search, .create( / .append( / .move( / updateMarkdown, or
//   .update( / .delete( on anything but a Map/Set created in the same file.
//
// Scope
// - URET data source titles only in the two adapters (Releases only in the
//   read adapter), plus the four locked "Stored in ..." lines;
// - the counter file is named only in bot/idCounter.js and test/helpers.js;
//   the setup script is never used; tests always use temporary counter files
//   and install the real-counter guard;
// - Phase 1 transport, authorization and session modules stay free of Notion;
//   Hermes appears only in the /health line;
// - no AI provider, webhook, server, GitHub or crawler code (the Worker option
//   name "Claude Code" is data: one exact literal in bot/captureFlows.js);
// - only Node built-ins or local files, only the Telegram host, no new
//   dependencies, no token- or ID-shaped literals.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { builtinModules } = require("module");
const { REAL_COUNTER_FILE } = require("./helpers");

const BOT_DIR = path.join(__dirname, "..", "bot");
const TEST_DIR = __dirname;

// Removes /* */ and // comments so code rules ignore prose. "://" in URLs is kept.
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

function load(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      return { file: f, text, code: stripComments(text) };
    });
}

const sources = load(BOT_DIR);
const testSources = load(TEST_DIR);
const source = (file) => sources.find((s) => s.file === file);
const lineOf = (text, index) => text.slice(0, index).split("\n").length;

const SDK = "@notionhq/client";
const READ_ADAPTER = "notion.js";
const WRITE_ADAPTER = "notionWrite.js";
const ADAPTERS = [READ_ADAPTER, WRITE_ADAPTER];
const READ_CALLS = ["blocks.children.list", "databases.retrieve", "dataSources.retrieve", "dataSources.query"];
const WRITE_CALLS = ["pages.create", "pages.update", "dataSources.retrieve"];
const PAGES_CREATE = /\bclient\s*\.\s*pages\s*\.\s*create\s*\(/g;
const PAGES_UPDATE = /\bclient\s*\.\s*pages\s*\.\s*update\s*\(/g;
// The one permitted update, whole: a page ID and the Status select, nothing else.
const PAGES_UPDATE_STATUS_ONLY =
  /\bclient\.pages\.update\(\{ page_id: [A-Za-z_$][\w$.]*, properties: \{ Status: \{ select: \{ name: [A-Za-z_$][\w$]* \} \} \} \}\)/g;
// Modules only index.js may load (it wires them together).
const WIRED_BY_INDEX = ["./notion", "./notionWrite", "./idCounter"];
// Phase 1 transport, authorization and session modules stay free of Notion.
const NOTION_FREE_FILES = ["auth.js", "session.js", "telegram.js"];

const TITLE = (names) => new RegExp(`URET\\s*[‐-―-]\\s*(?:${names})\\b`);
const ANY_TITLE = TITLE("Opportunities|Specs|Work Packages|Evidence|Releases");
const NOT_CREATABLE_TITLE = TITLE("Releases");
// The locked confirmation lines are the only titles outside the adapters.
const CONFIRMATION_FILE = "captureFlows.js";
const CONFIRMATION_LINES = [
  '"Stored in URET – Opportunities.",',
  '"Stored in URET – Specs.",',
  '"Stored in URET – Work Packages.",',
  '"Stored in URET – Evidence.",',
];

const COUNTER_STEM = path.basename(REAL_COUNTER_FILE, ".json");
const COUNTER_FILES = { bot: "idCounter.js", test: "helpers.js" };

const WORKER_OPTION = '"Claude Code"';
const WORKER_OPTION_FILE = "captureFlows.js";

// --- Checkers ----------------------------------------------------------------------

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
 * Notion client use. With an allow-list (`permitted`), every `client.<chain>`
 * must be one of those calls and must be called; bracket access and aliasing
 * are forbidden. Without one (`null`), `client.` / `client[` must not appear.
 */
function clientViolations(code, permitted) {
  const violations = [];
  if (/\bclient\s*\[/.test(code)) violations.push("bracket access on client");
  if (/(?:=|\(|,|\.\.\.)\s*client\s*(?:[;,)}\]]|$)/m.test(code)) violations.push("client aliased or passed on");
  for (const m of code.matchAll(/\bclient((?:\s*\.\s*[A-Za-z_$][\w$]*)+)/g)) {
    const chain = m[1].replace(/\s/g, "").slice(1);
    if (!permitted) {
      violations.push(`client.${chain} outside the adapters`);
      continue;
    }
    const called = /^\s*\(/.test(code.slice(m.index + m[0].length));
    if (!permitted.includes(chain) || !called) violations.push(`client.${chain} at line ${lineOf(code, m.index)}`);
  }
  return violations;
}

const usedCalls = (code) =>
  [...new Set([...code.matchAll(/\bclient((?:\s*\.\s*[A-Za-z_$][\w$]*)+)\s*\(/g)].map((m) => m[1].replace(/\s/g, "").slice(1)))].sort();

// The write adapter: its allow-list, pages.create written exactly once, and
// every other forbidden pattern still forbidden.
// The write adapter: its allow-list, pages.create written exactly once,
// pages.update written exactly once and only in the Status-only shape, and
// every other forbidden pattern still forbidden.
function writerViolations(code) {
  const violations = clientViolations(code, WRITE_CALLS);
  const creates = [...code.matchAll(PAGES_CREATE)].length;
  if (creates !== 1) violations.push(`pages.create written ${creates} times`);
  const updates = [...code.matchAll(PAGES_UPDATE)].length;
  const statusOnly = [...code.matchAll(PAGES_UPDATE_STATUS_ONLY)].length;
  if (updates !== 1) violations.push(`pages.update written ${updates} times`);
  if (statusOnly !== updates) violations.push("pages.update with a payload other than Status only");
  const exempted = code.replace(PAGES_CREATE, "client.PAGES_CREATE(").replace(PAGES_UPDATE_STATUS_ONLY, "client.PAGES_UPDATE_STATUS()");
  violations.push(...forbiddenCalls(exempted));
  return violations;
}

// --- Self-tests: the checkers catch what they claim to --------------------------

test("guard self-test: forbidden calls are detected, built-in collections are allowed", () => {
  const bad = [
    "client.pages.create({})",
    "notion.pages.retrieve({})",
    "client.pages.update({})",
    "client.pages.delete({})",
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
    "capture.createSession(1); store.deleteSession(id);",
    "const pageCount = 1; const hits = [];",
  ];
  for (const snippet of good) assert.deepStrictEqual(forbiddenCalls(snippet), [], `false positive: ${snippet}`);
});

test("guard self-test: client use outside an allow-list is detected", () => {
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
  for (const snippet of bad) assert.ok(clientViolations(snippet, READ_CALLS).length > 0, `not detected: ${snippet}`);
  for (const call of READ_CALLS) assert.deepStrictEqual(clientViolations(`client.${call}({})`, READ_CALLS), [], call);
  assert.deepStrictEqual(clientViolations("function f({ client, rootPageId }) {}", READ_CALLS), []);
  assert.ok(clientViolations("client.dataSources.query({})", null).length > 0, "client use outside the adapters not detected");
});

test("guard self-test: the write adapter rule", () => {
  const update = "client.pages.update({ page_id: page.id, properties: { Status: { select: { name: newStatus } } } })";
  const ok = `client.dataSources.retrieve({}); client.pages.create({}); ${update};`;
  assert.deepStrictEqual(writerViolations(ok), []);
  const bad = [
    "client.dataSources.retrieve({});",
    `${ok} client.pages.create({});`,
    `${ok} ${update};`,
    "client.dataSources.retrieve({}); client.pages.create({});",
    "client.dataSources.retrieve({}); client.pages.create({}); client.pages.update({ page_id: page.id, properties: props });",
    "client.dataSources.retrieve({}); client.pages.create({}); client.pages.update({ page_id: page.id, archived: true });",
    "client.dataSources.retrieve({}); client.pages.create({}); client.pages.update({ page_id: page.id, properties: { Status: { select: { name: s } }, Name: { title: [] } } });",
    "client.dataSources.retrieve({}); client.pages.create({}); client.pages.update({ page_id: page.id, properties: { Name: { select: { name: s } } } });",
    "client.dataSources.retrieve({}); client.pages.create({}); client.pages.update({ page_id: page.id, properties: { Status: { select: { name: s } } }, in_trash: true });",
    `${ok} client.databases.retrieve({});`,
    `${ok} client.dataSources.query({});`,
    `${ok} client.pages.move({});`,
    `${ok} notion.pages.retrieve({});`,
    `${ok} client.search({});`,
    `${ok} cache.delete(1);`,
  ];
  for (const snippet of bad) assert.ok(writerViolations(snippet).length > 0, `not detected: ${snippet}`);
});

test("guard self-test: comments are ignored for code rules but URLs survive", () => {
  assert.strictEqual(stripComments("a(); // client.pages.create()").trim(), "a();");
  assert.strictEqual(stripComments("/* search( */ b();").trim(), "b();");
  assert.strictEqual(stripComments('const u = "https://example.invalid/x";'), 'const u = "https://example.invalid/x";');
});

// --- Notion boundary ------------------------------------------------------------------

test("bot sources exist", () => {
  assert.ok(sources.length >= 14);
  for (const file of [...ADAPTERS, "idCounter.js", "captureFlows.js", "captureSession.js", "index.js"]) assert.ok(source(file), file);
});

test("only the two adapters load the Notion SDK; only index.js loads the adapters and the ID counter", () => {
  const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
  for (const { file, code } of sources) {
    assert.doesNotMatch(code, /\bimport\s*\(/, `${file} uses a dynamic import`);
    for (const [, name] of code.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
      if (name === SDK) {
        assert.ok(ADAPTERS.includes(file), `${file} loads the Notion SDK; only ${ADAPTERS.join(" and ")} may`);
      } else if (WIRED_BY_INDEX.includes(name)) {
        assert.strictEqual(file, "index.js", `${file} loads ${name}; only index.js wires it`);
      } else {
        assert.ok(name.startsWith("./") || builtins.has(name), `${file} requires ${name}`);
      }
    }
  }
  for (const file of ADAPTERS) assert.match(source(file).code, /require\(\s*["']@notionhq\/client["']\s*\)/, `${file} does not load the SDK`);
});

test("the read adapter calls exactly the four permitted reads", () => {
  const { code } = source(READ_ADAPTER);
  assert.deepStrictEqual(clientViolations(code, READ_CALLS), []);
  assert.deepStrictEqual(usedCalls(code), [...READ_CALLS].sort());
  assert.deepStrictEqual(forbiddenCalls(code), []);
});

test("the write adapter calls exactly pages.create (once), pages.update (once, Status only) and dataSources.retrieve", () => {
  const { code } = source(WRITE_ADAPTER);
  assert.deepStrictEqual(writerViolations(code), []);
  assert.deepStrictEqual(usedCalls(code), [...WRITE_CALLS].sort());
});

test("no other bot file touches a Notion client or calls a page API, request, search or mutation", () => {
  for (const { file, code } of sources) {
    if (ADAPTERS.includes(file)) continue;
    assert.deepStrictEqual(clientViolations(code, null), [], file);
    assert.deepStrictEqual(forbiddenCalls(code), [], file);
  }
});

// --- Scope ------------------------------------------------------------------------------

test("URET data source titles appear only in the adapters and the locked confirmation lines", () => {
  for (const { file, text } of sources) {
    if (file === READ_ADAPTER) continue;
    if (file === WRITE_ADAPTER) {
      assert.doesNotMatch(text, NOT_CREATABLE_TITLE, file);
      continue;
    }
    text.split("\n").forEach((line, i) => {
      if (!ANY_TITLE.test(line)) return;
      const allowed = file === CONFIRMATION_FILE && CONFIRMATION_LINES.includes(line.trim());
      assert.ok(allowed, `${file}:${i + 1} names a URET data source`);
    });
  }
  const flows = source(CONFIRMATION_FILE).text;
  for (const line of CONFIRMATION_LINES) assert.strictEqual(flows.split(line).length - 1, 1, line);
});

test("the counter file is named only in bot/idCounter.js and test/helpers.js; the setup script is never used", () => {
  assert.strictEqual(COUNTER_STEM, ["uret", "id", "counters"].join("-"));
  for (const [dir, files, allowed] of [["bot", sources, COUNTER_FILES.bot], ["test", testSources, COUNTER_FILES.test]]) {
    for (const { file, text } of files) {
      if (file === allowed) continue;
      assert.ok(!text.includes(COUNTER_STEM), `${dir}/${file} names the counter file`);
    }
    assert.ok(files.find((s) => s.file === allowed).text.includes(`${COUNTER_STEM}.json`), `${dir}/${allowed} no longer names it`);
  }
  for (const { file, text } of sources) assert.doesNotMatch(text, /nextUretId|create-uret-databases/, file);
});

test("every test file that can reach the ID counter installs the real-counter guard", () => {
  const reaches = /require\(\s*["']\.\.\/bot\/(?:idCounter|index)["']\s*\)/;
  const guarded = [];
  for (const { file, code } of testSources.filter((s) => s.file.endsWith(".test.js"))) {
    if (!reaches.test(code)) continue;
    assert.match(code, /^forbidRealCounterFile\(\);$/m, `${file} loads the ID counter without forbidRealCounterFile()`);
    guarded.push(file);
  }
  assert.ok(guarded.length >= 6, `only ${guarded.length} guarded files`);
});

test("tests always pass a temporary file to reserveNextId", () => {
  for (const { file, code } of testSources) {
    if (file === "static.test.js") continue;
    for (const m of code.matchAll(/reserveNextId\(([^\n]*)/g)) {
      assert.match(m[1], /\bfile\b/, `${file}: reserveNextId without a file option`);
    }
  }
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
  assert.ok(source("health.js").text.includes(allowed));
});

test("no AI provider, webhook, server, GitHub or crawler code", () => {
  const forbidden = /openai|anthropic|claude|gemini|perplexity|llm|setWebhook|webhook|createServer|listen\(|github|puppeteer|playwright|crawl/i;
  for (const { file, text } of sources) {
    const checked = file === WORKER_OPTION_FILE ? text.split(WORKER_OPTION).join('""') : text;
    checked.split("\n").forEach((line, i) => assert.doesNotMatch(line, forbidden, `${file}:${i + 1}`));
  }
});

test("the Worker option exemption covers exactly one literal in one file", () => {
  for (const { file, text } of sources) {
    assert.strictEqual(text.split(WORKER_OPTION).length - 1, file === WORKER_OPTION_FILE ? 1 : 0, file);
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
  for (const { file, text } of [...sources, ...testSources]) {
    for (const [shape, kind] of shapes) assert.doesNotMatch(text, shape, `${file} contains a ${kind}-shaped literal`);
  }
});

// --- Wiring -------------------------------------------------------------------------------

// main() runs only with a live configuration, so its wiring is checked here.
test("index.js wires the write adapter and ID reservation as designed", () => {
  const index = source("index.js").code;
  const main = index.slice(index.indexOf("async function main("));
  // Loaded only when Notion is configured, inside that branch.
  const branch = main.slice(main.indexOf("if (config.notionConfigured) {"), main.indexOf("} else if (notionStatus.state"));
  for (const mod of WIRED_BY_INDEX) {
    assert.ok(branch.includes(`require("${mod}")`), `${mod} not loaded in the configured branch`);
    assert.strictEqual(index.split(`require("${mod}")`).length - 1, 1, `${mod} loaded more than once`);
  }
  // A separate client for writes; the resolver is the read adapter's verified discovery.
  assert.match(branch, /createNotionWriter\(\{ client: createNotionWriteClient\(config\), rootPageId: config\.rootPageId, resolveDataSource: reader\.getDataSourceId \}\)/);
  // Production reservations use the default (repository) counter file and the read adapter.
  assert.match(branch, /reserveId = \(type, \{ signal \} = \{\}\) => reserveNextId\(type, reader, \{ signal \}\);/);
  assert.match(main, /createBot\(\{ config, configStatus: status, telegram, logger, sessions, notion, writer, reserveId \}\)/);
});
