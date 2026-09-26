"use strict";

/**
 * Small structured logger: one JSON object per line, written to a local log
 * file and echoed to stdout.
 *
 * Only an allow-listed set of fields is ever written, so message text, user
 * IDs, URLs and environment values cannot reach the log even if a caller
 * passes them. String fields are redacted and truncated as a second guard.
 */

const fs = require("fs");
const path = require("path");

const ALLOWED_FIELDS = ["event", "command", "result", "error_class", "duration_ms", "authorized"];
const MAX_FIELD_LENGTH = 64;

// Anything shaped like a Telegram bot token, with or without the "bot" URL prefix.
const TOKEN_PATTERN = /(bot)?\d{5,}:[A-Za-z0-9_-]{20,}/g;
// Anything shaped like a Notion integration token ("ntn_…" or "secret_…").
const NOTION_TOKEN_PATTERN = /(?:ntn|secret)_[A-Za-z0-9]{16,}/g;
// Any 32-hex-character Notion ID (page, database, data source), plain or dashed.
const NOTION_ID_PATTERN = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/gi;

function redact(text, secrets = []) {
  let out = String(text);
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[REDACTED]");
  }
  return out.replace(TOKEN_PATTERN, "[REDACTED]").replace(NOTION_TOKEN_PATTERN, "[REDACTED]").replace(NOTION_ID_PATTERN, "[REDACTED]");
}

function createLogger({ dir, fileName = "bot.log", secrets = [], stdout = process.stdout } = {}) {
  const filePath = dir ? path.join(dir, fileName) : null;
  let fileWritable = false;
  let warned = false;

  if (filePath) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fileWritable = true;
    } catch {
      fileWritable = false;
    }
  }

  function sanitize(entry) {
    const record = { timestamp: new Date().toISOString() };
    for (const field of ALLOWED_FIELDS) {
      const value = entry[field];
      if (value === undefined || value === null) continue;
      if (field === "duration_ms") {
        if (Number.isFinite(value)) record[field] = Math.round(value);
      } else if (field === "authorized") {
        record[field] = value === true;
      } else {
        record[field] = redact(value, secrets).slice(0, MAX_FIELD_LENGTH);
      }
    }
    return record;
  }

  function log(entry) {
    const line = JSON.stringify(sanitize(entry || {}));
    if (fileWritable) {
      try {
        fs.appendFileSync(filePath, line + "\n", { mode: 0o600 });
      } catch {
        fileWritable = false;
      }
    }
    if (!fileWritable && filePath && !warned) {
      warned = true;
      if (stdout) stdout.write(JSON.stringify(sanitize({ event: "log_file_unwritable", result: "stdout_only" })) + "\n");
    }
    if (stdout) stdout.write(line + "\n");
  }

  // Writes are synchronous, so there is nothing buffered to flush on close.
  function close() {}

  return { log, close, isFileWritable: () => fileWritable };
}

module.exports = { ALLOWED_FIELDS, createLogger, redact };
