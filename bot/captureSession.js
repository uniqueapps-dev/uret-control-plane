"use strict";

/**
 * In-memory capture sessions for the guided creation commands
 * (/new_opportunity, /new_spec, /new_work).
 *
 * One session per user. A session records which command is running, the
 * index of the next question, the answers given so far and, for /new_spec
 * and /new_work, the verified parent URET ID. Nothing is written to disk:
 * all sessions disappear when the process stops and none are restored.
 *
 * A session expires 30 minutes after it started, whatever the activity.
 * Expired sessions are treated as gone; when one is removed, a one-time
 * notice is kept so the user's next message can be told it expired.
 * Answers are never logged.
 */

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

// Answer keys, in question order. Prompts and validation live with each command.
const FIELDS = {
  new_opportunity: ["title", "assetType", "project", "problemSummary", "targetUsers", "successMetrics", "nextAction"],
  new_spec: ["title", "version", "summary", "scopeIn", "scopeOut", "constraints"],
  new_work: ["title", "type", "worker", "summary", "instructions", "outputs"],
  new_evidence: ["type", "summary", "verdict", "details", "nextAction"],
};
const PARENT_PREFIX = { new_opportunity: null, new_spec: "OPP", new_work: "SPEC", new_evidence: "WP" };

const CANCELLED_TEXT = "Cancelled. No record created.";
const NO_SESSION_TEXT = "No active session to cancel.";
const expiredText = (command) => `Session expired. Use /cancel to stop or /${command} to restart.`;

class CaptureSessionError extends Error {
  constructor(reason) {
    super(`Capture session error (${reason})`);
    this.name = "CaptureSessionError";
    this.reason = reason;
  }
}

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// Snapshot handed to callers; changing it does not change the stored session.
function snapshot(entry) {
  const { id, command, step, answers, startedAt, userId, parentId } = entry;
  return { id, command, step, answers: { ...answers }, startedAt, userId, parentId, complete: step >= FIELDS[command].length };
}

function createCaptureStore({ timeoutMs = DEFAULT_TIMEOUT_MS, now = () => Date.now() } = {}) {
  const sessions = new Map();
  const expiredNotices = new Map();
  let seq = 0;

  const isExpired = (entry) => now() - entry.startedAt > timeoutMs;

  function expire(entry) {
    sessions.delete(entry.id);
    expiredNotices.set(entry.userId, entry.command);
  }

  // Returns the stored entry if it exists and has not expired.
  function live(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) return null;
    if (isExpired(entry)) {
      expire(entry);
      return null;
    }
    return entry;
  }

  function activeEntry(userId) {
    for (const entry of sessions.values()) {
      if (entry.userId === userId) return live(entry.id);
    }
    return null;
  }

  return {
    createSession(userId, command, parentId = null) {
      if (!Number.isSafeInteger(userId)) throw new CaptureSessionError("invalid_user");
      if (!hasOwn(FIELDS, command)) throw new CaptureSessionError("unknown_command");
      const prefix = PARENT_PREFIX[command];
      if (prefix === null ? parentId !== null : !(typeof parentId === "string" && parentId.startsWith(`${prefix}-`))) {
        throw new CaptureSessionError("invalid_parent");
      }
      if (activeEntry(userId)) throw new CaptureSessionError("session_active");
      expiredNotices.delete(userId);
      seq += 1;
      const entry = { id: `capture-${seq}`, command, step: 0, answers: {}, startedAt: now(), userId, parentId };
      sessions.set(entry.id, entry);
      return snapshot(entry);
    },

    // Records the answer to question `questionIndex`, which must be the next one.
    updateAnswer(sessionId, questionIndex, answer) {
      const entry = sessions.get(sessionId);
      if (!entry) throw new CaptureSessionError("not_found");
      if (isExpired(entry)) {
        expire(entry);
        throw new CaptureSessionError("expired");
      }
      const fields = FIELDS[entry.command];
      if (entry.step >= fields.length) throw new CaptureSessionError("complete");
      if (questionIndex !== entry.step) throw new CaptureSessionError("wrong_step");
      if (typeof answer !== "string") throw new CaptureSessionError("invalid_answer");
      entry.answers[fields[entry.step]] = answer;
      entry.step += 1;
      return snapshot(entry);
    },

    getSession(sessionId) {
      const entry = live(sessionId);
      return entry ? snapshot(entry) : null;
    },

    deleteSession(sessionId) {
      sessions.delete(sessionId);
    },

    getActiveSession(userId) {
      const entry = activeEntry(userId);
      return entry ? snapshot(entry) : null;
    },

    // Removes every expired session; returns how many were removed.
    cleanupExpiredSessions() {
      let removed = 0;
      for (const entry of [...sessions.values()]) {
        if (isExpired(entry)) {
          expire(entry);
          removed += 1;
        }
      }
      return removed;
    },

    // The expiry message for this user's most recently expired session, once.
    takeExpiredNotice(userId) {
      const command = expiredNotices.get(userId);
      expiredNotices.delete(userId);
      return command ? expiredText(command) : null;
    },

    // /cancel: ends the user's active session, if any, and returns the reply.
    cancel(userId) {
      const entry = activeEntry(userId);
      expiredNotices.delete(userId);
      if (!entry) return NO_SESSION_TEXT;
      sessions.delete(entry.id);
      return CANCELLED_TEXT;
    },

    size() {
      return sessions.size;
    },
  };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  FIELDS,
  CANCELLED_TEXT,
  NO_SESSION_TEXT,
  CaptureSessionError,
  expiredText,
  createCaptureStore,
};
