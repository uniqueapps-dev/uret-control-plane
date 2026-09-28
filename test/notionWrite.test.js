"use strict";

const test = require("node:test");
const assert = require("node:assert");
const util = require("util");
const { APIResponseError, RequestTimeoutError, UnknownHTTPResponseError, Client } = require("@notionhq/client");
const nw = require("../bot/notionWrite");
const { fakeNotionToken, fakePageId, dashedId } = require("./helpers");

const TITLES = { opp: "URET – Opportunities", spec: "URET – Specs", wp: "URET – Work Packages" };

// --- Fake Notion ------------------------------------------------------------------

// Touching anything outside pages.create and dataSources.retrieve throws.
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
const select = (names) => ({ type: "select", select: { options: names.map((name) => ({ name })) } });
const multi = (names) => ({ type: "multi_select", multi_select: { options: names.map((name) => ({ name })) } });
const text = () => ({ type: "rich_text", rich_text: {} });
const relation = () => ({ type: "relation", relation: {} });

const ASSET_TYPES = ["App/PWA", "Ebook", "Video series", "Landing page / site", "Template"];

function properties(type) {
  const common = { "URET ID": text(), Name: { type: "title", title: {} } };
  if (type === "opp") {
    return {
      ...common,
      Status: select(["Idea", "Active", "Parked", "Done"]),
      "Asset type": multi(ASSET_TYPES),
      "Project / Asset": text(),
      "Problem summary": text(),
      "Target users": text(),
      "Success metrics": text(),
      "Next action": text(),
      Specs: relation(),
    };
  }
  if (type === "spec") {
    return {
      ...common,
      Status: select(["Draft", "Approved"]),
      Opportunity: relation(),
      Version: text(),
      Summary: text(),
      "Scope in": text(),
      "Scope out": text(),
      Constraints: text(),
    };
  }
  return {
    ...common,
    Status: select(["Draft", "Ready", "Done"]),
    Spec: relation(),
    Type: select(["Prototype", "Feature", "Bug fix", "Research", "Hardening"]),
    Worker: select(["Claude Code", "Manual"]),
    Summary: text(),
    Instructions: text(),
    Outputs: text(),
  };
}

function fakeNotion(type, opts = {}) {
  const root = fakePageId();
  const dsId = fakePageId();
  const calls = [];
  const dataSource = {
    object: "data_source",
    id: dsId,
    in_trash: false,
    title: rt(TITLES[type]),
    database_parent: { type: "page_id", page_id: dashedId(root) },
    properties: properties(type),
    ...(opts.dataSource || {}),
  };
  const raw = {
    dataSources: {
      retrieve: async (args) => {
        calls.push({ method: "dataSources.retrieve", args });
        return opts.onRetrieve ? opts.onRetrieve(args) : dataSource;
      },
    },
    pages: {
      create: async (args) => {
        calls.push({ method: "pages.create", args });
        if (opts.onCreate) return opts.onCreate(args);
        return { object: "page", id: fakePageId(), url: "https://www.notion.so/example" };
      },
    },
  };
  const resolved = [];
  const writer = nw.createNotionWriter({
    client: guard(raw),
    rootPageId: root,
    resolveDataSource: async (t, o) => {
      resolved.push({ type: t, opts: o });
      if (opts.onResolve) return opts.onResolve(t);
      return dsId;
    },
  });
  const count = (method) => calls.filter((c) => c.method === method).length;
  return { root, dsId, calls, count, resolved, writer, dataSource };
}

const RECORDS = {
  opp: () => ({
    uretId: "OPP-002",
    title: "Budget app",
    assetType: "App/PWA",
    project: "Money",
    problemSummary: "Tracking is hard",
    targetUsers: "Families",
    successMetrics: "100 users",
    nextAction: "Sketch",
  }),
  spec: () => ({
    uretId: "SPEC-001",
    title: "Budget app v1",
    version: "0.1",
    summary: "First cut",
    scopeIn: "Tracking",
    scopeOut: "Sync",
    constraints: "Offline",
    opportunityPageId: dashedId(fakePageId()),
  }),
  wp: () => ({
    uretId: "WP-001",
    title: "Login screen",
    type: "Feature",
    worker: "Manual",
    summary: "Login",
    instructions: "Build it",
    outputs: "A PR",
    specPageId: fakePageId(),
  }),
};

async function rejectsWith(promise, label, uncertain = false) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof nw.NotionWriteError, `unexpected ${err && err.name}: ${err && err.message}`);
    assert.strictEqual(err.label, label);
    assert.strictEqual(err.uncertain, uncertain, `uncertain should be ${uncertain}`);
    return true;
  });
}

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

// --- Client ------------------------------------------------------------------------

test("write client is created with the read adapter's settings", () => {
  let options;
  class Capture {
    constructor(o) {
      options = o;
    }
  }
  const config = { notionToken: fakeNotionToken() };
  nw.createNotionWriteClient(config, { ClientClass: Capture });
  assert.strictEqual(options.auth, config.notionToken);
  assert.strictEqual(options.notionVersion, "2025-09-03");
  assert.strictEqual(options.retry, false);
  assert.strictEqual(options.timeoutMs, 10000);
  assert.strictEqual(options.logger("warn", "request fail", { code: "x" }), undefined);
  assert.strictEqual(Object.keys(options).sort().join(","), "auth,logger,notionVersion,retry,timeoutMs");
  assert.ok(nw.createNotionWriteClient(config) instanceof Client);
});

test("a writer needs a data source resolver", () => {
  assert.throws(() => nw.createNotionWriter({ client: {}, rootPageId: fakePageId() }), TypeError);
});

// --- Successful creates ---------------------------------------------------------------

test("creating an Opportunity: one schema check, one pages.create, only the URET ID returned", async () => {
  const n = fakeNotion("opp");
  const out = await n.writer.createRecord("opp", RECORDS.opp());
  assert.deepStrictEqual(out, { uretId: "OPP-002" });
  assert.deepStrictEqual(n.calls.map((c) => c.method), ["dataSources.retrieve", "pages.create"]);
  assert.deepStrictEqual(n.calls[0].args, { data_source_id: n.dsId });
  assert.deepStrictEqual(n.calls[1].args, {
    parent: { type: "data_source_id", data_source_id: n.dsId },
    properties: {
      Name: { title: [{ type: "text", text: { content: "Budget app" } }] },
      "URET ID": { rich_text: [{ type: "text", text: { content: "OPP-002" } }] },
      Status: { select: { name: "Idea" } },
      "Asset type": { multi_select: [{ name: "App/PWA" }] },
      "Project / Asset": { rich_text: [{ type: "text", text: { content: "Money" } }] },
      "Problem summary": { rich_text: [{ type: "text", text: { content: "Tracking is hard" } }] },
      "Target users": { rich_text: [{ type: "text", text: { content: "Families" } }] },
      "Success metrics": { rich_text: [{ type: "text", text: { content: "100 users" } }] },
      "Next action": { rich_text: [{ type: "text", text: { content: "Sketch" } }] },
    },
  });
  assert.deepStrictEqual(n.resolved.map((r) => r.type), ["opp"]);
});

test("creating a Spec sets Status Draft and links the Opportunity", async () => {
  const n = fakeNotion("spec");
  const record = RECORDS.spec();
  assert.deepStrictEqual(await n.writer.createRecord("spec", record), { uretId: "SPEC-001" });
  const props = n.calls[1].args.properties;
  assert.deepStrictEqual(Object.keys(props).sort(), ["Constraints", "Name", "Opportunity", "Scope in", "Scope out", "Status", "Summary", "URET ID", "Version"]);
  assert.deepStrictEqual(props.Status, { select: { name: "Draft" } });
  assert.deepStrictEqual(props.Opportunity, { relation: [{ id: record.opportunityPageId }] });
  assert.deepStrictEqual(props["Scope out"], { rich_text: [{ type: "text", text: { content: "Sync" } }] });
});

test("creating a Work Package sets Status Draft, Type, Worker and links the Spec", async () => {
  const n = fakeNotion("wp");
  const record = RECORDS.wp();
  assert.deepStrictEqual(await n.writer.createRecord("wp", record), { uretId: "WP-001" });
  const props = n.calls[1].args.properties;
  assert.deepStrictEqual(Object.keys(props).sort(), ["Instructions", "Name", "Outputs", "Spec", "Status", "Summary", "Type", "URET ID", "Worker"]);
  assert.deepStrictEqual(props.Status, { select: { name: "Draft" } });
  assert.deepStrictEqual(props.Type, { select: { name: "Feature" } });
  assert.deepStrictEqual(props.Worker, { select: { name: "Manual" } });
  assert.deepStrictEqual(props.Spec, { relation: [{ id: record.specPageId }] });
});

test("empty free-text answers become empty rich text; long text is split within Notion's limit", async () => {
  const n = fakeNotion("opp");
  const long = "é".repeat(4500);
  await n.writer.createRecord("opp", { ...RECORDS.opp(), nextAction: "", problemSummary: long });
  const props = n.calls[1].args.properties;
  assert.deepStrictEqual(props["Next action"], { rich_text: [] });
  const chunks = props["Problem summary"].rich_text.map((t) => t.text.content);
  assert.deepStrictEqual(chunks.map((c) => c.length), [2000, 2000, 500]);
  assert.strictEqual(chunks.join(""), long);
});

test("the caller cannot set Status or extra properties", async () => {
  const n = fakeNotion("opp");
  await n.writer.createRecord("opp", { ...RECORDS.opp(), status: "Done", Status: "Done", Specs: "x", extra: "y" });
  const props = n.calls[1].args.properties;
  assert.deepStrictEqual(props.Status, { select: { name: "Idea" } });
  assert.strictEqual(props.Specs, undefined);
  assert.strictEqual(Object.keys(props).length, 9);
});

// --- Refused before any call ----------------------------------------------------------

test("invalid records are refused before any Notion call", async () => {
  const cases = [
    ["opp", null],
    ["opp", { ...RECORDS.opp(), uretId: "SPEC-002" }],
    ["opp", { ...RECORDS.opp(), uretId: "OPP-2" }],
    ["opp", { ...RECORDS.opp(), uretId: undefined }],
    ["opp", { ...RECORDS.opp(), title: "   " }],
    ["opp", { ...RECORDS.opp(), title: 5 }],
    ["opp", { ...RECORDS.opp(), assetType: "" }],
    ["opp", { ...RECORDS.opp(), targetUsers: undefined }],
    ["opp", { ...RECORDS.opp(), project: "x".repeat(200001) }],
    ["spec", { ...RECORDS.spec(), opportunityPageId: undefined }],
    ["spec", { ...RECORDS.spec(), opportunityPageId: "OPP-001" }],
    ["wp", { ...RECORDS.wp(), specPageId: "not-an-id" }],
    ["wp", { ...RECORDS.wp(), worker: " " }],
  ];
  for (const [type, record] of cases) {
    const n = fakeNotion(type);
    await rejectsWith(n.writer.createRecord(type, record), "notion_write_failed");
    assert.strictEqual(n.calls.length, 0, JSON.stringify(record && record.uretId));
    assert.strictEqual(n.resolved.length, 0);
  }
});

test("unknown record types are refused (Evidence and Releases are not creatable)", async () => {
  const n = fakeNotion("opp");
  for (const type of ["evd", "rel", "OPP", "__proto__", "constructor", undefined]) {
    await assert.rejects(n.writer.createRecord(type, RECORDS.opp()), TypeError);
  }
  assert.strictEqual(n.calls.length, 0);
});

// --- Schema validation before write ---------------------------------------------------

test("schema problems stop the write: pages.create is never called", async () => {
  const drop = (name) => (p) => {
    const copy = { ...p };
    delete copy[name];
    return copy;
  };
  const cases = [
    ["opp", drop("Next action")],
    ["opp", (p) => ({ ...p, "Asset type": select(ASSET_TYPES) })],
    ["opp", (p) => ({ ...p, Status: select(["Active", "Parked", "Done"]) })],
    ["opp", (p) => ({ ...p, "Asset type": multi(["Ebook"]) })],
    ["spec", drop("Opportunity")],
    ["spec", (p) => ({ ...p, Version: { type: "number", number: {} } })],
    ["spec", (p) => ({ ...p, Status: select(["Approved"]) })],
    ["wp", (p) => ({ ...p, Worker: select(["Claude Code"]) })],
    ["wp", (p) => ({ ...p, Type: select(["Feature2"]) })],
    ["wp", drop("URET ID")],
    ["wp", (p) => ({ ...p, Name: text() })],
  ];
  for (const [type, change] of cases) {
    const n = fakeNotion(type);
    n.dataSource.properties = change(n.dataSource.properties);
    await rejectsWith(n.writer.createRecord(type, RECORDS[type]()), "notion_schema_invalid");
    assert.strictEqual(n.count("pages.create"), 0);
  }
});

test("a data source outside the root, with another title, or in the trash is refused", async () => {
  const cases = [
    { database_parent: { type: "page_id", page_id: fakePageId() } },
    { database_parent: { type: "workspace", workspace: true } },
    { database_parent: undefined },
    { title: rt("URET – Specs") },
    { in_trash: true },
    { archived: true },
  ];
  for (const change of cases) {
    const n = fakeNotion("opp", { dataSource: change });
    await rejectsWith(n.writer.createRecord("opp", RECORDS.opp()), "notion_schema_invalid");
    assert.strictEqual(n.count("pages.create"), 0);
  }
  const empty = fakeNotion("opp", { onRetrieve: () => null });
  await rejectsWith(empty.writer.createRecord("opp", RECORDS.opp()), "notion_schema_invalid");
});

test("the schema is checked again before every create", async () => {
  const n = fakeNotion("wp");
  await n.writer.createRecord("wp", RECORDS.wp());
  n.dataSource.properties = { ...n.dataSource.properties, Worker: select(["Claude Code"]) };
  await rejectsWith(n.writer.createRecord("wp", RECORDS.wp()), "notion_schema_invalid");
  assert.deepStrictEqual(n.calls.map((c) => c.method), ["dataSources.retrieve", "pages.create", "dataSources.retrieve"]);
});

test("verifyWriteSchema reports problems without IDs", () => {
  const n = fakeNotion("opp");
  assert.deepStrictEqual(nw.verifyWriteSchema(n.dataSource, "opp", RECORDS.opp(), n.root), []);
  const problems = nw.verifyWriteSchema({ ...n.dataSource, title: rt("x") }, "opp", RECORDS.opp(), fakePageId());
  assert.deepStrictEqual(problems, ["parent", "title"]);
});

test("resolver errors pass through unchanged and nothing is sent", async () => {
  const readError = Object.assign(new Error("Notion read failed (notion_source_not_found)"), { label: "notion_source_not_found" });
  const n = fakeNotion("opp", {
    onResolve: () => {
      throw readError;
    },
  });
  await assert.rejects(n.writer.createRecord("opp", RECORDS.opp()), (err) => err === readError);
  assert.strictEqual(n.calls.length, 0);
});

// --- Error mapping --------------------------------------------------------------------

test("pages.create failures map to fixed labels, once, without retry", async () => {
  const secrets = () => [fakeNotionToken(), fakePageId()];
  const cases = [
    [apiError("unauthorized", 401, secrets()), "notion_unauthorized", false],
    [apiError("restricted_resource", 403, secrets()), "notion_unauthorized", false],
    [apiError("validation_error", 400, secrets()), "notion_write_failed", false],
    [apiError("object_not_found", 404, secrets()), "notion_write_failed", false],
    [apiError("conflict_error", 409, secrets()), "notion_write_failed", false],
    [apiError("some_future_code", 400, secrets()), "notion_write_failed", false],
    [apiError("rate_limited", 429, secrets()), "notion_unavailable", false],
    [apiError("service_overload", 503, secrets()), "notion_unavailable", false],
    [apiError("internal_server_error", 500, secrets()), "notion_unavailable", true],
    [apiError("service_unavailable", 503, secrets()), "notion_unavailable", true],
    [apiError("gateway_timeout", 504, secrets()), "notion_unavailable", true],
    [new RequestTimeoutError(), "notion_unavailable", true],
    [new UnknownHTTPResponseError({ status: 502, message: "bad gateway", headers: {}, rawBodyText: "<html>" }), "notion_unavailable", true],
    [new TypeError("fetch failed"), "notion_unavailable", true],
    [Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }), "notion_unavailable", true],
  ];
  for (const [error, label, uncertain] of cases) {
    const n = fakeNotion("opp", {
      onCreate: () => {
        throw error;
      },
    });
    await rejectsWith(n.writer.createRecord("opp", RECORDS.opp()), label, uncertain);
    assert.strictEqual(n.count("pages.create"), 1, `${label}: retried`);
  }
});

test("schema-check failures map to fixed labels and are never uncertain", async () => {
  const cases = [
    [apiError("unauthorized", 401, [fakeNotionToken(), fakePageId()]), "notion_unauthorized"],
    [apiError("object_not_found", 404, [fakeNotionToken(), fakePageId()]), "notion_write_failed"],
    [new RequestTimeoutError(), "notion_unavailable"],
    [new TypeError("fetch failed"), "notion_unavailable"],
  ];
  for (const [error, label] of cases) {
    const n = fakeNotion("spec", {
      onRetrieve: () => {
        throw error;
      },
    });
    await rejectsWith(n.writer.createRecord("spec", RECORDS.spec()), label, false);
    assert.strictEqual(n.count("pages.create"), 0);
  }
});

test("an unexpected create response counts as a possibly applied failure", async () => {
  const n = fakeNotion("opp", { onCreate: () => ({ object: "list" }) });
  await rejectsWith(n.writer.createRecord("opp", RECORDS.opp()), "notion_write_failed", true);
});

test("error labels and messages never carry tokens, IDs, request IDs or raw bodies", async () => {
  const token = fakeNotionToken();
  const n = fakeNotion("opp", {
    onCreate: () => {
      throw apiError("validation_error", 400, [token, n.root, n.dsId]);
    },
  });
  await assert.rejects(n.writer.createRecord("opp", RECORDS.opp()), (err) => {
    const dump = [err.message, err.label, err.stack, util.inspect(err, { depth: 5, showHidden: true }), JSON.stringify(err)].join("\n");
    for (const secret of [token, n.root, dashedId(n.root), n.dsId, "req-SECRET", "Bearer", "Failed for"]) {
      assert.ok(!dump.includes(secret), `leaked ${secret.slice(0, 6)}`);
    }
    assert.strictEqual(err.cause, undefined);
    assert.deepStrictEqual(Object.keys(err).sort(), ["label", "name", "uncertain"]);
    return true;
  });
});

test("a successful result carries no page ID or URL", async () => {
  const n = fakeNotion("wp");
  const out = await n.writer.createRecord("wp", RECORDS.wp());
  assert.deepStrictEqual(Object.keys(out), ["uretId"]);
  assert.doesNotMatch(JSON.stringify(out), /[0-9a-f]{32}|notion\.so/);
});

// --- Abort ------------------------------------------------------------------------------

test("an already-aborted signal stops before any call", async () => {
  const n = fakeNotion("opp");
  const ac = new AbortController();
  ac.abort();
  await rejectsWith(n.writer.createRecord("opp", RECORDS.opp(), { signal: ac.signal }), "notion_aborted", false);
  assert.strictEqual(n.calls.length, 0);
  assert.strictEqual(n.resolved[0].opts.signal, ac.signal, "signal not passed to the resolver");
});

test("aborting during pages.create is reported as possibly applied", async () => {
  const ac = new AbortController();
  const n = fakeNotion("opp", {
    onCreate: () => {
      ac.abort();
      return new Promise(() => {}); // never settles
    },
  });
  await rejectsWith(n.writer.createRecord("opp", RECORDS.opp(), { signal: ac.signal }), "notion_aborted", true);
});

// --- Forbidden operations ---------------------------------------------------------------

test("the writer touches nothing but dataSources.retrieve and pages.create", async () => {
  // The guard throws on any other property, including pages.update, search and request.
  for (const type of ["opp", "spec", "wp"]) {
    const n = fakeNotion(type);
    await n.writer.createRecord(type, RECORDS[type]());
    assert.deepStrictEqual(n.calls.map((c) => c.method), ["dataSources.retrieve", "pages.create"]);
  }
  const g = guard({ pages: { create: () => {} } });
  for (const touch of [() => g.pages.update, () => g.pages.delete, () => g.pages.move, () => g.blocks, () => g.search, () => g.request]) {
    assert.throws(touch, /forbidden access/);
  }
});

test("the writer exposes only createRecord", () => {
  const n = fakeNotion("opp");
  assert.deepStrictEqual(Object.keys(n.writer), ["createRecord"]);
});
