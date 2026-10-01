"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { APIResponseError, RequestTimeoutError } = require("@notionhq/client");
const { createRouter, NOT_CONFIGURED_TEXT } = require("../bot/commands");
const { createSessionStore } = require("../bot/session");
const { createCaptureStore } = require("../bot/captureSession");
const su = require("../bot/statusUpdate");
const nw = require("../bot/notionWrite");
const { tempDir, fakePageId, dashedId, AUTHORIZED_ID } = require("./helpers");

const USER = AUTHORIZED_ID;
const TITLES = { opp: "URET – Opportunities", spec: "URET – Specs", wp: "URET – Work Packages" };

function guard(target, pathSoFar = "client") {
  return new Proxy(target, {
    get(obj, prop) {
      if (typeof prop === "symbol") return undefined;
      if (!Object.prototype.hasOwnProperty.call(obj, prop)) throw new Error(`forbidden access: ${pathSoFar}.${prop}`);
      const value = obj[prop];
      return value && typeof value === "object" ? guard(value, `${pathSoFar}.${prop}`) : value;
    },
  });
}

const rt = (t) => [{ type: "text", plain_text: t, text: { content: t } }];
const select = (names) => ({ type: "select", select: { options: names.map((name) => ({ name })) } });

/**
 * Real router and write adapter; fake read adapter and Notion client. Each type
 * has its own data source with the locked Status options. `records` maps a
 * URET ID to a page, "duplicate" or { trashed: page }.
 */
function harness({ records = {}, onFind, onUpdate, configured = true } = {}) {
  const root = fakePageId();
  const dsIds = { opp: fakePageId(), spec: fakePageId(), wp: fakePageId() };
  const typeOfDs = Object.fromEntries(Object.entries(dsIds).map(([t, id]) => [id, t]));
  const dataSources = {};
  for (const [type, id] of Object.entries(dsIds)) {
    dataSources[type] = {
      object: "data_source",
      id,
      in_trash: false,
      title: rt(TITLES[type]),
      database_parent: { type: "page_id", page_id: dashedId(root) },
      properties: { "URET ID": { type: "rich_text", rich_text: {} }, Name: { type: "title", title: {} }, Status: select(su.STATUS_VOCABULARY[type]) },
    };
  }
  const calls = [];
  const client = guard({
    dataSources: {
      retrieve: async (args) => (calls.push({ method: "dataSources.retrieve", args }), dataSources[typeOfDs[args.data_source_id]]),
    },
    pages: {
      create: async () => {
        throw new Error("pages.create must not be called by /update_status");
      },
      update: async (args) => {
        calls.push({ method: "pages.update", args });
        if (onUpdate) return onUpdate(args);
        return { object: "page", id: args.page_id };
      },
    },
  });
  const reader = {
    findByUretId: async (type, id, opts) => {
      calls.push({ method: "findByUretId", type, id, opts });
      if (onFind) {
        const custom = onFind(type, id);
        if (custom) return custom;
      }
      const r = records[id];
      if (r === "duplicate") return { result: "duplicate", page: null, trashed: false };
      if (r && r.trashed) return { result: "found", page: r.trashed, trashed: true };
      if (r) return { result: "found", page: r, trashed: false };
      return { result: "not_found", page: null, trashed: false };
    },
    getDataSourceId: async (type) => (calls.push({ method: "getDataSourceId", type }), dsIds[type]),
  };
  const writer = nw.createNotionWriter({ client, rootPageId: root, resolveDataSource: reader.getDataSourceId });
  const capture = createCaptureStore();
  const router = createRouter({
    sessions: createSessionStore(),
    configStatus: { TELEGRAM_BOT_TOKEN: "valid", TELEGRAM_ALLOWED_USER_ID: "valid" },
    logDir: path.join(tempDir(), "logs"),
    notion: configured ? reader : null,
    writer: configured ? writer : null,
    reserveId: configured ? async () => "OPP-099" : null,
    capture,
  });
  const send = (t, extra = {}) => router.route({ text: t, chatId: USER, ...extra });
  const methods = () => calls.map((c) => c.method);
  const count = (method) => calls.filter((c) => c.method === method).length;
  // A page in a type's data source, with a current Status.
  const page = (type, status, extra = {}) => ({
    object: "page",
    id: fakePageId(),
    in_trash: false,
    parent: { type: "data_source_id", data_source_id: dashedId(dsIds[type]) },
    properties: { Status: { type: "select", select: status ? { name: status } : null } },
    ...extra,
  });
  return { send, calls, methods, count, page, dataSources, dsIds, capture, records };
}

const apiError = (code, status) => new APIResponseError({ code, status, message: "detail", headers: {}, rawBodyText: "{}" });

// --- Definition --------------------------------------------------------------------------------

test("the command's vocabulary is the write adapter's vocabulary", () => {
  assert.deepStrictEqual(su.STATUS_VOCABULARY, nw.STATUS_VOCABULARY);
});

// --- Success ---------------------------------------------------------------------------------------

test("/update_status for an Opportunity, a Spec and a Work Package: Status only, then confirmed", async () => {
  const cases = [
    ["opp", "OPP-002", "Idea", "/update_status OPP-002 Active", "Active"],
    ["spec", "SPEC-002", "Draft", "/update_status spec-2 approved", "Approved"],
    ["wp", "WP-002", "Draft", "/update_status wp-002 in  PROGRESS", "In progress"],
  ];
  for (const [type, id, from, command, to] of cases) {
    const h = harness();
    const p = h.page(type, from);
    h.records[id] = p;
    const out = await h.send(command);
    assert.strictEqual(out.command, "update_status");
    assert.strictEqual(out.label, undefined, id);
    assert.strictEqual(out.reply, `Updated ${id} status to ${to}.`);
    assert.deepStrictEqual(h.methods(), ["findByUretId", "getDataSourceId", "dataSources.retrieve", "pages.update"], id);
    assert.deepStrictEqual([h.calls[0].type, h.calls[0].id], [type, id]);
    assert.deepStrictEqual(h.calls[3].args, { page_id: p.id, properties: { Status: { select: { name: to } } } });
  }
});

test("every status in every vocabulary can be set, from no status at all", async () => {
  for (const [type, statuses] of Object.entries(su.STATUS_VOCABULARY)) {
    for (const status of statuses) {
      const h = harness();
      const id = `${type.toUpperCase()}-005`;
      h.records[id] = h.page(type, null);
      assert.strictEqual((await h.send(`/update_status ${id} ${status}`)).reply, `Updated ${id} status to ${status}.`);
    }
  }
});

// --- Refused before any Notion call ------------------------------------------------------------------

test("missing arguments show the usage; nothing is read", async () => {
  const h = harness();
  for (const t of ["/update_status", "/update_status   ", "/update_status OPP-002", "/update_status@UretBot OPP-002"]) {
    assert.strictEqual((await h.send(t)).reply, "Usage: /update_status <URET-ID> <status>\nExample: /update_status OPP-002 Active", t);
  }
  assert.strictEqual(h.calls.length, 0);
});

test("invalid or non-status IDs are refused; nothing is read", async () => {
  const h = harness();
  for (const t of ["/update_status EVD-001 Pass", "/update_status REL-001 Released", "/update_status OPP-0 Active", "/update_status OPP2 Active", "/update_status pharmacy Active"]) {
    assert.strictEqual((await h.send(t)).reply, "Invalid URET ID. Example: /update_status OPP-002 Active", t);
  }
  assert.strictEqual(h.calls.length, 0);
});

test("a status outside the type's vocabulary is refused with that vocabulary; nothing is read", async () => {
  const h = harness();
  const cases = [
    ["/update_status OPP-002 Approved", "Invalid status. Use one of: Idea, Active, Parked, Done."],
    ["/update_status OPP-002 In progress", "Invalid status. Use one of: Idea, Active, Parked, Done."],
    ["/update_status SPEC-002 Done", "Invalid status. Use one of: Draft, Approved, Superseded."],
    ["/update_status WP-002 Active", "Invalid status. Use one of: Draft, In progress, Done, Blocked."],
    ["/update_status WP-002 Inprogress", "Invalid status. Use one of: Draft, In progress, Done, Blocked."],
    ["/update_status WP-002 Done please", "Invalid status. Use one of: Draft, In progress, Done, Blocked."],
  ];
  for (const [t, reply] of cases) assert.strictEqual((await h.send(t)).reply, reply, t);
  assert.strictEqual(h.calls.length, 0);
});

test("without Notion configuration nothing is read or written", async () => {
  const h = harness({ configured: false });
  const out = await h.send("/update_status OPP-002 Active");
  assert.deepStrictEqual([out.reply, out.label], [NOT_CONFIGURED_TEXT, "notion_not_configured"]);
  assert.strictEqual(h.calls.length, 0);
});

// --- Lookup outcomes -----------------------------------------------------------------------------------

test("record not found, per type; nothing written", async () => {
  const h = harness();
  assert.strictEqual((await h.send("/update_status OPP-999 Active")).reply, "Opportunity OPP-999 not found.");
  assert.strictEqual((await h.send("/update_status SPEC-999 Approved")).reply, "Spec SPEC-999 not found.");
  assert.strictEqual((await h.send("/update_status WP-999 Done")).reply, "Work package WP-999 not found.");
  assert.strictEqual(h.count("pages.update"), 0);
  assert.strictEqual(h.count("dataSources.retrieve"), 0);
});

test("duplicate URET ID: data integrity text; nothing written", async () => {
  const h = harness({ records: { "WP-002": "duplicate" } });
  const out = await h.send("/update_status WP-002 Done");
  assert.deepStrictEqual([out.reply, out.label], ["Data integrity problem: multiple records found for WP-002.", "notion_duplicate_id"]);
  assert.strictEqual(h.count("pages.update"), 0);
});

test("a trashed record is not updated", async () => {
  const h = harness();
  h.records["OPP-002"] = { trashed: h.page("opp", "Idea", { in_trash: true }) };
  assert.strictEqual((await h.send("/update_status OPP-002 Active")).reply, "Opportunity OPP-002 is in the trash.");
  assert.strictEqual(h.count("pages.update"), 0);
});

test("already at that status: replies without calling the write adapter", async () => {
  const h = harness();
  h.records["OPP-002"] = h.page("opp", "Active");
  const out = await h.send("/update_status OPP-002 active");
  assert.deepStrictEqual([out.reply, out.label], ["OPP-002 is already Active.", undefined]);
  assert.deepStrictEqual(h.methods(), ["findByUretId"]);
});

test("a Notion failure during the lookup gives the fixed read text", async () => {
  const h = harness({
    onFind: () => {
      throw Object.assign(new Error("x"), { label: "notion_timeout" });
    },
  });
  const out = await h.send("/update_status OPP-002 Active");
  assert.deepStrictEqual([out.reply, out.label], ["Notion: Unavailable", "notion_timeout"]);
  assert.strictEqual(h.count("pages.update"), 0);
});

// --- Write outcomes -------------------------------------------------------------------------------------

test("an unconfirmed update asks the user to check with /show", async () => {
  for (const error of [new RequestTimeoutError(), apiError("internal_server_error", 500), new TypeError("fetch failed")]) {
    const h = harness({
      onUpdate: () => {
        throw error;
      },
    });
    h.records["OPP-002"] = h.page("opp", "Idea");
    const out = await h.send("/update_status OPP-002 Active");
    assert.deepStrictEqual([out.reply, out.label], ["Notion did not confirm the update. Check with /show OPP-002.", "notion_update_unconfirmed"]);
    assert.strictEqual(h.count("pages.update"), 1, "retried");
  }
});

test("clear update failures give the locked write texts", async () => {
  const cases = [
    [apiError("unauthorized", 401), "Notion access problem. Check configuration.", "notion_unauthorized"],
    [apiError("restricted_resource", 403), "Notion access problem. Check configuration.", "notion_unauthorized"],
    [apiError("validation_error", 400), "Notion write failed. Please try again.", "notion_write_failed"],
    [apiError("rate_limited", 429), "Notion is unavailable. Please try again later.", "notion_unavailable"],
  ];
  for (const [error, reply, label] of cases) {
    const h = harness({
      onUpdate: () => {
        throw error;
      },
    });
    h.records["SPEC-002"] = h.page("spec", "Draft");
    const out = await h.send("/update_status SPEC-002 Approved");
    assert.deepStrictEqual([out.reply, out.label], [reply, label]);
  }
});

test("a Status option missing in Notion stops the update with the schema text", async () => {
  const h = harness();
  h.dataSources.wp.properties.Status = select(["Draft", "Done", "Blocked"]);
  h.records["WP-002"] = h.page("wp", "Draft");
  const out = await h.send("/update_status WP-002 In progress");
  assert.deepStrictEqual([out.reply, out.label], ["Notion schema problem. Cannot create record.", "notion_schema_invalid"]);
  assert.strictEqual(h.count("pages.update"), 0);
});

test("a looked-up page that is not in the type's data source is never updated", async () => {
  const h = harness();
  h.records["OPP-002"] = h.page("opp", "Idea", { parent: { type: "data_source_id", data_source_id: dashedId(h.dsIds.spec) } });
  const out = await h.send("/update_status OPP-002 Active");
  assert.deepStrictEqual([out.reply, out.label], ["Notion write failed. Please try again.", "notion_write_failed"]);
  assert.strictEqual(h.count("pages.update"), 0);
});

test("an abort (shutdown) during the update is passed on, not answered", async () => {
  const ac = new AbortController();
  const h = harness({
    onUpdate: () => {
      ac.abort();
      return new Promise(() => {});
    },
  });
  h.records["OPP-002"] = h.page("opp", "Idea");
  await assert.rejects(h.send("/update_status OPP-002 Active", { signal: ac.signal }), (err) => err.label === "notion_aborted");
});

// --- Interaction with the rest of the bot ------------------------------------------------------------

test("/update_status works during a guided session and leaves it untouched", async () => {
  const h = harness();
  h.records["OPP-002"] = h.page("opp", "Idea");
  await h.send("/new_opportunity");
  await h.send("Title");
  assert.strictEqual((await h.send("/update_status OPP-002 Done")).reply, "Updated OPP-002 status to Done.");
  const session = h.capture.getActiveSession(USER);
  assert.strictEqual(session.command, "new_opportunity");
  assert.strictEqual(session.step, 1);
});

test("logged fields carry only the command name and fixed labels", async () => {
  const h = harness({
    onUpdate: () => {
      throw new RequestTimeoutError();
    },
  });
  h.records["OPP-002"] = h.page("opp", "Idea");
  const out = await h.send("/update_status OPP-002 Active");
  assert.strictEqual(out.command, "update_status");
  assert.doesNotMatch(`${out.command} ${out.label}`, /OPP-002|Active/);
});
