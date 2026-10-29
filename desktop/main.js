"use strict";

const { app, BrowserWindow, ipcMain, shell, dialog, safeStorage } = require("electron");
const path = require("path");
const fs = require("fs");
const { MuseServer } = require("../src/server");

let mainWindow = null;
let museServer = null;

function resolveDataDir() {
  const localDir = path.resolve(__dirname, "..", "data");
  try {
    if (!app.isPackaged) {
      fs.mkdirSync(localDir, { recursive: true });
      return localDir;
    }
  } catch (_err) {
    // fallback
  }

  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portableDir) {
    try {
      const d = path.join(portableDir, "muse-studio-data");
      fs.mkdirSync(d, { recursive: true });
      return d;
    } catch (_err) {
      // fallback
    }
  }

  const userDir = path.join(app.getPath("userData"), "data");
  fs.mkdirSync(userDir, { recursive: true });
  return userDir;
}

// OS-keychain-backed (Keychain / DPAPI / libsecret) encryption for cookies at rest.
function buildSecureStore() {
  try {
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      return {
        available: true,
        encrypt: (text) => safeStorage.encryptString(text),
        decrypt: (buf) => safeStorage.decryptString(buf),
      };
    }
  } catch (_err) {
    // fall through to plaintext
  }
  return { available: false };
}

async function createMainWindow() {
  const dataDir = resolveDataDir();
  museServer = new MuseServer({
    rootDir: path.resolve(__dirname, ".."),
    dataDir,
    port: Number(process.env.MUSE_PORT || 18638),
    secureStore: buildSecureStore(),
  });
  const baseUrl = await museServer.start();

  const isSmokeTest = process.argv.includes("--smoke-test");

  mainWindow = new BrowserWindow({
    width: 1540,
    height: 940,
    minWidth: 1120,
    minHeight: 700,
    show: !isSmokeTest,
    title: "Muse AI Studio — Node.js & shadcn/ui",
    backgroundColor: "#09090b",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url && /^https?:\/\//i.test(url) && !url.includes("127.0.0.1")) {
      shell.openExternal(url).catch(() => {});
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  await mainWindow.loadURL(baseUrl);

  if (isSmokeTest) {
    setTimeout(async () => {
      try {
        const title = await mainWindow.webContents.executeJavaScript("document.title");
        const hasTable = await mainWindow.webContents.executeJavaScript(
          "Boolean(document.querySelector('#batchTableBody'))"
        );
        console.log(JSON.stringify({ smoke: "ok", title, hasTable, baseUrl }));
      } catch (err) {
        console.error("Smoke test error:", err);
        process.exit(1);
      }
      await museServer.stop();
      app.quit();
    }, 1500);
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

ipcMain.handle("embong:open-media-folder", async () => {
  if (museServer && museServer.store && museServer.store.mediaDir) {
    await shell.openPath(museServer.store.mediaDir);
    return { ok: true, path: museServer.store.mediaDir };
  }
  return { ok: false };
});

ipcMain.handle("embong:open-external", async (_evt, url) => {
  if (typeof url === "string" && /^https?:\/\//i.test(url)) {
    await shell.openExternal(url);
    return { ok: true };
  }
  return { ok: false };
});

ipcMain.handle("embong:choose-download-folder", async (_evt, defaultPath = "") => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: "Chọn thư mục xuất Video / Ảnh hàng loạt",
    properties: ["openDirectory", "createDirectory"],
    ...(defaultPath && fs.existsSync(defaultPath) ? { defaultPath } : {}),
  });
  if (res.canceled || !res.filePaths.length) return { canceled: true };
  return { canceled: false, folderPath: res.filePaths[0] };
});

ipcMain.handle("embong:export-media-files", async (_evt, { filenames = [], targetDir = "" }) => {
  if (!museServer || !targetDir) return { ok: false, error: "Thiếu thư mục đích" };
  // A remembered folder may have been moved/deleted; report it so the UI can re-prompt.
  if (!fs.existsSync(targetDir)) return { ok: false, error: "Thư mục đích không còn tồn tại" };
  let copied = 0;
  for (const name of filenames) {
    const safe = path.basename(name);
    const src = path.join(museServer.store.mediaDir, safe);
    const dest = path.join(targetDir, safe);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      copied += 1;
    }
  }
  await shell.openPath(targetDir);
  return { ok: true, copied };
});

app.whenReady().then(() => {
  createMainWindow().catch((err) => {
    console.error("Failed to launch Muse AI Studio:", err);
    app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow().catch((err) => {
        console.error("Failed to re-open Muse AI Studio on macOS:", err);
      });
    }
  });
});

app.on("window-all-closed", async () => {
  if (process.platform !== "darwin") {
    if (museServer) {
      await museServer.stop();
    }
    app.quit();
  }
});
