"use strict";

const { contextBridge, ipcRenderer, webFrame } = require("electron");

contextBridge.exposeInMainWorld("embongDesktop", {
  isDesktop: true,
  openMediaFolder: () => ipcRenderer.invoke("embong:open-media-folder"),
  openExternal: (url) => ipcRenderer.invoke("embong:open-external", url),
  chooseDownloadFolder: (defaultPath) =>
    ipcRenderer.invoke("embong:choose-download-folder", defaultPath || ""),
  chooseSyncSource: (mode) =>
    ipcRenderer.invoke("embong:choose-sync-source", mode || "folder"),
  exportMediaFiles: (payload) => ipcRenderer.invoke("embong:export-media-files", payload),
  setZoomFactor: (factor) => {
    const f = Math.min(1.5, Math.max(0.6, Number(factor) || 1));
    webFrame.setZoomFactor(f);
    return f;
  },
  getZoomFactor: () => webFrame.getZoomFactor(),
});

