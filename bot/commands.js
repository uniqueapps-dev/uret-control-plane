"use strict";

/**
 * Phase 1 command router. Only /start, /help, /cancel and /health do anything;
 * every other input gets a pointer to /help. Handlers return reply text and
 * never call external services.
 */

const { buildHealthReport } = require("./health");

const COMMAND_LIST = [
  "/start - introduction",
  "/help - list commands",
  "/cancel - cancel the current interaction",
  "/health - local health check",
].join("\n");

const START_TEXT = [
  "URET Control Bot MVP v0.1",
  "",
  "A controlled, phone-first interface for URET.",
  "",
  "Available commands (Phase 1):",
  COMMAND_LIST,
  "",
  "This phase does not read or write any URET records.",
].join("\n");

const HELP_TEXT = ["Commands:", COMMAND_LIST].join("\n");

const CANCEL_TEXT = ["Cancelled the current interaction.", "No URET record was created or changed."].join("\n");

const UNKNOWN_TEXT = "Unknown command. Use /help to see the available commands.";

// "/cmd", "/cmd args" or "/cmd@BotName" -> "cmd"; anything else -> null.
function parseCommand(text) {
  if (typeof text !== "string") return null;
  const match = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s|$)/.exec(text.trim());
  return match ? match[1].toLowerCase() : null;
}

function createRouter({ sessions, configStatus, logDir }) {
  const handlers = {
    start: () => START_TEXT,
    help: () => HELP_TEXT,
    cancel: ({ chatId }) => {
      sessions.clear(chatId);
      return CANCEL_TEXT;
    },
    health: () =>
      buildHealthReport({ configStatus, logDir, sessions, commandCount: Object.keys(handlers).length }),
  };

  // Returns { command, reply }. `command` is a known command name or "unknown",
  // so user-supplied text never reaches the log.
  function route({ text, chatId }) {
    const name = parseCommand(text);
    if (name && Object.prototype.hasOwnProperty.call(handlers, name)) {
      return { command: name, reply: handlers[name]({ chatId }) };
    }
    return { command: "unknown", reply: UNKNOWN_TEXT };
  }

  return { route, commandNames: () => Object.keys(handlers) };
}

module.exports = { createRouter, parseCommand, START_TEXT, HELP_TEXT, CANCEL_TEXT, UNKNOWN_TEXT };
