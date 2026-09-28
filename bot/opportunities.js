"use strict";

/**
 * Pure formatting for the read-only commands: URET ID normalisation,
 * deterministic truncation, value formatting, and the fixed /status and
 * /show reply texts (Opportunities, Specs and Work Packages). No network access, no I/O,
 * no SDK.
 */

const REQUIRED_STATUSES = ["Idea", "Active", "Parked", "Done"];
const MAX_FIELD_LENGTH = 300;
const MIN_WORD_CUT = 200;
const ELLIPSIS = "…";
const EMPTY = "—";

const SHOW_USAGE = ["Usage: /show <URET-ID>", "Examples: /show OPP-001, /show SPEC-001, /show WP-001"].join("\n");
const INVALID_ID_TEXT = "Invalid URET ID. Examples: /show OPP-001, /show SPEC-001, /show WP-001";

// URET ID prefix -> source type key, for the prefixes /show accepts.
const SHOW_TYPES = { OPP: "opp", SPEC: "spec", WP: "wp" };

const STATUS_INTEGRITY_TEXT = ["Notion: Data integrity problem", "Unexpected Opportunity status values found."].join("\n");
const STATUS_INCOMPLETE_TEXT = [
  "Notion: Connected",
  "Counts: Incomplete",
  "At least 1,000 records were scanned.",
  "Use Notion directly for the full dataset.",
].join("\n");

/**
 * "opp-1", "OPP-001" -> "OPP-001"; "OPP-1000" -> "OPP-1000"; anything else ->
 * null. `prefixes` lists the accepted prefixes (default: OPP only).
 */
function normalizeUretId(input, prefixes = ["OPP"]) {
  if (typeof input !== "string") return null;
  const match = /^([a-z]+)-([0-9]+)$/i.exec(input.trim());
  if (!match) return null;
  const prefix = match[1].toUpperCase();
  if (!prefixes.includes(prefix)) return null;
  const digits = match[2].replace(/^0+/, "");
  if (digits === "") return null; // OPP-0, OPP-000
  return `${prefix}-${digits.padStart(3, "0")}`;
}

// A /show argument -> { type, uretId } for OPP, SPEC or WP, or null.
function parseShowId(input) {
  const uretId = normalizeUretId(input, Object.keys(SHOW_TYPES));
  return uretId ? { type: SHOW_TYPES[uretId.split("-")[0]], uretId } : null;
}

/**
 * Deterministic truncation to at most 300 characters (code points, so emoji
 * are never split). Longer text is cut at the last whitespace between
 * character 200 and 299 and gets "…"; with no such whitespace it is cut at
 * 299 characters plus "…".
 */
function truncate(text) {
  const chars = Array.from(String(text));
  if (chars.length <= MAX_FIELD_LENGTH) return chars.join("");
  let cut = -1;
  for (let i = MAX_FIELD_LENGTH - 1; i >= MIN_WORD_CUT; i--) {
    if (/\s/.test(chars[i])) {
      cut = i;
      break;
    }
  }
  const kept = cut === -1 ? chars.slice(0, MAX_FIELD_LENGTH - 1).join("") : chars.slice(0, cut).join("").trimEnd();
  return kept + ELLIPSIS;
}

// Concatenated plain text of a Notion rich-text (or title) array.
function richTextToPlain(items) {
  if (!Array.isArray(items)) return "";
  return items
    .map((item) => (item && typeof item.plain_text === "string" ? item.plain_text : item && item.text && item.text.content) || "")
    .join("");
}

// Empty or whitespace-only -> "—"; otherwise trimmed and truncated.
function formatText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" ? EMPTY : truncate(text);
}

function formatMultiSelect(options) {
  if (!Array.isArray(options)) return EMPTY;
  return formatText(options.map((o) => (o && o.name) || "").filter(Boolean).join(", "));
}

// ISO timestamp -> "YYYY-MM-DD HH:MM UTC"; missing or invalid -> "—".
function formatDate(value) {
  if (typeof value !== "string" || value === "") return EMPTY;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return EMPTY;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

// Display text for one Notion page property value, by its type.
function formatProperty(prop) {
  if (!prop || typeof prop !== "object") return EMPTY;
  switch (prop.type) {
    case "title":
      return formatText(richTextToPlain(prop.title));
    case "rich_text":
      return formatText(richTextToPlain(prop.rich_text));
    case "select":
      return formatText(prop.select && prop.select.name);
    case "multi_select":
      return formatMultiSelect(prop.multi_select);
    case "created_time":
      return formatDate(prop.created_time);
    case "last_edited_time":
      return formatDate(prop.last_edited_time);
    default:
      return EMPTY;
  }
}

// Uses the URL Notion returned for the page; never builds one.
function linkLine(page) {
  const url = page && typeof page.url === "string" ? page.url.trim() : "";
  return `Notion link: ${url === "" ? "unavailable" : url}`;
}

// Properties shown by /show, in order (label = Notion property name).
const SHOW_FIELDS = [
  "URET ID",
  "Name",
  "Status",
  "Asset type",
  "Project / Asset",
  "Problem summary",
  "Target users",
  "Success metrics",
  "Next action",
  "Created",
  "Last updated",
];

function buildShowReply(page) {
  const properties = (page && page.properties) || {};
  const lines = [];
  if (page && (page.in_trash === true || page.archived === true)) lines.push("Archived/trashed record");
  for (const field of SHOW_FIELDS) lines.push(`${field}: ${formatProperty(properties[field])}`);
  lines.push(linkLine(page));
  return lines.join("\n");
}

// Linked records by URET ID: "—", "OPP-002" or "OPP-002, OPP-003, …".
function linkedText(linked) {
  const ids = (linked && linked.uretIds) || [];
  return ids.length === 0 ? EMPTY : formatText(ids.join(", ") + (linked.more ? ", " + ELLIPSIS : ""));
}

// Header, fields and link for a Spec or Work Package; `fields` = [label, value].
function buildRecordReply(uretId, page, fields) {
  const properties = (page && page.properties) || {};
  const lines = [];
  if (page && (page.in_trash === true || page.archived === true)) lines.push("Archived/trashed record");
  lines.push(`${uretId} — ${formatProperty(properties.Name)}`, "");
  for (const [label, value] of fields) lines.push(`${label}: ${value}`);
  lines.push("", linkLine(page));
  return lines.join("\n");
}

/**
 * /show for a Spec. `linked` = { uretIds, more }: the Opportunities whose
 * "Specs" relation includes this Spec.
 */
function buildSpecShowReply(uretId, page, linked) {
  const p = (page && page.properties) || {};
  return buildRecordReply(uretId, page, [
    ["Version", formatProperty(p.Version)],
    ["Opportunity", linkedText(linked)],
    ["Status", formatProperty(p.Status)],
    ["Summary", formatProperty(p.Summary)],
    ["Scope in", formatProperty(p["Scope in"])],
    ["Scope out", formatProperty(p["Scope out"])],
    ["Constraints", formatProperty(p.Constraints)],
  ]);
}

/**
 * /show for a Work Package. `linked` = { uretIds, more }: the Specs whose
 * "Work packages" relation includes this Work Package.
 */
function buildWorkShowReply(uretId, page, linked) {
  const p = (page && page.properties) || {};
  return buildRecordReply(uretId, page, [
    ["Type", formatProperty(p.Type)],
    ["Worker", formatProperty(p.Worker)],
    ["Spec", linkedText(linked)],
    ["Status", formatProperty(p.Status)],
    ["Summary", formatProperty(p.Summary)],
    ["Instructions", formatProperty(p.Instructions)],
    ["Outputs", formatProperty(p.Outputs)],
  ]);
}

const notFoundText = (id) => `Not found: ${id}`;
const duplicateText = (id) => ["Notion: Data integrity problem", `Duplicate URET ID: ${id}`].join("\n");

/**
 * /status reply from a count result:
 *   { outcome: "counts", total, counts: { Idea, Active, Parked, Done } }
 *   { outcome: "data_integrity" }  -> fixed integrity text, no counts
 *   { outcome: "incomplete" }      -> fixed incomplete text, no counts
 */
function buildStatusReply(result) {
  if (result && result.outcome === "data_integrity") return STATUS_INTEGRITY_TEXT;
  if (result && result.outcome === "incomplete") return STATUS_INCOMPLETE_TEXT;
  const counts = (result && result.counts) || {};
  return [
    "Notion: Connected",
    `Total: ${result.total}`,
    ...REQUIRED_STATUSES.map((status) => `${status}: ${counts[status] || 0}`),
  ].join("\n");
}

module.exports = {
  REQUIRED_STATUSES,
  SHOW_USAGE,
  INVALID_ID_TEXT,
  STATUS_INTEGRITY_TEXT,
  STATUS_INCOMPLETE_TEXT,
  SHOW_TYPES,
  normalizeUretId,
  parseShowId,
  buildSpecShowReply,
  buildWorkShowReply,
  truncate,
  richTextToPlain,
  formatText,
  formatMultiSelect,
  formatDate,
  formatProperty,
  linkLine,
  buildShowReply,
  buildStatusReply,
  notFoundText,
  duplicateText,
};
