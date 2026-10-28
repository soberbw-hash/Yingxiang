const { contextBridge, ipcRenderer, webUtils } = require("electron");
const methods = new Set([
  "editReference",
  "editAssetStack",
  "bootstrap",
  "createProject",
  "openProject",
  "selectProject",
  "listProjectBackups",
  "createProjectBackup",
  "restoreProjectBackup",
  "importFiles",
  "pickFiles",
  "transferAssets",
  "updateAssets",
  "trashAssets",
  "restoreAssets",
  "createShot",
  "updateShot",
  "deleteShot",
  "saveSettings",
  "chooseInbox",
  "exportProject",
  "revealAsset",
  "readDocument",
  "fetchRemote",
]);
contextBridge.exposeInMainWorld("weaveDesktop", {
  startAssetDrag(projectId, assetId) {
    ipcRenderer.send("weave:drag-asset", { projectId, assetId });
  },
  invoke(method, payload = {}) {
    if (!methods.has(method))
      return Promise.reject(new Error("Unknown desktop method"));
    return ipcRenderer.invoke("weave:invoke", method, payload);
  },
  onChanged(callback) {
    if (typeof callback !== "function")
      throw new TypeError("Expected callback");
    const listener = (_event, change) => callback(change);
    ipcRenderer.on("weave:changed", listener);
    return () => ipcRenderer.removeListener("weave:changed", listener);
  },
  droppedFilePath(file) {
    return webUtils.getPathForFile(file);
  },
  checkForUpdates: () => ipcRenderer.invoke("update:check"),
  downloadUpdate: () => ipcRenderer.invoke("update:download"),
  openUpdate: (filePath) => ipcRenderer.invoke("update:open", filePath),
  onUpdate(callback) {
    if (typeof callback !== "function")
      throw new TypeError("Expected update callback");
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("weave:update", listener);
    return () => ipcRenderer.removeListener("weave:update", listener);
  },
});
contextBridge.exposeInMainWorld("weave", {
  chooseFolder: () => ipcRenderer.invoke("inbox:choose-folder"),
  exportProject: (payload) => ipcRenderer.invoke("project:export", payload),
  onInboxFile(callback) {
    const listener = (_event, change) => {
      if (change.reason === "inbox.imported")
        change.snapshot?.assets.filter((a) => !a.trashedAt).forEach(callback);
    };
    ipcRenderer.on("weave:changed", listener);
    return () => ipcRenderer.removeListener("weave:changed", listener);
  },
});
