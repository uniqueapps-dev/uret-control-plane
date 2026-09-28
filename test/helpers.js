"use strict";

// Shared test fixtures. No real credentials: tokens are generated randomly per run.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const AUTHORIZED_ID = 700000001;
const OTHER_ID = 700000002;

function fakeToken() {
  return `${crypto.randomInt(100000, 999999999)}:${crypto.randomBytes(27).toString("base64url")}`;
}

// Fake Notion values, generated per run: an "ntn_" token and a 32-hex page ID.
function fakeNotionToken() {
  return `ntn_${crypto.randomBytes(24).toString("hex")}`;
}

function fakePageId() {
  return crypto.randomBytes(16).toString("hex");
}

function dashedId(id) {
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

function tempDir(prefix = "uret-bot-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function message({ updateId, fromId = AUTHORIZED_ID, chatType = "private", chatId, text, username = "someone" }) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: fromId, is_bot: false, first_name: "Test", username },
      chat: { id: chatId !== undefined ? chatId : fromId, type: chatType },
      date: 0,
      text,
    },
  };
}

// Captures everything written through a { write } stream.
function captureStream() {
  const chunks = [];
  return { write: (chunk) => chunks.push(String(chunk)), text: () => chunks.join("") };
}

/**
 * Fake Telegram Bot API. `getUpdatesResponses` are returned in order; once they
 * run out, getUpdates behaves like a long poll that only ends when aborted.
 * Every call is recorded with its method name and parsed body.
 */
function fakeTelegramFetch({ getUpdatesResponses = [], sendMessageResponse } = {}) {
  const calls = [];
  const queue = [...getUpdatesResponses];

  async function fetchImpl(url, init) {
    const method = url.slice(url.lastIndexOf("/") + 1);
    const body = JSON.parse(init.body);
    calls.push({ method, body, url });

    if (method === "getUpdates" && queue.length) {
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return jsonResponse(next);
    }
    if (method === "getUpdates") {
      return new Promise((_, reject) => {
        const fail = () => reject(Object.assign(new Error(`aborted ${url}`), { name: "AbortError" }));
        if (init.signal.aborted) fail();
        else init.signal.addEventListener("abort", fail, { once: true });
      });
    }
    if (method === "sendMessage") {
      return jsonResponse(sendMessageResponse || { ok: true, result: { message_id: calls.length } });
    }
    throw new Error(`unexpected method ${method}`);
  }

  return { fetchImpl, calls };
}

function jsonResponse(payload) {
  return { status: payload.ok === false ? payload.error_code || 400 : 200, json: async () => payload };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// --- Real counter file guard ---------------------------------------------------------
//
// Tests must never read or write the repository's uret-id-counters.json (or
// its lock or temp files). forbidRealCounterFile() makes any fs call on those
// paths throw in this test process, records it (bot code may catch the error),
// and after all tests checks that the file is byte-for-byte unchanged, has the
// same modification time, and has no lock or temp file beside it.

const REAL_COUNTER_FILE = path.join(__dirname, "..", "uret-id-counters.json");
const GUARDED_FS = [
  "accessSync", "appendFileSync", "copyFileSync", "existsSync", "lstatSync", "openSync", "readFileSync",
  "renameSync", "rmSync", "statSync", "unlinkSync", "writeFileSync",
  "access", "appendFile", "copyFile", "open", "readFile", "rename", "rm", "stat", "unlink", "writeFile",
];
const counterGuard = { installed: false, violations: [] };

function isRealCounterPath(p) {
  if (typeof p !== "string" && !Buffer.isBuffer(p) && !(p instanceof URL)) return false;
  const abs = path.resolve(p instanceof URL ? p.pathname : String(p));
  return abs === REAL_COUNTER_FILE || abs.startsWith(`${REAL_COUNTER_FILE}.`);
}

function counterSnapshot() {
  const dir = path.dirname(REAL_COUNTER_FILE);
  const base = path.basename(REAL_COUNTER_FILE);
  return {
    content: fs.readFileSync(REAL_COUNTER_FILE, "utf8"),
    mtimeMs: fs.statSync(REAL_COUNTER_FILE).mtimeMs,
    siblings: fs.readdirSync(dir).filter((n) => n.startsWith(`${base}.`)),
  };
}

function forbidRealCounterFile() {
  if (counterGuard.installed) return counterGuard;
  counterGuard.installed = true;
  const before = counterSnapshot();
  const originals = {};
  for (const name of GUARDED_FS) {
    const original = fs[name];
    if (typeof original !== "function") continue;
    originals[name] = original;
    fs[name] = function guarded(...args) {
      if (args.slice(0, 2).some(isRealCounterPath)) {
        counterGuard.violations.push(`fs.${name}`);
        throw new Error(`test touched the real counter file via fs.${name}`);
      }
      return original.apply(this, args);
    };
  }
  require("node:test").after(() => {
    for (const [name, original] of Object.entries(originals)) fs[name] = original;
    const after = counterSnapshot();
    const assert = require("node:assert");
    assert.deepStrictEqual(counterGuard.violations, [], "a test touched the real counter file");
    assert.deepStrictEqual(after, before, "the real counter file changed during the tests");
  });
  return counterGuard;
}

module.exports = {
  AUTHORIZED_ID,
  OTHER_ID,
  fakeToken,
  fakeNotionToken,
  fakePageId,
  dashedId,
  tempDir,
  message,
  captureStream,
  fakeTelegramFetch,
  waitFor,
  REAL_COUNTER_FILE,
  isRealCounterPath,
  forbidRealCounterFile,
};
