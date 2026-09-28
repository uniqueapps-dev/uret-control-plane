#!/usr/bin/env node
"use strict";

/**
 * URET Control Bot MVP v0.1 — entry point.
 *
 * Telegram long polling -> authorization -> command router. When Notion is
 * configured, /status, /show and /health read URET Opportunities through the
 * read-only adapter, and /new_opportunity creates new records through the
 * write adapter (pages.create only). Existing records are never changed.
 *
 * Usage (Termux):
 *   set -a; . ./.env; set +a; npm run start:bot
 */

const path = require("path");
const { loadConfig, describeStatus, describeNotionStatus, secretValues } = require("./config");
const { createLogger } = require("./logger");
const { createSessionStore } = require("./session");
const { createTelegramClient } = require("./telegram");
const { isAuthorized } = require("./auth");
const { createRouter } = require("./commands");

const ROOT = path.join(__dirname, "..");
const LOG_DIR = path.join(ROOT, "logs");
const POLL_TIMEOUT_S = 30;
const RETRY_DELAY_MS = 5000;
// Telegram errors that retrying cannot fix: 401/404 mean the token is wrong,
// 409 means another process is already receiving updates for this token.
const FATAL_ERROR_CODES = new Set([401, 404, 409]);
const CONFLICT_ERROR_CODE = 409;

function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

const errorClassOf = (err) => (err && err.errorClass ? err.errorClass : "internal_error");
const errorLabelOf = (err) => (err && err.errorCode ? `${errorClassOf(err)}_${err.errorCode}` : errorClassOf(err));
const INTERNAL_ERROR_TEXT = "Internal error.";

function createBot({ config, configStatus, telegram, logger, sessions, notion = null, writer = null, reserveId = null, router: routerOverride, logDir = LOG_DIR, retryDelayMs = RETRY_DELAY_MS, pollTimeoutS = POLL_TIMEOUT_S }) {
  const router = routerOverride || createRouter({ sessions, configStatus, logDir, notion, writer, reserveId });
  const controller = new AbortController();
  let running = false;
  let loop = null;
  let fatal = null;

  async function handleUpdate(update) {
    const message = update && update.message;
    if (!message) return;

    if (!isAuthorized(message, config.allowedUserId)) {
      // Silently ignored: no reply, no routing, nothing about the sender logged.
      logger.log({ event: "update", result: "ignored", authorized: false });
      return;
    }
    if (!running) return;

    const started = Date.now();
    const signal = controller.signal;
    let command = typeof router.commandOf === "function" ? router.commandOf(message.text) : "unknown";
    let reply;
    let errorClass;
    try {
      const routed = await router.route({ text: message.text, chatId: message.chat.id, signal });
      command = routed.command;
      reply = routed.reply;
      errorClass = routed.label;
      if (typeof reply !== "string" || reply.trim() === "") {
        reply = INTERNAL_ERROR_TEXT;
        errorClass = "internal_error";
      }
    } catch (err) {
      if (err && err.label === "notion_aborted") {
        // Shutting down: the Notion read was abandoned and no reply is sent.
        logger.log({ event: "command", command, result: "aborted", error_class: "notion_aborted", authorized: true, duration_ms: Date.now() - started });
        return;
      }
      reply = INTERNAL_ERROR_TEXT;
      errorClass = "internal_error";
    }
    if (signal.aborted) {
      logger.log({ event: "command", command, result: "aborted", authorized: true, duration_ms: Date.now() - started });
      return;
    }
    try {
      await telegram.sendMessage(message.chat.id, reply, { signal });
      logger.log({ event: "command", command, result: errorClass ? "error" : "ok", error_class: errorClass, authorized: true, duration_ms: Date.now() - started });
    } catch (err) {
      logger.log({ event: "command", command, result: "error", error_class: errorLabelOf(err), authorized: true, duration_ms: Date.now() - started });
    }
  }

  // Finds the newest queued update and returns the offset just past it, so
  // everything queued while the bot was stopped is discarded, not executed.
  async function dropStaleUpdates() {
    while (running) {
      try {
        const last = await telegram.getUpdates({ offset: -1, limit: 1, timeout: 0, signal: controller.signal });
        const offset = last.length ? last[last.length - 1].update_id + 1 : undefined;
        logger.log({ event: "stale_updates", result: last.length ? "dropped" : "none" });
        return offset;
      } catch (err) {
        if (!running) return undefined;
        if (isFatal(err)) throw err;
        logger.log({ event: "stale_updates", result: "error", error_class: errorLabelOf(err) });
        await abortableSleep(retryDelayMs, controller.signal);
      }
    }
    return undefined;
  }

  function isFatal(err) {
    return err && err.errorClass === "api_error" && FATAL_ERROR_CODES.has(err.errorCode);
  }

  async function pollLoop() {
    let offset = await dropStaleUpdates();
    logger.log({ event: "polling", result: "started" });
    while (running) {
      let updates;
      try {
        updates = await telegram.getUpdates({ offset, timeout: pollTimeoutS, signal: controller.signal });
      } catch (err) {
        if (!running) break;
        if (isFatal(err)) throw err;
        logger.log({ event: "poll", result: "error", error_class: errorLabelOf(err) });
        await abortableSleep(retryDelayMs, controller.signal);
        continue;
      }
      for (const update of updates) {
        // Advance first: each update is handled at most once.
        offset = update.update_id + 1;
        if (!running) break;
        await handleUpdate(update);
      }
    }
    logger.log({ event: "polling", result: "stopped" });
  }

  return {
    start() {
      running = true;
      loop = pollLoop().catch((err) => {
        running = false;
        fatal = err;
        logger.log({ event: "polling", result: "fatal", error_class: errorLabelOf(err) });
      });
      return loop;
    },
    async stop() {
      running = false;
      controller.abort();
      if (loop) await loop;
    },
    handleUpdate,
    fatalError: () => fatal,
    isRunning: () => running,
  };
}

async function main() {
  const { ok, status, notion: notionStatus, config } = loadConfig(process.env);
  if (!ok) {
    process.stderr.write(["URET Control Bot: configuration invalid.", ...describeStatus(status).map((l) => `  ${l}`)].join("\n") + "\n");
    process.exitCode = 1;
    return;
  }

  const logger = createLogger({ dir: LOG_DIR, secrets: secretValues(config) });
  const telegram = createTelegramClient({ token: config.botToken });
  const sessions = createSessionStore();

  // Notion is optional. The SDK is loaded only when Notion is configured, and
  // nothing is read from Notion until the first command that needs it.
  let notion = null;
  let writer = null;
  let reserveId = null;
  if (config.notionConfigured) {
    const { createNotionClient, createNotionReader } = require("./notion");
    const { createNotionWriteClient, createNotionWriter } = require("./notionWrite");
    const { reserveNextId } = require("./idCounter");
    const reader = createNotionReader({ client: createNotionClient(config), rootPageId: config.rootPageId });
    notion = reader;
    writer = createNotionWriter({ client: createNotionWriteClient(config), rootPageId: config.rootPageId, resolveDataSource: reader.getDataSourceId });
    reserveId = (type, { signal } = {}) => reserveNextId(type, reader, { signal });
  } else if (notionStatus.state === "not_ok") {
    // Local console only: names and states, never values.
    process.stderr.write(["Notion configuration: NOT OK", ...describeNotionStatus(notionStatus).map((l) => `  ${l}`)].join("\n") + "\n");
  }
  logger.log({ event: "notion_config", result: notionStatus.state });

  const bot = createBot({ config, configStatus: status, telegram, logger, sessions, notion, writer, reserveId });

  let stopping = false;
  async function shutdown(signalName) {
    if (stopping) {
      process.exit(1);
    }
    stopping = true;
    logger.log({ event: "shutdown", result: signalName });
    await bot.stop();
    logger.close();
    process.exit(0);
  }
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  logger.log({ event: "startup", result: "ok" });
  await bot.start();
  const fatal = bot.fatalError();
  if (fatal) {
    logger.close();
    process.stderr.write(
      fatal.errorCode === CONFLICT_ERROR_CODE
        ? "URET Control Bot stopped: another process is already receiving updates for this bot token. Stop the other instance, then restart.\n"
        : "URET Control Bot stopped: Telegram rejected the bot token. Check TELEGRAM_BOT_TOKEN.\n"
    );
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`URET Control Bot stopped: ${errorLabelOf(err)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { createBot, main };
