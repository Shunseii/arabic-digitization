# @qiraa/desktop

Electron desktop app for the Qiraa Arabic digitization project — the desktop
companion to `apps/mobile`. Same API, same design language (dark OLED +
manuscript gold), same screens. Runs on **Windows** and **Linux**.

## Stack

- **Electron** shell (`electron/main.cjs`) — chosen over a system webview
  because Chromium shapes Arabic far better than Linux WebKitGTK.
- **React 19 + Vite 6 + TypeScript** renderer, bundled to `dist/`.
- **Tailwind CSS 3** with the exact color tokens from the mobile app.
- **TanStack Query** for server state, **react-router** (`HashRouter`, so the
  SPA loads correctly under `file://` in the packaged app) for navigation.
- **Noto Naskh Arabic**, self-hosted via `@fontsource` (bundled into `dist/`,
  so it works offline and satisfies the `'self'` CSP).
- Shared `@qiraa/shared` types and a ported copy of the mobile API client,
  markdown renderer, and theme.

The renderer talks to the deployed Cloudflare Worker with a plain `fetch`. The
Worker sends a wildcard CORS header (`Access-Control-Allow-Origin: *`), so calls
from the `file://` (prod) and `localhost` (dev) origins are allowed. The main
process needs no IPC, so every UI library is a build-time `devDependency`. The
packaged app's `node_modules` holds only `electron-updater`, the one runtime
`dependency`.

## What differs from mobile

- **Camera scan → file upload.** Desktops have no document-scanner camera, so
  the `scan` screen is replaced by `upload` — a drag-and-drop / file-picker
  page that uploads one or more image files (JPEG, PNG, WebP) as pages.
- **Bottom tab bar → left sidebar.** Same sections (Library / Activity /
  Settings), same icons and accent, laid out for a wide window.
- **Reader swipe → side-by-side panes.** Transcription and scan show together;
  the scan pane zooms with the scroll wheel, pans by drag, double-click resets.
- **Credentials** live in the webview's `localStorage` instead of the mobile OS
  keychain. Set them under **Settings**.

## Develop

```sh
# from the repo root
pnpm install
pnpm desktop          # starts Vite + the Electron window (with DevTools)
```

Or frontend-only in a browser (no native shell):

```sh
pnpm --filter @qiraa/desktop dev   # http://localhost:1420
```

## Build installers

```sh
pnpm desktop:build    # = vite build + electron-builder
```

Produces `.deb` + `.AppImage` on Linux and `Qiraa-Setup-<version>.exe` (NSIS)
plus `latest.yml` and the `.exe.blockmap` on Windows, under
`apps/desktop/release/`.

## Release

Releases run when a GitHub release with a version tag is published (see
"Releasing" in the root README and `.github/workflows/release.yml`):

```bash
gh release create v0.6.0 --title "v0.6.0" --notes "What changed"
```

The workflow stamps the tag's version into `apps/desktop/package.json` for the
build (nothing is committed back), builds the Windows + Linux installers,
attaches them to that release, and recreates the rolling **`desktop-latest`**
release (stable download URL). The same run publishes the mobile OTA update.
Each app is skipped when nothing it's built from changed since the last
release that shipped it.

Install and update: see "Desktop app" in the root README (Linux:
`scripts/install-desktop.sh`, published on `desktop-latest`; Windows: the
Setup `.exe`). There is no code signing yet, so Windows SmartScreen may warn
on the first install.

## Auto-update

`electron/updater.cjs` starts when the app is packaged. It checks the
`desktop-latest` release 15 seconds after launch and every 6 hours, one check
at a time, silently when up to date or offline. When a newer version is ready
it asks "Restart now" / "Later".

- **Windows:** `electron-updater` with the generic provider reads `latest.yml`
  from `desktop-latest` and downloads the Setup `.exe` in the background. Later
  installs it when the app quits.
- **Linux:** `electron/updater-linux.cjs`, only when the app runs from
  `<XDG_DATA_HOME or ~/.local/share>/qiraa-app/releases/<version>/` (an
  `install-desktop.sh` install). It reads `qiraa-desktop-version.txt`,
  downloads `Qiraa-x86_64.AppImage` into a staging dir inside `qiraa-app/`,
  checks it against `qiraa-desktop-checksums.txt`, extracts it, checks the
  version inside, moves it to `releases/<version>`, swaps `current` atomically
  and prunes to the new version plus the running one. On any failure it logs
  and leaves the install as it was. Restart now runs `~/.local/bin/qiraa-app`.
  electron-updater's AppImage updater doesn't apply, because the app runs
  extracted rather than as an AppImage. The `.deb`, a raw AppImage and dev
  runs don't update.

To try it against a local feed, set `QIRAA_UPDATE_BASE` to a URL that serves
the same files as `desktop-latest`. The pure helpers have unit tests:

```sh
pnpm --filter @qiraa/desktop test
```

## App icons

Source icons live in `build/` (`icon.png` 512×512 for Linux, `icon.ico` for
Windows, `icon.icns` for macOS) and are referenced from the `build` field in
`package.json`.
