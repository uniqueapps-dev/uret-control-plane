"use strict";

/**
 * Authorization: a message is accepted only when the sender's numeric Telegram
 * user ID exactly equals the configured allowed ID AND it was sent in a
 * private chat. Usernames, display names, phone numbers and chat titles are
 * never consulted.
 */

function isAuthorized(message, allowedUserId) {
  if (!message || !message.from || !message.chat) return false;
  const fromId = message.from.id;
  if (typeof fromId !== "number" || !Number.isSafeInteger(fromId)) return false;
  if (String(fromId) !== String(allowedUserId)) return false;
  return message.chat.type === "private";
}

module.exports = { isAuthorized };
