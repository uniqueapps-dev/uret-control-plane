"use strict";

/**
 * Guided creation flows. Step 6: /new_opportunity.
 *
 * A flow asks its questions one at a time (state in the in-memory capture
 * store), validates each answer, and after the last answer:
 *   1. reserves the next URET ID (idCounter: lock, Notion existence check,
 *      atomic counter write; never rolled back);
 *   2. creates the record through the write adapter (schema re-checked,
 *      one pages.create, Status fixed by the adapter);
 *   3. replies with the created record's summary.
 * The session is deleted once creation is attempted, whatever the outcome.
 * Answers are never logged; failures reply with fixed texts only.
 */

const { formatText } = require("./opportunities");

const MAX_TITLE = 200;
const MAX_ANSWER = 2000;
const SKIP = "-";

const ASSET_TYPES = ["App/PWA", "Ebook", "Video series", "Landing page / site", "Template"];

const ACTIVE_SESSION_TEXT = "You already have an active session. Finish it or use /cancel.";
const TEXT_ONLY_TEXT = "Please answer with text.";

// Fixed replies for a failed creation, by label.
const CREATE_ERROR_TEXT = {
  notion_write_failed: "Notion write failed. Please try again.",
  notion_unavailable: "Notion is unavailable. Please try again later.",
  notion_unauthorized: "Notion access problem. Check configuration.",
  notion_schema_invalid: "Notion schema problem. Cannot create record.",
  id_counter_failed: "ID allocation failed. Please try again.",
};
const unconfirmedText = (uretId) => `Notion did not confirm the write. Check Notion for ${uretId} before trying again.`;

// Read adapter labels (ID check, data source lookup) -> creation label.
const READ_LABELS = {
  notion_unauthorized: "notion_unauthorized",
  notion_forbidden: "notion_unauthorized",
  notion_not_found: "notion_unauthorized",
  notion_source_not_found: "notion_unauthorized",
  notion_source_ambiguous: "notion_unauthorized",
  notion_source_invalid: "notion_unauthorized",
  notion_schema_invalid: "notion_schema_invalid",
  notion_bad_request: "notion_write_failed",
};

// --- Answer validation: each returns { value } or { error } ---------------------

function title(text) {
  const value = text.trim();
  if (value === "") return { error: "The title cannot be empty." };
  if (/[\r\n]/.test(value)) return { error: "The title must be a single line." };
  if (Array.from(value).length > MAX_TITLE) return { error: `The title is too long (max ${MAX_TITLE} characters).` };
  return { value };
}

function choice(options, what) {
  return (text) => {
    const input = text.trim();
    const byNumber = /^[0-9]+$/.test(input) ? options[Number(input) - 1] : undefined;
    const byName = options.find((o) => o.toLowerCase() === input.toLowerCase());
    const value = byNumber || byName;
    if (!value) return { error: `Invalid ${what}. Reply with a number from 1 to ${options.length}.` };
    return { value };
  };
}

function freeText(text) {
  const value = text.trim();
  if (value === "") return { error: `Please answer, or send ${SKIP} to leave it empty.` };
  if (value === SKIP) return { value: "" };
  if (Array.from(value).length > MAX_ANSWER) return { error: `Too long (max ${MAX_ANSWER} characters).` };
  return { value };
}

const numbered = (options) => options.map((o, i) => `${i + 1}. ${o}`).join("\n");
const free = (label) => ({ prompt: `${label}? (send ${SKIP} to leave empty)`, validate: freeText, label });

// Questions in capture order; keys match the capture store's FIELDS.
const FLOWS = {
  new_opportunity: {
    type: "opp",
    name: "New Opportunity",
    questions: [
      { key: "title", label: "Title", prompt: `Title? (max ${MAX_TITLE} characters)`, validate: title },
      { key: "assetType", label: "Asset type", prompt: `Asset type? Reply with a number:\n${numbered(ASSET_TYPES)}`, validate: choice(ASSET_TYPES, "asset type") },
      { key: "project", ...free("Project / Asset") },
      { key: "problemSummary", ...free("Problem summary") },
      { key: "targetUsers", ...free("Target users") },
      { key: "successMetrics", ...free("Success metrics") },
      { key: "nextAction", ...free("Next action") },
    ],
    confirmation: (uretId, a) =>
      [
        `Created ${uretId}`,
        "",
        `Title: ${formatText(a.title)}`,
        `Asset type: ${formatText(a.assetType)}`,
        `Project / Asset: ${formatText(a.project)}`,
        "Status: Idea",
        `Next action: ${formatText(a.nextAction)}`,
        "",
        "Stored in URET – Opportunities.",
      ].join("\n"),
  },
};

function promptFor(flow, step) {
  return `${step + 1}/${flow.questions.length} ${flow.questions[step].prompt}`;
}

/**
 * capture: capture store; reader: read adapter (or null when Notion is not
 * configured); writer: write adapter; reserveId(type, { signal }): ID
 * reservation. Returns { start, answer }; each resolves to { reply, label? }
 * and rethrows only aborts and unexpected errors.
 */
function createCaptureFlows({ capture, reader, writer, reserveId }) {
  const ready = Boolean(reader && writer && reserveId);

  function start(userId, command) {
    const flow = FLOWS[command];
    if (capture.getActiveSession(userId)) return { reply: ACTIVE_SESSION_TEXT };
    capture.createSession(userId, command);
    const intro = `${flow.name}: ${flow.questions.length} questions. Send /cancel to stop.`;
    return { reply: `${intro}\n\n${promptFor(flow, 0)}` };
  }

  // Returns null when the user has no active session.
  async function answer(userId, text, signal) {
    const session = capture.getActiveSession(userId);
    if (!session) return null;
    const flow = FLOWS[session.command];
    const question = flow.questions[session.step];
    if (typeof text !== "string") return { reply: `${TEXT_ONLY_TEXT}\n\n${promptFor(flow, session.step)}` };
    const checked = question.validate(text);
    if (checked.error) return { reply: `${checked.error}\n\n${promptFor(flow, session.step)}` };
    const updated = capture.updateAnswer(session.id, session.step, checked.value);
    if (!updated.complete) return { reply: promptFor(flow, updated.step) };
    capture.deleteSession(updated.id);
    return create(flow, updated.answers, signal);
  }

  async function create(flow, answers, signal) {
    if (!ready) return { reply: CREATE_ERROR_TEXT.notion_unauthorized, label: "notion_not_configured" };
    let uretId;
    try {
      uretId = await reserveId(flow.type, { signal });
    } catch (err) {
      return failure(err, null);
    }
    try {
      await writer.createRecord(flow.type, { uretId, ...answers }, { signal });
    } catch (err) {
      return failure(err, uretId);
    }
    return { reply: flow.confirmation(uretId, answers) };
  }

  function failure(err, uretId) {
    const label = err && typeof err.label === "string" ? err.label : null;
    if (!label || label === "notion_aborted") throw err;
    if (err.uncertain === true && uretId) return { reply: unconfirmedText(uretId), label: "notion_write_unconfirmed" };
    const mapped = CREATE_ERROR_TEXT[label] ? label : READ_LABELS[label] || "notion_unavailable";
    return { reply: CREATE_ERROR_TEXT[mapped], label: mapped };
  }

  return { start, answer, ready };
}

module.exports = {
  FLOWS,
  ASSET_TYPES,
  MAX_TITLE,
  MAX_ANSWER,
  ACTIVE_SESSION_TEXT,
  TEXT_ONLY_TEXT,
  CREATE_ERROR_TEXT,
  unconfirmedText,
  createCaptureFlows,
};
