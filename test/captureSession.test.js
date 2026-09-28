"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const cs = require("../bot/captureSession");
const { AUTHORIZED_ID, OTHER_ID } = require("./helpers");

const MIN = 60 * 1000;

// A store with a controllable clock.
function store() {
  const clock = { t: 1_000_000 };
  const s = cs.createCaptureStore({ now: () => clock.t });
  return { s, clock };
}

function rejectsReason(fn, reason) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof cs.CaptureSessionError, `unexpected ${err && err.name}`);
    assert.strictEqual(err.reason, reason);
    return true;
  });
}

test("the timeout is 30 minutes", () => {
  assert.strictEqual(cs.DEFAULT_TIMEOUT_MS, 30 * MIN);
});

test("question fields follow the locked design", () => {
  assert.deepStrictEqual(Object.keys(cs.FIELDS), ["new_opportunity", "new_spec", "new_work"]);
  assert.strictEqual(cs.FIELDS.new_opportunity.length, 7);
  assert.strictEqual(cs.FIELDS.new_spec.length, 6);
  assert.strictEqual(cs.FIELDS.new_work.length, 6);
  for (const fields of Object.values(cs.FIELDS)) assert.strictEqual(fields[0], "title");
});

test("createSession returns the documented structure", () => {
  const { s, clock } = store();
  const session = s.createSession(AUTHORIZED_ID, "new_spec", "OPP-002");
  assert.deepStrictEqual(session, {
    id: session.id,
    command: "new_spec",
    step: 0,
    answers: {},
    startedAt: clock.t,
    userId: AUTHORIZED_ID,
    parentId: "OPP-002",
    complete: false,
  });
  assert.strictEqual(typeof session.id, "string");
  assert.strictEqual(s.createSession(OTHER_ID, "new_opportunity").parentId, null);
});

test("createSession validates command, user and parent", () => {
  const { s } = store();
  for (const command of ["new_release", "NEW_OPPORTUNITY", "", undefined, "constructor", "__proto__"]) {
    rejectsReason(() => s.createSession(AUTHORIZED_ID, command), "unknown_command");
  }
  for (const user of ["700000001", null, 1.5, undefined]) {
    rejectsReason(() => s.createSession(user, "new_opportunity"), "invalid_user");
  }
  rejectsReason(() => s.createSession(AUTHORIZED_ID, "new_opportunity", "OPP-001"), "invalid_parent");
  rejectsReason(() => s.createSession(AUTHORIZED_ID, "new_spec"), "invalid_parent");
  rejectsReason(() => s.createSession(AUTHORIZED_ID, "new_spec", "SPEC-001"), "invalid_parent");
  rejectsReason(() => s.createSession(AUTHORIZED_ID, "new_work", "OPP-001"), "invalid_parent");
  assert.strictEqual(s.size(), 0);
  assert.strictEqual(s.createSession(AUTHORIZED_ID, "new_work", "SPEC-001").parentId, "SPEC-001");
});

test("one active session per user; other users are independent", () => {
  const { s } = store();
  const a = s.createSession(AUTHORIZED_ID, "new_opportunity");
  rejectsReason(() => s.createSession(AUTHORIZED_ID, "new_spec", "OPP-001"), "session_active");
  const b = s.createSession(OTHER_ID, "new_opportunity");
  assert.notStrictEqual(a.id, b.id);
  assert.strictEqual(s.getActiveSession(AUTHORIZED_ID).id, a.id);
  assert.strictEqual(s.getActiveSession(OTHER_ID).id, b.id);
});

test("updateAnswer records answers in order and marks completion", () => {
  const { s } = store();
  const { id } = s.createSession(AUTHORIZED_ID, "new_work", "SPEC-003");
  const answers = ["Build login", "Feature", "Manual", "Sum", "Do it", "A PR"];
  let session;
  answers.forEach((answer, i) => {
    session = s.updateAnswer(id, i, answer);
    assert.strictEqual(session.step, i + 1);
  });
  assert.strictEqual(session.complete, true);
  assert.deepStrictEqual(session.answers, {
    title: "Build login",
    type: "Feature",
    worker: "Manual",
    summary: "Sum",
    instructions: "Do it",
    outputs: "A PR",
  });
  rejectsReason(() => s.updateAnswer(id, 6, "extra"), "complete");
});

test("updateAnswer refuses the wrong question, non-text answers and unknown sessions", () => {
  const { s } = store();
  const { id } = s.createSession(AUTHORIZED_ID, "new_opportunity");
  rejectsReason(() => s.updateAnswer(id, 1, "skip ahead"), "wrong_step");
  s.updateAnswer(id, 0, "Title");
  rejectsReason(() => s.updateAnswer(id, 0, "again"), "wrong_step");
  rejectsReason(() => s.updateAnswer(id, 1, 42), "invalid_answer");
  rejectsReason(() => s.updateAnswer(id, 1, undefined), "invalid_answer");
  rejectsReason(() => s.updateAnswer("capture-999", 0, "x"), "not_found");
  assert.deepStrictEqual(s.getSession(id).answers, { title: "Title" });
});

test("returned sessions are snapshots: changing them does not change the store", () => {
  const { s } = store();
  const session = s.createSession(AUTHORIZED_ID, "new_opportunity");
  session.step = 5;
  session.answers.title = "tampered";
  session.userId = OTHER_ID;
  const stored = s.getSession(session.id);
  assert.strictEqual(stored.step, 0);
  assert.deepStrictEqual(stored.answers, {});
  assert.strictEqual(stored.userId, AUTHORIZED_ID);
});

test("getSession and deleteSession", () => {
  const { s } = store();
  const { id } = s.createSession(AUTHORIZED_ID, "new_opportunity");
  assert.strictEqual(s.getSession(id).id, id);
  s.deleteSession(id);
  assert.strictEqual(s.getSession(id), null);
  assert.strictEqual(s.getActiveSession(AUTHORIZED_ID), null);
  s.deleteSession(id); // deleting twice is harmless
  s.deleteSession("capture-999");
  assert.strictEqual(s.getSession(undefined), null);
  assert.strictEqual(s.createSession(AUTHORIZED_ID, "new_opportunity").step, 0, "user blocked after delete");
});

test("a session lasts 30 minutes from startedAt, whatever the activity", () => {
  const { s, clock } = store();
  const { id } = s.createSession(AUTHORIZED_ID, "new_opportunity");
  clock.t += 29 * MIN;
  s.updateAnswer(id, 0, "Title"); // activity does not extend the session
  clock.t += 1 * MIN;
  assert.ok(s.getSession(id), "expired at exactly 30 minutes");
  clock.t += 1;
  assert.strictEqual(s.getSession(id), null);
  assert.strictEqual(s.getActiveSession(AUTHORIZED_ID), null);
  assert.strictEqual(s.size(), 0, "expired session kept in memory");
});

test("answering an expired session is refused as expired", () => {
  const { s, clock } = store();
  const { id } = s.createSession(AUTHORIZED_ID, "new_opportunity");
  clock.t += 31 * MIN;
  rejectsReason(() => s.updateAnswer(id, 0, "late"), "expired");
  rejectsReason(() => s.updateAnswer(id, 0, "late"), "not_found");
});

test("cleanupExpiredSessions removes only expired sessions", () => {
  const { s, clock } = store();
  const old = s.createSession(AUTHORIZED_ID, "new_opportunity");
  clock.t += 20 * MIN;
  const recent = s.createSession(OTHER_ID, "new_spec", "OPP-001");
  assert.strictEqual(s.cleanupExpiredSessions(), 0);
  clock.t += 11 * MIN;
  assert.strictEqual(s.cleanupExpiredSessions(), 1);
  assert.strictEqual(s.size(), 1);
  assert.strictEqual(s.getSession(old.id), null);
  assert.strictEqual(s.getSession(recent.id).id, recent.id);
  assert.strictEqual(s.cleanupExpiredSessions(), 0);
});

test("the expiry message is given once, naming the command to restart", () => {
  const { s, clock } = store();
  s.createSession(AUTHORIZED_ID, "new_opportunity");
  s.createSession(OTHER_ID, "new_work", "SPEC-001");
  clock.t += 31 * MIN;
  s.cleanupExpiredSessions();
  assert.strictEqual(s.takeExpiredNotice(AUTHORIZED_ID), "Session expired. Use /cancel to stop or /new_opportunity to restart.");
  assert.strictEqual(s.takeExpiredNotice(AUTHORIZED_ID), null);
  assert.strictEqual(s.takeExpiredNotice(OTHER_ID), "Session expired. Use /cancel to stop or /new_work to restart.");
  assert.strictEqual(s.takeExpiredNotice(12345), null);
});

test("lazy expiry (without cleanup) also leaves the notice; a new session clears it", () => {
  const { s, clock } = store();
  s.createSession(AUTHORIZED_ID, "new_spec", "OPP-001");
  clock.t += 31 * MIN;
  assert.strictEqual(s.getActiveSession(AUTHORIZED_ID), null);
  s.createSession(AUTHORIZED_ID, "new_opportunity");
  assert.strictEqual(s.takeExpiredNotice(AUTHORIZED_ID), null);
});

test("/cancel with an active session deletes it", () => {
  const { s } = store();
  const { id } = s.createSession(AUTHORIZED_ID, "new_opportunity");
  s.updateAnswer(id, 0, "Title");
  assert.strictEqual(s.cancel(AUTHORIZED_ID), "Cancelled. No record created.");
  assert.strictEqual(s.getSession(id), null);
  assert.strictEqual(s.size(), 0);
  assert.strictEqual(s.cancel(AUTHORIZED_ID), "No active session to cancel.");
});

test("/cancel without a session, or after expiry, has nothing to cancel", () => {
  const { s, clock } = store();
  assert.strictEqual(s.cancel(AUTHORIZED_ID), "No active session to cancel.");
  s.createSession(AUTHORIZED_ID, "new_opportunity");
  clock.t += 31 * MIN;
  assert.strictEqual(s.cancel(AUTHORIZED_ID), "No active session to cancel.");
  assert.strictEqual(s.takeExpiredNotice(AUTHORIZED_ID), null, "notice survives /cancel");
});

test("/cancel only affects the calling user", () => {
  const { s } = store();
  s.createSession(AUTHORIZED_ID, "new_opportunity");
  const other = s.createSession(OTHER_ID, "new_opportunity");
  s.cancel(AUTHORIZED_ID);
  assert.strictEqual(s.getActiveSession(OTHER_ID).id, other.id);
});

test("no persistent state: stores are independent and the module touches no files", () => {
  const a = cs.createCaptureStore();
  const b = cs.createCaptureStore();
  a.createSession(AUTHORIZED_ID, "new_opportunity");
  assert.strictEqual(b.getActiveSession(AUTHORIZED_ID), null);
  assert.strictEqual(b.size(), 0);
  const source = fs.readFileSync(path.join(__dirname, "..", "bot", "captureSession.js"), "utf8");
  assert.doesNotMatch(source, /require\(/, "captureSession.js loads a module");
  assert.doesNotMatch(source, /\bfs\b|writeFile|localStorage|process\.env/);
});
