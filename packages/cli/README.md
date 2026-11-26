# corpus

Command-line access to the Arabic digitization corpus: books, OCR status, retries, pause/resume, export, Opus review, spend and running jobs, and hybrid search.

`corpus` is a single self-contained executable (built with Bun; nothing else to install) for Linux, macOS and Windows. It needs four values to talk to the API and to Meilisearch, which it reads from environment variables or from the OS keychain.

## Install

**Linux and macOS** (x64 or arm64):

```sh
curl -fsSL https://github.com/Shunseii/arabic-digitization/releases/latest/download/install.sh | sh
```

**Windows** (x64, in PowerShell):

```powershell
irm https://github.com/Shunseii/arabic-digitization/releases/latest/download/install.ps1 | iex
```

Neither needs sudo or admin rights. The installers come from the same release as the binary they install, so the script and binary always match.

### What the installer does

| | Linux / macOS (`install.sh`) | Windows (`install.ps1`) |
| --- | --- | --- |
| Downloads | `corpus-<linux\|darwin>-<x64\|arm64>` from the latest `v*` GitHub release | `corpus-windows-x64.exe` from the latest `v*` release |
| Verifies | its SHA-256 against `corpus-checksums.txt` in the same release, then runs `--version` | same |
| Installs to | `~/.local/bin/corpus` | `%LOCALAPPDATA%\Programs\corpus\corpus.exe` |
| PATH | If `~/.local/bin` isn't on `PATH`, appends one line to your shell's startup file: `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc` (zsh), `~/.bashrc` (bash on Linux) or `~/.bash_profile` (bash on macOS), `~/.profile` (other shells), or `fish_add_path ~/.local/bin` to `~/.config/fish/config.fish` (fish). It never adds the line twice. | Adds the folder to your **user** `Path` if missing (also for the current session). |
| Afterwards | Open a new shell so the PATH change applies. | Open a new terminal. |

Options, set as environment variables for the installer:

| Variable | Effect |
| --- | --- |
| `CORPUS_VERSION=v0.6.1` | Install that release instead of the latest (pin or downgrade; v0.6.1 is the first with the CLI). |
| `CORPUS_INSTALL_DIR=/some/dir` | Install somewhere else. |
| `CORPUS_NO_MODIFY_PATH=1` | Don't touch shell startup files or the user PATH. |
| `CORPUS_DOWNLOAD_BASE=<url>` | Download the assets from this base URL instead of GitHub (mirrors, testing). |

```sh
curl -fsSL https://github.com/Shunseii/arabic-digitization/releases/latest/download/install.sh | CORPUS_VERSION=v0.6.1 sh
```

```powershell
$env:CORPUS_VERSION = 'v0.6.1'; irm https://github.com/Shunseii/arabic-digitization/releases/latest/download/install.ps1 | iex
```

## Configure credentials

`corpus` needs these four values:

| Env var / keychain entry | What | Needed for |
| --- | --- | --- |
| `ARABIC_OCR_URL` | API base URL (the Worker) | every command except `search` |
| `ARABIC_OCR_KEY` | API key (bearer token) | every command except `search` |
| `MEILI_URL` | Meilisearch URL | `search` |
| `MEILI_SEARCH_KEY` | Meilisearch **read-only** search key | `search` |

Each value is looked up on its own, in this order:

1. **Environment variable** of that name, if set and non-empty.
2. **OS keychain**, service `qiraa-corpus`, entry named after the env var. `corpus auth login` writes these.

Nothing is ever written to a file. Values are never printed, logged, or put in error messages.

### Interactive: `corpus auth login`

```sh
corpus auth login
```

Prompts for the API URL, the API key (typing is hidden), the Meilisearch URL, and the Meilisearch search key. The two Meilisearch values are optional (only `search` needs them); press Enter to skip. On a re-run, Enter keeps the stored value, so you can change just one.

### Non-interactive (scripts and agents)

Pass the URLs as flags and the keys on **stdin**, so keys never appear in shell history or the process list:

```sh
# API only
printf '%s\n' "$API_KEY" | corpus auth login --url https://api.example.com --key-stdin

# API and search: stdin holds two lines, the API key first, then the Meilisearch key
printf '%s\n%s\n' "$API_KEY" "$MEILI_KEY" | corpus auth login \
  --url https://api.example.com --key-stdin \
  --meili-url https://search.example.com --meili-key-stdin
```

Any subset works: only the values you pass are stored, the others stay as they were. URLs must be `http(s)://`. Without a terminal and without flags, `corpus auth login` exits with code 2 instead of waiting for input.

### From 1Password

If the 1Password CLI (`op`) is installed and signed in to an account that holds the **Arabic Digitization** vault:

```sh
corpus auth login --1password
```

reads all four values once (1Password asks you to approve once) and stores them in the keychain. After that, `corpus` never calls `op`. It reads:

- `op://Arabic Digitization/API Connection Vars/ARABIC_OCR_URL` and `…/ARABIC_OCR_KEY`
- `op://Arabic Digitization/Meilisearch/url` and `…/client read key`

The account defaults to `my.1password.com`; set `CORPUS_OP_ACCOUNT` for another. `--1password` can't be combined with the other login flags. Run it again after a key is rotated.

### Environment variables only

Set all four (or just the two API ones) and skip `auth login` entirely. Env vars always win over the keychain, and when both values a command needs are in the environment, the keychain isn't touched at all. Use this for CI, containers, and headless servers.

### Where the keychain is

| OS | Store | Notes |
| --- | --- | --- |
| macOS | Keychain (login keychain) | Visible in Keychain Access under `qiraa-corpus`. |
| Windows | Credential Manager | Under Windows Credentials. |
| Linux | Secret Service via libsecret (GNOME Keyring, KWallet, KeePassXC) | Needs a desktop session with a Secret Service running. |

**Headless Linux** (servers, SSH-only boxes, most containers) usually has no Secret Service. `corpus` then says *"The OS keychain is not available … Set the environment variables …"*: use the env vars instead.

### Check, change, remove

```sh
corpus auth status     # which values are set and where (env / keychain / not set); never the values
corpus auth logout     # delete the four keychain entries (env vars are unaffected)
```

`corpus auth status --json` gives `{service, keychain, values: {ARABIC_OCR_URL: "env"|"keychain"|null, …}, ready: {api, search}}`.

## Verify

```sh
corpus --version       # the release version, e.g. 0.6.0 ("dev" when run from source)
corpus auth status     # API: ready · search: ready
corpus books           # lists the books: proves the URL and key work
```

## Update

Re-run the install one-liner. It replaces the binary in place and leaves the PATH line and keychain entries alone. Use `CORPUS_VERSION` to pick a specific release.

## Uninstall

Remove the stored credentials first (the binary does that), then the binary:

```sh
corpus auth logout
rm ~/.local/bin/corpus
```

Then delete the `# Added by the corpus installer` line and the line after it from your shell startup file, if the installer added one.

On Windows:

```powershell
corpus auth logout
Remove-Item -Recurse "$env:LOCALAPPDATA\Programs\corpus"
```

and remove that folder from your user `Path` (Settings → System → About → Advanced system settings → Environment Variables).

## Build from source

You need [Bun](https://bun.sh) 1.4 or newer (the CLI uses `Bun.secrets`) and the workspace dependencies:

```sh
pnpm install                                  # from the repo root
cd packages/cli
bun src/main.ts --help                        # run from source (version "dev")
pnpm build                                    # dist/corpus for this machine
pnpm build:release 0.6.0                      # every release target + checksums into dist/
pnpm typecheck
```

`src/main.ts` has a `#!/usr/bin/env bun` shebang, so for development you can also symlink it onto PATH: `ln -sf "$PWD/src/main.ts" ~/.local/bin/corpus`.

Releases are built by the `cli` job in `.github/workflows/release.yml` when a `v<X.Y.Z>` GitHub release is published: it runs `scripts/compile.sh` with the tag's version and uploads `corpus-linux-x64`, `corpus-linux-arm64`, `corpus-darwin-x64`, `corpus-darwin-arm64`, `corpus-windows-x64.exe`, `corpus-checksums.txt`, `install.sh` and `install.ps1`. The one-liners use `/releases/latest/download/`, so the newest `v*` release must be marked **Latest** on GitHub (don't publish it as a pre-release).

## Commands

`<book>` is a book id, an exact title, or a unique part of a title. An ambiguous title lists the matches and asks for the id. Add `--json` to any command for machine-readable output.

```text
corpus --version                              the installed version
corpus auth login [--1password | --url <u> --key-stdin [--meili-url <u> --meili-key-stdin]]
corpus auth status | logout

corpus books                                  list books with per-state page counts
corpus show <book>                            counts, OCR/review cost, review on/off, paused, OCR engine, OCR instructions
corpus create --title <t> [--id <slug>] [--instructions <text>] [--work <id>] [--engine inkling|claude]
corpus engine <book> <inkling|claude|default>  set which OCR provider runs first
corpus delete <book> --yes                    irreversible; refuses without --yes
corpus pause <book>                           stop OCR for this book only
corpus resume <book>                          resume and re-queue its waiting pages

corpus status <book> [--state failed]         per-page states; lists failed and (edited) pages
corpus retry <book> [--states failed,rate_limited]
corpus ocr <book> <fileId...>                 re-run OCR on specific pages, wait for the results
corpus export <book>                          all pages + text as JSON (always JSON; fetched 200 pages at a time, progress on stderr)
corpus text <book> <fileId> [--rev <id>]      one page's Markdown, or an earlier version

corpus edit <book> <fileId> --old <text> --new <text> [--note <why>]
corpus edit <book> <fileId> --edits <file.json|-> [--note <why>]
                                              exact find-and-replace, all or nothing
corpus history <book> <fileId>                changes to a page's text, newest first

corpus review <book> on [--yes | --new-only]  review pages as they finish OCR; asks whether to queue done pages too
corpus review <book> off                      stop reviewing new pages
corpus review <book> --all [--yes]            re-review every done page, even with review off (asks first)
corpus review <book> <fileId|page...>         review specific pages now, even with review off
corpus reviews [--days n] [--book <book>]     review totals: pages, words changed, cost, batch timing
corpus reviews <book> <fileId|page>           a page's reviews and words changed (older reviews: each edit)

corpus jobs                                   live OCR per book, review batches, pages that gave up
corpus spend [--days n] [--book <book>]       OCR vs review cost: by model, daily, top books

corpus search <query> [--book <book>] [--ratio 0..1] [--limit n]
```

Editing: each `old` must occur exactly once in the page (add surrounding words to pick one of several), and nothing is applied if any edit fails. Every change to a page's text, by hand or by re-OCR, first saves the text it replaces: `corpus history` lists the changes and `corpus text --rev <id>` shows the text just before one. **Re-OCR overwrites hand edits** (`corpus ocr`, `corpus retry --states done`); check for `(edited)` pages in `corpus status` first. To restore a version, replace the whole page with it via `--edits` (one edit whose `old` is the full current text).

OCR engine: each book OCRs with Inkling by default, falling back to Claude when Inkling is rate-limited, down, or cuts a page off at its length cap. `--engine claude` (on `create`) or `corpus engine <book> claude` flips the order: Claude first, Inkling as the fallback. `default` resets it to Inkling. Changing the engine only affects pages OCR'd from then on; to re-OCR finished pages run `corpus retry <book> --states done` (this overwrites hand edits, see above). `corpus books` tags each book that has an engine set.

Review: Claude Opus proofreads OCR'd pages against the scan in batches (one every 3 hours, results within a day) returns each page whole with its corrections; the server applies it only if it passes sanity checks (not cut off, no large share of the text missing, footnotes kept). Each applied review is a `review` entry in `corpus history`, so it can be undone like any change. **A review never changes a hand-edited page**, and hand-edited pages are left out when queueing. **It costs money** (about $0.03 a page): `corpus review <book> on` and `--all` show the page count and an estimate (pages × the measured cost per page from the last 90 days, or $0.03 before any review has run) and ask before queueing. Without a terminal they refuse unless you pass `--yes` (queue) or, for `on`, `--new-only` (review only pages OCR'd from now on). Pages named one by one (`corpus review <book> 12 13`) are queued without asking and start a review run if none is running. A page number can match several fragments of one page; all of them are queued.

Activity: `corpus jobs` reads the same data as the desktop Activity screen; run it when you want a look, don't loop it (it reads the database on every call). `corpus reviews` and `corpus spend` default to the last 30 days.

Search is hybrid: `--ratio 0` is keyword-only, `1` is semantic-only, default `0.5`. Concrete phrases work better than category words ("rules of ablution", not "fiqh").

Exit codes: `0` success, `1` request, keychain, or 1Password failure, `2` usage error (bad arguments, ambiguous book, missing `--yes`).

## Troubleshooting

- **`corpus: command not found`** right after installing: open a new shell (the PATH line only applies to new shells), or run `~/.local/bin/corpus` directly. Check `echo $PATH` and the end of your shell startup file.
- **`Not configured for the API: ARABIC_OCR_URL and ARABIC_OCR_KEY missing`:** run `corpus auth login`, or set the env vars. `corpus auth status` shows which are missing.
- **`The OS keychain is not available`:** typical on headless Linux. Set the four env vars instead (see above), or start a Secret Service (e.g. `gnome-keyring-daemon`) in your session.
- **`… → 401` / `403` with "key rejected":** the key was rotated or mistyped. Run `corpus auth login` again (or `corpus auth login --1password`), or fix the env var, which takes precedence over the keychain.
- **`op read` failed / timed out** (`--1password` only): unlock 1Password or approve the prompt and retry. If the vault is in another account, set `CORPUS_OP_ACCOUNT`.
- **Installer: `download failed … 404`:** no published `v*` release marked Latest has the CLI assets yet, or `CORPUS_VERSION` names a release without them.
- **Linux: `Illegal instruction` or `not found` when running the binary:** the binaries need glibc (not musl/Alpine) on x64 or arm64.
