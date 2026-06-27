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
process needs no IPC, so every UI library is a build-time `devDependency` and
the packaged app's `node_modules` is empty.

## What differs from mobile

- **Camera scan → file upload.** Desktops have no document-scanner camera, so
  the `scan` screen is replaced by `upload` — a drag-and-drop / file-picker
  page that uploads one or more image (or PDF) files as pages.
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

Produces `.deb` + `.AppImage` on Linux and `.exe` (NSIS) on Windows, under
`apps/desktop/release/`.

## Release

Releases are cut by hand from the **desktop-release** GitHub Actions workflow
(`.github/workflows/desktop-release.yml`). Run it from the Actions tab →
*desktop-release* → **Run workflow**, then provide:

- **bump** — `patch` / `minor` / `major` (semver bump from the current version).
- **notes** — the release notes for this version. **Required** — write what
  changed (a short changelog) so every release has a record. This text becomes
  the GitHub release body.

The workflow then:

1. Bumps the version in `apps/desktop/package.json` and commits it back to
   `master` (`chore(desktop): release vX.Y.Z [skip ci]`).
2. Builds the Windows + Linux installers from that commit with electron-builder.
3. Publishes them to two GitHub Releases:
   - **`desktop-v<X.Y.Z>`** — immutable, with your release notes; the version
     history.
   - **`desktop-latest`** — rolling pointer to the newest build (stable
     download URL).

There is no auto-updater and no code signing yet — users download the installer
from the release page.

## App icons

Source icons live in `build/` (`icon.png` 512×512 for Linux, `icon.ico` for
Windows, `icon.icns` for macOS) and are referenced from the `build` field in
`package.json`.
