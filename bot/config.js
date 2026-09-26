"use strict";

/**
 * Configuration for the URET Control Bot, read only from environment variables.
 *
 * Each variable is classified as "missing", "malformed" or "valid". Values are
 * never returned in status reports or printed. Secrets are attached to the
 * config object as non-enumerable properties so they do not appear if the
 * object is ever logged, inspected or serialised.
 *
 * Telegram settings decide whether the bot can start. Notion settings are
 * optional and separate: the bot starts without them, and they only switch
 * the read-only Notion commands on or off.
 */

const VARIABLES = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USER_ID"];
const NOTION_VARIABLES = ["NOTION_TOKEN", "URET_ROOT_PAGE_ID"];

// Telegram bot tokens look like "<numeric bot id>:<35-ish url-safe chars>".
const BOT_TOKEN_PATTERN = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;
// Telegram user IDs are positive integers (up to 52 bits); kept as a string.
const USER_ID_PATTERN = /^[1-9]\d{0,19}$/;
// Notion integration tokens: "ntn_…" (current) or "secret_…" (older), no spaces.
const NOTION_TOKEN_PATTERN = /^(?:ntn_|secret_)\S+$/;
const NOTION_TOKEN_MIN_LENGTH = 20;
// Notion page IDs: 32 hex characters, either plain or in 8-4-4-4-12 UUID form.
const PAGE_ID_PATTERN = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

const isBlank = (value) => value === undefined || value.trim() === "";

function classify(value, pattern) {
  if (isBlank(value)) return "missing";
  return pattern.test(value.trim()) ? "valid" : "malformed";
}

function classifyNotionToken(value) {
  if (isBlank(value)) return "missing";
  const token = value.trim();
  return token.length >= NOTION_TOKEN_MIN_LENGTH && NOTION_TOKEN_PATTERN.test(token) ? "valid" : "malformed";
}

// "off" when neither Notion variable is set, "ok" when both are valid,
// "not_ok" otherwise (one missing, or either malformed).
function loadNotionConfig(env) {
  const status = {
    NOTION_TOKEN: classifyNotionToken(env.NOTION_TOKEN),
    URET_ROOT_PAGE_ID: classify(env.URET_ROOT_PAGE_ID, PAGE_ID_PATTERN),
  };
  let state = "not_ok";
  if (NOTION_VARIABLES.every((name) => status[name] === "missing")) state = "off";
  else if (NOTION_VARIABLES.every((name) => status[name] === "valid")) state = "ok";
  return { state, status };
}

function loadConfig(env = process.env) {
  const status = {
    TELEGRAM_BOT_TOKEN: classify(env.TELEGRAM_BOT_TOKEN, BOT_TOKEN_PATTERN),
    TELEGRAM_ALLOWED_USER_ID: classify(env.TELEGRAM_ALLOWED_USER_ID, USER_ID_PATTERN),
  };
  const notion = loadNotionConfig(env);
  const ok = VARIABLES.every((name) => status[name] === "valid");
  if (!ok) return { ok, status, notion, config: null };

  const config = { allowedUserId: env.TELEGRAM_ALLOWED_USER_ID.trim(), notionConfigured: notion.state === "ok" };
  Object.defineProperty(config, "botToken", { value: env.TELEGRAM_BOT_TOKEN.trim(), enumerable: false });
  if (config.notionConfigured) {
    // Stored as 32 lowercase hex characters without dashes.
    const rootPageId = env.URET_ROOT_PAGE_ID.trim().replace(/-/g, "").toLowerCase();
    Object.defineProperty(config, "notionToken", { value: env.NOTION_TOKEN.trim(), enumerable: false });
    Object.defineProperty(config, "rootPageId", { value: rootPageId, enumerable: false });
  }
  return { ok, status, notion, config };
}

// Human-readable lines naming each variable and its status, never its value.
// For the local console only; Telegram never shows variable names.
function describeStatus(status) {
  return VARIABLES.map((name) => `${name}: ${status[name]}`);
}

function describeNotionStatus(notion) {
  return NOTION_VARIABLES.map((name) => `${name}: ${notion.status[name]}`);
}

// The single Notion configuration line allowed in Telegram replies.
function notionConfigLine(config) {
  return `Notion configuration: ${config && config.notionConfigured ? "OK" : "NOT OK"}`;
}

// Every secret value the logger must redact, including both forms of the root page ID.
function secretValues(config) {
  if (!config) return [];
  const secrets = [config.botToken];
  if (config.notionConfigured) {
    const id = config.rootPageId;
    const dashed = `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
    secrets.push(config.notionToken, id, dashed);
  }
  return secrets.filter(Boolean);
}

module.exports = {
  VARIABLES,
  NOTION_VARIABLES,
  loadConfig,
  describeStatus,
  describeNotionStatus,
  notionConfigLine,
  secretValues,
};
