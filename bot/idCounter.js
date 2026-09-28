"use strict";

/**
 * URET ID allocation from uret-id-counters.json.
 *
 * The file stores, per prefix, the last number handed out
 * ({"OPP": 1, "SPEC": 0, ...} means OPP-001 is taken and OPP-002 is next).
 *
 * reserveNextId(type, reader):
 *   1. takes the same exclusive lock file as the Notion setup script;
 *   2. reads and validates the counters;
 *   3. checks each candidate ID in Notion through the read-only adapter and
 *      skips any that already exist (found, trashed or duplicated);
 *   4. writes the new counter atomically (temp file, fsync, rename);
 *   5. releases the lock and returns the ID.
 * The number is consumed as soon as it is written: if creating the Notion
 * record later fails, it is not reused. Gaps are acceptable; duplicates are
 * not. If Notion cannot be checked, nothing is reserved or written and the
 * Notion error is passed on unchanged.
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_FILE = path.join(__dirname, "..", "uret-id-counters.json");
const TYPES = { opp: "OPP", spec: "SPEC", wp: "WP", evd: "EVD", rel: "REL" };
// Upper bound on existing IDs skipped in one reservation.
const MAX_SKIPS = 25;

class IdCounterError extends Error {
  constructor(reason) {
    super(`ID allocation failed (${reason})`);
    this.name = "IdCounterError";
    this.label = "id_counter_failed";
    this.reason = reason;
  }
}

function keyFor(type) {
  if (!Object.prototype.hasOwnProperty.call(TYPES, type)) throw new IdCounterError("unknown_type");
  return TYPES[type];
}

const formatId = (key, n) => `${key}-${String(n).padStart(3, "0")}`;

// Reads and validates all counters. A missing file means all zeros (as in the
// setup script); a missing key is 0; anything else invalid is refused.
function readAll(file) {
  let data = {};
  if (fs.existsSync(file)) {
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      throw new IdCounterError("unreadable");
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new IdCounterError("invalid");
  for (const key of Object.values(TYPES)) {
    if (data[key] === undefined) data[key] = 0;
    if (!Number.isInteger(data[key]) || data[key] < 0) throw new IdCounterError("invalid");
  }
  return data;
}

// Atomic write: temp file, fsync, rename. The original is untouched on failure.
function writeAll(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeSync(fd, JSON.stringify(data, null, 2) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // temp file was never created
    }
    throw new IdCounterError("write_failed");
  }
}

// Exclusive lock shared with the Notion setup script. An existing lock is
// never removed here: it may belong to another run.
async function withLock(file, fn) {
  const lock = `${file}.lock`;
  try {
    const fd = fs.openSync(lock, "wx");
    try {
      fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    throw new IdCounterError(err && err.code === "EEXIST" ? "locked" : "lock_failed");
  }
  try {
    return await fn();
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {
      // already gone
    }
  }
}

function readCounter(type, { file = DEFAULT_FILE } = {}) {
  return readAll(file)[keyFor(type)];
}

async function reserveNextId(type, reader, { file = DEFAULT_FILE, signal } = {}) {
  const key = keyFor(type);
  if (!reader || typeof reader.findByUretId !== "function") throw new IdCounterError("no_reader");
  return withLock(file, async () => {
    const data = readAll(file);
    let n = data[key];
    for (let skipped = 0; skipped <= MAX_SKIPS; skipped++) {
      n += 1;
      const id = formatId(key, n);
      // Notion errors propagate as-is; nothing has been written yet.
      const found = await reader.findByUretId(type, id, { signal });
      if (found && found.result === "not_found") {
        data[key] = n;
        writeAll(file, data);
        return id;
      }
    }
    throw new IdCounterError("too_many_existing");
  });
}

module.exports = { DEFAULT_FILE, TYPES, MAX_SKIPS, IdCounterError, readCounter, reserveNextId, formatId };
