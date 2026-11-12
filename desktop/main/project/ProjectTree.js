"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const Path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { hashId, randomId } = require("../util/ids");
const { HttpError } = require("../util/errors");
const FileTypes = require("./FileTypes");

function readHead(absPath, maxBytes) {
  const fd = fs.openSync(absPath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

const MAX_DEPTH = 24;
const MAX_ENTITIES = 20000;
const RESCAN_DEBOUNCE_MS = 200;
const RESCAN_MAX_WAIT_MS = 1500;

/**
 * An in-memory mirror of the folder the user opened, in the shape Overleaf's
 * file tree expects (folders / docs / fileRefs with ids), kept up to date by
 * watching the folder.
 *
 * Events:
 *  - 'socket' (eventName, ...args): something the editor must be told through
 *    its "websocket" (reciveNewDoc, removeEntity, ...)
 *  - 'entity-removed' (node): a doc/file/folder left the tree
 *  - 'rescanned': the tree was reconciled with the disk
 */
class ProjectTree extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.rootPath absolute path of the project folder
   * @param {(absPath: string) => Promise<void>} [options.trash] moves a path
   *        to the system trash; falls back to deleting
   * @param {boolean} [options.showBuildArtifacts]
   */
  constructor({ rootPath, trash, showBuildArtifacts = false }) {
    super();
    this.rootPath = rootPath;
    this.id = hashId("project", rootPath);
    this.name = Path.basename(rootPath) || rootPath;
    this.trash = trash;
    this.showBuildArtifacts = showBuildArtifacts;
    this.truncated = false;
    /** Set by the session: is this doc currently loaded in the editor? */
    this.isDocOpen = () => false;
    this.nodesById = new Map();
    this.nodesByHash = new Map();
    this.root = this._createNode({
      id: hashId(this.id, "folder", ""),
      name: "rootFolder",
      type: "folder",
      parent: null,
    });
    this._queue = Promise.resolve();
    this._watcher = null;
    this._rescanTimer = null;
    this._rescanFirstRequestedAt = 0;
    this._closed = false;
  }

  // --------------------------------------------------------------- lookups

  getNode(id) {
    return this.nodesById.get(id) || null;
  }

  getNodeByHash(hash) {
    return this.nodesByHash.get(hash) || null;
  }

  /** Project-relative path with forward slashes ('' for the root folder). */
  relPath(node) {
    const parts = [];
    for (let n = node; n && n.parent; n = n.parent) {
      parts.unshift(n.name);
    }
    return parts.join("/");
  }

  absPath(node) {
    return Path.join(this.rootPath, ...this.relPath(node).split("/"));
  }

  findByPath(relPath) {
    let node = this.root;
    const parts = relPath.split("/").filter((part) => part && part !== ".");
    for (const part of parts) {
      if (!node || node.type !== "folder") return null;
      node = node.children.get(part);
    }
    return node || null;
  }

  /** All nodes of the given type, depth first, sorted by name. */
  *walk(type, folder = this.root) {
    const children = [...folder.children.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const child of children) {
      if (!type || child.type === type) yield child;
      if (child.type === "folder") yield* this.walk(type, child);
    }
  }

  countEntities() {
    return this.nodesById.size - 1;
  }

  // ----------------------------------------------------------------- views

  docView(node) {
    return { _id: node.id, name: node.name };
  }

  fileView(node) {
    return {
      _id: node.id,
      name: node.name,
      hash: node.hash,
      created: new Date(node.mtimeMs || Date.now()).toISOString(),
    };
  }

  folderView(node) {
    const view = {
      _id: node.id,
      name: node.name,
      folders: [],
      fileRefs: [],
      docs: [],
    };
    const children = [...node.children.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const child of children) {
      if (child.type === "folder") view.folders.push(this.folderView(child));
      else if (child.type === "doc") view.docs.push(this.docView(child));
      else view.fileRefs.push(this.fileView(child));
    }
    return view;
  }

  entityView(node) {
    if (node.type === "folder") return this.folderView(node);
    if (node.type === "doc") return this.docView(node);
    return this.fileView(node);
  }

  // ------------------------------------------------------------- lifecycle

  async load() {
    await this._enqueue(() => this._reconcile(null));
  }

  startWatching() {
    if (this._watcher || this._closed) return;
    try {
      this._watcher = fs.watch(
        this.rootPath,
        { recursive: true, persistent: false },
        (_eventType, filename) => {
          if (filename && this._isIgnoredWatchPath(String(filename))) return;
          this.scheduleRescan();
        },
      );
      this._watcher.on("error", (err) => {
        this.emit("watch-error", err);
        this._restartWatcher();
      });
    } catch (err) {
      this.emit("watch-error", err);
    }
  }

  _restartWatcher() {
    try {
      this._watcher?.close();
    } catch {}
    this._watcher = null;
    if (this._closed) return;
    setTimeout(() => {
      if (this._closed) return;
      this.startWatching();
      this.scheduleRescan();
    }, 2000).unref?.();
  }

  _isIgnoredWatchPath(filename) {
    const parts = filename.split(/[\\/]/);
    const basename = parts.pop();
    if (parts.some((part) => FileTypes.isIgnoredDirectory(part))) return true;
    // Changes to hidden build by-products do not affect the tree.
    return FileTypes.isIgnoredFile(basename, {
      showBuildArtifacts: this.showBuildArtifacts,
    });
  }

  /** Ask for the tree to be reconciled with the disk soon. */
  scheduleRescan() {
    if (this._closed) return;
    const now = Date.now();
    if (!this._rescanTimer) this._rescanFirstRequestedAt = now;
    clearTimeout(this._rescanTimer);
    const waited = now - this._rescanFirstRequestedAt;
    const delay = Math.max(
      0,
      Math.min(RESCAN_DEBOUNCE_MS, RESCAN_MAX_WAIT_MS - waited),
    );
    this._rescanTimer = setTimeout(() => {
      this._rescanTimer = null;
      this.rescan().catch((err) => this.emit("watch-error", err));
    }, delay);
  }

  /** Reconcile the tree with the disk now. */
  async rescan() {
    if (this._closed) return;
    await this._enqueue(async () => {
      const events = [];
      await this._reconcile(events);
      this._emitSocketEvents(events);
    });
    this.emit("rescanned");
  }

  close() {
    this._closed = true;
    clearTimeout(this._rescanTimer);
    try {
      this._watcher?.close();
    } catch {}
    this._watcher = null;
  }

  // ------------------------------------------------- mutations from the UI

  async createDoc(parentId, name, content = "") {
    return await this._enqueue(async () => {
      const parent = this._requireFolder(parentId);
      const absPath = await this._newEntityPath(parent, name);
      await fsp.writeFile(absPath, content, { flag: "wx" });
      const stat = await fsp.stat(absPath);
      const node = this._addFileNode(parent, name, "doc", stat);
      this.emit(
        "socket",
        "reciveNewDoc",
        parent.id,
        this.docView(node),
        "editor",
      );
      return this.docView(node);
    });
  }

  async createFolder(parentId, name) {
    return await this._enqueue(async () => {
      const parent = this._requireFolder(parentId);
      const absPath = await this._newEntityPath(parent, name);
      await fsp.mkdir(absPath);
      const node = this._createNode({
        id: this._idForPath(parent, name),
        name,
        type: "folder",
        parent,
      });
      this.emit("socket", "reciveNewFolder", parent.id, this.folderView(node));
      return this.folderView(node);
    });
  }

  /** Write an uploaded file; replaces an existing file of the same name. */
  async writeUploadedFile(parentId, name, buffer) {
    return await this._enqueue(async () => {
      const parent = this._requireFolder(parentId);
      if (!FileTypes.isCleanFilename(name)) {
        throw new HttpError(422, "invalid_filename");
      }
      const existing = parent.children.get(name);
      if (existing && existing.type === "folder") {
        throw new HttpError(400, "a folder with this name already exists");
      }
      const absPath = Path.join(this.absPath(parent), name);
      await fsp.writeFile(absPath, buffer);
      const events = [];
      await this._reconcileFolder(parent, this.absPath(parent), 0, events, {
        recursive: false,
      });
      this._emitSocketEvents(events);
      const node = parent.children.get(name);
      if (!node) {
        // The file is hidden from the tree (e.g. a build artifact).
        return { success: true, entity_id: null, entity_type: "file" };
      }
      return {
        success: true,
        entity_id: node.id,
        entity_type: node.type === "doc" ? "doc" : "file",
        hash: node.hash,
      };
    }).finally(() => this.emit("rescanned"));
  }

  async rename(id, newName) {
    return await this._enqueue(async () => {
      const node = this._requireEntity(id);
      if (newName === node.name) return;
      const parent = node.parent;
      const fromPath = this.absPath(node);
      const toPath = await this._newEntityPath(parent, newName, node);
      await fsp.rename(fromPath, toPath);
      parent.children.delete(node.name);
      node.name = newName;
      parent.children.set(newName, node);
      this.emit("socket", "reciveEntityRename", node.id, newName);
    });
  }

  async move(id, toFolderId) {
    return await this._enqueue(async () => {
      const node = this._requireEntity(id);
      const target = this._requireFolder(toFolderId);
      if (target === node.parent) return;
      for (let n = target; n; n = n.parent) {
        if (n === node) {
          throw new HttpError(400, "cannot move a folder into itself");
        }
      }
      const fromPath = this.absPath(node);
      const toPath = await this._newEntityPath(target, node.name);
      await fsp.rename(fromPath, toPath);
      node.parent.children.delete(node.name);
      node.parent = target;
      target.children.set(node.name, node);
      this.emit("socket", "reciveEntityMove", node.id, target.id);
    });
  }

  async delete(id) {
    return await this._enqueue(async () => {
      const node = this._requireEntity(id);
      const absPath = this.absPath(node);
      // Tell listeners first so that an open doc is not flushed back to disk.
      this._detach(node);
      try {
        if (this.trash) {
          await this.trash(absPath);
        } else {
          await fsp.rm(absPath, { recursive: true, force: true });
        }
      } catch (err) {
        if (fs.existsSync(absPath)) {
          await fsp.rm(absPath, { recursive: true, force: true });
        }
      }
      this.emit("socket", "removeEntity", node.id, "editor");
    });
  }

  /**
   * A file that was listed as a doc turned out not to be editable text when
   * it was opened: show it as a plain file instead.
   */
  async convertToFile(id) {
    return await this._enqueue(async () => {
      const node = this.nodesById.get(id);
      if (!node || node.type !== "doc") return;
      const parent = node.parent;
      const { name, size, mtimeMs } = node;
      this._detach(node);
      this.emit("socket", "removeEntity", node.id, "external");
      const file = this._createNode({
        id: this._idForPath(parent, name),
        name,
        type: "file",
        parent,
        size,
        mtimeMs,
      });
      this.emit(
        "socket",
        "reciveNewFile",
        parent.id,
        this.fileView(file),
        "external",
        null,
      );
    });
  }

  // -------------------------------------------------------------- internals

  _enqueue(fn) {
    const run = this._queue.then(fn, fn);
    // Keep the queue alive after a failure.
    this._queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  _emitSocketEvents(events) {
    for (const event of events) {
      this.emit("socket", ...event);
    }
  }

  _requireFolder(id) {
    const node = this.nodesById.get(id);
    if (!node || node.type !== "folder") {
      throw new HttpError(404, "folder not found");
    }
    return node;
  }

  _requireEntity(id) {
    const node = this.nodesById.get(id);
    if (!node || node === this.root) {
      throw new HttpError(404, "entity not found");
    }
    return node;
  }

  /**
   * Validate a name for a new (or renamed/moved) entity and return the
   * absolute path it will have. Refuses to overwrite anything on disk,
   * including files that are hidden from the tree.
   */
  async _newEntityPath(parent, name, renamedNode = null) {
    if (!FileTypes.isCleanFilename(name)) {
      throw new HttpError(422, "invalid_filename");
    }
    const absPath = Path.join(this.absPath(parent), name);
    const isCaseOnlyRename =
      renamedNode &&
      renamedNode.parent === parent &&
      renamedNode.name.toLowerCase() === name.toLowerCase();
    if (!isCaseOnlyRename) {
      let exists = true;
      try {
        await fsp.lstat(absPath);
      } catch (err) {
        if (err.code === "ENOENT") exists = false;
        else throw err;
      }
      if (exists) {
        throw new HttpError(400, "file already exists");
      }
    }
    return absPath;
  }

  _idForPath(parent, name) {
    const relPath = [this.relPath(parent), name].filter(Boolean).join("/");
    const id = hashId(this.id, "entity", relPath);
    // A renamed entity keeps its id, so the id derived from its old path may
    // still be in use.
    return this.nodesById.has(id) ? randomId() : id;
  }

  _createNode({ id, name, type, parent, size = 0, mtimeMs = 0 }) {
    const node = { id, name, type, parent, size, mtimeMs };
    if (type === "folder") {
      node.children = new Map();
    } else {
      node.hash = crypto
        .createHash("sha1")
        .update(`${this.id}\u0000blob\u0000${id}`)
        .digest("hex");
      this.nodesByHash.set(node.hash, node);
    }
    this.nodesById.set(id, node);
    if (parent) parent.children.set(name, node);
    return node;
  }

  _addFileNode(parent, name, type, stat) {
    return this._createNode({
      id: this._idForPath(parent, name),
      name,
      type,
      parent,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }

  /** Remove a node (and everything below it) from the tree. */
  _detach(node) {
    if (node.type === "folder") {
      for (const child of [...node.children.values()]) {
        this._detach(child);
      }
    }
    node.parent?.children.delete(node.name);
    this.nodesById.delete(node.id);
    if (node.hash) this.nodesByHash.delete(node.hash);
    node.removed = true;
    this.emit("entity-removed", node);
  }

  async _reconcile(events) {
    this._visitedRealPaths = new Set();
    this.truncated = false;
    await this._reconcileFolder(this.root, this.rootPath, 0, events, {
      recursive: true,
    });
    this._visitedRealPaths = null;
  }

  /**
   * Bring `folder` in line with the directory at `absDir`.
   *
   * @param {Array | null} events socket events are collected here; null while
   *        building a subtree nobody has been told about yet
   */
  async _reconcileFolder(folder, absDir, depth, events, { recursive }) {
    let entries;
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    if (this._visitedRealPaths) {
      try {
        const real = await fsp.realpath(absDir);
        if (this._visitedRealPaths.has(real)) return; // symlink loop
        this._visitedRealPaths.add(real);
      } catch {}
    }

    const seen = new Set();
    for (const entry of entries) {
      const name = entry.name;
      const absPath = Path.join(absDir, name);
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      let stat = null;
      if (entry.isSymbolicLink()) {
        try {
          stat = await fsp.stat(absPath);
        } catch {
          continue; // dangling link
        }
        isDirectory = stat.isDirectory();
        isFile = stat.isFile();
      }

      if (isDirectory) {
        if (FileTypes.isIgnoredDirectory(name) || depth >= MAX_DEPTH) continue;
        let node = folder.children.get(name);
        if (node && node.type !== "folder") {
          this._detach(node);
          events?.push(["removeEntity", node.id, "external"]);
          node = null;
        }
        const isNew = !node;
        if (isNew) {
          if (this.nodesById.size > MAX_ENTITIES) {
            this.truncated = true;
            continue;
          }
          node = this._createNode({
            id: this._idForPath(folder, name),
            name,
            type: "folder",
            parent: folder,
          });
        }
        seen.add(name);
        if (recursive || isNew) {
          await this._reconcileFolder(
            node,
            absPath,
            depth + 1,
            isNew ? null : events,
            { recursive: true },
          );
        }
        if (isNew) {
          events?.push(["reciveNewFolder", folder.id, this.folderView(node)]);
        }
      } else if (isFile) {
        if (
          FileTypes.isIgnoredFile(name, {
            showBuildArtifacts: this.showBuildArtifacts,
          })
        ) {
          continue;
        }
        if (!stat) {
          try {
            stat = await fsp.stat(absPath);
          } catch {
            continue;
          }
        }
        let node = folder.children.get(name);
        if (node && node.type === "folder") {
          this._detach(node);
          events?.push(["removeEntity", node.id, "external"]);
          node = null;
        }
        if (node && node.size === stat.size && node.mtimeMs === stat.mtimeMs) {
          seen.add(name);
          continue;
        }
        // A doc that is open in the editor stays a doc while it is being
        // edited; the editor itself keeps its content editable.
        const type =
          node && node.type === "doc" && this.isDocOpen(node)
            ? "doc"
            : FileTypes.classify(name, stat.size, (maxBytes) =>
                readHead(absPath, maxBytes),
              );
        if (node && node.type !== type) {
          this._detach(node);
          events?.push(["removeEntity", node.id, "external"]);
          node = null;
        }
        if (node) {
          node.size = stat.size;
          node.mtimeMs = stat.mtimeMs;
        } else {
          if (this.nodesById.size > MAX_ENTITIES) {
            this.truncated = true;
            continue;
          }
          node = this._addFileNode(folder, name, type, stat);
          if (type === "doc") {
            events?.push([
              "reciveNewDoc",
              folder.id,
              this.docView(node),
              "external",
            ]);
          } else {
            events?.push([
              "reciveNewFile",
              folder.id,
              this.fileView(node),
              "external",
              null,
            ]);
          }
        }
        seen.add(name);
      }
    }

    for (const [name, child] of [...folder.children]) {
      if (!seen.has(name)) {
        this._detach(child);
        events?.push(["removeEntity", child.id, "external"]);
      }
    }
  }
}

module.exports = { ProjectTree, MAX_ENTITIES };
