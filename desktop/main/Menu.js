"use strict";
const Path = require("node:path");
const { app, BrowserWindow, Menu, shell } = require("electron");
const { APP_NAME } = require("./server/html");

// Interface languages that Overleaf ships translations for.
const LANGUAGES = [
  ["en", "English"],
  ["zh-CN", "简体中文"],
  ["cs", "Čeština"],
  ["da", "Dansk"],
  ["de", "Deutsch"],
  ["es", "Español"],
  ["fi", "Suomi"],
  ["fr", "Français"],
  ["it", "Italiano"],
  ["ja", "日本語"],
  ["ko", "한국어"],
  ["nl", "Nederlands"],
  ["no", "Norsk"],
  ["pl", "Polski"],
  ["pt", "Português"],
  ["ru", "Русский"],
  ["sv", "Svenska"],
  ["tr", "Türkçe"],
];

/** @param {import('./DesktopApp').DesktopApp} desktop */
function buildMenu(desktop) {
  const isMac = process.platform === "darwin";
  const focused = () => BrowserWindow.getFocusedWindow();
  const editorWindow = () => {
    const win = focused();
    return win && win.localleafRole === "editor" ? win : null;
  };
  const hasEditor = Boolean(
    BrowserWindow.getAllWindows().some((win) => win.localleafRole === "editor"),
  );
  const available = new Set(desktop.config.translatedLanguages || ["en"]);

  const recentFolders = desktop.appState.getRecentFolders();
  const recentItems = recentFolders.length
    ? [
        ...recentFolders.map((folderPath) => ({
          label: `${Path.basename(folderPath)} — ${Path.dirname(folderPath)}`,
          click: () => desktop.openFolder(folderPath, { win: focused() }),
        })),
        { type: "separator" },
        {
          label: "Clear Menu",
          click: () => {
            desktop.appState.clearRecentFolders();
            app.clearRecentDocuments();
            desktop.refreshMenu();
          },
        },
      ]
    : [{ label: "No Recent Folders", enabled: false }];

  const languageItems = LANGUAGES.filter(([code]) => available.has(code)).map(
    ([code, label]) => ({
      label,
      type: "radio",
      checked: desktop.appState.language === code,
      click: () => {
        desktop.appState.language = code;
        desktop.reloadAllWindows();
        desktop.refreshMenu();
      },
    }),
  );

  const texItem = {
    label: "TeX Distribution…",
    click: () => desktop.showTexDialog(focused()),
  };

  const template = [
    ...(isMac
      ? [
          {
            label: APP_NAME,
            submenu: [
              { role: "about" },
              { type: "separator" },
              texItem,
              { label: "Language", submenu: languageItems },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "Open Folder…",
          accelerator: "CmdOrCtrl+O",
          click: () => desktop.chooseAndOpenFolder(focused()),
        },
        { label: "Open Recent", submenu: recentItems },
        {
          label: "New Window",
          accelerator: "CmdOrCtrl+Shift+N",
          click: () => desktop.showWelcomeWindow(),
        },
        { type: "separator" },
        {
          label: isMac ? "Reveal Folder in Finder" : "Show Folder",
          enabled: hasEditor,
          click: () => {
            const session = desktop.getSession(
              editorWindow()?.localleafProjectId,
            );
            if (session) shell.openPath(session.rootPath);
          },
        },
        { type: "separator" },
        { role: isMac ? "close" : "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
      ],
    },
    ...(isMac
      ? [{ role: "windowMenu" }]
      : [
          {
            label: "Settings",
            submenu: [texItem, { label: "Language", submenu: languageItems }],
          },
        ]),
    {
      role: "help",
      submenu: [
        {
          label: "LaTeX Documentation (overleaf.com, opens browser)",
          click: () => shell.openExternal("https://www.overleaf.com/learn"),
        },
        {
          label: "About the Overleaf Project (opens browser)",
          click: () =>
            shell.openExternal("https://github.com/overleaf/overleaf"),
        },
        ...(isMac ? [] : [{ type: "separator" }, { role: "about" }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildMenu, LANGUAGES };
