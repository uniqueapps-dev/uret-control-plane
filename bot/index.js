#!/usr/bin/env node
"use strict";

/**
 * URET Control Bot MVP v0.1 — Phase 1 entry point.
 *
 * Telegram long polling -> authorization -> Phase 1 command router.
 * Phase 1 reads and writes no URET records.
 *
 * Usage (Termux):
 *   set -a; . ./.env; set +a; npm run start:bot
 */

const path = require("path");
const { loadConfig, describeStatus } = require("./config");
const { createLogger } = require("./logger");
const { createSessionStore } = require("./session");
const { createTelegramClient } = require("./telegram");
const { isAuthorized } = require("./auth");
const { createRouter } = require("./commands");

const ROOT = path.join(__dirname, "..");
const LOG_DIR = path.join(ROOT, "logs");
const RUNTIME_DIR = path.join(ROOT, "runtime");
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

function createBot({ config, configStatus, telegram, logger, sessions, logDir = LOG_DIR, runtimeDir = RUNTIME_DIR, retryDelayMs = RETRY_DELAY_MS, pollTimeoutS = POLL_TIMEOUT_S }) {
  const router = createRouter({ sessions, configStatus, logDir, runtimeDir });
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
    let command = "unknown";
    try {
      const routed = router.route({ text: message.text, chatId: message.chat.id });
      command = routed.command;
      await telegram.sendMessage(message.chat.id, routed.reply, { signal: controller.signal });
      logger.log({ event: "command", command, result: "ok", authorized: true, duration_ms: Date.now() - started });
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
  const { ok, status, config } = loadConfig(process.env);
  if (!ok) {
    process.stderr.write(["URET Control Bot: configuration invalid.", ...describeStatus(status).map((l) => `  ${l}`)].join("\n") + "\n");
    process.exitCode = 1;
    return;
  }

  const logger = createLogger({ dir: LOG_DIR, secrets: [config.botToken] });
  const telegram = createTelegramClient({ token: config.botToken });
  const sessions = createSessionStore();
  const bot = createBot({ config, configStatus: status, telegram, logger, sessions });

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
