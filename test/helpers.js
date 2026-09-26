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

module.exports = { AUTHORIZED_ID, OTHER_ID, fakeToken, tempDir, message, captureStream, fakeTelegramFetch, waitFor };
