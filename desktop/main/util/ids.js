"use strict";
const crypto = require("node:crypto");

/**
 * Overleaf identifies projects, folders, docs and files with 24 character hex
 * ids (Mongo ObjectIds). The desktop app has no database, so ids are derived
 * from paths: they stay the same between sessions, which lets the editor
 * restore "last opened file", layout and PDF position from localStorage.
 */
function hashId(...parts) {
  return crypto
    .createHash("sha1")
    .update(parts.join("\u0000"))
    .digest("hex")
    .slice(0, 24);
}

function randomId() {
  return crypto.randomBytes(12).toString("hex");
}

module.exports = { hashId, randomId };
