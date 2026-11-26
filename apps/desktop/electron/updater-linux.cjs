// Self-update for Linux installs made by scripts/install-desktop.sh, which
// extracts the AppImage to <data>/qiraa-app/releases/<version> and points
// <data>/qiraa-app/current at it. electron-updater's AppImage updater can't
// help here: the app doesn't run as an AppImage. This module has no Electron
// imports so it can be run and tested from plain Node.
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const APPIMAGE_ASSET = "Qiraa-x86_64.AppImage";
const CHECKSUMS_ASSET = "qiraa-desktop-checksums.txt";
const VERSION_ASSET = "qiraa-desktop-version.txt";
const APP_BINARY = "qiraa";
const STAGING_PREFIX = ".update-";
const STALE_STAGING_MS = 24 * 60 * 60 * 1000;
const MANIFEST_TIMEOUT_MS = 30 * 1000;
const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000;
const EXTRACT_TIMEOUT_MS = 5 * 60 * 1000;

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const parseVersion = (text) => {
  const match = SEMVER.exec(text);
  if (!match) return null;
  const [, major, minor, patch, prerelease] = match;
  return {
    core: [Number(major), Number(minor), Number(patch)],
    prerelease: prerelease ? prerelease.split(".") : [],
  };
};

const isNumericIdentifier = (identifier) => /^\d+$/.test(identifier);

const comparePrereleaseIdentifiers = (a, b) => {
  const aNumeric = isNumericIdentifier(a);
  const bNumeric = isNumericIdentifier(b);
  if (aNumeric && bNumeric) return Math.sign(Number(a) - Number(b));
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

// Semver 2.0 precedence: -1 if a < b, 0 if equal, 1 if a > b.
const compareVersions = (a, b) => {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new Error(`not a semver version: ${left ? b : a}`);

  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i])
      return left.core[i] < right.core[i] ? -1 : 1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return Math.sign(right.prerelease.length - left.prerelease.length);
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < length; i++) {
    if (left.prerelease[i] === undefined) return -1;
    if (right.prerelease[i] === undefined) return 1;
    const order = comparePrereleaseIdentifiers(
      left.prerelease[i],
      right.prerelease[i],
    );
    if (order !== 0) return order;
  }
  return 0;
};

const parseVersionManifest = (text) => {
  const version = text.trim();
  if (!parseVersion(version) || version.includes("+")) {
    throw new Error(
      `${VERSION_ASSET} holds no valid version: ${JSON.stringify(text.slice(0, 64))}`,
    );
  }
  return version;
};

// sha256sum output: "<hex>  <name>" (text mode) or "<hex> *<name>" (binary).
const findChecksum = ({ checksums, fileName }) => {
  for (const line of checksums.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim());
    if (match && match[2] === fileName) return match[1].toLowerCase();
  }
  return null;
};

const parseDesktopEntryVersion = (desktopEntry) => {
  const match = /^X-AppImage-Version=(.+)$/m.exec(desktopEntry);
  return match ? match[1].trim() : null;
};

// Keep the release `current` points at and the one the app runs from; when
// they're the same, also keep the newest other version as the fallback.
const selectReleasesToPrune = ({ releases, current, running }) => {
  const keep = new Set([current, running].filter(Boolean));
  const others = releases
    .filter((name) => !keep.has(name))
    .sort((a, b) => {
      const aValid = parseVersion(a) !== null;
      const bValid = parseVersion(b) !== null;
      if (aValid !== bValid) return aValid ? -1 : 1;
      return aValid ? compareVersions(b, a) : a.localeCompare(b);
    });
  if (keep.size < 2 && others.length > 0 && parseVersion(others[0])) {
    keep.add(others[0]);
  }
  return releases.filter((name) => !keep.has(name));
};

const resolveInstallLayout = ({ env, homeDir }) => {
  const dataHome = env.XDG_DATA_HOME || path.join(homeDir, ".local", "share");
  const appDir = path.join(dataHome, "qiraa-app");
  return {
    appDir,
    releasesDir: path.join(appDir, "releases"),
    currentLink: path.join(appDir, "current"),
    launcher: path.join(homeDir, ".local", "bin", "qiraa-app"),
  };
};

const realpathOrNull = (target) => {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
};

// The install script's layout, or null when the app runs from anywhere else
// (dev, the .deb, a raw AppImage), where self-update must not touch anything.
const detectManagedInstall = ({ execPath, env, homeDir }) => {
  const layout = resolveInstallLayout({ env, homeDir });
  const releasesDir = realpathOrNull(layout.releasesDir);
  const binary = realpathOrNull(execPath);
  if (!releasesDir || !binary) return null;
  const releaseDir = path.dirname(binary);
  if (
    path.dirname(releaseDir) !== releasesDir ||
    path.basename(binary) !== APP_BINARY
  ) {
    return null;
  }
  return { ...layout, releasesDir, runningRelease: path.basename(releaseDir) };
};

const fetchOk = async ({ fetchImpl, url, timeoutMs }) => {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok)
    throw new Error(`GET ${url} failed: HTTP ${response.status}`);
  return response;
};

const fetchText = async ({ fetchImpl, url }) => {
  const response = await fetchOk({
    fetchImpl,
    url,
    timeoutMs: MANIFEST_TIMEOUT_MS,
  });
  return response.text();
};

const downloadToFile = async ({ fetchImpl, url, destination }) => {
  const response = await fetchOk({
    fetchImpl,
    url,
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
  });
  if (!response.body) throw new Error(`GET ${url} returned no body`);
  await pipeline(
    Readable.fromWeb(response.body),
    fs.createWriteStream(destination),
  );
};

const sha256OfFile = async (file) => {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
};

const extractAppImage = ({ appImage, cwd }) =>
  new Promise((resolve, reject) => {
    const child = spawn(appImage, ["--appimage-extract"], {
      cwd,
      stdio: "ignore",
      timeout: EXTRACT_TIMEOUT_MS,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `AppImage extraction failed (code ${code}, signal ${signal})`,
          ),
        );
    });
  });

const isExecutableFile = async (file) => {
  try {
    await fsp.access(file, fs.constants.X_OK);
    return (await fsp.stat(file)).isFile();
  } catch {
    return false;
  }
};

const removeStaleStagingDirs = async (appDir) => {
  const entries = await fsp.readdir(appDir, { withFileTypes: true });
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.name.startsWith(STAGING_PREFIX)) continue;
    const full = path.join(appDir, entry.name);
    const { mtimeMs } = await fsp.lstat(full);
    if (now - mtimeMs > STALE_STAGING_MS)
      await fsp.rm(full, { recursive: true, force: true });
  }
};

// A temp symlink renamed over `current` swaps it atomically: there is never a
// moment without a valid `current`.
const repointCurrent = async ({ appDir, currentLink, target }) => {
  const tempLink = path.join(
    appDir,
    `${STAGING_PREFIX}link-${crypto.randomUUID()}`,
  );
  await fsp.symlink(target, tempLink);
  try {
    await fsp.rename(tempLink, currentLink);
  } catch (error) {
    await fsp.rm(tempLink, { force: true });
    throw error;
  }
};

// The staging dir sits inside appDir (same filesystem), so moving the extracted
// tree into releases/ is a single atomic rename.
const installRelease = async ({ extracted, target, staging }) => {
  try {
    await fsp.rename(extracted, target);
    return;
  } catch (error) {
    if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
  }
  // A leftover dir for this version (e.g. a copy the install script was
  // interrupted writing): set it aside, then move ours in.
  await fsp.rename(target, path.join(staging, "replaced"));
  await fsp.rename(extracted, target);
};

const pruneReleases = async ({
  releasesDir,
  currentLink,
  runningRelease,
  log,
}) => {
  const current = path.basename(fs.realpathSync(currentLink));
  const entries = await fsp.readdir(releasesDir, { withFileTypes: true });
  const releases = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const name of selectReleasesToPrune({
    releases,
    current,
    running: runningRelease,
  })) {
    log(`removing old release ${name}`);
    await fsp.rm(path.join(releasesDir, name), {
      recursive: true,
      force: true,
    });
  }
};

// Returns { status: "not-managed" | "up-to-date" } or, when `latest` is in
// place under releases/ and `current` points at it, { status: "ready", version }.
const checkForLinuxUpdate = async ({
  currentVersion,
  execPath,
  env = process.env,
  homeDir = os.homedir(),
  baseUrl,
  fetchImpl = globalThis.fetch,
  log = () => {},
}) => {
  const install = detectManagedInstall({ execPath, env, homeDir });
  if (!install) return { status: "not-managed" };
  const { appDir, releasesDir, currentLink, runningRelease } = install;

  const latest = parseVersionManifest(
    await fetchText({ fetchImpl, url: `${baseUrl}/${VERSION_ASSET}` }),
  );
  if (compareVersions(latest, currentVersion) <= 0)
    return { status: "up-to-date" };

  const target = path.join(releasesDir, latest);
  if (
    realpathOrNull(currentLink) === target &&
    (await isExecutableFile(path.join(target, APP_BINARY)))
  ) {
    return { status: "ready", version: latest };
  }

  log(`downloading ${latest} (running ${currentVersion})`);
  await removeStaleStagingDirs(appDir);
  const staging = await fsp.mkdtemp(path.join(appDir, STAGING_PREFIX));
  try {
    const appImage = path.join(staging, APPIMAGE_ASSET);
    const [checksums] = await Promise.all([
      fetchText({ fetchImpl, url: `${baseUrl}/${CHECKSUMS_ASSET}` }),
      downloadToFile({
        fetchImpl,
        url: `${baseUrl}/${APPIMAGE_ASSET}`,
        destination: appImage,
      }),
    ]);
    const expected = findChecksum({ checksums, fileName: APPIMAGE_ASSET });
    if (!expected)
      throw new Error(`${APPIMAGE_ASSET} is missing from ${CHECKSUMS_ASSET}`);
    const actual = await sha256OfFile(appImage);
    if (actual !== expected) {
      throw new Error(
        `checksum mismatch for ${APPIMAGE_ASSET}: expected ${expected}, got ${actual}`,
      );
    }

    await fsp.chmod(appImage, 0o755);
    await extractAppImage({ appImage, cwd: staging });
    const extracted = path.join(staging, "squashfs-root");
    if (!(await isExecutableFile(path.join(extracted, APP_BINARY)))) {
      throw new Error("the AppImage has no qiraa binary");
    }
    const bundled = parseDesktopEntryVersion(
      await fsp.readFile(path.join(extracted, "qiraa.desktop"), "utf8"),
    );
    if (bundled !== latest) {
      throw new Error(
        `the AppImage holds version ${bundled}, but ${VERSION_ASSET} says ${latest}`,
      );
    }

    await installRelease({ extracted, target, staging });
    await repointCurrent({ appDir, currentLink, target });
    log(`installed ${latest} to ${target}`);
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }

  try {
    await pruneReleases({ releasesDir, currentLink, runningRelease, log });
  } catch (error) {
    log(
      `pruning old releases failed: ${error instanceof Error ? error.message : error}`,
    );
  }
  return { status: "ready", version: latest };
};

// What "Restart now" runs: the launcher (it sets CHROME_DESKTOP and resolves
// `current`), else the new release's binary directly.
const resolveRelaunchCommand = ({
  env = process.env,
  homeDir = os.homedir(),
}) => {
  const { launcher, currentLink } = resolveInstallLayout({ env, homeDir });
  try {
    fs.accessSync(launcher, fs.constants.X_OK);
    return launcher;
  } catch {
    return path.join(fs.realpathSync(currentLink), APP_BINARY);
  }
};

module.exports = {
  checkForLinuxUpdate,
  compareVersions,
  detectManagedInstall,
  findChecksum,
  parseDesktopEntryVersion,
  parseVersionManifest,
  resolveInstallLayout,
  resolveRelaunchCommand,
  selectReleasesToPrune,
};
