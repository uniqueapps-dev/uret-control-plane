"use strict";

/**
 * /update_status <URET-ID> <status>: changes the Status of one Opportunity,
 * Spec or Work Package. No guided session.
 *
 * In order: parse and normalise the ID (OPP, SPEC or WP); match the status
 * against the type's vocabulary (any case, stored in its canonical form); look
 * the record up (exactly one, not trashed); reply without writing if it already
 * has that status; otherwise ask the write adapter to change Status only.
 * Lookup failures are labelled read errors and propagate to the router; write
 * failures become the fixed write texts here.
 */

const { normalizeUretId } = require("./opportunities");
const { CREATE_ERROR_TEXT, READ_LABELS } = require("./captureFlows");

// The Status values each type may be set to. Must equal the write adapter's
// STATUS_VOCABULARY (a test checks this; only index.js may load that module).
const STATUS_VOCABULARY = {
  opp: ["Idea", "Active", "Parked", "Done"],
  spec: ["Draft", "Approved", "Superseded"],
  wp: ["Draft", "In progress", "Done", "Blocked"],
};
const TYPE_OF_PREFIX = { OPP: "opp", SPEC: "spec", WP: "wp" };
const TYPE_LABEL = { opp: "Opportunity", spec: "Spec", wp: "Work package" };

const USAGE_TEXT = ["Usage: /update_status <URET-ID> <status>", "Example: /update_status OPP-002 Active"].join("\n");
const INVALID_ID_TEXT = "Invalid URET ID. Example: /update_status OPP-002 Active";
const invalidStatusText = (type) => `Invalid status. Use one of: ${STATUS_VOCABULARY[type].join(", ")}.`;
const notFoundText = (type, id) => `${TYPE_LABEL[type]} ${id} not found.`;
const duplicateText = (id) => `Data integrity problem: multiple records found for ${id}.`;
const trashedText = (type, id) => `${TYPE_LABEL[type]} ${id} is in the trash.`;
const alreadyText = (id, status) => `${id} is already ${status}.`;
const updatedText = (id, status) => `Updated ${id} status to ${status}.`;
const unconfirmedText = (id) => `Notion did not confirm the update. Check with /show ${id}.`;

/**
 * Splits "<id> <status words>" and validates both, without any Notion call.
 * Returns { type, uretId, status } or { reply }.
 */
function parseArgs(args) {
  const match = /^(\S+)(?:\s+([\s\S]+))?$/.exec(typeof args === "string" ? args.trim() : "");
  if (!match) return { reply: USAGE_TEXT };
  const uretId = normalizeUretId(match[1], Object.keys(TYPE_OF_PREFIX));
  if (!uretId) return { reply: INVALID_ID_TEXT };
  const type = TYPE_OF_PREFIX[uretId.split("-")[0]];
  if (!match[2]) return { reply: USAGE_TEXT };
  const wanted = match[2].trim().replace(/\s+/g, " ").toLowerCase();
  const status = STATUS_VOCABULARY[type].find((s) => s.toLowerCase() === wanted);
  if (!status) return { reply: invalidStatusText(type) };
  return { type, uretId, status };
}

const currentStatus = (page) => {
  const prop = page && page.properties && page.properties.Status;
  return prop && prop.type === "select" && prop.select ? prop.select.name : null;
};

/**
 * reader: read adapter (findByUretId); writer: write adapter (updateStatus).
 * run(args, signal) resolves to { reply, label? }. Read errors from the lookup
 * propagate (labelled); write errors are turned into fixed texts; aborts and
 * unlabelled errors are rethrown.
 */
function createStatusUpdater({ reader, writer }) {
  async function run(args, signal) {
    const parsed = parseArgs(args);
    if (parsed.reply) return parsed;
    const { type, uretId, status } = parsed;

    const found = await reader.findByUretId(type, uretId, { signal });
    if (found.result === "not_found") return { reply: notFoundText(type, uretId) };
    if (found.result === "duplicate") return { reply: duplicateText(uretId), label: "notion_duplicate_id" };
    if (found.trashed) return { reply: trashedText(type, uretId) };
    if (currentStatus(found.page) === status) return { reply: alreadyText(uretId, status) };

    try {
      await writer.updateStatus(type, found.page, status, { signal });
    } catch (err) {
      const label = err && typeof err.label === "string" ? err.label : null;
      if (!label || label === "notion_aborted") throw err;
      if (err.uncertain === true) return { reply: unconfirmedText(uretId), label: "notion_update_unconfirmed" };
      const mapped = CREATE_ERROR_TEXT[label] ? label : READ_LABELS[label] || "notion_unavailable";
      return { reply: CREATE_ERROR_TEXT[mapped], label: mapped };
    }
    return { reply: updatedText(uretId, status) };
  }

  return { run };
}

module.exports = {
  STATUS_VOCABULARY,
  USAGE_TEXT,
  INVALID_ID_TEXT,
  invalidStatusText,
  parseArgs,
  createStatusUpdater,
};
