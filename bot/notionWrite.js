"use strict";

/**
 * Notion write adapter: creates new Opportunity, Spec, Work Package and
 * Evidence records, and changes the Status of existing Opportunities, Specs
 * and Work Packages.
 *
 * This is the only bot module that writes to Notion. It makes two writes:
 * pages.create, and pages.update with the Status property only. It also calls
 * dataSources.retrieve, to verify the target data source and its schema
 * immediately before every write. It never changes any other property, never
 * deletes, moves or appends anything, never calls search or client.request,
 * and never retries.
 *
 * Callers pass plain answers; this module builds the Notion properties itself
 * and fixes the initial Status (Idea for Opportunities, Draft otherwise).
 * Select and multi-select values must already exist as options in Notion, so a
 * create can never add an option to the schema.
 *
 * Every SDK error is caught at the call boundary and replaced by a
 * NotionWriteError carrying only a fixed label. The original error (message,
 * body, headers, request ID, URL) is never kept or passed on. A successful
 * create returns only the URET ID: no page ID or URL leaves this module.
 */

const { Client, isNotionClientError, APIErrorCode, ClientErrorCode } = require("@notionhq/client");

const NOTION_VERSION = "2025-09-03";
const TIMEOUT_MS = 10000;
// Notion's limit for one rich text item, and for the number of items.
const TEXT_CHUNK = 2000;
const MAX_CHUNKS = 100;

// What each creatable type writes: data source title, URET ID prefix, fixed
// initial Status (null: the type has no Status, as for Evidence), and each
// answer's property (in capture order), with the Notion type it must have.
// `relation` is the parent link, if any.
const TARGETS = {
  opp: {
    title: "URET – Opportunities",
    prefix: "OPP",
    status: "Idea",
    relation: null,
    fields: {
      assetType: ["Asset type", "multi_select"],
      project: ["Project / Asset", "rich_text"],
      problemSummary: ["Problem summary", "rich_text"],
      targetUsers: ["Target users", "rich_text"],
      successMetrics: ["Success metrics", "rich_text"],
      nextAction: ["Next action", "rich_text"],
    },
  },
  spec: {
    title: "URET – Specs",
    prefix: "SPEC",
    status: "Draft",
    relation: ["opportunityPageId", "Opportunity"],
    fields: {
      version: ["Version", "rich_text"],
      summary: ["Summary", "rich_text"],
      scopeIn: ["Scope in", "rich_text"],
      scopeOut: ["Scope out", "rich_text"],
      constraints: ["Constraints", "rich_text"],
    },
  },
  wp: {
    title: "URET – Work Packages",
    prefix: "WP",
    status: "Draft",
    relation: ["specPageId", "Spec"],
    fields: {
      type: ["Type", "select"],
      worker: ["Worker", "select"],
      summary: ["Summary", "rich_text"],
      instructions: ["Instructions", "rich_text"],
      outputs: ["Outputs", "rich_text"],
    },
  },
  evd: {
    title: "URET – Evidence",
    prefix: "EVD",
    status: null,
    relation: ["wpPageId", "Work package"],
    fields: {
      type: ["Type", "select"],
      verdict: ["Verdict", "select"],
      summary: ["Summary", "rich_text"],
    },
  },
};

class NotionWriteError extends Error {
  /**
   * label: fixed "notion_*" label for the reply.
   * uncertain: true when a write (pages.create or pages.update) was sent and may have been applied
   * (timeout, transport failure, server error, abort).
   */
  constructor(label, { uncertain = false } = {}) {
    super(`Notion write failed (${label})`);
    this.name = "NotionWriteError";
    this.label = label;
    this.uncertain = uncertain;
  }
}

const API_LABELS = {
  [APIErrorCode.Unauthorized]: "notion_unauthorized",
  [APIErrorCode.RestrictedResource]: "notion_unauthorized",
  [APIErrorCode.RateLimited]: "notion_unavailable",
  [APIErrorCode.InternalServerError]: "notion_unavailable",
  [APIErrorCode.ServiceOverload]: "notion_unavailable",
  [APIErrorCode.ServiceUnavailable]: "notion_unavailable",
  [APIErrorCode.GatewayTimeout]: "notion_unavailable",
  [ClientErrorCode.RequestTimeout]: "notion_unavailable",
  [ClientErrorCode.ResponseError]: "notion_unavailable",
};

// Failures after which a sent create may still have been applied.
const MAYBE_APPLIED = new Set([
  APIErrorCode.InternalServerError,
  APIErrorCode.ServiceUnavailable,
  APIErrorCode.GatewayTimeout,
  ClientErrorCode.RequestTimeout,
  ClientErrorCode.ResponseError,
]);

// Maps an SDK error to a fixed label; only the SDK's fixed `code` is consulted.
// Non-SDK errors at this boundary are transport failures.
function labelFor(err) {
  if (isNotionClientError(err)) return API_LABELS[err.code] || "notion_write_failed";
  return "notion_unavailable";
}

function maybeApplied(err) {
  return isNotionClientError(err) ? MAYBE_APPLIED.has(err.code) : true;
}

function createNotionWriteClient(config, { ClientClass = Client } = {}) {
  return new ClientClass({
    auth: config.notionToken,
    notionVersion: NOTION_VERSION,
    retry: false,
    timeoutMs: TIMEOUT_MS,
    logger: () => {},
  });
}

const normId = (id) => String(id || "").replace(/-/g, "").toLowerCase();
const normTitle = (title) =>
  String(title || "")
    .normalize("NFKC")
    .replace(/[‐-―−-]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
const plainTitle = (richText) => (Array.isArray(richText) ? richText.map((t) => (t && t.plain_text) || "").join("") : "");
const isTrashed = (obj) => Boolean(obj && (obj.in_trash === true || obj.archived === true));
const optionNames = (prop, kind) => new Set(((prop[kind] && prop[kind].options) || []).map((o) => o && o.name));
const isPageId = (id) => typeof id === "string" && /^[0-9a-f]{32}$/.test(normId(id)) && /^[0-9a-f-]+$/i.test(id);

// Text split into rich text items within Notion's per-item limit.
function richText(value) {
  const chars = Array.from(value);
  const chunks = [];
  for (let i = 0; i < chars.length; i += TEXT_CHUNK) chunks.push(chars.slice(i, i + TEXT_CHUNK).join(""));
  return chunks.map((content) => ({ type: "text", text: { content } }));
}

const invalidRecord = () => new NotionWriteError("notion_write_failed");

// The Status values each type may be set to (the setup script's options).
const STATUS_VOCABULARY = {
  opp: ["Idea", "Active", "Parked", "Done"],
  spec: ["Draft", "Approved", "Superseded"],
  wp: ["Draft", "In progress", "Done", "Blocked"],
};

// Checks the caller's record before anything is sent. Throws without any call.
function checkRecord(target, record) {
  if (!record || typeof record !== "object") throw invalidRecord();
  const idPattern = new RegExp(`^${target.prefix}-\\d{3,}$`);
  if (typeof record.uretId !== "string" || !idPattern.test(record.uretId)) throw invalidRecord();
  if (typeof record.title !== "string" || record.title.trim() === "") throw invalidRecord();
  for (const key of ["title", ...Object.keys(target.fields)]) {
    if (typeof record[key] !== "string") throw invalidRecord();
    if (Array.from(record[key]).length > TEXT_CHUNK * MAX_CHUNKS) throw invalidRecord();
  }
  for (const [key, [, kind]] of Object.entries(target.fields)) {
    if (kind !== "rich_text" && record[key].trim() === "") throw invalidRecord();
  }
  if (target.relation && !isPageId(record[target.relation[0]])) throw invalidRecord();
}

/**
 * Verifies the target data source immediately before a create: under the
 * root page, the expected title, not in the trash, every written property
 * present with the right type, and every select value an existing option.
 * Returns the list of problems (empty when writable).
 */
function verifyWriteSchema(dataSource, type, record, rootPageId) {
  const target = TARGETS[type];
  const problems = [];
  const parent = dataSource && dataSource.database_parent;
  if (!parent || parent.type !== "page_id" || normId(parent.page_id) !== normId(rootPageId)) problems.push("parent");
  if (!dataSource || normTitle(plainTitle(dataSource.title)) !== normTitle(target.title)) problems.push("title");
  if (isTrashed(dataSource)) problems.push("trashed");
  const properties = (dataSource && dataSource.properties) || {};
  const expected = [
    ["URET ID", "rich_text"],
    ["Name", "title"],
    ...(target.status ? [["Status", "select"]] : []),
    ...Object.values(target.fields),
    ...(target.relation ? [[target.relation[1], "relation"]] : []),
  ];
  for (const [name, kind] of expected) {
    const prop = properties[name];
    if (!prop) problems.push(`missing:${name}`);
    else if (prop.type !== kind) problems.push(`type:${name}`);
  }
  if (problems.length > 0) return problems;
  if (target.status && !optionNames(properties.Status, "select").has(target.status)) problems.push("option:Status");
  for (const [key, [name, kind]] of Object.entries(target.fields)) {
    if (kind !== "rich_text" && !optionNames(properties[name], kind).has(record[key])) problems.push(`option:${name}`);
  }
  return problems;
}

function buildProperties(target, record) {
  const properties = {
    Name: { title: richText(record.title) },
    "URET ID": { rich_text: richText(record.uretId) },
  };
  if (target.status) properties.Status = { select: { name: target.status } };
  for (const [key, [name, kind]] of Object.entries(target.fields)) {
    if (kind === "rich_text") properties[name] = { rich_text: richText(record[key]) };
    else if (kind === "select") properties[name] = { select: { name: record[key] } };
    else properties[name] = { multi_select: [{ name: record[key] }] };
  }
  if (target.relation) properties[target.relation[1]] = { relation: [{ id: record[target.relation[0]] }] };
  return properties;
}

/**
 * resolveDataSource(type, { signal }) must return the ID of the verified data
 * source for that type (the read adapter's discovery). Its errors pass on
 * unchanged.
 */
function createNotionWriter({ client, rootPageId, resolveDataSource }) {
  if (typeof resolveDataSource !== "function") throw new TypeError("resolveDataSource is required");

  // Runs one SDK call. Aborting (bot shutdown) abandons it without waiting;
  // an abandoned write counts as possibly applied.
  async function call(fn, signal, { isWrite = false } = {}) {
    if (signal && signal.aborted) throw new NotionWriteError("notion_aborted");
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(new NotionWriteError("notion_aborted", { uncertain: isWrite }));
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
    const request = (async () => {
      try {
        return await fn();
      } catch (err) {
        throw new NotionWriteError(labelFor(err), { uncertain: isWrite && maybeApplied(err) });
      }
    })();
    request.catch(() => {}); // an abandoned request must not become an unhandled rejection
    try {
      return await Promise.race([request, aborted]);
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Creates one record of type "opp", "spec", "wp" or "evd". `record` holds the
   * URET ID, the title and the capture answers (plus the parent page ID for
   * Specs, Work Packages and Evidence). Returns { uretId } only.
   */
  async function createRecord(type, record, { signal } = {}) {
    if (!Object.prototype.hasOwnProperty.call(TARGETS, type)) throw new TypeError("unknown record type");
    const target = TARGETS[type];
    checkRecord(target, record);

    const dataSourceId = await resolveDataSource(type, { signal });
    const dataSource = await call(() => client.dataSources.retrieve({ data_source_id: dataSourceId }), signal);
    if (verifyWriteSchema(dataSource, type, record, rootPageId).length > 0) throw new NotionWriteError("notion_schema_invalid");

    const created = await call(
      () =>
        client.pages.create({
          parent: { type: "data_source_id", data_source_id: dataSourceId },
          properties: buildProperties(target, record),
        }),
      signal,
      { isWrite: true }
    );
    if (!created || created.object !== "page") throw new NotionWriteError("notion_write_failed", { uncertain: true });
    return { uretId: record.uretId };
  }

  /**
   * Sets the Status of an existing record of type "opp", "spec" or "wp".
   * `page` is the page object from the read adapter's lookup. Before the
   * write: the value must be in the type's vocabulary, the page must not be
   * trashed, the target data source must pass the same checks as for a create
   * (root parent, title, not trashed), its Status must be a select that has the
   * option, and the page must belong to that data source. Then one
   * pages.update with the Status property only. Returns { status }.
   */
  async function updateStatus(type, page, newStatus, { signal } = {}) {
    if (!Object.prototype.hasOwnProperty.call(STATUS_VOCABULARY, type)) throw new TypeError("unknown record type");
    if (typeof newStatus !== "string" || !STATUS_VOCABULARY[type].includes(newStatus)) throw invalidRecord();
    if (!page || !isPageId(page.id) || isTrashed(page)) throw invalidRecord();

    const dataSourceId = await resolveDataSource(type, { signal });
    const dataSource = await call(() => client.dataSources.retrieve({ data_source_id: dataSourceId }), signal);
    const parent = dataSource && dataSource.database_parent;
    const status = dataSource && dataSource.properties && dataSource.properties.Status;
    if (
      !parent || parent.type !== "page_id" || normId(parent.page_id) !== normId(rootPageId) ||
      normTitle(plainTitle(dataSource.title)) !== normTitle(TARGETS[type].title) || isTrashed(dataSource) ||
      !status || status.type !== "select" || !optionNames(status, "select").has(newStatus)
    ) {
      throw new NotionWriteError("notion_schema_invalid");
    }
    const pageParent = page.parent;
    if (!pageParent || pageParent.type !== "data_source_id" || normId(pageParent.data_source_id) !== normId(dataSourceId)) {
      throw invalidRecord();
    }

    const updated = await call(
      () => client.pages.update({ page_id: page.id, properties: { Status: { select: { name: newStatus } } } }),
      signal,
      { isWrite: true }
    );
    if (!updated || updated.object !== "page") throw new NotionWriteError("notion_write_failed", { uncertain: true });
    return { status: newStatus };
  }

  return { createRecord, updateStatus };
}

module.exports = {
  NOTION_VERSION,
  TIMEOUT_MS,
  TARGETS,
  STATUS_VOCABULARY,
  NotionWriteError,
  createNotionWriteClient,
  createNotionWriter,
  verifyWriteSchema,
  labelFor,
};
