"use strict";

const test = require("node:test");
const assert = require("node:assert");
const util = require("util");
const { APIResponseError, RequestTimeoutError, UnknownHTTPResponseError, InvalidPathParameterError, Client } = require("@notionhq/client");
const notion = require("../bot/notion");
const { fakeNotionToken, fakePageId, dashedId } = require("./helpers");

const TITLE = "URET – Opportunities";
const PERMITTED = ["blocks.children.list", "databases.retrieve", "dataSources.retrieve", "dataSources.query"];

// --- Fake Notion ------------------------------------------------------------------

// Wraps the fake so that touching anything outside the four permitted methods
// throws. The adapter therefore cannot call pages.*, search, request, or any
// write, even by accident.
function guard(target, pathSoFar = "client") {
  return new Proxy(target, {
    get(obj, prop) {
      if (typeof prop === "symbol") return undefined;
      if (!Object.prototype.hasOwnProperty.call(obj, prop)) throw new Error(`forbidden access: ${pathSoFar}.${prop}`);
      const value = obj[prop];
      return value && typeof value === "object" ? guard(value, `${pathSoFar}.${prop}`) : value;
    },
    set(_obj, prop) {
      throw new Error(`forbidden write: ${pathSoFar}.${String(prop)}`);
    },
  });
}

const rt = (text) => [{ type: "text", plain_text: text, text: { content: text } }];

function validProperties(statusOptions = ["Idea", "Active", "Parked", "Done"]) {
  return {
    "URET ID": { id: "uid", type: "rich_text", rich_text: {} },
    Name: { id: "title", type: "title", title: {} },
    Status: { id: "stat", type: "select", select: { options: statusOptions.map((name) => ({ name })) } },
    "Asset type": { id: "asst", type: "multi_select", multi_select: { options: [] } },
    "Project / Asset": { id: "proj", type: "rich_text", rich_text: {} },
    "Problem summary": { id: "prob", type: "rich_text", rich_text: {} },
    "Target users": { id: "user", type: "rich_text", rich_text: {} },
    "Success metrics": { id: "metr", type: "rich_text", rich_text: {} },
    "Next action": { id: "next", type: "rich_text", rich_text: {} },
    Created: { id: "crtd", type: "created_time", created_time: {} },
    "Last updated": { id: "edtd", type: "last_edited_time", last_edited_time: {} },
    Specs: { id: "spec", type: "relation", relation: {} },
    Releases: { id: "rels", type: "relation", relation: {} },
  };
}

/**
 * A small fake workspace. Override any part via `opts`. Handlers may throw.
 * Every call is recorded as { method, args }.
 */
function fakeWorkspace(opts = {}) {
  const root = opts.root || fakePageId();
  const dbId = fakePageId();
  const dsId = fakePageId();
  const calls = [];
  const state = {
    childPages: opts.childPages || [[{ object: "block", id: dbId, type: "child_database", in_trash: false, child_database: { title: TITLE } }]],
    database: {
      object: "database",
      id: dbId,
      in_trash: false,
      parent: { type: "page_id", page_id: dashedId(root) },
      data_sources: [{ id: dsId, name: TITLE }],
      ...(opts.database || {}),
    },
    dataSource: {
      object: "data_source",
      id: dsId,
      in_trash: false,
      title: rt(TITLE),
      database_parent: { type: "page_id", page_id: dashedId(root) },
      properties: validProperties(),
      ...(opts.dataSource || {}),
    },
    query: opts.query || (() => ({ object: "list", results: [], has_more: false, next_cursor: null })),
  };

  const record = (method, args, fn) => {
    calls.push({ method, args });
    return fn();
  };
  const raw = {
    blocks: {
      children: {
        list: async (args) =>
          record("blocks.children.list", args, () => {
            if (opts.onList) return opts.onList(args);
            const index = args.start_cursor ? Number(args.start_cursor) : 0;
            const results = state.childPages[index] || [];
            const hasMore = index + 1 < state.childPages.length;
            return { object: "list", results, has_more: hasMore, next_cursor: hasMore ? String(index + 1) : null };
          }),
      },
    },
    databases: {
      retrieve: async (args) => record("databases.retrieve", args, () => (opts.onDatabase ? opts.onDatabase(args) : state.database)),
    },
    dataSources: {
      retrieve: async (args) => record("dataSources.retrieve", args, () => (opts.onDataSource ? opts.onDataSource(args) : state.dataSource)),
      query: async (args) => record("dataSources.query", args, () => state.query(args)),
    },
  };
  const client = guard(raw);
  const reader = notion.createNotionReader({ client, rootPageId: root });
  const count = (method) => calls.filter((c) => c.method === method).length;
  return { root, dbId, dsId, calls, count, state, reader, raw };
}

const page = (status, extra = {}) => ({
  object: "page",
  in_trash: false,
  url: "https://www.notion.so/example",
  properties: { Status: { id: "stat", type: "select", select: status === null ? null : { name: status } } },
  ...extra,
});

// Query handler returning `pages` split into pages of 100.
function pagedQuery(pages) {
  return (args) => {
    const index = args.start_cursor ? Number(args.start_cursor) : 0;
    const results = pages.slice(index * 100, index * 100 + 100);
    const hasMore = (index + 1) * 100 < pages.length;
    return { object: "list", results, has_more: hasMore, next_cursor: hasMore ? String(index + 1) : null };
  };
}

async function rejectsWith(promise, label) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof notion.NotionReadError, `unexpected error type: ${err && err.name}`);
    assert.strictEqual(err.label, label);
    return true;
  });
}

// --- Client settings ---------------------------------------------------------------

test("client is created with version 2025-09-03, no retries, 10 s timeout and a no-op logger", () => {
  let options;
  class Capture {
    constructor(o) {
      options = o;
    }
  }
  const token = fakeNotionToken();
  const config = {};
  Object.defineProperty(config, "notionToken", { value: token, enumerable: false });
  notion.createNotionClient(config, { ClientClass: Capture });
  assert.strictEqual(options.notionVersion, "2025-09-03");
  assert.strictEqual(options.retry, false);
  assert.strictEqual(options.timeoutMs, 10000);
  assert.strictEqual(typeof options.logger, "function");
  assert.strictEqual(options.logger("warn", "request fail", { code: "x" }), undefined);
  assert.ok(options.auth === token, "auth not taken from the hidden config property");
  assert.strictEqual(Object.keys(options).sort().join(","), "auth,logger,notionVersion,retry,timeoutMs");
});

test("the real SDK client accepts those settings without any network call", () => {
  const config = {};
  Object.defineProperty(config, "notionToken", { value: fakeNotionToken(), enumerable: false });
  const client = notion.createNotionClient(config);
  assert.ok(client instanceof Client);
});

// --- Discovery -----------------------------------------------------------------------

test("discovery is lazy: nothing is called until the first read", () => {
  const ws = fakeWorkspace();
  assert.strictEqual(ws.calls.length, 0);
  assert.strictEqual(ws.reader.hasCachedSource(), false);
});

test("discovery succeeds with exactly one verified source and is then remembered", async () => {
  const ws = fakeWorkspace();
  await ws.reader.countByStatus();
  assert.deepStrictEqual(ws.calls.map((c) => c.method), ["blocks.children.list", "databases.retrieve", "dataSources.retrieve", "dataSources.query"]);
  assert.strictEqual(ws.calls[0].args.block_id, ws.root);
  assert.strictEqual(ws.calls[1].args.database_id, ws.dbId);
  assert.strictEqual(ws.calls[2].args.data_source_id, ws.dsId);
  assert.strictEqual(ws.reader.hasCachedSource(), true);
  await ws.reader.countByStatus();
  assert.strictEqual(ws.count("blocks.children.list"), 1, "rediscovered although remembered");
  assert.strictEqual(ws.count("dataSources.query"), 2);
});

test("titles are compared after normalising dashes, spacing and case", async () => {
  for (const title of ["URET - Opportunities", "uret  —  opportunities", " URET – Opportunities "]) {
    const ws = fakeWorkspace({ childPages: [[{ object: "block", id: "x", type: "child_database", child_database: { title } }]], onDatabase: () => ({}) });
    await rejectsWith(ws.reader.countByStatus(), "notion_source_invalid"); // matched, then failed on the fake database
    assert.strictEqual(ws.count("databases.retrieve"), 1, `title not matched: ${title}`);
  }
});

test("zero matching sources fails safe", async () => {
  const others = [
    { object: "block", id: "a", type: "child_database", child_database: { title: "URET – Specs" } },
    { object: "block", id: "b", type: "child_database", child_database: { title: "URET – Opportunities (old)" } },
    { object: "block", id: "c", type: "child_page", child_page: { title: TITLE } },
    { object: "block", id: "d", type: "child_database", in_trash: true, child_database: { title: TITLE } },
  ];
  const ws = fakeWorkspace({ childPages: [others] });
  await rejectsWith(ws.reader.countByStatus(), "notion_source_not_found");
  assert.strictEqual(ws.count("databases.retrieve"), 0);
  assert.strictEqual(ws.reader.hasCachedSource(), false);
});

test("multiple matching sources fail safe without choosing one", async () => {
  const two = [
    { object: "block", id: "a", type: "child_database", child_database: { title: TITLE } },
    { object: "block", id: "b", type: "child_database", child_database: { title: "URET - Opportunities" } },
  ];
  const ws = fakeWorkspace({ childPages: [two] });
  await rejectsWith(ws.reader.countByStatus(), "notion_source_ambiguous");
  assert.strictEqual(ws.count("databases.retrieve"), 0);
});

test("discovery follows child-block pagination, and matches across pages are still ambiguous", async () => {
  const match = (id) => ({ object: "block", id, type: "child_database", child_database: { title: TITLE } });
  const filler = { object: "block", id: "f", type: "paragraph", paragraph: {} };
  const ws = fakeWorkspace({ childPages: [[filler], [filler]] });
  ws.state.childPages[2] = [match(ws.dbId)];
  await ws.reader.countByStatus();
  assert.strictEqual(ws.count("blocks.children.list"), 3);
  assert.deepStrictEqual(ws.calls.filter((c) => c.method === "blocks.children.list").map((c) => c.args.start_cursor), [undefined, "1", "2"]);

  const split = fakeWorkspace({ childPages: [[match("a")], [match("b")]] });
  await rejectsWith(split.reader.countByStatus(), "notion_source_ambiguous");
});

test("more than 10 pages of root children is treated as ambiguous", async () => {
  const filler = { object: "block", id: "f", type: "paragraph", paragraph: {} };
  const ws = fakeWorkspace({ childPages: Array.from({ length: 12 }, () => [filler]) });
  await rejectsWith(ws.reader.countByStatus(), "notion_source_ambiguous");
  assert.strictEqual(ws.count("blocks.children.list"), 10);
});

test("a database with the wrong parent, in the trash, or without exactly one data source fails safe", async () => {
  const other = fakePageId();
  const cases = [
    [{ parent: { type: "page_id", page_id: other } }, "notion_source_invalid"],
    [{ parent: { type: "block_id", block_id: fakePageId() } }, "notion_source_invalid"],
    [{ parent: { type: "workspace", workspace: true } }, "notion_source_invalid"],
    [{ in_trash: true }, "notion_source_invalid"],
    [{ data_sources: [] }, "notion_source_invalid"],
    [{ data_sources: [{ id: "a" }, { id: "b" }] }, "notion_source_ambiguous"],
  ];
  for (const [database, label] of cases) {
    const ws = fakeWorkspace({ database });
    await rejectsWith(ws.reader.countByStatus(), label);
    assert.strictEqual(ws.count("dataSources.retrieve"), 0);
    assert.strictEqual(ws.reader.hasCachedSource(), false);
  }
});

test("a data source with the wrong parent, title, or in the trash fails safe", async () => {
  const cases = [
    { database_parent: { type: "page_id", page_id: fakePageId() } },
    { database_parent: { type: "block_id", block_id: fakePageId() } },
    { title: rt("Something else") },
    { in_trash: true },
  ];
  for (const dataSource of cases) {
    const ws = fakeWorkspace({ dataSource });
    await rejectsWith(ws.reader.countByStatus(), "notion_source_invalid");
    assert.strictEqual(ws.count("dataSources.query"), 0);
    assert.strictEqual(ws.reader.hasCachedSource(), false);
  }
});

test("the root page ID matches in plain or dashed form", async () => {
  const root = fakePageId();
  const ws = fakeWorkspace({ root, database: { parent: { type: "page_id", page_id: root } } });
  await ws.reader.countByStatus();
  assert.strictEqual(ws.reader.hasCachedSource(), true);
});

test("a remembered source that is no longer found is forgotten, and rediscovered on the next command", async () => {
  let fail = false;
  const ws = fakeWorkspace({
    query: () => {
      if (fail) throw new APIResponseError({ code: "object_not_found", status: 404, message: "gone", headers: {}, rawBodyText: "{}" });
      return { results: [], has_more: false };
    },
  });
  await ws.reader.countByStatus();
  fail = true;
  await rejectsWith(ws.reader.countByStatus(), "notion_not_found");
  assert.strictEqual(ws.reader.hasCachedSource(), false);
  assert.strictEqual(ws.count("blocks.children.list"), 1, "rediscovered within the failing command");
  fail = false;
  await ws.reader.countByStatus();
  assert.strictEqual(ws.count("blocks.children.list"), 2);
});

// --- Schema ------------------------------------------------------------------------------

test("valid schema passes, including extra Status options", () => {
  assert.deepStrictEqual(notion.verifySchema({ properties: validProperties() }), { ok: true, problems: [] });
  const extra = notion.verifySchema({ properties: validProperties(["Idea", "Active", "Parked", "Done", "Archived", "Later"]) });
  assert.strictEqual(extra.ok, true);
});

test("missing properties, wrong types and missing Status options are reported", () => {
  const missing = validProperties();
  delete missing["Next action"];
  delete missing.Releases;
  assert.deepStrictEqual(notion.verifySchema({ properties: missing }).problems, ["missing:Next action", "missing:Releases"]);

  const wrongType = validProperties();
  wrongType.Status = { id: "stat", type: "status", status: {} };
  wrongType.Created = { id: "crtd", type: "date", date: {} };
  assert.deepStrictEqual(notion.verifySchema({ properties: wrongType }).problems, ["type:Status", "type:Created"]);

  const options = notion.verifySchema({ properties: validProperties(["Idea", "Active"]) });
  assert.deepStrictEqual(options.problems, ["status_option:Parked", "status_option:Done"]);
  assert.strictEqual(notion.verifySchema({}).ok, false);
});

test("an invalid schema blocks /status and /show reads", async () => {
  const props = validProperties(["Idea"]);
  const ws = fakeWorkspace({ dataSource: { properties: props } });
  await rejectsWith(ws.reader.countByStatus(), "notion_schema_invalid");
  await rejectsWith(ws.reader.findByUretId("opp", "OPP-001"), "notion_schema_invalid");
  assert.strictEqual(ws.count("dataSources.query"), 0);
});

test("the required schema matches the approved property list", () => {
  assert.deepStrictEqual(Object.keys(notion.REQUIRED_SCHEMA), [
    "URET ID", "Name", "Status", "Asset type", "Project / Asset", "Problem summary", "Target users",
    "Success metrics", "Next action", "Created", "Last updated", "Specs", "Releases",
  ]);
});

// --- Counting ------------------------------------------------------------------------------

test("counts non-trashed records by the four statuses", async () => {
  const pages = [
    ...Array(3).fill(0).map(() => page("Idea")),
    ...Array(2).fill(0).map(() => page("Active")),
    page("Parked"),
    page("Done"),
    page("Idea", { in_trash: true }),
    page("Weird", { archived: true }),
    { object: "data_source" },
  ];
  const ws = fakeWorkspace({ query: pagedQuery(pages) });
  const result = await ws.reader.countByStatus();
  assert.strictEqual(result.outcome, "counts");
  assert.strictEqual(result.total, 7);
  assert.deepStrictEqual(result.counts, { Idea: 3, Active: 2, Parked: 1, Done: 1 });
  assert.deepStrictEqual([result.idea, result.active, result.parked, result.done], [3, 2, 1, 1]);
  assert.strictEqual(result.unexpected, 0);
  assert.strictEqual(result.empty, 0);
  assert.strictEqual(result.incomplete, false);
  const query = ws.calls.find((c) => c.method === "dataSources.query").args;
  assert.strictEqual(query.data_source_id, ws.dsId);
  assert.strictEqual(query.page_size, 100);
  assert.deepStrictEqual(query.filter_properties, ["stat"], "should request only the Status property (by its ID)");
});

test("an unexpected or empty Status is a data integrity problem", async () => {
  for (const odd of [page("Someday"), page(null), { object: "page", in_trash: false, properties: {} }]) {
    const ws = fakeWorkspace({ query: pagedQuery([page("Idea"), odd]) });
    const result = await ws.reader.countByStatus();
    assert.strictEqual(result.outcome, "data_integrity");
    assert.strictEqual(result.unexpected + result.empty, 1);
  }
});

test("exactly 1,000 records with nothing remaining is complete", async () => {
  const ws = fakeWorkspace({ query: pagedQuery(Array(1000).fill(0).map(() => page("Done"))) });
  const result = await ws.reader.countByStatus();
  assert.strictEqual(result.outcome, "counts");
  assert.strictEqual(result.total, 1000);
  assert.strictEqual(ws.count("dataSources.query"), 10);
});

test("reaching the 10-page cap with more remaining is incomplete, with no 11th request", async () => {
  const ws = fakeWorkspace({ query: pagedQuery(Array(1001).fill(0).map(() => page("Idea"))) });
  const result = await ws.reader.countByStatus();
  assert.strictEqual(result.outcome, "incomplete");
  assert.strictEqual(result.incomplete, true);
  assert.strictEqual(ws.count("dataSources.query"), 10);
  const cursors = ws.calls.filter((c) => c.method === "dataSources.query").map((c) => c.args.start_cursor);
  assert.deepStrictEqual(cursors, [undefined, "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
});

test("a data integrity problem takes priority over an incomplete scan", async () => {
  const ws = fakeWorkspace({ query: pagedQuery([page("Nope"), ...Array(1100).fill(0).map(() => page("Idea"))]) });
  const result = await ws.reader.countByStatus();
  assert.strictEqual(result.outcome, "data_integrity");
  assert.strictEqual(result.incomplete, true);
});

// --- Lookup ----------------------------------------------------------------------------------

test("exact lookup sends an equals filter with page_size 2", async () => {
  const ws = fakeWorkspace({ query: () => ({ results: [page("Idea")], has_more: false }) });
  const found = await ws.reader.findByUretId("opp", "OPP-001");
  assert.strictEqual(found.result, "found");
  assert.strictEqual(found.trashed, false);
  const query = ws.calls.find((c) => c.method === "dataSources.query").args;
  assert.deepStrictEqual(query, { data_source_id: ws.dsId, filter: { property: "URET ID", rich_text: { equals: "OPP-001" } }, page_size: 2 });
});

test("lookup reports zero, duplicate and trashed results", async () => {
  const cases = [
    [{ results: [], has_more: false }, "not_found", false],
    [{ results: [page("Idea"), page("Done")], has_more: false }, "duplicate", false],
    [{ results: [page("Idea")], has_more: true }, "duplicate", false],
    [{ results: [page("Idea", { in_trash: true })], has_more: false }, "found", true],
    [{ results: [page("Idea", { archived: true })], has_more: false }, "found", true],
  ];
  for (const [response, result, trashed] of cases) {
    const ws = fakeWorkspace({ query: () => response });
    const out = await ws.reader.findByUretId("opp", "OPP-002");
    assert.strictEqual(out.result, result);
    assert.strictEqual(out.trashed, trashed);
    if (result !== "found") assert.strictEqual(out.page, null, "a record was chosen despite ambiguity");
    assert.strictEqual(ws.count("dataSources.query"), 1);
  }
});

// --- Health ----------------------------------------------------------------------------------

test("health: all OK only when every read succeeded", async () => {
  const ws = fakeWorkspace();
  const first = await ws.reader.health();
  assert.deepStrictEqual(first, { reachable: "ok", sourceFound: "ok", schemaValid: "ok", label: null });
  const second = await ws.reader.health();
  assert.deepStrictEqual(second, first);
  assert.strictEqual(ws.count("blocks.children.list"), 1, "remembered source not reused");
  assert.strictEqual(ws.count("dataSources.retrieve"), 2, "remembered source not re-read");
});

test("health: unreachable Notion leaves the other lines NOT CHECKED", async () => {
  const ws = fakeWorkspace({
    onList: () => {
      throw new RequestTimeoutError();
    },
  });
  assert.deepStrictEqual(await ws.reader.health(), { reachable: "not_ok", sourceFound: "not_checked", schemaValid: "not_checked", label: "notion_timeout" });
});

test("health: source not found or ambiguous", async () => {
  const none = fakeWorkspace({ childPages: [[]] });
  assert.deepStrictEqual(await none.reader.health(), { reachable: "ok", sourceFound: "not_ok", schemaValid: "not_checked", label: "notion_source_not_found" });
  const twoMatches = [
    { object: "block", id: "a", type: "child_database", child_database: { title: TITLE } },
    { object: "block", id: "b", type: "child_database", child_database: { title: TITLE } },
  ];
  const two = fakeWorkspace({ childPages: [twoMatches] });
  assert.deepStrictEqual(await two.reader.health(), { reachable: "ok", sourceFound: "not_ok", schemaValid: "not_checked", label: "notion_source_ambiguous" });
});

test("health: schema invalid", async () => {
  const ws = fakeWorkspace({ dataSource: { properties: validProperties(["Idea", "Active", "Parked"]) } });
  assert.deepStrictEqual(await ws.reader.health(), { reachable: "ok", sourceFound: "ok", schemaValid: "not_ok", label: "notion_schema_invalid" });
});

test("health: access problem on the first read", async () => {
  const ws = fakeWorkspace({
    onList: () => {
      throw new APIResponseError({ code: "unauthorized", status: 401, message: "bad token", headers: {}, rawBodyText: "{}" });
    },
  });
  const out = await ws.reader.health();
  assert.deepStrictEqual(out, { reachable: "not_ok", sourceFound: "not_checked", schemaValid: "not_checked", label: "notion_unauthorized" });
});

// --- Errors, timeout, abort --------------------------------------------------------------------

function apiError(code, status, secrets) {
  return new APIResponseError({
    code,
    status,
    message: `Failed for ${secrets.join(" ")}`,
    headers: { authorization: `Bearer ${secrets[0]}`, "x-request-id": "req-SECRET" },
    rawBodyText: JSON.stringify({ message: secrets.join(" "), request_id: "req-SECRET" }),
    additional_data: { secret: secrets[1] },
    request_id: "req-SECRET",
  });
}

test("every SDK error maps to its fixed label with exactly one call and no retry", async () => {
  const token = fakeNotionToken();
  const mapping = {
    unauthorized: "notion_unauthorized",
    restricted_resource: "notion_forbidden",
    object_not_found: "notion_not_found",
    rate_limited: "notion_rate_limited",
    validation_error: "notion_bad_request",
    invalid_request: "notion_bad_request",
    invalid_request_url: "notion_bad_request",
    invalid_json: "notion_bad_request",
    invalid_beta: "notion_bad_request",
    conflict_error: "notion_conflict",
    internal_server_error: "notion_unavailable",
    service_overload: "notion_unavailable",
    service_unavailable: "notion_unavailable",
    gateway_timeout: "notion_unavailable",
    some_future_code: "notion_error",
  };
  for (const [code, label] of Object.entries(mapping)) {
    const ws = fakeWorkspace({
      onList: () => {
        throw apiError(code, 400, [token, ws.root]);
      },
    });
    await rejectsWith(ws.reader.countByStatus(), label);
    assert.strictEqual(ws.calls.length, 1, `${code}: retried or continued`);
  }
});

test("client-side errors and transport failures map to fixed labels", async () => {
  const cases = [
    [new RequestTimeoutError(), "notion_timeout"],
    [new UnknownHTTPResponseError({ status: 502, message: "bad gateway", headers: {}, rawBodyText: "<html>" }), "notion_unavailable"],
    [new InvalidPathParameterError(), "notion_bad_request"],
    [new TypeError("fetch failed"), "notion_unavailable"],
    [Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }), "notion_unavailable"],
  ];
  for (const [error, label] of cases) {
    const ws = fakeWorkspace({
      onList: () => {
        throw error;
      },
    });
    await rejectsWith(ws.reader.countByStatus(), label);
    assert.strictEqual(ws.calls.length, 1);
  }
});

test("a timeout during /show lookup fails once with notion_timeout", async () => {
  const ws = fakeWorkspace({
    query: () => {
      throw new RequestTimeoutError();
    },
  });
  await rejectsWith(ws.reader.findByUretId("opp", "OPP-001"), "notion_timeout");
  assert.strictEqual(ws.count("dataSources.query"), 1);
  assert.strictEqual(ws.reader.hasCachedSource(), true, "a timeout must not forget the source");
});

test("an aborted read is abandoned promptly with notion_aborted", async () => {
  const ws = fakeWorkspace({ onList: () => new Promise(() => {}) }); // never settles
  const controller = new AbortController();
  const started = Date.now();
  const pending = ws.reader.countByStatus({ signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await rejectsWith(pending, "notion_aborted");
  assert.ok(Date.now() - started < 500, "abort was not prompt");
  await assert.rejects(ws.reader.health({ signal: controller.signal }), (err) => err.label === "notion_aborted");
});

test("an already-aborted signal makes no Notion call", async () => {
  const ws = fakeWorkspace();
  const controller = new AbortController();
  controller.abort();
  await rejectsWith(ws.reader.findByUretId("opp", "OPP-001", { signal: controller.signal }), "notion_aborted");
  assert.strictEqual(ws.calls.length, 0);
});

// --- Leak scan -------------------------------------------------------------------------------------

test("no token, Notion ID, request ID or raw error text escapes in errors or results", async () => {
  const token = fakeNotionToken();
  const ws = fakeWorkspace();
  const secrets = [token, ws.root, dashedId(ws.root), ws.dbId, ws.dsId, dashedId(ws.dsId), "req-SECRET", "Failed for"];
  const outputs = [];
  const failing = fakeWorkspace({
    root: ws.root,
    onList: () => {
      throw apiError("unauthorized", 401, [token, ws.root, ws.dsId]);
    },
  });
  try {
    await failing.reader.countByStatus();
  } catch (err) {
    outputs.push(String(err), err.stack, JSON.stringify(err), util.inspect(err, { showHidden: true, depth: 5 }), err.label);
    assert.strictEqual(err.cause, undefined);
  }
  outputs.push(JSON.stringify(await failing.reader.health()));
  outputs.push(JSON.stringify(await ws.reader.health()));
  outputs.push(JSON.stringify(await ws.reader.countByStatus()));
  for (const text of outputs) {
    for (const secret of secrets) assert.ok(!String(text).includes(secret), "sensitive value escaped the adapter");
  }
});

// --- Boundary --------------------------------------------------------------------------------------

test("the adapter touches only the four permitted read methods", async () => {
  const ws = fakeWorkspace({ query: () => ({ results: [page("Idea")], has_more: false }) });
  await ws.reader.health();
  await ws.reader.countByStatus();
  await ws.reader.findByUretId("opp", "OPP-001");
  for (const { method } of ws.calls) assert.ok(PERMITTED.includes(method), method);
  assert.deepStrictEqual([...new Set(ws.calls.map((c) => c.method))].sort(), [...PERMITTED].sort());
});

test("the guard really blocks anything outside the allow-list", () => {
  const ws = fakeWorkspace();
  const client = new Proxy(ws.raw, {}); // unguarded view, for comparison
  assert.ok(client.blocks);
  const guarded = guard(ws.raw);
  for (const access of [() => guarded.pages, () => guarded.search, () => guarded.request, () => guarded.databases.update, () => guarded.dataSources.create, () => guarded.blocks.children.append]) {
    assert.throws(access, /forbidden access/);
  }
  assert.throws(() => {
    guarded.blocks.children.list = () => {};
  }, /forbidden write/);
});

test("the adapter exposes no write operation", () => {
  const reader = fakeWorkspace().reader;
  assert.deepStrictEqual(Object.keys(reader).sort(), ["countByStatus", "countEvidenceForSpec", "countEvidenceForWP", "findByUretId", "findLinkedUretIds", "getDataSourceId", "hasCachedSource", "health", "listActiveWork"]);
});

// --- Phase 3-5 step 1: all five URET data sources -----------------------------------

const TYPE_TITLES = {
  opp: "URET – Opportunities",
  spec: "URET – Specs",
  wp: "URET – Work Packages",
  evd: "URET – Evidence",
  rel: "URET – Releases",
};

function schemaFor(type) {
  if (type === "opp") return validProperties();
  const p = (id, t, extra = {}) => ({ id, type: t, [t]: extra });
  if (type === "spec") {
    return {
      "URET ID": p("uid", "rich_text"), Name: p("title", "title"), Opportunity: p("opp", "relation"),
      Version: p("ver", "rich_text"), Summary: p("sum", "rich_text"), "Scope in": p("sin", "rich_text"),
      "Scope out": p("sout", "rich_text"), Constraints: p("con", "rich_text"),
      Status: p("stat", "select", { options: ["Draft", "Approved", "Superseded"].map((name) => ({ name })) }),
      Repo: p("repo", "url"), Branch: p("br", "rich_text"), "Work packages": p("wps", "relation"), Releases: p("rels", "relation"),
    };
  }
  if (type === "wp") {
    return {
      "URET ID": p("uid", "rich_text"), Name: p("title", "title"), Spec: p("spec", "relation"),
      Type: p("type", "select", { options: [] }), Worker: p("wrk", "select", { options: [] }), Status: p("stat", "select", { options: [] }),
      Summary: p("sum", "rich_text"), Instructions: p("ins", "rich_text"), Outputs: p("out", "rich_text"),
      "Commit / PR": p("pr", "url"), "Start date": p("sd", "date"), "End date": p("ed", "date"), Evidence: p("evd", "relation"),
    };
  }
  if (type === "evd") {
    return {
      "URET ID": p("uid", "rich_text"), Name: p("title", "title"), "Work package": p("wp", "relation"),
      Type: p("type", "select", { options: [] }), Summary: p("sum", "rich_text"), Verdict: p("ver", "select", { options: [] }),
    };
  }
  return { "URET ID": p("uid", "rich_text"), Name: p("title", "title") };
}

// Fake workspace with a database per type (all five by default), guarded so
// only the four permitted read methods exist. `extraBlocks` adds more child
// blocks; `properties[type]` overrides a schema; `query[type]` answers queries.
function multiWorkspace({ types = Object.keys(TYPE_TITLES), extraBlocks = [], properties = {}, query = {} } = {}) {
  const root = fakePageId();
  const calls = [];
  const byDb = {};
  const byDs = {};
  const blocks = [];
  for (const type of types) {
    const dbId = fakePageId();
    const dsId = fakePageId();
    byDb[dbId] = { object: "database", id: dbId, in_trash: false, parent: { type: "page_id", page_id: root }, data_sources: [{ id: dsId }] };
    byDs[dsId] = {
      object: "data_source", id: dsId, in_trash: false, title: rt(TYPE_TITLES[type]),
      database_parent: { type: "page_id", page_id: root }, properties: properties[type] || schemaFor(type), type,
    };
    blocks.push({ object: "block", id: dbId, type: "child_database", child_database: { title: TYPE_TITLES[type] } });
  }
  const raw = {
    blocks: { children: { list: async (args) => { calls.push({ method: "blocks.children.list", args }); return { results: [...blocks, ...extraBlocks], has_more: false }; } } },
    databases: { retrieve: async (args) => { calls.push({ method: "databases.retrieve", args }); return byDb[args.database_id] || extraBlocks.find((b) => b.id === args.database_id)?.db; } },
    dataSources: {
      retrieve: async (args) => { calls.push({ method: "dataSources.retrieve", args }); return byDs[args.data_source_id]; },
      query: async (args) => {
        calls.push({ method: "dataSources.query", args });
        const type = byDs[args.data_source_id].type;
        return query[type] ? query[type](args) : { results: [], has_more: false };
      },
    },
  };
  const reader = notion.createNotionReader({ client: guard(raw), rootPageId: root });
  const count = (method) => calls.filter((c) => c.method === method).length;
  const typeOfQuery = (c) => byDs[c.args.data_source_id].type;
  return { root, calls, count, reader, typeOfQuery };
}

test("the five source types have the expected titles and ID prefixes", () => {
  const summary = Object.fromEntries(Object.entries(notion.SOURCES).map(([k, v]) => [k, [v.title, v.prefix]]));
  assert.deepStrictEqual(summary, {
    opp: ["URET – Opportunities", "OPP"],
    spec: ["URET – Specs", "SPEC"],
    wp: ["URET – Work Packages", "WP"],
    evd: ["URET – Evidence", "EVD"],
    rel: ["URET – Releases", "REL"],
  });
});

test("verified Specs and Work Packages schemas pass; a missing property is reported", () => {
  for (const type of ["spec", "wp", "evd", "rel"]) {
    assert.deepStrictEqual(notion.verifySchema({ properties: schemaFor(type) }, type), { ok: true, problems: [] }, type);
  }
  const spec = schemaFor("spec");
  delete spec.Opportunity;
  spec.Version = { id: "ver", type: "number", number: {} };
  assert.deepStrictEqual(notion.verifySchema({ properties: spec }, "spec").problems, ["missing:Opportunity", "type:Version"]);
  const wp = schemaFor("wp");
  delete wp.Spec;
  assert.deepStrictEqual(notion.verifySchema({ properties: wp }, "wp").problems, ["missing:Spec"]);
  // Only Opportunities requires specific Status options.
  assert.deepStrictEqual(notion.verifySchema({ properties: schemaFor("opp") }), { ok: true, problems: [] });
});

test("typed lookup discovers and queries only the requested source", async () => {
  const ws = multiWorkspace({ query: { spec: () => ({ results: [page("Draft")], has_more: false }) } });
  const out = await ws.reader.findByUretId("spec", "SPEC-001");
  assert.strictEqual(out.result, "found");
  assert.strictEqual(ws.count("databases.retrieve"), 1);
  assert.strictEqual(ws.count("dataSources.retrieve"), 1);
  const q = ws.calls.find((c) => c.method === "dataSources.query");
  assert.strictEqual(ws.typeOfQuery(q), "spec");
  assert.deepStrictEqual(q.args.filter, { property: "URET ID", rich_text: { equals: "SPEC-001" } });
  assert.strictEqual(q.args.page_size, 2);
  assert.strictEqual(ws.reader.hasCachedSource("spec"), true);
  assert.strictEqual(ws.reader.hasCachedSource("opp"), false, "Opportunities discovered without need");
});

test("each source type is discovered once, lazily, and remembered separately", async () => {
  const ws = multiWorkspace();
  await ws.reader.findByUretId("spec", "SPEC-001");
  await ws.reader.findByUretId("wp", "WP-001");
  await ws.reader.findByUretId("spec", "SPEC-002");
  await ws.reader.findByUretId("evd", "EVD-001");
  await ws.reader.findByUretId("rel", "REL-001");
  await ws.reader.countByStatus();
  assert.strictEqual(ws.count("blocks.children.list"), 5, "one scan per type discovered");
  assert.strictEqual(ws.count("databases.retrieve"), 5);
  for (const type of Object.keys(TYPE_TITLES)) assert.strictEqual(ws.reader.hasCachedSource(type), true, type);
});

test("Opportunities, /status and /health keep working when another source is missing or broken", async () => {
  const noSpecs = multiWorkspace({ types: ["opp", "wp", "evd", "rel"] });
  await rejectsWith(noSpecs.reader.findByUretId("spec", "SPEC-001"), "notion_source_not_found");
  assert.strictEqual((await noSpecs.reader.countByStatus()).outcome, "counts");
  assert.deepStrictEqual(await noSpecs.reader.health(), { reachable: "ok", sourceFound: "ok", schemaValid: "ok", label: null });

  const badSpecs = schemaFor("spec");
  delete badSpecs.Opportunity;
  const broken = multiWorkspace({ properties: { spec: badSpecs } });
  await rejectsWith(broken.reader.findByUretId("spec", "SPEC-001"), "notion_schema_invalid");
  assert.strictEqual(broken.count("dataSources.query"), 0, "queried a source with an invalid schema");
  assert.strictEqual((await broken.reader.findByUretId("opp", "OPP-001")).result, "not_found");
});

test("duplicate databases for a type are ambiguous; no candidate is chosen", async () => {
  const twin = { object: "block", id: fakePageId(), type: "child_database", child_database: { title: "URET - Specs" } };
  const ws = multiWorkspace({ extraBlocks: [twin] });
  await rejectsWith(ws.reader.findByUretId("spec", "SPEC-001"), "notion_source_ambiguous");
  assert.strictEqual(ws.count("databases.retrieve"), 0);
  assert.strictEqual((await ws.reader.findByUretId("wp", "WP-001")).result, "not_found", "other types affected");
});

test("a not-found source is forgotten only for its own type", async () => {
  let fail = false;
  const ws = multiWorkspace({
    query: {
      spec: () => {
        if (fail) throw new APIResponseError({ code: "object_not_found", status: 404, message: "gone", headers: {}, rawBodyText: "{}" });
        return { results: [], has_more: false };
      },
    },
  });
  await ws.reader.findByUretId("spec", "SPEC-001");
  await ws.reader.findByUretId("opp", "OPP-001");
  fail = true;
  await rejectsWith(ws.reader.findByUretId("spec", "SPEC-001"), "notion_not_found");
  assert.strictEqual(ws.reader.hasCachedSource("spec"), false);
  assert.strictEqual(ws.reader.hasCachedSource("opp"), true);
});

test("typed lookup rejects unknown types and mismatched prefixes without any Notion call", async () => {
  const ws = multiWorkspace();
  for (const [type, id] of [["spec", "OPP-001"], ["opp", "SPEC-001"], ["wp", "WPX-1"], ["xyz", "X-001"], ["spec", undefined]]) {
    await assert.rejects(ws.reader.findByUretId(type, id), TypeError, `${type} ${id}`);
  }
  assert.strictEqual(ws.calls.length, 0);
});

test("lookups in every source type report duplicates and trashed records the same way", async () => {
  for (const type of ["spec", "wp", "evd", "rel"]) {
    const prefix = notion.SOURCES[type].prefix;
    const dup = multiWorkspace({ query: { [type]: () => ({ results: [page("x"), page("y")], has_more: false }) } });
    assert.strictEqual((await dup.reader.findByUretId(type, `${prefix}-001`)).result, "duplicate", type);
    const trashed = multiWorkspace({ query: { [type]: () => ({ results: [page("x", { in_trash: true })], has_more: false }) } });
    const out = await trashed.reader.findByUretId(type, `${prefix}-001`);
    assert.deepStrictEqual([out.result, out.trashed], ["found", true], type);
  }
});

// --- Phase 3-5 step 6: data source ID for the write adapter -----------------------------

test("getDataSourceId discovers once and returns the verified data source ID", async () => {
  const ws = fakeWorkspace();
  assert.strictEqual(await ws.reader.getDataSourceId("opp"), ws.dsId);
  assert.strictEqual(await ws.reader.getDataSourceId("opp"), ws.dsId);
  assert.strictEqual(ws.count("blocks.children.list"), 1, "discovery repeated");
  assert.strictEqual(ws.count("dataSources.query"), 0);
});

test("getDataSourceId refuses an invalid schema, an unknown type, and a missing source", async () => {
  const bad = fakeWorkspace({ dataSource: { properties: {} } });
  await rejectsWith(bad.reader.getDataSourceId("opp"), "notion_schema_invalid");
  const none = fakeWorkspace({ childPages: [[]] });
  await rejectsWith(none.reader.getDataSourceId("opp"), "notion_source_not_found");
  for (const type of ["OPP", "x", "__proto__", undefined]) {
    await assert.rejects(none.reader.getDataSourceId(type), TypeError);
  }
});

// --- Phase 3-5 step 7: linked records for /show SPEC ----------------------------------

const withUretId = (id, extra = {}) => ({ object: "page", in_trash: false, properties: { "URET ID": { type: "rich_text", rich_text: rt(id) } }, ...extra });

test("findLinkedUretIds queries by relation and returns URET IDs only", async () => {
  const specPage = fakePageId();
  const ws = fakeWorkspace({
    query: () => ({
      object: "list",
      results: [withUretId("OPP-002"), withUretId("OPP-009", { in_trash: true }), withUretId("  "), { object: "data_source" }],
      has_more: false,
    }),
  });
  const out = await ws.reader.findLinkedUretIds("opp", "Specs", specPage);
  assert.deepStrictEqual(out, { uretIds: ["OPP-002"], more: false });
  const query = ws.calls.find((c) => c.method === "dataSources.query").args;
  assert.deepStrictEqual(query, { data_source_id: ws.dsId, filter: { property: "Specs", relation: { contains: specPage } }, page_size: 10 });
});

test("findLinkedUretIds reports more results and refuses bad arguments without calling Notion", async () => {
  const ws = fakeWorkspace({ query: () => ({ object: "list", results: [withUretId("OPP-001")], has_more: true }) });
  assert.deepStrictEqual(await ws.reader.findLinkedUretIds("opp", "Specs", fakePageId()), { uretIds: ["OPP-001"], more: true });
  const fresh = fakeWorkspace();
  for (const args of [["x", "Specs", "p"], ["opp", "Name", "p"], ["opp", "Nope", "p"], ["opp", "Specs", ""], ["opp", "Specs", undefined], ["__proto__", "Specs", "p"]]) {
    await assert.rejects(fresh.reader.findLinkedUretIds(...args), TypeError);
  }
  assert.strictEqual(fresh.calls.length, 0);
});

test("findLinkedUretIds errors carry fixed labels", async () => {
  const ws = fakeWorkspace({
    query: () => {
      throw new RequestTimeoutError();
    },
  });
  await rejectsWith(ws.reader.findLinkedUretIds("opp", "Specs", fakePageId()), "notion_timeout");
});

// --- Phase 4 step 1: evidence counts ------------------------------------------------------

const pageItem = (extra = {}) => ({ object: "page", id: fakePageId(), in_trash: false, properties: {}, ...extra });

test("the Evidence schema requires the properties Phase 4 writes and reads", () => {
  assert.deepStrictEqual(notion.EVIDENCE_SCHEMA, {
    "URET ID": "rich_text", Name: "title", "Work package": "relation", Type: "select", Summary: "rich_text", Verdict: "select",
  });
  assert.strictEqual(notion.SOURCES.evd.schema, notion.EVIDENCE_SCHEMA);
  const missing = schemaFor("evd");
  delete missing["Work package"];
  missing.Verdict = { id: "ver", type: "rich_text", rich_text: {} };
  assert.deepStrictEqual(notion.verifySchema({ properties: missing }, "evd").problems, ["missing:Work package", "type:Verdict"]);
});

test("countEvidenceForWP queries Evidence by its Work package relation and skips trashed records", async () => {
  const wpPage = fakePageId();
  const ws = multiWorkspace({
    query: { evd: () => ({ results: [pageItem(), pageItem({ in_trash: true }), pageItem({ archived: true }), pageItem(), { object: "data_source" }], has_more: false }) },
  });
  assert.deepStrictEqual(await ws.reader.countEvidenceForWP(wpPage), { count: 2, incomplete: false });
  const queries = ws.calls.filter((c) => c.method === "dataSources.query");
  assert.strictEqual(queries.length, 1);
  assert.strictEqual(ws.typeOfQuery(queries[0]), "evd");
  assert.deepStrictEqual(queries[0].args.filter, { property: "Work package", relation: { contains: wpPage } });
  assert.strictEqual(queries[0].args.page_size, 100);
});

test("countEvidenceForWP pages through results and marks the count incomplete at the page cap", async () => {
  let n = 0;
  const twoPages = multiWorkspace({
    query: { evd: (args) => (args.start_cursor ? { results: [pageItem()], has_more: false } : { results: [pageItem(), pageItem()], has_more: true, next_cursor: "c2" }) },
  });
  assert.deepStrictEqual(await twoPages.reader.countEvidenceForWP(fakePageId()), { count: 3, incomplete: false });
  assert.strictEqual(twoPages.calls.filter((c) => c.method === "dataSources.query")[1].args.start_cursor, "c2");
  const endless = multiWorkspace({ query: { evd: () => ({ results: [pageItem()], has_more: true, next_cursor: String(++n) }) } });
  assert.deepStrictEqual(await endless.reader.countEvidenceForWP(fakePageId()), { count: notion.MAX_COUNT_PAGES, incomplete: true });
  assert.strictEqual(endless.count("dataSources.query"), notion.MAX_COUNT_PAGES);
});

test("countEvidenceForSpec sums the evidence of the Spec's Work Packages", async () => {
  const specPage = fakePageId();
  const wpA = pageItem();
  const wpB = pageItem();
  const evidence = { [wpA.id]: 2, [wpB.id]: 3 };
  const ws = multiWorkspace({
    query: {
      wp: () => ({ results: [wpA, pageItem({ in_trash: true }), wpB], has_more: false }),
      evd: (args) => ({ results: Array.from({ length: evidence[args.filter.relation.contains] || 0 }, () => pageItem()), has_more: false }),
    },
  });
  assert.deepStrictEqual(await ws.reader.countEvidenceForSpec(specPage), { count: 5, incomplete: false, workPackages: 2 });
  const queries = ws.calls.filter((c) => c.method === "dataSources.query");
  assert.deepStrictEqual(queries.map((c) => ws.typeOfQuery(c)), ["wp", "evd", "evd"]);
  assert.deepStrictEqual(queries[0].args.filter, { property: "Spec", relation: { contains: specPage } });
  assert.deepStrictEqual(queries.slice(1).map((c) => c.args.filter.relation.contains), [wpA.id, wpB.id], "trashed Work Package counted");
});

test("countEvidenceForSpec: no Work Packages is zero; too many is capped and marked incomplete", async () => {
  const none = multiWorkspace();
  assert.deepStrictEqual(await none.reader.countEvidenceForSpec(fakePageId()), { count: 0, incomplete: false, workPackages: 0 });
  assert.strictEqual(none.count("dataSources.query"), 1);
  const many = notion.MAX_SPEC_WORK_PACKAGES + 3;
  const big = multiWorkspace({
    query: {
      wp: () => ({ results: Array.from({ length: many }, () => pageItem()), has_more: false }),
      evd: () => ({ results: [pageItem()], has_more: false }),
    },
  });
  assert.deepStrictEqual(await big.reader.countEvidenceForSpec(fakePageId()), { count: notion.MAX_SPEC_WORK_PACKAGES, incomplete: true, workPackages: many });
  assert.strictEqual(big.count("dataSources.query"), 1 + notion.MAX_SPEC_WORK_PACKAGES);
});

test("countEvidenceForSpec is incomplete when any Work Package's evidence count is", async () => {
  let n = 0;
  const ws = multiWorkspace({
    query: {
      wp: () => ({ results: [pageItem()], has_more: false }),
      evd: () => ({ results: [pageItem()], has_more: true, next_cursor: String(++n) }),
    },
  });
  const out = await ws.reader.countEvidenceForSpec(fakePageId());
  assert.deepStrictEqual(out, { count: notion.MAX_COUNT_PAGES, incomplete: true, workPackages: 1 });
});

test("evidence counts refuse an Evidence source without the Phase 4 schema, before any query", async () => {
  const props = schemaFor("evd");
  delete props["Work package"];
  const ws = multiWorkspace({ properties: { evd: props } });
  await rejectsWith(ws.reader.countEvidenceForWP(fakePageId()), "notion_schema_invalid");
  assert.strictEqual(ws.count("dataSources.query"), 0);
});

test("evidence counts need a page ID and pass Notion errors on as fixed labels", async () => {
  const ws = multiWorkspace();
  for (const bad of ["", undefined, null, 42]) {
    await assert.rejects(ws.reader.countEvidenceForWP(bad), TypeError);
    await assert.rejects(ws.reader.countEvidenceForSpec(bad), TypeError);
  }
  assert.strictEqual(ws.calls.length, 0);
  const failing = multiWorkspace({
    query: {
      evd: () => {
        throw new RequestTimeoutError();
      },
    },
  });
  await rejectsWith(failing.reader.countEvidenceForWP(fakePageId()), "notion_timeout");
});

test("evidence counts never call anything but the four permitted reads", async () => {
  const ws = multiWorkspace({ query: { wp: () => ({ results: [pageItem()], has_more: false }) } });
  await ws.reader.countEvidenceForSpec(fakePageId());
  assert.deepStrictEqual([...new Set(ws.calls.map((c) => c.method))].sort(), ["blocks.children.list", "dataSources.query", "dataSources.retrieve", "databases.retrieve"]);
});

// --- Phase 4 step 5: active work for /status ---------------------------------------------

const wpItem = (uretId, title, extra = {}) => ({
  object: "page",
  id: fakePageId(),
  in_trash: false,
  properties: { "URET ID": { type: "rich_text", rich_text: rt(uretId) }, Name: { type: "title", title: rt(title) } },
  ...extra,
});

test("listActiveWork asks for In progress or Draft, newest edit first, at most 5", async () => {
  const ws = multiWorkspace();
  await ws.reader.listActiveWork();
  const queries = ws.calls.filter((c) => c.method === "dataSources.query");
  assert.strictEqual(queries.length, 1);
  assert.strictEqual(ws.typeOfQuery(queries[0]), "wp");
  const { filter, sorts, page_size: pageSize } = queries[0].args;
  assert.deepStrictEqual(filter, { or: [{ property: "Status", select: { equals: "In progress" } }, { property: "Status", select: { equals: "Draft" } }] });
  assert.deepStrictEqual(sorts, [{ timestamp: "last_edited_time", direction: "descending" }]);
  assert.strictEqual(pageSize, 5);
  assert.deepStrictEqual(notion.ACTIVE_WORK_STATUSES, ["In progress", "Draft"]);
  assert.strictEqual(notion.MAX_ACTIVE_WORK, 5);
});

test("listActiveWork keeps Notion's order, skips trashed pages, and reports more", async () => {
  const a = wpItem("WP-003", "Newest");
  const b = wpItem("WP-002", "Older");
  const ws = multiWorkspace({ query: { wp: () => ({ results: [a, wpItem("WP-009", "Gone", { in_trash: true }), b, { object: "data_source" }], has_more: true }) } });
  assert.deepStrictEqual(await ws.reader.listActiveWork(), {
    items: [{ uretId: "WP-003", title: "Newest", pageId: a.id }, { uretId: "WP-002", title: "Older", pageId: b.id }],
    more: true,
  });
});

test("listActiveWork: missing URET ID or Name come back empty; no active work is an empty list", async () => {
  const bare = { object: "page", id: fakePageId(), in_trash: false, properties: {} };
  const ws = multiWorkspace({ query: { wp: () => ({ results: [bare], has_more: false }) } });
  assert.deepStrictEqual(await ws.reader.listActiveWork(), { items: [{ uretId: "", title: "", pageId: bare.id }], more: false });
  const none = multiWorkspace();
  assert.deepStrictEqual(await none.reader.listActiveWork(), { items: [], more: false });
});

test("listActiveWork refuses an invalid Work Packages schema and labels Notion errors", async () => {
  const props = schemaFor("wp");
  delete props.Status;
  const bad = multiWorkspace({ properties: { wp: props } });
  await rejectsWith(bad.reader.listActiveWork(), "notion_schema_invalid");
  assert.strictEqual(bad.count("dataSources.query"), 0);
  const failing = multiWorkspace({
    query: {
      wp: () => {
        throw new RequestTimeoutError();
      },
    },
  });
  await rejectsWith(failing.reader.listActiveWork(), "notion_timeout");
});
