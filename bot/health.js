"use strict";

/**
 * /health — local checks only. Makes no network calls and reports no values,
 * paths or error details. A reply shows only that the command reached the bot;
 * it makes no claim about process supervision or lasting connectivity.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { VARIABLES } = require("./config");

const EXPECTED_COMMAND_COUNT = 4;

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

function buildHealthReport({ configStatus, logDir, sessions, commandCount }) {
  const configOk = VARIABLES.every((name) => configStatus[name] === "valid");
  return [
    "URET CONTROL BOT HEALTH",
    "",
    `Command handler: ${commandCount === EXPECTED_COMMAND_COUNT ? "OK" : "NOT OK"}`,
    `Configuration: ${configOk ? "OK" : "NOT OK"}`,
    `Session store: ${sessionStoreOk(sessions) ? "OK" : "NOT OK"}`,
    `Logs: ${checkWritable(logDir) ? "OK" : "NOT WRITABLE"}`,
    "Notion: Not configured in Phase 1",
    "Hermes: Not used / isolated legacy system",
  ].join("\n");
}

module.exports = { buildHealthReport, checkWritable };
