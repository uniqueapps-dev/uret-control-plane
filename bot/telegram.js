"use strict";

/**
 * Minimal Telegram Bot API client using Node's built-in fetch.
 *
 * Only two methods are used: getUpdates (long polling) and sendMessage.
 * The bot token appears only in the request URL built inside `call`. Errors
 * are replaced by TelegramError, which carries a short class label and the
 * numeric Telegram error code only — never the URL, the original error, its
 * message or its cause, any of which could contain the token.
 */

const API_BASE = "https://api.telegram.org";
// Extra time allowed on top of the long-poll timeout before a request is aborted.
const REQUEST_GRACE_MS = 15000;

class TelegramError extends Error {
  constructor(errorClass, errorCode) {
    super(`Telegram request failed (${errorClass})`);
    this.name = "TelegramError";
    this.errorClass = errorClass;
    if (errorCode !== undefined) this.errorCode = errorCode;
  }
}

// Returns an AbortSignal that fires when `outer` aborts or `timeoutMs` passes.
// (AbortSignal.any is not available on Node 18.)
function linkedSignal(outer, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener("abort", onAbort, { once: true });
  }
  const dispose = () => {
    clearTimeout(timer);
    if (outer) outer.removeEventListener("abort", onAbort);
  };
  return { signal: controller.signal, dispose };
}

function createTelegramClient({ token, fetchImpl = globalThis.fetch, apiBase = API_BASE }) {
  if (typeof fetchImpl !== "function") throw new TelegramError("fetch_unavailable");

  async function call(method, body, { signal, timeoutMs = 30000 } = {}) {
    const { signal: requestSignal, dispose } = linkedSignal(signal, timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${apiBase}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: requestSignal,
      });
    } catch {
      throw new TelegramError(signal && signal.aborted ? "aborted" : requestSignal.aborted ? "timeout" : "network");
    } finally {
      dispose();
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new TelegramError("invalid_response", response.status);
    }
    if (!payload || payload.ok !== true) {
      throw new TelegramError("api_error", (payload && payload.error_code) || response.status);
    }
    return payload.result;
  }

  return {
    getUpdates({ offset, timeout = 30, limit, signal } = {}) {
      const body = { timeout, allowed_updates: ["message"] };
      if (offset !== undefined) body.offset = offset;
      if (limit !== undefined) body.limit = limit;
      return call("getUpdates", body, { signal, timeoutMs: timeout * 1000 + REQUEST_GRACE_MS });
    },
    sendMessage(chatId, text, { signal } = {}) {
      return call("sendMessage", { chat_id: chatId, text }, { signal, timeoutMs: REQUEST_GRACE_MS });
    },
  };
}

module.exports = { TelegramError, createTelegramClient };
