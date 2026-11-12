"use strict";
const fs = require("node:fs");
const Path = require("node:path");
const { EventEmitter } = require("node:events");
const { randomId } = require("../util/ids");
const { ProjectTree } = require("./ProjectTree");
const { Documents, decodeFile } = require("./Documents");
const { Compiler, COMPILER_FLAGS } = require("./Compiler");
const { Snapshot } = require("./Snapshot");
const Metadata = require("./Metadata");
const FileTypes = require("./FileTypes");

const PROTOCOL_VERSION = 2;

const DOCUMENTCLASS_RE = /^[^%\n]*\\documentclass/m;
const MAGIC_PROGRAM_RE = /^\s*%\s*!\s*T[Ee]X\s+(?:TS-)?program\s*=\s*(\S+)/m;

/** Overleaf's DocumentHelper.contentHasDocumentclass */
function contentHasDocumentclass(content) {
  return DOCUMENTCLASS_RE.test(content);
}

/**
 * A sensible compiler for a project that has no stored choice yet: honour a
 * TeXShop/TeXstudio style "% !TEX program = xelatex" line, otherwise pick
 * XeLaTeX/LuaLaTeX when the preamble clearly needs it.
 */
function guessCompiler(content) {
  const head = content.slice(0, 20000);
  const magic = head.match(MAGIC_PROGRAM_RE);
  if (magic) {
    const program = magic[1].toLowerCase();
    if (program.includes("xelatex")) return "xelatex";
    if (program.includes("lualatex")) return "lualatex";
    if (program.includes("pdflatex")) return "pdflatex";
    if (program === "latex") return "latex";
  }
  const uncommented = head.replace(/(^|[^\\])%.*/g, "$1");
  if (
    /\\(usepackage|RequirePackage)(\[[^\]]*\])?\{[^}]*\b(luacode|luatexja|luatexja-fontspec|lua-ul)\b/.test(
      uncommented,
    )
  ) {
    return "lualatex";
  }
  if (
    /\\(usepackage|RequirePackage)(\[[^\]]*\])?\{[^}]*\b(fontspec|xeCJK|unicode-math|polyglossia|ctex)\b/.test(
      uncommented,
    ) ||
    /\\documentclass(\[[^\]]*\])?\{ctex(art|rep|book|beamer)\}/.test(
      uncommented,
    )
  ) {
    return "xelatex";
  }
  return "pdflatex";
}

/**
 * One opened folder: its file tree, open documents, compiler and settings.
 *
 * Replaces, for a single local user, what Overleaf spreads over the web,
 * real-time, document-updater, docstore, filestore, history and CLSI
 * services plus MongoDB and Redis.
 *
 * Editor windows attach as "clients" (see connectClient); everything the
 * real-time service would push over the websocket is delivered to them.
 *
 * Events:
 *  - 'save-error' ({ path, error })
 */
class ProjectSession extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.rootPath
   * @param {import('../AppState').AppState} options.appState
   * @param {(absPath: string) => Promise<void>} [options.trash]
   */
  constructor({ rootPath, appState, trash }) {
    super();
    this.rootPath = rootPath;
    this.appState = appState;
    this.tree = new ProjectTree({
      rootPath,
      trash,
      showBuildArtifacts: Boolean(appState.store.get("showBuildArtifacts")),
    });
    this.id = this.tree.id;
    this.documents = new Documents(this.tree);
    this.snapshot = new Snapshot(this.tree, this.documents);
    this.compiler = new Compiler({
      tree: this.tree,
      buildsDir: Path.join(appState.buildsDir, this.id),
      getSettings: () => ({
        compiler: this.getCompiler(),
        ...appState.getCompileSettings(),
      }),
    });
    /** @type {Map<string, (eventName: string, args: any[]) => void>} */
    this.clients = new Map();
    this.tree.on("socket", (eventName, ...args) =>
      this.broadcast(eventName, ...args),
    );
    this.documents.on("update", ({ clientIds, payload }) => {
      for (const clientId of clientIds) {
        this.sendTo(clientId, "otUpdateApplied", payload);
      }
    });
    this.documents.on("save-error", (info) => this.emit("save-error", info));
    this.tree.on("watch-error", (error) => {
      console.warn(`[${this.name}] file watcher:`, error.message);
    });
    this.tree.on("entity-removed", (node) => {
      if (node.id === this._rootDocId) this._rootDocId = null;
    });
    this._rootDocId = null;
  }

  get name() {
    return this.tree.name;
  }

  async open() {
    await this.tree.load();
    this.tree.startWatching();
    this._restoreRootDoc();
    const settings = this.appState.getProjectSettings(this.id);
    if (!COMPILER_FLAGS[settings.compiler]) {
      const root = this.getRootDocNode();
      let compiler = "pdflatex";
      if (root) {
        try {
          compiler = guessCompiler(this.documents.readContent(root));
        } catch {}
      }
      this.appState.updateProjectSettings(this.id, { compiler });
    }
    this.appState.updateProjectSettings(this.id, { rootPath: this.rootPath });
  }

  async close() {
    this.clients.clear();
    this.tree.close();
    await this.compiler.dispose();
    this.removeAllListeners();
  }

  // --------------------------------------------------------------- settings

  getCompiler() {
    const { compiler } = this.appState.getProjectSettings(this.id);
    return COMPILER_FLAGS[compiler] ? compiler : "pdflatex";
  }

  getSpellCheckLanguage() {
    const { spellCheckLanguage } = this.appState.getProjectSettings(this.id);
    return typeof spellCheckLanguage === "string"
      ? spellCheckLanguage
      : "en_US";
  }

  /** Apply POST /project/:id/settings */
  updateSettings(body) {
    const changes = {};
    if (typeof body.compiler === "string" && COMPILER_FLAGS[body.compiler]) {
      changes.compiler = body.compiler;
      this.broadcast("compilerUpdated", body.compiler);
    }
    if (typeof body.spellCheckLanguage === "string") {
      changes.spellCheckLanguage = body.spellCheckLanguage;
      this.broadcast("spellCheckLanguageUpdated", body.spellCheckLanguage);
    }
    if (typeof body.rootDocId === "string") {
      const node = this.tree.getNode(body.rootDocId);
      if (node && node.type === "doc") {
        this._rootDocId = node.id;
        changes.rootDocPath = this.tree.relPath(node);
        this.broadcast("rootDocUpdated", node.id);
      }
    }
    if (Object.keys(changes).length > 0) {
      this.appState.updateProjectSettings(this.id, changes);
    }
  }

  // ---------------------------------------------------------------- root doc

  getRootDocNode() {
    const node = this._rootDocId && this.tree.getNode(this._rootDocId);
    if (node && node.type === "doc") return node;
    const detected = this._detectRootDoc();
    this._rootDocId = detected ? detected.id : null;
    return detected;
  }

  _restoreRootDoc() {
    const { rootDocPath } = this.appState.getProjectSettings(this.id);
    const stored = rootDocPath ? this.tree.findByPath(rootDocPath) : null;
    if (stored && stored.type === "doc") {
      this._rootDocId = stored.id;
    } else {
      this._rootDocId = null;
      this.getRootDocNode();
    }
  }

  /**
   * Same search order as Overleaf's ProjectRootDocManager: prefer files close
   * to the project root, then small files (a main file often just \input's
   * the rest), then by name; take the first one with a \documentclass.
   */
  _detectRootDoc() {
    const candidates = [];
    for (const node of this.tree.walk("doc")) {
      const extension = Path.extname(node.name).slice(1);
      if (
        !FileTypes.ROOT_DOC_EXTENSIONS.some(
          (ext) => ext.toLowerCase() === extension.toLowerCase(),
        )
      ) {
        continue;
      }
      const relPath = this.tree.relPath(node);
      candidates.push({ node, relPath, depth: relPath.split("/").length });
    }
    candidates.sort(
      (a, b) =>
        a.depth - b.depth ||
        a.node.size - b.node.size ||
        a.relPath.localeCompare(b.relPath),
    );
    let firstInRootFolder = null;
    for (const candidate of candidates.slice(0, 200)) {
      if (!firstInRootFolder && candidate.depth === 1) {
        firstInRootFolder = candidate.node;
      }
      try {
        if (
          contentHasDocumentclass(this.documents.readContent(candidate.node))
        ) {
          return candidate.node;
        }
      } catch {}
    }
    return firstInRootFolder;
  }

  // ------------------------------------------------------------ project view

  /** The `project` of Overleaf's joinProject response. */
  projectView() {
    const user = this.appState.user;
    const root = this.getRootDocNode();
    return {
      _id: this.id,
      name: this.name,
      rootDoc_id: root ? root.id : undefined,
      rootFolder: [this.tree.folderView(this.tree.root)],
      publicAccesLevel: "private",
      dropboxEnabled: false,
      compiler: this.getCompiler(),
      description: "",
      spellCheckLanguage: this.getSpellCheckLanguage(),
      deletedByExternalDataSource: false,
      owner: {
        _id: user.id,
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
        privileges: "owner",
        signUpDate: new Date(0).toISOString(),
      },
      members: [],
      invites: [],
      features: {
        collaborators: 0,
        versioning: false,
        dropbox: false,
        github: false,
        gitBridge: false,
        compileTimeout: 600,
        compileGroup: "standard",
        templates: false,
        references: false,
        referencesSearch: false,
        mendeley: false,
        zotero: false,
        trackChanges: false,
        trackChangesVisible: false,
        symbolPalette: true,
      },
    };
  }

  // ------------------------------------------------------- editor "clients"

  /**
   * Attach an editor window. Plays the part of the socket.io handshake
   * followed by joinProject.
   *
   * @param {(eventName: string, args: any[]) => void} send
   * @return {{clientId: string, joinProjectResponse: object}}
   */
  connectClient(send) {
    const clientId = `P.${randomId()}`;
    this.clients.set(clientId, send);
    return {
      clientId,
      joinProjectResponse: {
        project: this.projectView(),
        permissionsLevel: "owner",
        protocolVersion: PROTOCOL_VERSION,
        publicId: clientId,
      },
    };
  }

  disconnectClient(clientId) {
    this.clients.delete(clientId);
    this.documents.leaveAll(clientId);
  }

  broadcast(eventName, ...args) {
    for (const send of this.clients.values()) {
      send(eventName, args);
    }
  }

  sendTo(clientId, eventName, ...args) {
    this.clients.get(clientId)?.(eventName, args);
  }

  /**
   * Handle an event an editor window emitted on its socket.
   * @return {Promise<any[] | undefined>} arguments for the editor's callback
   */
  async handleSocketEvent(clientId, event, args) {
    if (!this.clients.has(clientId)) {
      return [{ message: "not connected" }];
    }
    switch (event) {
      case "joinDoc": {
        const docId = args[0];
        const fromVersion = typeof args[1] === "number" ? args[1] : undefined;
        try {
          const { lines, version, updates, ranges } = this.documents.join(
            docId,
            fromVersion,
            clientId,
          );
          return [null, lines, version, updates, ranges, "sharejs-text-ot"];
        } catch (error) {
          if (!this.documents.has(docId)) {
            // Not editable text after all: list it as a plain file.
            this.tree.convertToFile(docId).catch(() => {});
          }
          return [{ message: error.message }];
        }
      }
      case "leaveDoc":
        this.documents.leave(args[0], clientId);
        return [null];
      case "applyOtUpdate": {
        const [docId, update] = args;
        try {
          this.documents.applyUpdate(docId, update, clientId);
          return [null];
        } catch (error) {
          return [{ message: error.message }];
        }
      }
      case "clientTracking.getConnectedUsers":
        return [null, []];
      case "clientTracking.updatePosition":
      case "clientPong":
        return undefined;
      case "debug.getHostname":
        return ["localhost"];
      default:
        return [null];
    }
  }

  // ----------------------------------------------------------------- compile

  async compile({ rootDocId, draft, stopOnFirstError }) {
    const requested = rootDocId && this.tree.getNode(rootDocId);
    const rootNode =
      requested && requested.type === "doc" ? requested : this.getRootDocNode();
    return await this.compiler.compile({ rootNode, draft, stopOnFirstError });
  }

  async clearCompileCache() {
    await this.compiler.clearCache([this.getRootDocNode()]);
    this.tree.scheduleRescan();
  }

  // ---------------------------------------------------------------- metadata

  async metadataForDoc(node) {
    return await Metadata.extractMetaFromDoc(this.documents.readContent(node));
  }

  async metadataForProject() {
    const projectMeta = {};
    for (const node of this.tree.walk("doc")) {
      if (!Metadata.hasMetadata(node.name)) continue;
      if (node.size > 1024 * 1024) continue;
      try {
        projectMeta[node.id] = await this.metadataForDoc(node);
      } catch {}
    }
    return projectMeta;
  }

  /** Raw bytes of a file in the tree (for previews and downloads). */
  readFile(node) {
    return fs.readFileSync(this.tree.absPath(node));
  }
}

module.exports = {
  ProjectSession,
  contentHasDocumentclass,
  guessCompiler,
  decodeFile,
};
