// Auto-update from the rolling `desktop-latest` GitHub release. Never
// /releases/latest: GitHub's "Latest" is the newest v* release, which has no
// desktop assets when a release didn't change the desktop app.
//   Windows: electron-updater (generic provider) reads latest.yml and installs
//            the NSIS update.
//   Linux:   updater-linux.cjs, only for installs made by install-desktop.sh.
const { app, dialog, net } = require("electron");
const {
  checkForLinuxUpdate,
  resolveRelaunchCommand,
} = require("./updater-linux.cjs");

const FEED_URL =
  "https://github.com/Shunseii/arabic-digitization/releases/download/desktop-latest";
const FIRST_CHECK_DELAY_MS = 15 * 1000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// For testing against a local feed, or a mirror (same idea as the install
// script's QIRAA_DOWNLOAD_BASE).
const feedUrl = () =>
  (process.env.QIRAA_UPDATE_BASE || FEED_URL).replace(/\/+$/, "");

const log = (message) => console.log(`[updater] ${message}`);

const describeError = (error) =>
  error instanceof Error ? error.message : String(error);

const askToRestart = async (version) => {
  const { response } = await dialog.showMessageBox({
    type: "info",
    title: "رقمنة",
    message: `Version ${version} is ready`,
    detail:
      "Restart رقمنة to start using it. If you choose Later, it's used the next time you open the app.",
    buttons: ["Restart now", "Later"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  return response === 0;
};

const createWindowsUpdater = () => {
  const { autoUpdater } = require("electron-updater");
  autoUpdater.setFeedURL({ provider: "generic", url: feedUrl() });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} };

  const prompted = new Set();
  autoUpdater.on("update-downloaded", async ({ version }) => {
    if (prompted.has(version)) return;
    prompted.add(version);
    if (await askToRestart(version)) autoUpdater.quitAndInstall();
  });
  // checkForUpdates rejects with the same error; the scheduler logs it.
  autoUpdater.on("error", () => {});

  return async () => {
    const result = await autoUpdater.checkForUpdates();
    await result?.downloadPromise;
  };
};

const createLinuxUpdater = () => {
  const prompted = new Set();
  return async () => {
    const result = await checkForLinuxUpdate({
      currentVersion: app.getVersion(),
      execPath: process.execPath,
      baseUrl: feedUrl(),
      fetchImpl: net.fetch,
      log,
    });
    if (result.status !== "ready" || prompted.has(result.version)) return;
    prompted.add(result.version);
    if (!(await askToRestart(result.version))) return;
    process.env.CHROME_DESKTOP ||= "qiraa.desktop";
    app.relaunch({
      execPath: resolveRelaunchCommand({}),
      args: process.argv.slice(1),
    });
    app.quit();
  };
};

const createPlatformUpdater = () => {
  if (process.platform === "win32") return createWindowsUpdater();
  if (process.platform === "linux") return createLinuxUpdater();
  return null;
};

const startAutoUpdates = () => {
  if (!app.isPackaged) return;
  const check = createPlatformUpdater();
  if (!check) return;

  let running = false;
  const runCheck = async () => {
    if (running) return;
    running = true;
    try {
      await check();
    } catch (error) {
      log(`update check failed: ${describeError(error)}`);
    } finally {
      running = false;
    }
  };

  setTimeout(runCheck, FIRST_CHECK_DELAY_MS);
  setInterval(runCheck, CHECK_INTERVAL_MS);
};

module.exports = { startAutoUpdates };
