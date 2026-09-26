"use strict";

/**
 * In-memory conversation state, keyed by chat.
 *
 * Placeholder for later conversation workflows. Nothing here is durable: all
 * sessions disappear when the process stops, and none are restored on start.
 * Sessions older than the timeout (30 minutes by default) are treated as gone.
 */

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function createSessionStore({ timeoutMs = DEFAULT_TIMEOUT_MS, now = () => Date.now() } = {}) {
  const sessions = new Map();

  function isExpired(entry) {
    return now() - entry.updatedAt > timeoutMs;
  }

  return {
    get(key) {
      const entry = sessions.get(String(key));
      if (!entry) return null;
      if (isExpired(entry)) {
        sessions.delete(String(key));
        return null;
      }
      return entry.state;
    },
    set(key, state) {
      sessions.set(String(key), { state, updatedAt: now() });
    },
    // Returns true if there was an active session to clear.
    clear(key) {
      const entry = sessions.get(String(key));
      sessions.delete(String(key));
      return Boolean(entry && !isExpired(entry));
    },
    size() {
      for (const [key, entry] of sessions) {
        if (isExpired(entry)) sessions.delete(key);
      }
      return sessions.size;
    },
  };
}

module.exports = { DEFAULT_TIMEOUT_MS, createSessionStore };
