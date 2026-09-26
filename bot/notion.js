"use strict";

/**
 * Read-only Notion adapter for exactly one data source: "URET – Opportunities".
 *
 * This is the only bot module that loads @notionhq/client. It calls only four
 * read operations:
 *   blocks.children.list, databases.retrieve, dataSources.retrieve, dataSources.query
 * It never creates, updates, deletes, appends or moves anything, never calls
 * any page API, search or client.request, and never retries.
 *
 * Every SDK error is caught at the call boundary and replaced by a
 * NotionReadError carrying only a fixed "notion_*" label. The original error
 * (message, body, headers, request ID, URL) is never kept or passed on, and
 * no Notion ID or token is ever part of a label or reply.
 */

const { Client, isNotionClientError, APIErrorCode, ClientErrorCode } = require("@notionhq/client");
const { REQUIRED_STATUSES } = require("./opportunities");

const NOTION_VERSION = "2025-09-03";
const TIMEOUT_MS = 10000;
const SOURCE_TITLE = "URET – Opportunities";
const PAGE_SIZE = 100;
const MAX_STATUS_PAGES = 10;
// Bounds discovery on a very large root page; beyond it the result is ambiguous.
const MAX_CHILD_PAGES = 10;

const REQUIRED_SCHEMA = {
  "URET ID": "rich_text",
  Name: "title",
  Status: "select",
  "Asset type": "multi_select",
  "Project / Asset": "rich_text",
  "Problem summary": "rich_text",
  "Target users": "rich_text",
  "Success metrics": "rich_text",
  "Next action": "rich_text",
  Created: "created_time",
  "Last updated": "last_edited_time",
  Specs: "relation",
  Releases: "relation",
};

class NotionReadError extends Error {
  constructor(label) {
    super(`Notion read failed (${label})`);
    this.name = "NotionReadError";
    this.label = label;
  }
}

const API_LABELS = {
  [APIErrorCode.Unauthorized]: "notion_unauthorized",
  [APIErrorCode.RestrictedResource]: "notion_forbidden",
  [APIErrorCode.ObjectNotFound]: "notion_not_found",
  [APIErrorCode.RateLimited]: "notion_rate_limited",
  [APIErrorCode.ValidationError]: "notion_bad_request",
  [APIErrorCode.InvalidRequest]: "notion_bad_request",
  [APIErrorCode.InvalidRequestURL]: "notion_bad_request",
  [APIErrorCode.InvalidJSON]: "notion_bad_request",
  [APIErrorCode.InvalidBeta]: "notion_bad_request",
  [APIErrorCode.ConflictError]: "notion_conflict",
  [APIErrorCode.InternalServerError]: "notion_unavailable",
  [APIErrorCode.ServiceOverload]: "notion_unavailable",
  [APIErrorCode.ServiceUnavailable]: "notion_unavailable",
  [APIErrorCode.GatewayTimeout]: "notion_unavailable",
  [ClientErrorCode.RequestTimeout]: "notion_timeout",
  [ClientErrorCode.ResponseError]: "notion_unavailable",
  [ClientErrorCode.InvalidPathParameter]: "notion_bad_request",
};

// Maps an error thrown by an SDK call to a fixed label. Only the SDK's fixed
// `code` is consulted. Non-SDK errors at this boundary are transport failures.
function labelFor(err) {
  if (isNotionClientError(err)) return API_LABELS[err.code] || "notion_error";
  return "notion_unavailable";
}

function createNotionClient(config, { ClientClass = Client } = {}) {
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

// Required properties and types, plus the four required Status options.
function verifySchema(dataSource) {
  const properties = (dataSource && dataSource.properties) || {};
  const problems = [];
  for (const [name, type] of Object.entries(REQUIRED_SCHEMA)) {
    const prop = properties[name];
    if (!prop) problems.push(`missing:${name}`);
    else if (prop.type !== type) problems.push(`type:${name}`);
  }
  const status = properties.Status;
  if (status && status.type === "select") {
    const options = new Set(((status.select && status.select.options) || []).map((o) => o && o.name));
    for (const required of REQUIRED_STATUSES) {
      if (!options.has(required)) problems.push(`status_option:${required}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

function createNotionReader({ client, rootPageId }) {
  const root = normId(rootPageId);
  // In-memory only; lost on restart.
  let cached = null; // { dataSourceId, statusPropertyId, schemaOk }
  let successfulReads = 0; // lets /health tell "reached Notion" from "never reached"

  // Runs one SDK call. Aborting (bot shutdown) abandons it without waiting.
  async function call(fn, signal) {
    if (signal && signal.aborted) throw new NotionReadError("notion_aborted");
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(new NotionReadError("notion_aborted"));
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
    const request = (async () => {
      try {
        const result = await fn();
        successfulReads++;
        return result;
      } catch (err) {
        throw new NotionReadError(labelFor(err));
      }
    })();
    request.catch(() => {}); // an abandoned request must not become an unhandled rejection
    try {
      return await Promise.race([request, aborted]);
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  async function listMatchingChildDatabases(signal) {
    const matches = [];
    let cursor;
    for (let page = 0; page < MAX_CHILD_PAGES; page++) {
      const res = await call(
        () => client.blocks.children.list({ block_id: root, start_cursor: cursor, page_size: PAGE_SIZE }),
        signal
      );
      for (const block of (res && res.results) || []) {
        if (block && block.type === "child_database" && !isTrashed(block) && block.child_database &&
            normTitle(block.child_database.title) === normTitle(SOURCE_TITLE)) {
          matches.push(block.id);
        }
      }
      if (!res || !res.has_more) return matches;
      cursor = res.next_cursor;
    }
    // Too many children to be sure there is no second match.
    throw new NotionReadError("notion_source_ambiguous");
  }

  // Strict discovery under the root page; no workspace search, no guessing.
  // Returns the verified data source object and caches its ID in memory.
  async function discover(signal) {
    const matches = await listMatchingChildDatabases(signal);
    if (matches.length === 0) throw new NotionReadError("notion_source_not_found");
    if (matches.length > 1) throw new NotionReadError("notion_source_ambiguous");

    const database = await call(() => client.databases.retrieve({ database_id: matches[0] }), signal);
    if (!database || !database.parent || database.parent.type !== "page_id" || normId(database.parent.page_id) !== root) {
      throw new NotionReadError("notion_source_invalid");
    }
    if (isTrashed(database)) throw new NotionReadError("notion_source_invalid");
    const sources = Array.isArray(database.data_sources) ? database.data_sources : [];
    if (sources.length !== 1) throw new NotionReadError(sources.length > 1 ? "notion_source_ambiguous" : "notion_source_invalid");

    const dataSource = await call(() => client.dataSources.retrieve({ data_source_id: sources[0].id }), signal);
    checkSource(dataSource);
    remember(dataSource);
    return dataSource;
  }

  function checkSource(dataSource) {
    const parent = dataSource && dataSource.database_parent;
    if (!parent || parent.type !== "page_id" || normId(parent.page_id) !== root) throw new NotionReadError("notion_source_invalid");
    if (normTitle(plainTitle(dataSource.title)) !== normTitle(SOURCE_TITLE)) throw new NotionReadError("notion_source_invalid");
    if (isTrashed(dataSource)) throw new NotionReadError("notion_source_invalid");
  }

  function remember(dataSource) {
    const status = dataSource.properties && dataSource.properties.Status;
    cached = { dataSourceId: dataSource.id, statusPropertyId: status && status.id, schemaOk: verifySchema(dataSource).ok };
  }

  // A remembered source that Notion no longer finds is forgotten; the next
  // command discovers again (no second attempt inside this command).
  async function withSource(signal, fn) {
    if (!cached) await discover(signal);
    if (!cached.schemaOk) throw new NotionReadError("notion_schema_invalid");
    try {
      return await fn(cached);
    } catch (err) {
      if (err instanceof NotionReadError && err.label === "notion_not_found") cached = null;
      throw err;
    }
  }

  async function countByStatus({ signal } = {}) {
    return withSource(signal, async (source) => {
      const counts = Object.fromEntries(REQUIRED_STATUSES.map((s) => [s, 0]));
      let total = 0;
      let unexpected = 0;
      let empty = 0;
      let cursor;
      let hasMore = false;
      for (let page = 0; page < MAX_STATUS_PAGES; page++) {
        const query = { data_source_id: source.dataSourceId, page_size: PAGE_SIZE, start_cursor: cursor };
        if (source.statusPropertyId) query.filter_properties = [source.statusPropertyId];
        const res = await call(() => client.dataSources.query(query), signal);
        for (const item of (res && res.results) || []) {
          if (!item || item.object !== "page" || isTrashed(item)) continue;
          total++;
          const prop = item.properties && item.properties.Status;
          const name = prop && prop.type === "select" && prop.select ? prop.select.name : null;
          if (!name) empty++;
          else if (Object.prototype.hasOwnProperty.call(counts, name)) counts[name]++;
          else unexpected++;
        }
        hasMore = Boolean(res && res.has_more);
        if (!hasMore) break;
        cursor = res.next_cursor;
      }
      const incomplete = hasMore;
      let outcome = "counts";
      if (unexpected > 0 || empty > 0) outcome = "data_integrity";
      else if (incomplete) outcome = "incomplete";
      return { outcome, total, counts, idea: counts.Idea, active: counts.Active, parked: counts.Parked, done: counts.Done, unexpected, empty, incomplete };
    });
  }

  // Exact URET ID lookup. `uretId` must already be canonical (OPP-NNN).
  async function findByUretId(uretId, { signal } = {}) {
    return withSource(signal, async (source) => {
      const res = await call(
        () =>
          client.dataSources.query({
            data_source_id: source.dataSourceId,
            filter: { property: "URET ID", rich_text: { equals: uretId } },
            page_size: 2,
          }),
        signal
      );
      const hits = ((res && res.results) || []).filter((item) => item && item.object === "page");
      if (hits.length === 0) return { result: "not_found", page: null, trashed: false };
      if (hits.length > 1 || (res && res.has_more)) return { result: "duplicate", page: null, trashed: false };
      return { result: "found", page: hits[0], trashed: isTrashed(hits[0]) };
    });
  }

  /**
   * Read-only health: each field is "ok", "not_ok" or "not_checked", and is
   * "ok" only if its read succeeded during this call.
   *   reachable   - at least one Notion read succeeded
   *   sourceFound - exactly one verified Opportunities source
   *   schemaValid - required properties, types and Status options present
   */
  async function health({ signal } = {}) {
    const out = { reachable: "not_checked", sourceFound: "not_checked", schemaValid: "not_checked", label: null };
    const readsBefore = successfulReads;
    let dataSource;
    try {
      if (cached) {
        dataSource = await call(() => client.dataSources.retrieve({ data_source_id: cached.dataSourceId }), signal);
        checkSource(dataSource);
        remember(dataSource);
      } else {
        dataSource = await discover(signal);
      }
      out.reachable = "ok";
      out.sourceFound = "ok";
    } catch (err) {
      const label = err instanceof NotionReadError ? err.label : "notion_error";
      if (label === "notion_aborted") throw err;
      out.label = label;
      if (label === "notion_not_found" && cached) cached = null;
      if (successfulReads > readsBefore) {
        out.reachable = "ok";
        out.sourceFound = "not_ok";
      } else {
        out.reachable = "not_ok";
      }
      return out;
    }
    const schema = verifySchema(dataSource);
    out.schemaValid = schema.ok ? "ok" : "not_ok";
    if (!schema.ok) out.label = "notion_schema_invalid";
    return out;
  }

  return {
    countByStatus,
    findByUretId,
    health,
    // For tests: whether a data source is currently remembered.
    hasCachedSource: () => cached !== null,
  };
}

module.exports = {
  NOTION_VERSION,
  TIMEOUT_MS,
  SOURCE_TITLE,
  REQUIRED_SCHEMA,
  MAX_STATUS_PAGES,
  NotionReadError,
  createNotionClient,
  createNotionReader,
  verifySchema,
  labelFor,
};
