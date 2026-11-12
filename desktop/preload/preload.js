"use strict";
/*
 * Runs in every window before the page. Exposes a small, fixed API to the
 * page; the page itself has no access to Node.js or Electron.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("localleafBridge", {
  // ---- the editor's "websocket" (see desktop/shims/socket.io.js)
  socketConnect: (projectId) => ipcRenderer.invoke("socket:connect", projectId),
  socketDisconnect: () => ipcRenderer.send("socket:disconnect"),
  socketEmit: (eventName, args) =>
    ipcRenderer.invoke("socket:emit", eventName, args),
  onSocketEvent: (handler) => {
    ipcRenderer.on("socket:event", (_event, eventName, args) => {
      handler(eventName, args);
    });
  },

  // ---- desktop features used by the welcome page and the editor add-ons
  openFolderDialog: () => ipcRenderer.invoke("app:open-folder-dialog"),
  openFolder: (folderPath) => ipcRenderer.invoke("app:open-folder", folderPath),
  getRecentFolders: () => ipcRenderer.invoke("app:get-recent-folders"),
  removeRecentFolder: (folderPath) =>
    ipcRenderer.invoke("app:remove-recent-folder", folderPath),
  revealInFinder: (relPath) => ipcRenderer.invoke("app:reveal", relPath),
  openInDefaultApp: (relPath) => ipcRenderer.invoke("app:open-path", relPath),
  getTexStatus: () => ipcRenderer.invoke("app:get-tex-status"),
  chooseTexDirectory: () => ipcRenderer.invoke("app:choose-tex-directory"),
  resetTexDirectory: () => ipcRenderer.invoke("app:reset-tex-directory"),
  getAppInfo: () => ipcRenderer.invoke("app:get-info"),
  onCommand: (handler) => {
    ipcRenderer.on("app:command", (_event, command, payload) => {
      handler(command, payload);
    });
  },
});
