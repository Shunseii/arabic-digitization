# corpus

Command-line access to the Arabic digitization corpus: books, OCR status, retries, pause/resume, export, and hybrid search.

It exists so that you (and agents running commands for you) stop getting a 1Password prompt on every call. `corpus` reads its four secrets from 1Password **once**, caches them in RAM for 12 hours, and every later call — including separate processes — reads the cache.

## Setup

You need Node 22.18 or newer (it runs the TypeScript directly; no build step), the 1Password CLI (`op`), and access to the **Arabic Digitization** vault.

1. **Install dependencies** from the repo root:

   ```sh
   pnpm install
   ```

2. **Put `corpus` on your PATH.** Symlink the entry point into a directory already on PATH (`~/.local/bin` here):

   ```sh
   ln -sf "$PWD/packages/cli/src/main.ts" ~/.local/bin/corpus
   ```

   Run this from the repo root. The symlink follows the repo, so `git pull` updates the CLI with no reinstall.

3. **Sign in once:**

   ```sh
   corpus auth login
   ```

   1Password asks you to approve once. After that, `corpus auth status` shows when the cache expires.

4. **Check it works:**

   ```sh
   corpus books
   ```

That's it. For the next 12 hours no `corpus` command touches 1Password.

### Configuration (optional)

| Variable | Default | Purpose |
| --- | --- | --- |
| `CORPUS_OP_ACCOUNT` | `my.1password.com` | 1Password account that holds the vault |
| `CORPUS_SECRET_TTL_HOURS` | `12` | How long cached secrets stay valid |
| `ARABIC_OCR_URL`, `ARABIC_OCR_KEY`, `MEILI_URL`, `MEILI_SEARCH_KEY` | unset | If **all four** are set, `corpus` uses them and never calls `op` or caches anything (for CI or another machine) |

## How the secret cache works

- Secrets are read with `op read --account <account>` from:
  - `op://Arabic Digitization/API Connection Vars/ARABIC_OCR_URL` and `…/ARABIC_OCR_KEY`
  - `op://Arabic Digitization/Meilisearch/url` and `…/client read key` (read-only: search only)
- They are cached in `$XDG_RUNTIME_DIR/qiraa-corpus/secrets.json` (normally `/run/user/<uid>/…`). That directory is **tmpfs**: it lives in RAM, belongs only to you, and is wiped when you log out or reboot. If `$XDG_RUNTIME_DIR` is unset, `/dev/shm` is used. `corpus` never falls back to a disk-backed directory.
- The cache directory is mode `700` and the file `600`. A cache file that is readable by anyone else, or owned by another user, is deleted and ignored.
- Secrets are never printed, logged, or put in error messages.
- **Expiry:** after the TTL, the next command reads 1Password again (one prompt) and refreshes the cache.
- **Rotated key:** if the API or Meilisearch answers 401/403 while using cached secrets, `corpus` re-reads 1Password once and retries. If that still fails, it stops with an error.
- **Wipe early:** `corpus auth logout`.

## Commands

`<book>` is a book id, an exact title, or a unique part of a title. An ambiguous title lists the matches and asks for the id. Add `--json` to any command for machine-readable output.

```text
corpus auth login | status | logout

corpus books                                  list books with per-state page counts
corpus show <book>                            counts, OCR cost, paused, OCR instructions
corpus create --title <t> [--id <slug>] [--instructions <text>] [--work <id>]
corpus delete <book> --yes                    irreversible; refuses without --yes
corpus pause <book>                           stop OCR for this book only
corpus resume <book>                          resume and re-queue its waiting pages

corpus status <book> [--state failed]         per-page states
corpus retry <book> [--states failed,rate_limited]
corpus export <book>                          all pages + text as JSON (always JSON)
corpus text <book> <fileId>                   one page's Markdown

corpus search <query> [--book <book>] [--ratio 0..1] [--limit n]
```

Search is hybrid: `--ratio 0` is keyword-only, `1` is semantic-only, default `0.5`. Concrete phrases work better than category words ("rules of ablution", not "fiqh").

Exit codes: `0` success, `1` request or 1Password failure, `2` usage error (bad arguments, ambiguous book, missing `--yes`).

## Troubleshooting

- **`op read` failed / timed out:** unlock 1Password or approve the prompt, then run `corpus auth login`. If the vault is in another account, set `CORPUS_OP_ACCOUNT`.
- **`corpus: command not found`:** the symlink isn't on PATH. Check `ls -l ~/.local/bin/corpus` and `echo $PATH`.
- **`ExperimentalWarning` or a syntax error on startup:** Node is older than 22.18. Check `node --version`.
