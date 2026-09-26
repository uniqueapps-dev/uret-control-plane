"use strict";

/**
 * Command router. /start, /help, /cancel, /status, /show and /health do
 * something; every other input gets a pointer to /help.
 *
 * Handlers are asynchronous and always awaited. /status, /show and /health
 * read Notion only through the injected read-only adapter (`notion`), which is
 * null when Notion is not configured. Adapter failures arrive as errors with a
 * fixed "notion_*" label and are turned into fixed reply texts here; nothing
 * from the original error ever reaches a reply.
 */

const { buildHealthReport } = require("./health");
const opp = require("./opportunities");

const COMMAND_LIST = [
  "/start - introduction",
  "/help - list commands",
  "/cancel - cancel the current interaction",
  "/status - Opportunity counts (read-only)",
  "/show <URET-ID> - one Opportunity (read-only)",
  "/health - health check",
].join("\n");

const START_TEXT = [
  "URET Control Bot MVP v0.1",
  "",
  "A controlled, phone-first interface for URET.",
  "",
  "Available commands:",
  COMMAND_LIST,
  "",
  "Read-only: this bot never creates or changes URET records.",
].join("\n");

const HELP_TEXT = ["Commands:", COMMAND_LIST].join("\n");

const CANCEL_TEXT = ["Cancelled the current interaction.", "No URET record was created or changed."].join("\n");

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

function createRouter({ sessions, configStatus, logDir, notion = null }) {
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

  const handlers = {
    start: async () => ({ reply: START_TEXT }),
    help: async () => ({ reply: HELP_TEXT }),
    cancel: async ({ chatId }) => {
      sessions.clear(chatId);
      return { reply: CANCEL_TEXT };
    },
    status: async ({ signal }) => {
      if (!notion) return { reply: NOT_CONFIGURED_TEXT, label: "notion_not_configured" };
      const result = await read(() => notion.countByStatus({ signal }));
      if (result.reply) return result;
      const label = result.value.outcome === "data_integrity" ? "notion_data_integrity" : undefined;
      return { reply: opp.buildStatusReply(result.value), label };
    },
    show: async ({ args, signal }) => {
      if (!args) return { reply: opp.SHOW_USAGE };
      const uretId = opp.normalizeUretId(args);
      if (!uretId) return { reply: opp.INVALID_ID_TEXT };
      if (!notion) return { reply: NOT_CONFIGURED_TEXT, label: "notion_not_configured" };
      const result = await read(() => notion.findByUretId(uretId, { signal }));
      if (result.reply) return result;
      const found = result.value;
      if (found.result === "not_found") return { reply: opp.notFoundText(uretId) };
      if (found.result === "duplicate") return { reply: opp.duplicateText(uretId), label: "notion_duplicate_id" };
      return { reply: opp.buildShowReply(found.page) };
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
  };

  /**
   * Returns { command, reply, label? }. `command` is a known command name or
   * "unknown", so user-supplied text never reaches the log; `label` is a fixed
   * notion_* label when Notion could not answer normally.
   */
  async function route({ text, chatId, signal }) {
    const parsed = parseCommand(text);
    if (parsed && Object.prototype.hasOwnProperty.call(handlers, parsed.name)) {
      const out = await handlers[parsed.name]({ chatId, args: parsed.args, signal });
      return { command: parsed.name, reply: out.reply, label: out.label };
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
  CANCEL_TEXT,
  UNKNOWN_TEXT,
  NOT_CONFIGURED_TEXT,
  NOTION_ERROR_TEXT,
};
