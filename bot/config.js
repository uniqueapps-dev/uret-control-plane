"use strict";

/**
 * Configuration for the URET Control Bot, read only from environment variables.
 *
 * Each variable is classified as "missing", "malformed" or "valid". Values are
 * never returned in status reports or printed. The bot token is attached to the
 * config object as a non-enumerable property so it does not appear if the
 * object is ever logged, inspected or serialised.
 */

const VARIABLES = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USER_ID"];

// Telegram bot tokens look like "<numeric bot id>:<35-ish url-safe chars>".
const BOT_TOKEN_PATTERN = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;
// Telegram user IDs are positive integers (up to 52 bits); kept as a string.
const USER_ID_PATTERN = /^[1-9]\d{0,19}$/;

function classify(value, pattern) {
  if (value === undefined || value.trim() === "") return "missing";
  return pattern.test(value.trim()) ? "valid" : "malformed";
}

function loadConfig(env = process.env) {
  const status = {
    TELEGRAM_BOT_TOKEN: classify(env.TELEGRAM_BOT_TOKEN, BOT_TOKEN_PATTERN),
    TELEGRAM_ALLOWED_USER_ID: classify(env.TELEGRAM_ALLOWED_USER_ID, USER_ID_PATTERN),
  };
  const ok = VARIABLES.every((name) => status[name] === "valid");
  if (!ok) return { ok, status, config: null };

  const config = { allowedUserId: env.TELEGRAM_ALLOWED_USER_ID.trim() };
  Object.defineProperty(config, "botToken", { value: env.TELEGRAM_BOT_TOKEN.trim(), enumerable: false });
  return { ok, status, config };
}

// Human-readable lines naming each variable and its status, never its value.
function describeStatus(status) {
  return VARIABLES.map((name) => `${name}: ${status[name]}`);
}

module.exports = { VARIABLES, loadConfig, describeStatus };
