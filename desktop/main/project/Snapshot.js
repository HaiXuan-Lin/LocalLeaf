"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");
const { isUtf8 } = require("node:buffer");
const { decodeFile } = require("./Documents");

/**
 * Stand-in for Overleaf's project history service.
 *
 * The editor keeps a "project snapshot" (all files of the project) for
 * project-wide search, word count, reference indexing and following \input
 * chains. It builds it from GET /latest/history and then asks for the changes
 * since the version it has. Here the snapshot is simply the current content
 * of the folder, and "changes" are the difference to what was reported before.
 */

// Text files above this size are reported as binary: they are data, not
// prose, and loading them into the editor's snapshot would only cost memory.
const MAX_TEXT_FILE_SIZE = 1024 * 1024;
const MAX_TOTAL_TEXT_SIZE = 96 * 1024 * 1024;
const KEPT_STATES = 32;

// overleaf-editor-core refuses pathnames that are not "clean".
// eslint-disable-next-line no-control-regex
const BAD_CHAR_RX = /[\\/*\u0000-\u001F\u007F\u0080-\u009F\uD800-\uDFFF]/;
const BLOCKED_FILE_RX =
  /^(prototype|constructor|toString|toLocaleString|valueOf|hasOwnProperty|isPrototypeOf|propertyIsEnumerable|__defineGetter__|__lookupGetter__|__defineSetter__|__lookupSetter__|__proto__)$/;

function isSnapshotSafePath(relPath) {
  if (relPath.length === 0 || relPath.length > 1024) return false;
  if (BLOCKED_FILE_RX.test(relPath)) return false;
  return relPath.split("/").every((part) => {
    return (
      part.length > 0 &&
      part !== "." &&
      part !== ".." &&
      part === part.trim() &&
      !BAD_CHAR_RX.test(part)
    );
  });
}

class Snapshot {
  /**
   * @param {import('./ProjectTree').ProjectTree} tree
   * @param {import('./Documents').Documents} documents
   */
  constructor(tree, documents) {
    this.tree = tree;
    this.documents = documents;
    this.version = 0;
    /** @type {Map<number, Map<string, {key: string, raw: object}>>} */
    this.states = new Map();
    // per-file cache so unchanged docs are not re-read for every refresh
    this._cache = new Map();
  }

  /** Response body of GET /project/:id/latest/history */
  latestChunk() {
    const state = this._advance();
    const files = {};
    for (const [path, entry] of state) files[path] = entry.raw;
    return {
      chunk: {
        history: { snapshot: { files }, changes: [] },
        startVersion: this.version,
      },
    };
  }

  /** Response body of GET /project/:id/changes?since=<version> */
  changesSince(since) {
    const current = this._advance();
    if (!(since < this.version)) {
      return { changes: [], hasMore: false };
    }
    // If the base state was forgotten, re-send every file. Files deleted in
    // the meantime linger in the editor's snapshot until the next reload.
    const base = this.states.get(since) || new Map();
    const operations = [];
    for (const [path, entry] of base) {
      const now = current.get(path);
      if (!now || now.key !== entry.key) {
        operations.push({ pathname: path, newPathname: "" });
      }
    }
    for (const [path, entry] of current) {
      const before = base.get(path);
      if (!before || before.key !== entry.key) {
        operations.push({ pathname: path, file: entry.raw });
      }
    }
    const timestamp = new Date().toISOString();
    const changes = [{ operations, timestamp, authors: [] }];
    // The editor counts one version per change: pad to stay in step.
    while (since + changes.length < this.version) {
      changes.push({ operations: [], timestamp, authors: [] });
    }
    return { changes, hasMore: false };
  }

  /** Record the current state of the folder; bump the version if it changed. */
  _advance() {
    const current = this._readState();
    const latest = this.states.get(this.version);
    if (latest && sameState(latest, current)) return latest;
    if (latest) this.version++;
    this.states.set(this.version, current);
    for (const version of this.states.keys()) {
      if (version <= this.version - KEPT_STATES) this.states.delete(version);
    }
    return current;
  }

  _readState() {
    const state = new Map();
    const cache = new Map();
    let totalText = 0;
    for (const node of this.tree.walk()) {
      if (node.type === "folder") continue;
      const path = this.tree.relPath(node);
      if (!isSnapshotSafePath(path)) continue;
      let entry = null;
      if (
        node.type === "doc" &&
        node.size <= MAX_TEXT_FILE_SIZE &&
        totalText + node.size <= MAX_TOTAL_TEXT_SIZE
      ) {
        entry = this._textEntry(node);
        if (entry) totalText += node.size;
      }
      if (!entry) {
        entry = {
          key: `binary:${node.hash}:${node.size}:${node.mtimeMs}`,
          raw: { hash: node.hash, byteLength: node.size },
        };
      }
      cache.set(node.id, entry);
      state.set(path, entry);
    }
    this._cache = cache;
    return state;
  }

  _textEntry(node) {
    let content;
    if (this.documents.has(node.id)) {
      // Open in the editor: that copy is the freshest.
      content = this.documents.readContent(node);
    } else {
      const cached = this._cache.get(node.id);
      const stamp = `${node.size}:${node.mtimeMs}`;
      if (cached && cached.stamp === stamp) return cached;
      try {
        const buffer = fs.readFileSync(this.tree.absPath(node));
        if (!isUtf8(buffer)) return null;
        content = decodeFile(buffer).content;
      } catch {
        return null;
      }
      const key =
        "text:" + crypto.createHash("sha1").update(content).digest("hex");
      return { key, raw: { content }, stamp };
    }
    const key =
      "text:" + crypto.createHash("sha1").update(content).digest("hex");
    return { key, raw: { content } };
  }
}

function sameState(a, b) {
  if (a.size !== b.size) return false;
  for (const [path, entry] of a) {
    const other = b.get(path);
    if (!other || other.key !== entry.key) return false;
  }
  return true;
}

module.exports = { Snapshot, isSnapshotSafePath };
