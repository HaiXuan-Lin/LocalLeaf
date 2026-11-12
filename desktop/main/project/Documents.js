"use strict";
const fs = require("node:fs");
const { isUtf8 } = require("node:buffer");
const { EventEmitter } = require("node:events");
const { requireVendored } = require("../util/vendor");
const FileTypes = require("./FileTypes");

// The same operational-transformation text type that Overleaf's
// document-updater service runs on the server.
const otText = requireVendored("sharejs/text.js");

const MAX_HISTORY = 1000;
const EXTERNAL_UPDATE_META = {
  // The editor applies 'external' updates from this source silently, which is
  // what we want when a file changes on disk (git pull, another editor, ...).
  type: "external",
  source: "git-bridge",
  user_id: "local-filesystem",
};

/** Split a file's bytes into editor text + what is needed to write it back. */
function decodeFile(buffer) {
  let content = buffer.toString("utf8");
  const bom = content.charCodeAt(0) === 0xfeff;
  if (bom) content = content.slice(1);
  let eol = "\n";
  if (content.includes("\r\n")) {
    eol = "\r\n";
    content = content.replace(/\r\n/g, "\n");
  }
  return { content, eol, bom };
}

function encodeFile({ content, eol, bom }) {
  let text = eol === "\n" ? content : content.replace(/\n/g, eol);
  if (bom) text = "﻿" + text;
  return text;
}

/** Overleaf's real-time service sends doc lines as UTF-8 "binary strings". */
function encodeForWebsockets(text) {
  return Buffer.from(text, "utf8").toString("latin1");
}

const isHighSurrogate = (code) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code) => code >= 0xdc00 && code <= 0xdfff;

/**
 * A minimal OT operation turning `oldText` into `newText`: replace the part
 * between the common prefix and the common suffix.
 */
function diffToOp(oldText, newText) {
  const minLength = Math.min(oldText.length, newText.length);
  let start = 0;
  while (
    start < minLength &&
    oldText.charCodeAt(start) === newText.charCodeAt(start)
  ) {
    start++;
  }
  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldText.charCodeAt(oldEnd - 1) === newText.charCodeAt(newEnd - 1)
  ) {
    oldEnd--;
    newEnd--;
  }
  // Never cut a surrogate pair in half.
  if (start > 0 && isHighSurrogate(oldText.charCodeAt(start - 1))) start--;
  if (oldEnd < oldText.length && isLowSurrogate(oldText.charCodeAt(oldEnd))) {
    oldEnd++;
    newEnd++;
  }
  const op = [];
  if (oldEnd > start) op.push({ p: start, d: oldText.slice(start, oldEnd) });
  if (newEnd > start) op.push({ p: start, i: newText.slice(start, newEnd) });
  return op;
}

/**
 * The docs currently open in the editor.
 *
 * Plays the role of Overleaf's real-time + document-updater + docstore
 * services for a single local user: it answers joinDoc, applies the editor's
 * OT updates and writes the result straight to the file on disk. Changes made
 * to the file by other programs are turned into OT updates for the editor.
 *
 * Events:
 *  - 'update' ({ clientIds, payload }): an otUpdateApplied message for the
 *    given editor clients
 *  - 'save-error' ({ path, error })
 */
class Documents extends EventEmitter {
  /** @param {import('./ProjectTree').ProjectTree} tree */
  constructor(tree) {
    super();
    this.tree = tree;
    this.docs = new Map();
    tree.isDocOpen = (node) => this.docs.has(node.id);
    tree.on("entity-removed", (node) => {
      // The file is gone: forget the doc without writing it back.
      this.docs.delete(node.id);
    });
    tree.on("rescanned", () => this.checkExternalChanges());
  }

  has(docId) {
    return this.docs.has(docId);
  }

  /** Current text of a doc: the editor's version if open, else from disk. */
  readContent(node) {
    const open = this.docs.get(node.id);
    if (open) return open.content;
    const buffer = fs.readFileSync(this.tree.absPath(node));
    return decodeFile(buffer).content;
  }

  /**
   * @param {string} docId
   * @param {number | undefined} fromVersion
   * @param {string} clientId the editor window joining the doc
   * @return {{lines: string[], version: number, updates: object[], ranges: object}}
   */
  join(docId, fromVersion, clientId) {
    const node = this.tree.getNode(docId);
    if (!node || node.type !== "doc") {
      throw new Error("doc not found");
    }
    let doc = this.docs.get(docId);
    if (!doc) {
      const absPath = this.tree.absPath(node);
      const buffer = fs.readFileSync(absPath);
      if (!isUtf8(buffer)) {
        throw new Error("file is not valid UTF-8 text");
      }
      const decoded = decodeFile(buffer);
      if (!FileTypes.isEditableString(decoded.content)) {
        throw new Error("file is too large or not plain text");
      }
      const stat = fs.statSync(absPath);
      doc = {
        id: docId,
        node,
        ...decoded,
        version: 0,
        firstHistoryVersion: 0,
        history: [],
        diskSize: stat.size,
        diskMtimeMs: stat.mtimeMs,
        clients: new Set(),
      };
      this.docs.set(docId, doc);
    }
    let updates = [];
    if (typeof fromVersion === "number" && fromVersion !== doc.version) {
      if (fromVersion < doc.firstHistoryVersion || fromVersion > doc.version) {
        throw new Error("doc ops range is not loaded");
      }
      updates = doc.history
        .slice(fromVersion - doc.firstHistoryVersion)
        .map((entry, index) => ({
          doc: docId,
          op: entry.op,
          v: fromVersion + index,
          meta: entry.meta,
        }));
    }
    doc.clients.add(clientId);
    return {
      lines: doc.content.split("\n").map(encodeForWebsockets),
      version: doc.version,
      updates,
      ranges: {},
    };
  }

  leave(docId, clientId) {
    const doc = this.docs.get(docId);
    if (!doc) return;
    doc.clients.delete(clientId);
    // Every update is written to disk as it is applied, so there is nothing
    // to flush: just forget the in-memory copy.
    if (doc.clients.size === 0) this.docs.delete(docId);
  }

  /** An editor window went away. */
  leaveAll(clientId) {
    for (const docId of [...this.docs.keys()]) {
      this.leave(docId, clientId);
    }
  }

  /**
   * Apply an update from an editor window, acknowledge it and pass it on to
   * any other window that has the doc open.
   */
  applyUpdate(docId, update, clientId) {
    const doc = this.docs.get(docId);
    if (!doc || !doc.clients.has(clientId)) {
      throw new Error("doc not open");
    }
    if (!update || !Array.isArray(update.op) || typeof update.v !== "number") {
      throw new Error("invalid update");
    }
    if (update.v > doc.version) {
      throw new Error("Op at future version");
    }
    if (update.v < doc.firstHistoryVersion) {
      throw new Error("Op too old");
    }
    // Transform the op over anything applied since the version it was made
    // against (changes the sender had not seen yet).
    let op = update.op;
    for (let v = update.v; v < doc.version; v++) {
      const applied = doc.history[v - doc.firstHistoryVersion];
      op = otText.transform(op, applied.op, "left");
    }
    const content = otText.apply(doc.content, op);
    if (content.length >= FileTypes.MAX_DOC_LENGTH) {
      throw new Error("Update takes doc over max doc size");
    }
    const appliedAt = doc.version;
    const meta = { source: clientId, user_id: "local", ts: Date.now() };
    doc.content = content;
    this._pushHistory(doc, { op, meta });
    this._write(doc);

    // Acknowledgement for the sender, the op itself for everyone else. Both
    // travel on the same channel as external updates, so order is preserved.
    this.emit("update", {
      clientIds: [clientId],
      payload: { v: appliedAt, doc: docId },
    });
    const others = [...doc.clients].filter((id) => id !== clientId);
    if (others.length > 0) {
      this.emit("update", {
        clientIds: others,
        payload: { doc: docId, op, v: appliedAt, meta },
      });
    }
  }

  /** Pick up changes other programs made to open docs. */
  checkExternalChanges() {
    for (const doc of [...this.docs.values()]) {
      if (doc.node.removed) {
        this.docs.delete(doc.id);
        continue;
      }
      const absPath = this.tree.absPath(doc.node);
      let stat;
      try {
        stat = fs.statSync(absPath);
      } catch {
        continue;
      }
      if (stat.size === doc.diskSize && stat.mtimeMs === doc.diskMtimeMs) {
        continue;
      }
      let buffer;
      try {
        buffer = fs.readFileSync(absPath);
      } catch {
        continue;
      }
      doc.diskSize = stat.size;
      doc.diskMtimeMs = stat.mtimeMs;
      if (!isUtf8(buffer)) continue;
      const decoded = decodeFile(buffer);
      if (!FileTypes.isEditableString(decoded.content)) continue;
      doc.eol = decoded.eol;
      doc.bom = decoded.bom;
      if (decoded.content === doc.content) continue;

      const op = diffToOp(doc.content, decoded.content);
      const appliedAt = doc.version;
      const meta = { ...EXTERNAL_UPDATE_META, ts: Date.now() };
      doc.content = decoded.content;
      this._pushHistory(doc, { op, meta });
      this.emit("update", {
        clientIds: [...doc.clients],
        payload: { doc: doc.id, op, v: appliedAt, meta },
      });
    }
  }

  _pushHistory(doc, entry) {
    doc.history.push(entry);
    doc.version++;
    if (doc.history.length > MAX_HISTORY) {
      const drop = doc.history.length - MAX_HISTORY;
      doc.history.splice(0, drop);
      doc.firstHistoryVersion += drop;
    }
  }

  _write(doc) {
    const absPath = this.tree.absPath(doc.node);
    try {
      fs.writeFileSync(absPath, encodeFile(doc));
      const stat = fs.statSync(absPath);
      doc.diskSize = stat.size;
      doc.diskMtimeMs = stat.mtimeMs;
      // Keep the tree in step so the next rescan does not re-read the file.
      doc.node.size = stat.size;
      doc.node.mtimeMs = stat.mtimeMs;
    } catch (error) {
      this.emit("save-error", { path: absPath, error });
      throw new Error(`could not save ${doc.node.name}: ${error.message}`);
    }
  }
}

module.exports = { Documents, decodeFile, encodeFile, diffToOp };
