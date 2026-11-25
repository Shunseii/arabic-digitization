#!/bin/sh
# Install or update the `corpus` CLI on Linux or macOS.
#
#   curl -fsSL https://github.com/Shunseii/arabic-digitization/releases/latest/download/install.sh | sh
#
# Downloads the binary for this OS/CPU from the latest v* GitHub release,
# checks its SHA-256, and installs it as ~/.local/bin/corpus (no sudo).
# If that directory isn't on PATH, adds it to your shell's startup file.
# Re-run to update.
#
# Environment (all optional):
#   CORPUS_VERSION       release tag to install, e.g. v0.6.0 (default: latest)
#   CORPUS_INSTALL_DIR   where to put the binary (default: ~/.local/bin)
#   CORPUS_NO_MODIFY_PATH=1  never edit shell startup files
#   CORPUS_DOWNLOAD_BASE base URL holding the release assets (for mirrors and
#                        testing; overrides CORPUS_VERSION)

set -eu

REPO="Shunseii/arabic-digitization"

say() { printf '%s\n' "$*"; }
fail() {
  printf 'corpus installer: %s\n' "$*" >&2
  exit 1
}

detect_os() {
  case "$(uname -s)" in
    Linux) echo linux ;;
    Darwin) echo darwin ;;
    MINGW* | MSYS* | CYGWIN*)
      fail "on Windows, run in PowerShell: irm https://github.com/$REPO/releases/latest/download/install.ps1 | iex"
      ;;
    *) fail "unsupported OS: $(uname -s) (supported: Linux, macOS, Windows)" ;;
  esac
}

detect_arch() {
  arch=$(uname -m)
  # A shell running under Rosetta reports x86_64 on Apple silicon; the
  # native arm64 build is the better choice there.
  if [ "$arch" = x86_64 ] && [ "$(uname -s)" = Darwin ] &&
    [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
    arch=arm64
  fi
  case "$arch" in
    x86_64 | amd64) echo x64 ;;
    aarch64 | arm64) echo arm64 ;;
    *) fail "unsupported CPU architecture: $arch (supported: x86_64, arm64)" ;;
  esac
}

download() {
  # $1 = URL, $2 = output file
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    fail "need curl or wget to download"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    echo ""
  fi
}

# Prints the startup file to edit and the line to add, separated by a tab.
path_line_for_shell() {
  dir=$1
  case "$dir" in
    "$HOME"/*) shown="\$HOME${dir#"$HOME"}" ;;
    *) shown=$dir ;;
  esac
  case "$(basename "${SHELL:-sh}")" in
    zsh) printf '%s\t%s\n' "${ZDOTDIR:-$HOME}/.zshrc" "export PATH=\"$shown:\$PATH\"" ;;
    bash)
      # macOS Terminal starts bash as a login shell, which reads .bash_profile.
      if [ "$(uname -s)" = Darwin ]; then
        rc="$HOME/.bash_profile"
      else
        rc="$HOME/.bashrc"
      fi
      printf '%s\t%s\n' "$rc" "export PATH=\"$shown:\$PATH\""
      ;;
    fish) printf '%s\t%s\n' "${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish" "fish_add_path $dir" ;;
    *) printf '%s\t%s\n' "$HOME/.profile" "export PATH=\"$shown:\$PATH\"" ;;
  esac
}

ensure_on_path() {
  dir=$1
  case ":$PATH:" in
    *":$dir:"*) return 0 ;;
  esac
  if [ "${CORPUS_NO_MODIFY_PATH:-}" = 1 ]; then
    say ""
    say "$dir is not on your PATH. Add it yourself to run \`corpus\` by name."
    return 0
  fi
  entry=$(path_line_for_shell "$dir")
  rc=$(printf '%s' "$entry" | cut -f 1)
  line=$(printf '%s' "$entry" | cut -f 2-)
  if [ -f "$rc" ] && grep -qxF "$line" "$rc"; then
    say ""
    say "$rc already adds $dir to PATH. Open a new shell to pick it up."
    return 0
  fi
  mkdir -p "$(dirname "$rc")"
  printf '\n# Added by the corpus installer\n%s\n' "$line" >>"$rc"
  say ""
  say "Added $dir to PATH in $rc:"
  say "  $line"
  say "Open a new shell (or run: $line) to use \`corpus\`."
}

main() {
  os=$(detect_os)
  arch=$(detect_arch)
  asset="corpus-$os-$arch"

  if [ -n "${CORPUS_DOWNLOAD_BASE:-}" ]; then
    base=${CORPUS_DOWNLOAD_BASE%/}
  elif [ -n "${CORPUS_VERSION:-}" ]; then
    case "$CORPUS_VERSION" in
      v*) tag=$CORPUS_VERSION ;;
      *) tag="v$CORPUS_VERSION" ;;
    esac
    base="https://github.com/$REPO/releases/download/$tag"
  else
    base="https://github.com/$REPO/releases/latest/download"
  fi

  dir=${CORPUS_INSTALL_DIR:-$HOME/.local/bin}
  mkdir -p "$dir"
  # Download next to the target so the final mv is an atomic rename.
  tmp=$(mktemp "$dir/.corpus.XXXXXX")
  sums=$(mktemp "${TMPDIR:-/tmp}/corpus-checksums.XXXXXX")
  trap 'rm -f "$tmp" "$sums"' EXIT INT TERM

  say "Downloading $asset from $base"
  download "$base/$asset" "$tmp" ||
    fail "download failed: $base/$asset (is there a published v* release with CLI assets?)"

  if download "$base/corpus-checksums.txt" "$sums" 2>/dev/null; then
    expected=$(grep " $asset\$" "$sums" | cut -d ' ' -f 1)
    actual=$(sha256_of "$tmp")
    if [ -z "$expected" ]; then
      fail "corpus-checksums.txt has no entry for $asset"
    elif [ -z "$actual" ]; then
      say "warning: no sha256sum or shasum found; skipping checksum verification"
    elif [ "$expected" != "$actual" ]; then
      fail "checksum mismatch for $asset (expected $expected, got $actual)"
    fi
  else
    say "warning: no corpus-checksums.txt in the release; skipping checksum verification"
  fi

  chmod 755 "$tmp"
  version=$("$tmp" --version 2>/dev/null) ||
    fail "the downloaded binary does not run on this machine ($os-$arch)"
  mv -f "$tmp" "$dir/corpus"
  trap - EXIT INT TERM
  rm -f "$sums"

  say "Installed corpus $version to $dir/corpus"
  ensure_on_path "$dir"
  say ""
  say "Next: corpus auth status   (then corpus auth login if it's not configured)"
}

main "$@"
