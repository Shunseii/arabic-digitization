// Electron main process. The renderer is the Vite-built React app in dist/
// (or the dev server in development) — it talks to the Cloudflare Worker over
// fetch, so the main process needs no IPC, just a window. Chosen over a system
// webview because Chromium shapes Arabic far better than Linux WebKitGTK.
const { app, BrowserWindow, shell } = require("electron");
const path = require("node:path");

// The app name becomes the window identity Linux uses to match the window to its
// installed .desktop file — the X11 WM_CLASS and, crucially on Wayland (GNOME,
// COSMIC), the xdg app_id. It must equal the .desktop basename ("qiraa.desktop")
// or the compositor can't associate the window and shows no icon / the raw id.
// The user-facing name stays Arabic — that comes from the .desktop `Name`, not
// this identifier.
app.setName("qiraa");
// Renaming the app would move userData to ~/.config/qiraa and drop existing
// settings (Meili creds, master key in localStorage). Pin it to the previous
// capitalized dir so they survive.
app.setPath("userData", path.join(app.getPath("appData"), "Qiraa"));

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
