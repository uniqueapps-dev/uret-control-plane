"use strict";

/**
 * /health — local checks only. Makes no network calls and reports no values,
 * paths or error details.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { VARIABLES } = require("./config");

// Creates the directory if needed, then writes and removes a probe file.
function checkWritable(dir) {
  const probe = path.join(dir, `.health-probe-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return "writable";
  } catch {
    try {
      fs.unlinkSync(probe);
    } catch {
      // probe was never created
    }
    return "not writable";
  }
}

function buildHealthReport({ configStatus, logDir, runtimeDir, sessions, commandCount }) {
  const configLine = VARIABLES.map((name) => `${name} ${configStatus[name] === "valid" ? "present" : configStatus[name]}`).join(", ");

  let sessionLine;
  try {
    sessionLine = `available (in memory, ${sessions.size()} active)`;
  } catch {
    sessionLine = "unavailable";
  }

  return [
    "URET Control Bot health (local checks only)",
    "",
    `Configuration: ${configLine}`,
    `Log directory: ${checkWritable(logDir)}`,
    `Runtime directory: ${checkWritable(runtimeDir)}`,
    `Session store: ${sessionLine}`,
    `Command handlers: ${commandCount} available`,
    "Notion: Not configured in Phase 1",
    "Hermes: Not used / isolated legacy system",
    "",
    "This reply shows only that the bot process is running and polling. It is not watched by any external supervisor.",
  ].join("\n");
}

module.exports = { buildHealthReport, checkWritable };
