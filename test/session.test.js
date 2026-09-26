"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { createSessionStore, DEFAULT_TIMEOUT_MS } = require("../bot/session");

test("default conversation timeout is 30 minutes", () => {
  assert.strictEqual(DEFAULT_TIMEOUT_MS, 30 * 60 * 1000);
});

test("stores, reads and clears sessions in memory", () => {
  const store = createSessionStore();
  assert.strictEqual(store.get(1), null);
  store.set(1, { step: "a" });
  assert.deepStrictEqual(store.get(1), { step: "a" });
  assert.strictEqual(store.size(), 1);
  assert.strictEqual(store.clear(1), true);
  assert.strictEqual(store.clear(1), false);
  assert.strictEqual(store.size(), 0);
});

test("sessions expire after the timeout", () => {
  let now = 0;
  const store = createSessionStore({ timeoutMs: 1000, now: () => now });
  store.set(1, { step: "a" });
  now = 999;
  assert.deepStrictEqual(store.get(1), { step: "a" });
  now = 2100;
  assert.strictEqual(store.get(1), null);
  assert.strictEqual(store.size(), 0);
});

test("a new store (as after a restart) starts empty", () => {
  const first = createSessionStore();
  first.set(1, { step: "a" });
  const afterRestart = createSessionStore();
  assert.strictEqual(afterRestart.get(1), null);
  assert.strictEqual(afterRestart.size(), 0);
});
