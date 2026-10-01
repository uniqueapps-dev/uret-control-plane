"use strict";

/**
 * Command router. /start, /help, /cancel, /status, /show, /health,
 * /new_opportunity, /new_spec, /new_work, /new_evidence and /update_status
 * do something. Plain text answers an active capture
 * session (see captureFlows.js); any other input gets a pointer to /help.
 *
 * Handlers are asynchronous and always awaited. /status, /show and /health
 * read Notion only through the injected read-only adapter (`notion`), which is
 * null when Notion is not configured. Adapter failures arrive as errors with a
 * fixed "notion_*" label and are turned into fixed reply texts here; nothing
 * from the original error ever reaches a reply.
 */

const { buildHealthReport } = require("./health");
const opp = require("./opportunities");
const { createCaptureStore } = require("./captureSession");
const { createCaptureFlows } = require("./captureFlows");
const { createStatusUpdater } = require("./statusUpdate");

const COMMAND_LIST = [
  "/start - introduction",
  "/help - list commands",
  "/cancel - cancel the current interaction",
  "/status - Opportunity counts and active work (read-only)",
  "/show <URET-ID> - one Opportunity, Spec, Work Package or Evidence (read-only)",
  "/health - health check",
  "/new_opportunity - create an Opportunity (guided)",
  "/new_spec <OPP-ID> - create a Spec for an Opportunity (guided)",
  "/new_work <SPEC-ID> - create a Work Package for a Spec (guided)",
  "/new_evidence <WP-ID> - record Evidence for a Work Package (guided)",
  "/update_status <URET-ID> <status> - change the Status of an Opportunity, Spec or Work Package",
].join("\n");

const START_TEXT = [
  "URET Control Bot MVP v0.1",
  "",
  "A controlled, phone-first interface for URET.",
  "",
  "Available commands:",
  COMMAND_LIST,
  "",
  "It can create new Opportunities, Specs, Work Packages and Evidence through guided questions.",
  "It can change the Status of existing Opportunities, Specs and Work Packages.",
  "It never deletes records or changes any other field.",
].join("\n");

const HELP_TEXT = ["Commands:", COMMAND_LIST].join("\n");


const UNKNOWN_TEXT = "Unknown command. Use /help to see the available commands.";

const NOT_CONFIGURED_TEXT = "Notion configuration: NOT OK";

// Fixed reply text for each adapter error label.
const NOTION_ERROR_TEXT = {
  notion_not_configured: NOT_CONFIGURED_TEXT,
  notion_timeout: "Notion: Unavailable",
  notion_unavailable: "Notion: Unavailable",
  notion_rate_limited: "Notion: Unavailable",
  notion_conflict: "Notion: Unavailable",
  notion_error: "Notion: Unavailable",
  notion_unauthorized: "Notion: Access problem",
  notion_forbidden: "Notion: Access problem",
  notion_not_found: "Notion: Access problem",
  notion_bad_request: "Notion: Request problem",
  notion_source_not_found: "Notion: Configuration or access problem",
  notion_source_ambiguous: "Notion: Configuration or access problem",
  notion_source_invalid: "Notion: Configuration or access problem",
  notion_schema_invalid: "Notion: Schema problem",
  notion_data_integrity: opp.STATUS_INTEGRITY_TEXT,
};

// Adapter errors carry a "notion_*" label; anything else is a bug and is rethrown.
function notionLabel(err) {
  return err && typeof err.label === "string" && err.label.startsWith("notion_") ? err.label : null;
}

// "/cmd", "/cmd args" or "/cmd@BotName args" -> { name, args }; anything else -> null.
function parseCommand(text) {
  if (typeof text !== "string") return null;
  const match = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? { name: match[1].toLowerCase(), args: (match[2] || "").trim() } : null;
}

/**
 * capture: in-memory capture store (a fresh one if omitted). writer and
 * reserveId are needed for creation; without them (or without `notion`)
 * the creation commands reply that Notion is not configured.
 */
function createRouter({ sessions, configStatus, logDir, notion = null, writer = null, reserveId = null, capture = createCaptureStore() }) {
  const flows = createCaptureFlows({ capture, reader: notion, writer, reserveId });
  const statusUpdates = createStatusUpdater({ reader: notion, writer });

  // Runs an adapter read and turns a labelled failure into its fixed reply.
  // Aborts (shutdown) and unlabelled errors propagate to the caller.
  async function read(fn) {
    try {
      return { value: await fn() };
    } catch (err) {
      const label = notionLabel(err);
      if (!label || label === "notion_aborted") throw err;
      return { reply: NOTION_ERROR_TEXT[label] || "Notion: Unavailable", label };
    }
  }

  // Active Work Packages with each one's Spec (by URET ID) and evidence count.
  async function activeWork(signal) {
    const { items, more } = await notion.listActiveWork({ signal });
    const out = [];
    for (const item of items) {
      const spec = await notion.findLinkedUretIds("spec", "Work packages", item.pageId, { signal });
      const evidence = await notion.countEvidenceForWP(item.pageId, { signal });
      out.push({ uretId: item.uretId, title: item.title, spec, evidence });
    }
    return { items: out, more };
  }

  async function startFlow(command, chatId, args, signal) {
    if (!flows.ready) return { reply: NOT_CONFIGURED_TEXT, label: "notion_not_configured" };
    const result = await read(() => flows.start(chatId, command, args, signal));
    return result.reply ? result : result.value;
  }

  const handlers = {
    start: async () => ({ reply: START_TEXT }),
    help: async () => ({ reply: HELP_TEXT }),
    cancel: async ({ chatId }) => {
      sessions.clear(chatId);
      return { reply: capture.cancel(chatId) };
    },
    status: async ({ signal }) => {
      if (!notion) return { reply: NOT_CONFIGURED_TEXT, label: "notion_not_configured" };
      const result = await read(() => notion.countByStatus({ signal }));
      if (result.reply) return result;
      const countLabel = result.value.outcome === "data_integrity" ? "notion_data_integrity" : undefined;
      // Active work follows whatever the counts showed; if it cannot be read,
      // the counts still stand and the section says so.
      const active = await read(() => activeWork(signal));
      const section = active.reply ? opp.ACTIVE_WORK_UNAVAILABLE : opp.buildActiveWorkSection(active.value);
      return { reply: `${opp.buildStatusReply(result.value)}\n\n${section}`, label: countLabel || active.label };
    },
    show: async ({ args, signal }) => {
      if (!args) return { reply: opp.SHOW_USAGE };
      const parsed = opp.parseShowId(args);
      if (!parsed) return { reply: opp.INVALID_ID_TEXT };
      const { type, uretId } = parsed;
      if (!notion) return { reply: NOT_CONFIGURED_TEXT, label: "notion_not_configured" };
      const result = await read(() => notion.findByUretId(type, uretId, { signal }));
      if (result.reply) return result;
      const found = result.value;
      if (found.result === "not_found") return { reply: opp.notFoundText(uretId) };
      if (found.result === "duplicate") return { reply: opp.duplicateText(uretId), label: "notion_duplicate_id" };
      if (type === "opp") return { reply: opp.buildShowReply(found.page) };
      // A Spec shows its Opportunity, a Work Package its Spec, Evidence its Work
      // Package, by URET ID, found through the reverse side of the two-way
      // relation. Specs and Work Packages also show their evidence count.
      const [parentType, relation, build] = {
        spec: ["opp", "Specs", opp.buildSpecShowReply],
        wp: ["spec", "Work packages", opp.buildWorkShowReply],
        evd: ["wp", "Evidence", opp.buildEvidenceShowReply],
      }[type];
      const linked = await read(() => notion.findLinkedUretIds(parentType, relation, found.page.id, { signal }));
      if (linked.reply) return linked;
      if (type === "evd") return { reply: build(uretId, found.page, linked.value) };
      const evidence = await read(() =>
        type === "spec" ? notion.countEvidenceForSpec(found.page.id, { signal }) : notion.countEvidenceForWP(found.page.id, { signal })
      );
      if (evidence.reply) return evidence;
      return { reply: build(uretId, found.page, linked.value, evidence.value) };
    },
    health: async ({ signal }) => {
      const { text, label } = await buildHealthReport({
        configStatus,
        logDir,
        sessions,
        commandCount: Object.keys(handlers).length,
        notion,
        signal,
      });
      return { reply: text, label: label || undefined };
    },
    new_opportunity: async ({ chatId, signal }) => startFlow("new_opportunity", chatId, "", signal),
    new_spec: async ({ chatId, args, signal }) => startFlow("new_spec", chatId, args, signal),
    new_work: async ({ chatId, args, signal }) => startFlow("new_work", chatId, args, signal),
    new_evidence: async ({ chatId, args, signal }) => startFlow("new_evidence", chatId, args, signal),
    update_status: async ({ args, signal }) => {
      if (!notion || !writer) return { reply: NOT_CONFIGURED_TEXT, label: "notion_not_configured" };
      const result = await read(() => statusUpdates.run(args, signal));
      return result.reply ? result : result.value;
    },
  };

  /**
   * Returns { command, reply, label? }. `command` is a known command name or
   * "unknown", so user-supplied text never reaches the log; `label` is a fixed
   * notion_* label when Notion could not answer normally.
   */
  async function route({ text, chatId, signal }) {
    capture.cleanupExpiredSessions();
    const parsed = parseCommand(text);
    if (parsed && Object.prototype.hasOwnProperty.call(handlers, parsed.name)) {
      const out = await handlers[parsed.name]({ chatId, args: parsed.args, signal });
      return { command: parsed.name, reply: out.reply, label: out.label };
    }
    if (!parsed) {
      // Plain text (or no text): an answer for an active capture session.
      const session = capture.getActiveSession(chatId);
      if (session) {
        const out = await flows.answer(chatId, text, signal);
        return { command: session.command, reply: out.reply, label: out.label };
      }
      const expired = capture.takeExpiredNotice(chatId);
      if (expired) return { command: "unknown", reply: expired };
    }
    return { command: "unknown", reply: UNKNOWN_TEXT };
  }

  // Known command name for logging, or "unknown"; never user-supplied text.
  function commandOf(text) {
    const parsed = parseCommand(text);
    return parsed && Object.prototype.hasOwnProperty.call(handlers, parsed.name) ? parsed.name : "unknown";
  }

  return { route, commandOf, commandNames: () => Object.keys(handlers) };
}

module.exports = {
  createRouter,
  parseCommand,
  START_TEXT,
  HELP_TEXT,
  UNKNOWN_TEXT,
  NOT_CONFIGURED_TEXT,
  NOTION_ERROR_TEXT,
};
