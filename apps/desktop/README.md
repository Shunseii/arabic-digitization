# @qiraa/desktop

Tauri desktop app for the Qiraa Arabic digitization project — the desktop
companion to `apps/mobile`. Same API, same design language (dark OLED +
manuscript gold), same screens. Runs on **Windows** and **Linux**.

## Stack

- **Tauri 2** shell (Rust), webview frontend
- **React 19 + Vite 6 + TypeScript**
- **Tailwind CSS 3** with the exact color tokens from the mobile app
- **TanStack Query** for server state, **react-router** for navigation
- Shared `@qiraa/shared` types and a ported copy of the mobile API client,
  markdown renderer, and theme

Requests go through `@tauri-apps/plugin-http` (HTTP from the Rust side), which
bypasses browser CORS — the deployed Worker sets no CORS headers, so a plain
webview `fetch` would be blocked. See `src/lib/http.ts`.

## What differs from mobile

- **Camera scan → file upload.** Desktops have no document-scanner camera, so
  the `scan` screen is replaced by `upload` — a drag-and-drop / file-picker
  page that uploads one or more image (or PDF) files as pages.
- **Bottom tab bar → left sidebar.** Same sections (Library / Activity /
  Settings), same icons and accent, laid out for a wide window.
- **Reader swipe → side-by-side panes.** Transcription and scan show together;
  the scan pane zooms with the scroll wheel, pans by drag, double-click resets.
- **Credentials** live in the webview's `localStorage` (app-private data dir)
  instead of the mobile OS keychain. Set them under **Settings**.

## Develop

```sh
# from the repo root
pnpm install
pnpm desktop          # = tauri dev (starts Vite + the native window)
```

Or frontend-only in a browser (no native shell, HTTP plugin disabled):

```sh
pnpm --filter @qiraa/desktop dev   # http://localhost:1420
```

## Build installers

```sh
pnpm desktop:build    # = tauri build
```

Produces `.deb` + `.AppImage` on Linux and `.exe` (NSIS) on Windows, under
`apps/desktop/src-tauri/target/release/bundle/`.

## Release

Releases are cut by hand from the **desktop-release** GitHub Actions workflow
(`.github/workflows/desktop-release.yml`). Run it from the Actions tab →
*desktop-release* → **Run workflow**, then provide:

- **bump** — `patch` / `minor` / `major` (semver bump from the current version).
- **notes** — the release notes for this version. **Required** — write what
  changed (a short changelog) so every release has a record. This text becomes
  the GitHub release body.

The workflow then:

1. Bumps the version in all three source files — `package.json`,
   `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` — and commits that back
   to `master` (`chore(desktop): release vX.Y.Z [skip ci]`).
2. Builds the Windows + Linux installers from that commit.
3. Publishes them to two GitHub Releases:
   - **`desktop-v<X.Y.Z>`** — immutable, with your release notes; the version
     history.
   - **`desktop-latest`** — rolling pointer to the newest build (stable
     download URL).

Versions are kept in sync by the workflow, so don't bump them by hand. There is
no auto-updater and no code signing yet — users download the installer from the
release page.

## System prerequisites

**Rust** (stable) is required: https://rustup.rs

**Linux (Debian/Ubuntu/Pop!\_OS)** also needs the WebKitGTK + build libraries:

```sh
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf
```

**Windows** needs the Microsoft C++ Build Tools and WebView2 (preinstalled on
Windows 10/11; the NSIS bundle also fetches it if absent). See
https://tauri.app/start/prerequisites/

## App icons

Generated from a source PNG with `pnpm tauri icon <path-to-png>` into
`src-tauri/icons/`.
