"use strict";
const fs = require("node:fs");
const Path = require("node:path");
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  protocol,
  session: electronSession,
  shell,
} = require("electron");

const { AppState } = require("./AppState");
const { ProjectSession } = require("./project/ProjectSession");
const {
  resolveTexEnvironment,
  resetCache: resetTexCache,
} = require("./project/TexEnvironment");
const { hashId } = require("./util/ids");
const { handleApiRequest } = require("./server/Api");
const {
  renderEditorPage,
  renderWelcomePage,
  APP_NAME,
} = require("./server/html");
const { serveFile, safeJoin, notFound, text } = require("./server/http");
const { buildMenu } = require("./Menu");

const SCHEME = "localleaf";
const ORIGIN = `${SCHEME}://app`;
const APP_ROOT = Path.join(__dirname, "..");
const PRELOAD = Path.join(APP_ROOT, "preload", "preload.js");
const SOCKET_SHIM = Path.join(APP_ROOT, "shims", "socket.io.js");

const PROJECT_URL_RE =
  /^\/project\/([0-9a-f]{24})(?:\/(detached|detacher))?\/?$/;
// Content-hashed files emitted by webpack never change.
const HASHED_ASSET_RE = /[-.][0-9a-f]{16,}\.[a-z0-9.]+$/;

function rendererDir() {
  return process.env.LOCALLEAF_RENDERER_DIR || Path.join(APP_ROOT, "renderer");
}

/**
 * Must run before the app is ready: makes localleaf:// behave like https://
 * (relative URLs, fetch, workers, localStorage, WebAssembly streaming).
 */
function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        codeCache: true,
      },
    },
  ]);
}

class DesktopApp {
  constructor() {
    this.appState = new AppState(app.getPath("userData"));
    /** @type {Map<string, ProjectSession>} */
    this.sessions = new Map();
    /** project id -> main editor window */
    this.projectWindows = new Map();
    /** webContents id -> { session, clientId } */
    this.socketClients = new Map();
    this.manifest = {};
    this.config = {};
    this.pendingOpens = new Map();
  }

  // ------------------------------------------------------------------ startup

  async start() {
    this._loadRendererBuild();
    // Per-build copies of PDFs and logs do not outlive the app.
    fs.rmSync(this.appState.buildsDir, { recursive: true, force: true });
    this._lockDownSession(electronSession.defaultSession);
    protocol.handle(SCHEME, (request) => this._handleRequest(request));
    this._registerIpc();
    this.refreshMenu();
    this.applyNativeTheme();
  }

  /**
   * The title bar, dialogs and native menus follow the theme chosen in the
   * editor's settings, not only the system appearance: a dark editor under a
   * white title bar looks broken.
   */
  applyNativeTheme() {
    const { overallTheme } = this.appState.getUserSettings();
    let source = "dark"; // Overleaf's default theme ("") is the dark one
    if (overallTheme === "light-") source = "light";
    else if (overallTheme === "system") source = "system";
    if (nativeTheme.themeSource !== source) nativeTheme.themeSource = source;
    const background = nativeTheme.shouldUseDarkColors ? "#1b222c" : "#ffffff";
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.setBackgroundColor(background);
    }
  }

  _loadRendererBuild() {
    const dir = rendererDir();
    try {
      this.manifest = JSON.parse(
        fs.readFileSync(Path.join(dir, "manifest.json"), "utf8"),
      );
      this.config = JSON.parse(
        fs.readFileSync(Path.join(dir, "desktop-config.json"), "utf8"),
      );
    } catch (error) {
      dialog.showErrorBox(
        `${APP_NAME} is not built`,
        `The editor front end was not found in:\n${dir}\n\nRun ./build.sh in the repository first.\n\n(${error.message})`,
      );
      app.exit(1);
    }
  }

  /** The app is offline by design: no request ever leaves the machine. */
  _lockDownSession(ses) {
    ses.webRequest.onBeforeRequest(
      {
        urls: [
          "http://*/*",
          "https://*/*",
          "ws://*/*",
          "wss://*/*",
          "ftp://*/*",
        ],
      },
      (details, callback) => {
        // DevTools fetches its own front-end resources through this session.
        callback({ cancel: !details.url.startsWith("devtools://") });
      },
    );
    const allowedPermissions = new Set([
      "clipboard-read",
      "clipboard-sanitized-write",
    ]);
    ses.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(allowedPermissions.has(permission));
    });
    ses.setPermissionCheckHandler((_webContents, permission) =>
      allowedPermissions.has(permission),
    );
    ses.on("will-download", (_event, item) => {
      if (process.env.LOCALLEAF_TEST_DOWNLOAD_DIR) {
        // automated tests cannot answer a save dialog
        item.setSavePath(
          Path.join(
            process.env.LOCALLEAF_TEST_DOWNLOAD_DIR,
            item.getFilename(),
          ),
        );
        return;
      }
      item.setSaveDialogOptions({
        defaultPath: Path.join(app.getPath("downloads"), item.getFilename()),
      });
    });
  }

  refreshMenu() {
    buildMenu(this);
  }

  getSession(projectId) {
    return this.sessions.get(projectId) || null;
  }

  // ------------------------------------------------------------------ windows

  _createWindow({ width = 1440, height = 900 } = {}) {
    const win = new BrowserWindow({
      width,
      height,
      minWidth: 720,
      minHeight: 480,
      show: false,
      title: APP_NAME,
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#1b222c" : "#ffffff",
      webPreferences: this._webPreferences(),
    });
    win.once("ready-to-show", () => win.show());
    this._guardWebContents(win.webContents);
    return win;
  }

  _webPreferences() {
    return {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false, // the editor has its own spell checker
    };
  }

  _guardWebContents(webContents) {
    // Links leaving the app open in the default browser.
    webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith(ORIGIN + "/")) {
        event.preventDefault();
        this._openExternal(url);
      }
    });
    webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith(ORIGIN + "/")) {
        const match = PROJECT_URL_RE.exec(new URL(url).pathname);
        if (match && match[2] === "detached" && this.sessions.has(match[1])) {
          // "PDF in separate window"
          return {
            action: "allow",
            overrideBrowserWindowOptions: {
              width: 900,
              height: 1000,
              title: APP_NAME,
              webPreferences: this._webPreferences(),
            },
          };
        }
        // Links such as "Download PDF" open a new tab on the web; here the
        // file is saved through a save dialog instead.
        if (
          /^\/(download\/)?project\/[0-9a-f]{24}\/.+/.test(
            new URL(url).pathname,
          )
        ) {
          webContents.downloadURL(url);
        }
        return { action: "deny" };
      }
      this._openExternal(url);
      return { action: "deny" };
    });
    webContents.on("did-create-window", (child) => {
      this._guardWebContents(child.webContents);
      const parent = BrowserWindow.fromWebContents(webContents);
      parent?.once("closed", () => {
        if (!child.isDestroyed()) child.close();
      });
    });
    // A page that goes away takes its socket with it.
    const dropSocket = () => this._disconnectSocket(webContents.id);
    webContents.on("destroyed", dropSocket);
    webContents.on("render-process-gone", dropSocket);
    webContents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) dropSocket();
    });
  }

  _openExternal(url) {
    if (/^(https?|mailto):/i.test(url)) {
      shell.openExternal(url).catch(() => {});
    }
  }

  showWelcomeWindow() {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.localleafRole === "welcome") {
        win.show();
        win.focus();
        return win;
      }
    }
    const win = this._createWindow({ width: 960, height: 680 });
    this._trackWindow(win);
    win.loadURL(`${ORIGIN}/project`);
    return win;
  }

  /**
   * Keep a window's role in step with the page it shows. A window moves
   * between the welcome page and a project (e.g. via the editor's home
   * button), and the project's backend lives as long as its window shows it.
   */
  _trackWindow(win) {
    win.localleafRole = "welcome";
    win.localleafProjectId = null;
    const update = (url) => {
      let pathname = "";
      try {
        pathname = new URL(url).pathname;
      } catch {}
      const match = PROJECT_URL_RE.exec(pathname);
      const projectId = match ? match[1] : null;
      const previous = win.localleafProjectId;
      if (previous && previous !== projectId) {
        this._releaseProject(previous, win);
      }
      win.localleafProjectId = projectId;
      win.localleafRole = projectId ? "editor" : "welcome";
      if (projectId) {
        this.projectWindows.set(projectId, win);
        const session = this.sessions.get(projectId);
        if (session && process.platform === "darwin") {
          win.setRepresentedFilename(session.rootPath);
        }
      } else if (process.platform === "darwin") {
        win.setRepresentedFilename("");
      }
      this.refreshMenu();
    };
    win.webContents.on("did-navigate", (_event, url) => update(url));
    // The page titles are written for a browser tab ("… - Online LaTeX
    // Editor"); a window title is the folder name.
    win.on("page-title-updated", (event) => {
      event.preventDefault();
      const session = this.sessions.get(win.localleafProjectId);
      win.setTitle(session ? session.name : APP_NAME);
    });
    win.on("focus", () => {
      // Catch up with anything the file watcher may have missed.
      const session = this.sessions.get(win.localleafProjectId);
      session?.tree.scheduleRescan();
    });
    win.on("closed", () => {
      if (win.localleafProjectId) {
        this._releaseProject(win.localleafProjectId, win);
      }
      this.refreshMenu();
    });
  }

  _releaseProject(projectId, win) {
    if (this.projectWindows.get(projectId) !== win) return;
    this.projectWindows.delete(projectId);
    const session = this.sessions.get(projectId);
    this.sessions.delete(projectId);
    session?.close().catch(() => {});
  }

  // ----------------------------------------------------------------- projects

  async chooseAndOpenFolder(win) {
    const parent = win && !win.isDestroyed() ? win : undefined;
    const options = {
      title: "Open Folder",
      buttonLabel: "Open",
      properties: ["openDirectory", "createDirectory"],
    };
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return false;
    return await this.openFolder(result.filePaths[0], { win: parent });
  }

  /**
   * Open a folder as a project, in `win` if given (when it shows the welcome
   * page), otherwise in a new window. A folder that is already open is
   * brought to the front.
   */
  async openFolder(folderPath, { win } = {}) {
    let rootPath;
    try {
      rootPath = fs.realpathSync(Path.resolve(folderPath));
      if (!fs.statSync(rootPath).isDirectory()) {
        // A file was given (e.g. main.tex): open the folder it is in.
        rootPath = Path.dirname(rootPath);
      }
    } catch (error) {
      this.appState.removeRecentFolder(folderPath);
      this.refreshMenu();
      dialog.showErrorBox(
        "Folder not found",
        `${folderPath}\n\n${error.message}`,
      );
      return false;
    }
    const projectId = hashId("project", rootPath);

    const existing = this.projectWindows.get(projectId);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return true;
    }
    // Two requests for the same folder at once share one session.
    if (this.pendingOpens.has(projectId)) {
      return await this.pendingOpens.get(projectId);
    }

    const opening = (async () => {
      const session = new ProjectSession({
        rootPath,
        appState: this.appState,
        trash: (absPath) => shell.trashItem(absPath),
      });
      session.on("save-error", ({ path, error }) => {
        dialog.showErrorBox(
          "Could not save file",
          `${path}\n\n${error.message}\n\nYour latest changes to this file are not on disk.`,
        );
      });
      try {
        await session.open();
      } catch (error) {
        await session.close().catch(() => {});
        dialog.showErrorBox(
          "Could not open folder",
          `${rootPath}\n\n${error.message}`,
        );
        return false;
      }
      this.sessions.set(projectId, session);
      this.appState.addRecentFolder(rootPath);
      app.addRecentDocument(rootPath);

      let target =
        win && !win.isDestroyed() && win.localleafRole === "welcome"
          ? win
          : null;
      if (!target) {
        target = this._createWindow();
        this._trackWindow(target);
      }
      this.projectWindows.set(projectId, target);
      await target.loadURL(`${ORIGIN}/project/${projectId}`);
      this.refreshMenu();
      if (session.tree.truncated) {
        dialog.showMessageBox(target, {
          type: "warning",
          message: "This folder is very large",
          detail:
            "Only part of it is shown in the file tree. Open the folder that contains your LaTeX project instead of a parent folder.",
        });
      }
      return true;
    })();
    this.pendingOpens.set(projectId, opening);
    try {
      return await opening;
    } finally {
      this.pendingOpens.delete(projectId);
    }
  }

  reloadAllWindows() {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.reload();
    }
  }

  sendCommand(win, command, payload) {
    if (win && !win.isDestroyed()) {
      win.webContents.send("app:command", command, payload);
    }
  }

  // ---------------------------------------------------------------------- TeX

  async texStatus() {
    const { texBinDir } = this.appState.getCompileSettings();
    const tex = await resolveTexEnvironment({ customBinDir: texBinDir });
    return {
      latexmk: tex.latexmk,
      synctex: tex.synctex,
      customBinDir: texBinDir || "",
      searched: tex.dirs,
    };
  }

  async chooseTexDirectory(win) {
    const options = {
      title: "Folder that contains latexmk",
      message: "Choose the folder that contains latexmk, pdflatex and synctex",
      buttonLabel: "Use This Folder",
      defaultPath: fs.existsSync("/Library/TeX/texbin")
        ? "/Library/TeX/texbin"
        : undefined,
      properties: ["openDirectory", "showHiddenFiles"],
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0)
      return await this.texStatus();
    this.appState.store.set("texBinDir", result.filePaths[0]);
    resetTexCache();
    return await this.texStatus();
  }

  async showTexDialog(win) {
    resetTexCache();
    const status = await this.texStatus();
    const found = Boolean(status.latexmk);
    const detail = found
      ? `latexmk: ${status.latexmk}\nsynctex: ${status.synctex || "not found"}\n\n${
          status.customBinDir
            ? `Using the folder you chose: ${status.customBinDir}`
            : "Found automatically."
        }`
      : `${APP_NAME} does not include TeX. Install MacTeX or TeX Live, or choose the folder that contains latexmk.\n\nSearched in:\n${status.searched.join("\n")}`;
    const buttons = ["OK", "Choose Folder…"];
    if (status.customBinDir) buttons.push("Detect Automatically");
    const options = {
      type: found ? "info" : "warning",
      message: found ? "TeX distribution found" : "No TeX distribution found",
      detail,
      buttons,
      defaultId: 0,
      cancelId: 0,
    };
    const { response } = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
    if (response === 1) {
      await this.chooseTexDirectory(win);
      await this.showTexDialog(win);
    } else if (response === 2) {
      this.appState.store.set("texBinDir", "");
      await this.showTexDialog(win);
    }
  }

  // ---------------------------------------------------------------------- IPC

  _registerIpc() {
    const windowOf = (event) => BrowserWindow.fromWebContents(event.sender);
    const sessionOf = (event) => {
      const client = this.socketClients.get(event.sender.id);
      if (client) return client.session;
      const win = windowOf(event);
      return this.sessions.get(win?.localleafProjectId) || null;
    };
    // Only our own pages may talk to the backend.
    const trusted = (event) => {
      const url = event.senderFrame?.url || "";
      return url.startsWith(ORIGIN + "/");
    };
    const handle = (channel, handler) => {
      ipcMain.handle(channel, async (event, ...args) => {
        if (!trusted(event)) throw new Error("forbidden");
        return await handler(event, ...args);
      });
    };

    handle("socket:connect", (event, projectId) => {
      const session = this.sessions.get(projectId);
      if (!session) throw new Error("project is not open");
      const webContents = event.sender;
      this._disconnectSocket(webContents.id);
      const { clientId, joinProjectResponse } = session.connectClient(
        (eventName, args) => {
          if (!webContents.isDestroyed()) {
            webContents.send("socket:event", eventName, args);
          }
        },
      );
      this.socketClients.set(webContents.id, { session, clientId });
      return { clientId, joinProjectResponse };
    });

    handle("socket:emit", async (event, eventName, args) => {
      const client = this.socketClients.get(event.sender.id);
      if (!client) return [{ message: "not connected" }];
      return await client.session.handleSocketEvent(
        client.clientId,
        String(eventName),
        Array.isArray(args) ? args : [],
      );
    });

    ipcMain.on("socket:disconnect", (event) => {
      if (trusted(event)) this._disconnectSocket(event.sender.id);
    });

    handle("app:open-folder-dialog", (event) =>
      this.chooseAndOpenFolder(windowOf(event)),
    );
    handle("app:open-folder", (event, folderPath) =>
      this.openFolder(String(folderPath), { win: windowOf(event) }),
    );
    handle("app:get-recent-folders", () =>
      this.appState.getRecentFolders().map((folderPath) => ({
        path: folderPath,
        name: Path.basename(folderPath),
        exists: fs.existsSync(folderPath),
      })),
    );
    handle("app:remove-recent-folder", (_event, folderPath) => {
      this.appState.removeRecentFolder(String(folderPath));
      this.refreshMenu();
    });
    handle("app:reveal", (event, relPath) => {
      const session = sessionOf(event);
      if (!session) return;
      const absPath = safeJoin(session.rootPath, String(relPath || ""));
      if (absPath && fs.existsSync(absPath)) shell.showItemInFolder(absPath);
    });
    handle("app:open-path", async (event, relPath) => {
      const session = sessionOf(event);
      if (!session) return;
      const absPath = safeJoin(session.rootPath, String(relPath || ""));
      if (absPath && fs.existsSync(absPath)) await shell.openPath(absPath);
    });
    handle("app:get-tex-status", () => this.texStatus());
    handle("app:choose-tex-directory", (event) =>
      this.chooseTexDirectory(windowOf(event)),
    );
    handle("app:reset-tex-directory", () => {
      this.appState.store.set("texBinDir", "");
      resetTexCache();
      return this.texStatus();
    });
    handle("app:get-info", () => ({
      name: APP_NAME,
      version: app.getVersion(),
      platform: process.platform,
    }));
  }

  _disconnectSocket(webContentsId) {
    const client = this.socketClients.get(webContentsId);
    if (!client) return;
    this.socketClients.delete(webContentsId);
    client.session.disconnectClient(client.clientId);
  }

  // --------------------------------------------------------- localleaf:// URLs

  async _handleRequest(request) {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return notFound();
    }
    if (url.host !== "app") return notFound();
    const pathname = decodeURIComponent(url.pathname);

    try {
      if (request.method === "GET") {
        if (
          pathname === "/" ||
          pathname === "/project" ||
          pathname === "/project/"
        ) {
          return this._html(
            renderWelcomePage({
              appState: this.appState,
              manifest: this.manifest,
              config: this.config,
              origin: ORIGIN,
              prefersDark: nativeTheme.shouldUseDarkColors,
            }),
          );
        }
        const match = PROJECT_URL_RE.exec(pathname);
        if (match) {
          const session = this.sessions.get(match[1]);
          if (!session) {
            // e.g. a stale window: back to the start page
            return Response.redirect(`${ORIGIN}/project`, 302);
          }
          return this._html(
            renderEditorPage({
              session,
              appState: this.appState,
              manifest: this.manifest,
              config: this.config,
              origin: ORIGIN,
              detachRole: match[2] || "",
            }),
          );
        }
        if (pathname === "/socket.io/socket.io.js") {
          return await serveFile(SOCKET_SHIM, request);
        }
      }

      const apiResponse = await handleApiRequest({ request, url, app: this });
      if (apiResponse) return apiResponse;

      if (request.method === "GET" || request.method === "HEAD") {
        const absPath = safeJoin(rendererDir(), pathname);
        if (
          absPath &&
          fs.existsSync(absPath) &&
          fs.statSync(absPath).isFile()
        ) {
          return await serveFile(absPath, request, {
            immutable: HASHED_ASSET_RE.test(pathname),
          });
        }
      }
      if (process.env.LOCALLEAF_DEBUG) {
        console.warn(`[404] ${request.method} ${url.pathname}${url.search}`);
      }
      return notFound();
    } catch (error) {
      console.error(`request failed: ${request.method} ${url.pathname}`, error);
      return text("Internal error", 500);
    }
  }

  _html(html) {
    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        // Everything the page needs is served by the app itself.
        "Content-Security-Policy": [
          "default-src 'self'",
          "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval' blob:",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "font-src 'self' data:",
          "worker-src 'self' blob:",
          "connect-src 'self' data: blob:",
          "frame-src 'self' blob:",
          "object-src 'none'",
          "base-uri 'self'",
        ].join("; "),
      },
    });
  }
}

module.exports = { DesktopApp, registerScheme, SCHEME, ORIGIN };
