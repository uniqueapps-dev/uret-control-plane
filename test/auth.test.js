"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { isAuthorized } = require("../bot/auth");
const { AUTHORIZED_ID, OTHER_ID, message } = require("./helpers");

const ALLOWED = String(AUTHORIZED_ID);

test("the allowed numeric user ID in a private chat is accepted", () => {
  assert.strictEqual(isAuthorized(message({ updateId: 1, text: "/start" }).message, ALLOWED), true);
});

test("a different numeric user ID is rejected", () => {
  assert.strictEqual(isAuthorized(message({ updateId: 1, fromId: OTHER_ID, text: "/start" }).message, ALLOWED), false);
});

test("the same username with a different ID is rejected (usernames are never used)", () => {
  const msg = message({ updateId: 1, fromId: OTHER_ID, username: "owner", text: "/start" }).message;
  assert.strictEqual(isAuthorized(msg, ALLOWED), false);
});

test("the allowed user outside a private chat is rejected", () => {
  for (const chatType of ["group", "supergroup", "channel"]) {
    const msg = message({ updateId: 1, chatType, chatId: -100123, text: "/start" }).message;
    assert.strictEqual(isAuthorized(msg, ALLOWED), false, chatType);
  }
});

test("messages without a numeric sender are rejected", () => {
  assert.strictEqual(isAuthorized(null, ALLOWED), false);
  assert.strictEqual(isAuthorized({ chat: { type: "private" } }, ALLOWED), false);
  assert.strictEqual(isAuthorized({ from: { id: ALLOWED }, chat: { type: "private" } }, ALLOWED), false);
  assert.strictEqual(isAuthorized({ from: { id: AUTHORIZED_ID } }, ALLOWED), false);
});
