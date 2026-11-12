"use strict";
const fs = require("node:fs");
const Path = require("node:path");
const { app, BrowserWindow, dialog } = require("electron");

// A separate data folder can be given for tests and side-by-side installs.
if (process.env.LOCALLEAF_USER_DATA) {
  app.setPath("userData", Path.resolve(process.env.LOCALLEAF_USER_DATA));
}

const { DesktopApp, registerScheme } = require("./DesktopApp");
const { APP_NAME } = require("./server/html");

registerScheme();
app.setName(APP_NAME);
app.setAboutPanelOptions({
  applicationName: APP_NAME,
  applicationVersion: app.getVersion(),
  credits:
    "An offline, folder-based LaTeX editor built from the Overleaf Community Edition editor. Not affiliated with or endorsed by Overleaf.",
  copyright:
    "Based on Overleaf, © Overleaf and contributors. Licensed under the GNU AGPL v3.",
});

/** Folders named on the command line: `LocalLeaf path/to/project`. */
function foldersFromArgv(argv, cwd = process.cwd()) {
  // argv[0] is the executable. When run from source (`electron <app dir>`),
  // the first non-option argument is the app itself.
  const args = argv.slice(1).filter((arg) => arg && !arg.startsWith("-"));
  if (!app.isPackaged) args.shift();
  const folders = [];
  for (const arg of args) {
    const candidate = Path.resolve(cwd, arg);
    if (fs.existsSync(candidate)) folders.push(candidate);
  }
  return folders;
}

let desktop = null;
// Folders requested before the app finished starting (macOS open-file).
const pendingFolders = [];

function openFolders(folders) {
  if (!desktop) {
    pendingFolders.push(...folders);
    return;
  }
  for (const folder of folders) {
    desktop.openFolder(folder).catch((error) => {
      dialog.showErrorBox(
        "Could not open folder",
        `${folder}\n\n${error.message}`,
      );
    });
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv, workingDirectory) => {
    const folders = foldersFromArgv(argv, workingDirectory);
    if (folders.length > 0) {
      openFolders(folders);
    } else if (desktop) {
      const [win] = BrowserWindow.getAllWindows();
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
      } else {
        desktop.showWelcomeWindow();
      }
    }
  });

  // macOS: a folder dropped on the Dock icon, `open -a`, or "Open Recent" in
  // the Dock menu.
  app.on("open-file", (event, path) => {
    event.preventDefault();
    openFolders([path]);
  });

  app.whenReady().then(async () => {
    desktop = new DesktopApp();
    await desktop.start();
    const folders = [...pendingFolders, ...foldersFromArgv(process.argv)];
    pendingFolders.length = 0;
    if (folders.length > 0) {
      const results = await Promise.all(
        folders.map((folder) => desktop.openFolder(folder).catch(() => false)),
      );
      if (!results.some(Boolean)) desktop.showWelcomeWindow();
    } else {
      desktop.showWelcomeWindow();
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        desktop.showWelcomeWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
