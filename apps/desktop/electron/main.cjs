// Electron main process. The renderer is the Vite-built React app in dist/
// (or the dev server in development) — it talks to the Cloudflare Worker over
// fetch, so the main process needs no IPC, just a window. Chosen over a system
// webview because Chromium shapes Arabic far better than Linux WebKitGTK.
const { app, BrowserWindow, shell } = require("electron");
const path = require("node:path");

// Sets app.getName(), and on Linux the window's WM_CLASS — which must match the
// .desktop file's StartupWMClass (electron-builder writes "Qiraa") or the dock
// shows the raw class ("@qiraa/desktop") and finds no icon.
app.setName("Qiraa");

const isDev = !app.isPackaged;
const DEV_URL = "http://localhost:1420";

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#0C0D10",
    title: "رقمنة",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // External links open in the user's browser, never a new Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  if (isDev) {
    win.loadURL(DEV_URL);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    // base: "./" + HashRouter make the SPA load correctly under file://.
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
};

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
