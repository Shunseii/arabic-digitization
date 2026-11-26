#!/bin/sh
# Install or update the رقمنة (Qiraa) desktop app on Linux, for this user only.
#
#   curl -fsSL https://github.com/Shunseii/arabic-digitization/releases/download/desktop-latest/install-desktop.sh | sh
#
# Downloads the newest Linux AppImage from the `desktop-latest` release, checks
# its SHA-256 and extracts it (no FUSE needed, no sudo):
#   ~/.local/share/qiraa-app/releases/<version>/   the app
#   ~/.local/share/qiraa-app/current               link to the version in use
#   ~/.local/bin/qiraa-app                         launcher
#   ~/.local/share/applications/qiraa.desktop      menu entry, with its icon
# Re-run to update; it keeps the previous version and removes older ones.
# Restart the app after an update. The installed app also updates itself
# (apps/desktop/electron/updater-linux.cjs) into the same layout.
#
#   sh install-desktop.sh --uninstall    remove all of the above
#
# Environment (all optional):
#   QIRAA_DOWNLOAD_BASE  base URL holding the assets (for mirrors and testing)
#   QIRAA_FORCE=1        reinstall even if this version is already in use

set -eu

REPO="Shunseii/arabic-digitization"
ASSET="Qiraa-x86_64.AppImage"
CHECKSUMS="qiraa-desktop-checksums.txt"

DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}"
APP_DIR="$DATA_DIR/qiraa-app"
BIN_DIR="$HOME/.local/bin"
LAUNCHER="$BIN_DIR/qiraa-app"
DESKTOP_FILE="$DATA_DIR/applications/qiraa.desktop"
ICON_DIR="$DATA_DIR/icons/hicolor/512x512/apps"
ICON="$ICON_DIR/qiraa.png"

say() { printf '%s\n' "$*"; }
fail() {
  printf 'qiraa installer: %s\n' "$*" >&2
  exit 1
}

refresh_menu() {
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$DATA_DIR/applications" >/dev/null 2>&1 || true
  fi
}

uninstall() {
  rm -rf "$APP_DIR"
  rm -f "$LAUNCHER" "$DESKTOP_FILE" "$ICON"
  refresh_menu
  say "Removed the رقمنة desktop app."
}

# An earlier system-wide install from the .deb.
check_old_installs() {
  if command -v dpkg-query >/dev/null 2>&1 &&
    dpkg-query -W -f='${Status}' qiraa 2>/dev/null | grep -q "install ok installed"; then
    say "Note: the system-wide qiraa package (.deb) is also installed."
    say "      Remove it to avoid two menu entries: sudo apt remove qiraa"
  fi
}

download() {
  curl --fail --location --silent --show-error --output "$2" "$1" ||
    fail "download failed: $1"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

write_launcher() {
  mkdir -p "$BIN_DIR"
  cat >"$LAUNCHER" <<'EOF'
#!/bin/sh
APP_DIR="$(readlink -f "${XDG_DATA_HOME:-$HOME/.local/share}/qiraa-app/current")"
unset ELECTRON_RENDERER_URL NODE_ENV
export CHROME_DESKTOP=qiraa.desktop
exec "$APP_DIR/qiraa" "$@"
EOF
  chmod 755 "$LAUNCHER"
}

write_menu_entry() {
  mkdir -p "$ICON_DIR" "$(dirname "$DESKTOP_FILE")"
  cp "$APP_DIR/current/qiraa.png" "$ICON"
  cat >"$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=رقمنة
GenericName=Arabic digitization
Comment=Digitize and read Arabic books
Exec=$LAUNCHER %U
Icon=$ICON
Terminal=false
Categories=Office;
Keywords=arabic;ocr;books;qiraa;
StartupWMClass=qiraa
EOF
  refresh_menu
}

# Keep the version in use and the one before it.
prune_old_versions() {
  current=$(readlink "$APP_DIR/current" | xargs basename)
  ls -1t "$APP_DIR/releases" | grep -vx "$current" | tail -n +2 |
    while read -r old; do
      rm -rf "${APP_DIR:?}/releases/$old"
    done
}

main() {
  if [ "${1:-}" = "--uninstall" ]; then
    uninstall
    return
  fi
  [ "$(uname -s)" = "Linux" ] ||
    fail "this installer is for Linux; on Windows, run Qiraa-Setup-<version>.exe from https://github.com/$REPO/releases/tag/desktop-latest"
  [ "$(uname -m)" = "x86_64" ] || fail "only x86_64 Linux builds are published"
  command -v curl >/dev/null 2>&1 || fail "curl is required"

  base="${QIRAA_DOWNLOAD_BASE:-https://github.com/$REPO/releases/download/desktop-latest}"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT

  say "Downloading $ASSET from $base"
  download "$base/$ASSET" "$tmp/$ASSET"
  download "$base/$CHECKSUMS" "$tmp/$CHECKSUMS"
  expected=$(grep " $ASSET\$" "$tmp/$CHECKSUMS" | cut -d' ' -f1)
  [ -n "$expected" ] || fail "$ASSET is missing from $CHECKSUMS"
  [ "$(sha256_of "$tmp/$ASSET")" = "$expected" ] || fail "checksum mismatch for $ASSET"

  chmod +x "$tmp/$ASSET"
  (cd "$tmp" && "./$ASSET" --appimage-extract >/dev/null) ||
    fail "could not extract the AppImage"
  [ -x "$tmp/squashfs-root/qiraa" ] || fail "the AppImage has no qiraa binary"
  version=$(sed -n 's/^X-AppImage-Version=//p' "$tmp/squashfs-root/qiraa.desktop")
  [ -n "$version" ] || fail "could not read the app version"

  target="$APP_DIR/releases/$version"
  if [ "$(readlink -f "$APP_DIR/current" 2>/dev/null || true)" = "$target" ] &&
    [ "${QIRAA_FORCE:-0}" != "1" ]; then
    say "رقمنة $version is already installed and in use."
  else
    mkdir -p "$APP_DIR/releases"
    rm -rf "$target"
    mv "$tmp/squashfs-root" "$target"
    ln -sfn "$target" "$APP_DIR/current"
    say "Installed رقمنة $version to $target"
  fi

  write_launcher
  write_menu_entry
  prune_old_versions
  check_old_installs

  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) say "Note: $BIN_DIR is not on PATH; the menu entry works regardless." ;;
  esac
  say "Open it from the app menu, or run: qiraa-app (restart it if it was running)"
}

main "$@"
