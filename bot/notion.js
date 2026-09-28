"use strict";

/**
 * Read-only Notion adapter for the five URET data sources under the root page:
 * Opportunities, Specs, Work Packages, Evidence and Releases.
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
const SOURCE_TITLE = "URET – Opportunities"; // the Opportunities source (/status, /health)
const PAGE_SIZE = 100;
const MAX_STATUS_PAGES = 10;
// Bounds discovery on a very large root page; beyond it the result is ambiguous.
const MAX_CHILD_PAGES = 10;
// Linked records listed by /show (more are marked as such).
const MAX_LINKED = 10;

// Opportunities: required properties and types (Status options checked separately).
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

const SPEC_SCHEMA = {
  "URET ID": "rich_text",
  Name: "title",
  Opportunity: "relation",
  Version: "rich_text",
  Summary: "rich_text",
  "Scope in": "rich_text",
  "Scope out": "rich_text",
  Constraints: "rich_text",
  Status: "select",
  Repo: "url",
  Branch: "rich_text",
  "Work packages": "relation",
  Releases: "relation",
};

const WORK_PACKAGE_SCHEMA = {
  "URET ID": "rich_text",
  Name: "title",
  Spec: "relation",
  Type: "select",
  Worker: "select",
  Status: "select",
  Summary: "rich_text",
  Instructions: "rich_text",
  Outputs: "rich_text",
  "Commit / PR": "url",
  "Start date": "date",
  "End date": "date",
  Evidence: "relation",
};

// Evidence and Releases are only looked up by URET ID, so only what that needs.
const LOOKUP_SCHEMA = { "URET ID": "rich_text", Name: "title" };

// The five URET data sources, by type key. Only Opportunities also checks
// Status options (for /status); the others check property names and types.
const SOURCES = {
  opp: { title: SOURCE_TITLE, prefix: "OPP", schema: REQUIRED_SCHEMA, statusOptions: REQUIRED_STATUSES },
  spec: { title: "URET – Specs", prefix: "SPEC", schema: SPEC_SCHEMA },
  wp: { title: "URET – Work Packages", prefix: "WP", schema: WORK_PACKAGE_SCHEMA },
  evd: { title: "URET – Evidence", prefix: "EVD", schema: LOOKUP_SCHEMA },
  rel: { title: "URET – Releases", prefix: "REL", schema: LOOKUP_SCHEMA },
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

// Required properties and types for a source type; for Opportunities also the
// four required Status options.
function verifySchema(dataSource, type = "opp") {
  const source = SOURCES[type];
  const properties = (dataSource && dataSource.properties) || {};
  const problems = [];
  for (const [name, type] of Object.entries(source.schema)) {
    const prop = properties[name];
    if (!prop) problems.push(`missing:${name}`);
    else if (prop.type !== type) problems.push(`type:${name}`);
  }
  const status = properties.Status;
  if (source.statusOptions && status && status.type === "select") {
    const options = new Set(((status.select && status.select.options) || []).map((o) => o && o.name));
    for (const required of source.statusOptions) {
      if (!options.has(required)) problems.push(`status_option:${required}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

function createNotionReader({ client, rootPageId }) {
  const root = normId(rootPageId);
  // Per source type, in memory only; lost on restart.
  const cache = {}; // type -> { dataSourceId, statusPropertyId, schemaOk }
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

  async function listMatchingChildDatabases(title, signal) {
    const matches = [];
    let cursor;
    for (let page = 0; page < MAX_CHILD_PAGES; page++) {
      const res = await call(
        () => client.blocks.children.list({ block_id: root, start_cursor: cursor, page_size: PAGE_SIZE }),
        signal
      );
      for (const block of (res && res.results) || []) {
        if (block && block.type === "child_database" && !isTrashed(block) && block.child_database &&
            normTitle(block.child_database.title) === normTitle(title)) {
          matches.push(block.id);
        }
      }
      if (!res || !res.has_more) return matches;
      cursor = res.next_cursor;
    }
    // Too many children to be sure there is no second match.
    throw new NotionReadError("notion_source_ambiguous");
  }

  // Strict discovery of one source type under the root page; no workspace
  // search, no guessing. Returns the verified data source and caches its ID.
  async function discover(type, signal) {
    const matches = await listMatchingChildDatabases(SOURCES[type].title, signal);
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
    checkSource(type, dataSource);
    remember(type, dataSource);
    return dataSource;
  }

  function checkSource(type, dataSource) {
    const parent = dataSource && dataSource.database_parent;
    if (!parent || parent.type !== "page_id" || normId(parent.page_id) !== root) throw new NotionReadError("notion_source_invalid");
    if (normTitle(plainTitle(dataSource.title)) !== normTitle(SOURCES[type].title)) throw new NotionReadError("notion_source_invalid");
    if (isTrashed(dataSource)) throw new NotionReadError("notion_source_invalid");
  }

  function remember(type, dataSource) {
    const status = dataSource.properties && dataSource.properties.Status;
    cache[type] = { dataSourceId: dataSource.id, statusPropertyId: status && status.id, schemaOk: verifySchema(dataSource, type).ok };
  }

  // A remembered source that Notion no longer finds is forgotten; the next
  // command discovers again (no second attempt inside this command).
  async function withSource(type, signal, fn) {
    if (!cache[type]) await discover(type, signal);
    const source = cache[type];
    if (!source.schemaOk) throw new NotionReadError("notion_schema_invalid");
    try {
      return await fn(source);
    } catch (err) {
      if (err instanceof NotionReadError && err.label === "notion_not_found") delete cache[type];
      throw err;
    }
  }

  async function countByStatus({ signal } = {}) {
    return withSource("opp", signal, async (source) => {
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

  /**
   * Exact URET ID lookup in one source type ("opp", "spec", "wp", "evd",
   * "rel"). `uretId` must already be canonical, with that type's prefix
   * (OPP-001, SPEC-001, ...).
   */
  async function findByUretId(type, uretId, { signal } = {}) {
    const def = SOURCES[type];
    if (!def) throw new TypeError("unknown source type");
    if (typeof uretId !== "string" || !uretId.startsWith(`${def.prefix}-`)) throw new TypeError("URET ID does not match source type");
    return withSource(type, signal, async (source) => {
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
   * URET IDs of the records of `type` whose relation property `relation`
   * contains the page `pageId` (for example the Opportunity whose "Specs"
   * include a given Spec). Returns { uretIds, more }; trashed records and
   * empty URET IDs are left out.
   */
  async function findLinkedUretIds(type, relation, pageId, { signal } = {}) {
    const def = Object.prototype.hasOwnProperty.call(SOURCES, type) ? SOURCES[type] : null;
    if (!def) throw new TypeError("unknown source type");
    if (def.schema[relation] !== "relation") throw new TypeError("not a relation of this source type");
    if (typeof pageId !== "string" || pageId === "") throw new TypeError("page ID required");
    return withSource(type, signal, async (source) => {
      const res = await call(
        () =>
          client.dataSources.query({
            data_source_id: source.dataSourceId,
            filter: { property: relation, relation: { contains: pageId } },
            page_size: MAX_LINKED,
          }),
        signal
      );
      const uretIds = ((res && res.results) || [])
        .filter((item) => item && item.object === "page" && !isTrashed(item))
        .map((item) => {
          const prop = item.properties && item.properties["URET ID"];
          return prop && prop.type === "rich_text" ? plainTitle(prop.rich_text).trim() : "";
        })
        .filter((id) => id !== "");
      return { uretIds, more: Boolean(res && res.has_more) };
    });
  }

  /**
   * ID of the verified data source for a source type, discovering it if
   * needed; refused if its schema is invalid. For the write adapter only:
   * the ID stays inside the process and is never logged or shown.
   */
  async function getDataSourceId(type, { signal } = {}) {
    if (!Object.prototype.hasOwnProperty.call(SOURCES, type)) throw new TypeError("unknown source type");
    return withSource(type, signal, async (source) => source.dataSourceId);
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
      if (cache.opp) {
        dataSource = await call(() => client.dataSources.retrieve({ data_source_id: cache.opp.dataSourceId }), signal);
        checkSource("opp", dataSource);
        remember("opp", dataSource);
      } else {
        dataSource = await discover("opp", signal);
      }
      out.reachable = "ok";
      out.sourceFound = "ok";
    } catch (err) {
      const label = err instanceof NotionReadError ? err.label : "notion_error";
      if (label === "notion_aborted") throw err;
      out.label = label;
      if (label === "notion_not_found" && cache.opp) delete cache.opp;
      if (successfulReads > readsBefore) {
        out.reachable = "ok";
        out.sourceFound = "not_ok";
      } else {
        out.reachable = "not_ok";
      }
      return out;
    }
    const schema = verifySchema(dataSource, "opp");
    out.schemaValid = schema.ok ? "ok" : "not_ok";
    if (!schema.ok) out.label = "notion_schema_invalid";
    return out;
  }

  return {
    countByStatus,
    findByUretId,
    findLinkedUretIds,
    getDataSourceId,
    health,
    // For tests: whether a source type's data source is currently remembered.
    hasCachedSource: (type = "opp") => Boolean(cache[type]),
  };
}

module.exports = {
  NOTION_VERSION,
  TIMEOUT_MS,
  SOURCE_TITLE,
  REQUIRED_SCHEMA,
  SPEC_SCHEMA,
  WORK_PACKAGE_SCHEMA,
  SOURCES,
  MAX_STATUS_PAGES,
  NotionReadError,
  createNotionClient,
  createNotionReader,
  verifySchema,
  labelFor,
};
