"use strict";

/**
 * /health. The Phase 1 lines are local checks only and report no values,
 * paths or error details. The Notion lines come from the read-only adapter's
 * health() and say OK only when that read succeeded during this /health.
 * A reply shows only that the command reached the bot; it makes no claim
 * about process supervision or lasting connectivity.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { VARIABLES } = require("./config");

const EXPECTED_COMMAND_COUNT = 8;
const STATE_TEXT = { ok: "OK", not_ok: "NOT OK", not_checked: "NOT CHECKED" };

// Creates the directory if needed, then writes and removes a probe file.
function checkWritable(dir) {
  const probe = path.join(dir, `.health-probe-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return true;
  } catch {
    try {
      fs.unlinkSync(probe);
    } catch {
      // probe was never created
    }
    return false;
  }
}

function sessionStoreOk(sessions) {
  try {
    return Number.isInteger(sessions.size());
  } catch {
    return false;
  }
}

// Notion part of /health. Without an adapter nothing is read.
async function notionHealth(notion, signal) {
  if (!notion) {
    return { configured: false, reachable: "not_checked", sourceFound: "not_checked", schemaValid: "not_checked", label: "notion_not_configured" };
  }
  try {
    const h = await notion.health({ signal });
    return { configured: true, ...h };
  } catch (err) {
    if (err && err.label === "notion_aborted") throw err;
    return { configured: true, reachable: "not_ok", sourceFound: "not_checked", schemaValid: "not_checked", label: "notion_error" };
  }
}

const stateText = (state) => STATE_TEXT[state] || "NOT CHECKED";

// Returns { text, label }, where label is the adapter's notion_* label (or null).
async function buildHealthReport({ configStatus, logDir, sessions, commandCount, notion = null, signal }) {
  const configOk = VARIABLES.every((name) => configStatus[name] === "valid");
  const n = await notionHealth(notion, signal);
  const text = [
    "URET CONTROL BOT HEALTH",
    "",
    `Command handler: ${commandCount === EXPECTED_COMMAND_COUNT ? "OK" : "NOT OK"}`,
    `Configuration: ${configOk ? "OK" : "NOT OK"}`,
    `Session store: ${sessionStoreOk(sessions) ? "OK" : "NOT OK"}`,
    `Logs: ${checkWritable(logDir) ? "OK" : "NOT WRITABLE"}`,
    `Notion configuration: ${n.configured ? "OK" : "NOT OK"}`,
    `Notion reachable: ${stateText(n.reachable)}`,
    `Opportunities source: ${stateText(n.sourceFound)}`,
    `Opportunities schema: ${stateText(n.schemaValid)}`,
    "Hermes: Not used / isolated legacy system",
  ].join("\n");
  return { text, label: n.label || null };
}

module.exports = { buildHealthReport, checkWritable, EXPECTED_COMMAND_COUNT };
