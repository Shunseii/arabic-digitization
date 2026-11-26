---
name: arabic-books
description: Manage books and read status on the Arabic digitization API (the deployed Cloudflare Worker), and search the digitized corpus via Meilisearch, through the `corpus` CLI. Create books, list them with per-state counts, inspect a single book, delete a book (and all its files), poll per-file OCR status, re-run OCR on failed files, pause/resume OCR for a book, hand-edit a page's transcription and read or restore its history, switch the Opus review on/off or review pages on demand and read their review history, check OCR/review spend and running jobs, and run hybrid (lexical + semantic) search across the library. Manually invoked — use for "/arabic-books", "create a book for <title>", "list my books", "delete <book>", "what's the OCR status of <book>", "re-run OCR on the failed pages of <book>", "pause/resume <book>", "fix the text of page <n>", "what changed on this page", "restore the previous version", "turn on review for <book>", "review page <n>", "what did the review change", "how much have we spent", "what's running", "search the corpus for <query>", "find pages about <topic>". Does NOT upload scans and does NOT pull/reformat transcriptions — uploading is done out of band, and pulling finished text into Obsidian is the separate arabic-ocr skill.
---

# Arabic Books — manage + monitor the digitization pipeline

The digitization API (a Cloudflare Worker) OCRs uploaded scans server-side. This skill is the **management + monitoring** side: create and inspect books, watch OCR progress, pause/resume OCR, re-queue failed pages, and search the corpus. It does **not** upload scans, and it does **not** pull or reformat finished text — that is the **arabic-ocr** skill.

## The `corpus` CLI

Everything goes through `corpus`, a standalone binary (source and full docs: `packages/cli/README.md` in `Shunseii/arabic-digitization`). It reads the API URL/key and the Meilisearch URL/read-only search key from environment variables (`ARABIC_OCR_URL`, `ARABIC_OCR_KEY`, `MEILI_URL`, `MEILI_SEARCH_KEY`), otherwise from the OS keychain (service `qiraa-corpus`).

### Setup (check once per session, before the first command)

1. `corpus --version`. If it's not found, install it:
   - Linux/macOS: `curl -fsSL https://github.com/Shunseii/arabic-digitization/releases/latest/download/install.sh | sh`. It installs `~/.local/bin/corpus` and, if that directory isn't on PATH, adds it to the shell rc file; until a new shell starts, run it as `~/.local/bin/corpus`.
   - Windows (PowerShell): `irm https://github.com/Shunseii/arabic-digitization/releases/latest/download/install.ps1 | iex`.
   - Re-running the installer updates it in place.
2. `corpus auth status`. It shows, per value, `env`, `keychain` or `not set`, and whether the API and search are ready. It never prints values.
3. If something is `not set`:
   - On the user's own machine with 1Password: ask the user to run `! corpus auth login --1password` (it reads the four values from the Arabic Digitization vault once, with one 1Password prompt, and stores them in the keychain). Don't run it yourself unprompted: it triggers a 1Password prompt.
   - Otherwise ask the user for the values, or have them run `! corpus auth login` (interactive, keys hidden). To store values non-interactively, pass the keys on stdin from an env var or file, never as arguments: `printf '%s\n' "$ARABIC_OCR_KEY" | corpus auth login --url <api-url> --key-stdin` (add `--meili-url <url> --meili-key-stdin` with the Meilisearch key as stdin's second line).
   - If `corpus auth status` says the keychain is unavailable (headless Linux), use the four env vars instead.
4. `corpus books` confirms the API works.

Rules:
- **Never print, echo, or log a secret**, and never type one literally into a command (it lands in shell history and the transcript). Never run `op read` or curl the API/Meilisearch directly.
- A `401`/`403` with "key rejected" means a rotated key: ask the user to run `! corpus auth login --1password` (or `corpus auth login`) again.
- `corpus auth logout` deletes the keychain entries; only run it when asked.

Usage:
- Add `--json` when you need to process the output; the default is a short human summary.
- `<book>` is a book id, an exact title, or a unique part of a title. Ambiguous titles exit `2` and list the matching ids — pick one or ask.
- Exit codes: `0` ok, `1` request, credential or 1Password failure, `2` usage error.

| Command | Purpose |
| --- | --- |
| `corpus books` | List books: id, title, `[paused]`, page count, per-state counts |
| `corpus show <book>` | One book: counts, OCR/review cost split, review on/off, paused, work, OCR instructions |
| `corpus create --title <t> [--id <slug>] [--instructions <text>] [--work <id>]` | Create a book |
| `corpus delete <book> --yes` | Delete a book with all its scans and text. **Irreversible**; refuses without `--yes` |
| `corpus pause <book>` / `corpus resume <book>` | Stop OCR for one book (other books keep going) / resume and re-queue its waiting pages |
| `corpus status <book> [--state <s>]` | Per-page states; failed pages (with a short reason) and hand-edited pages `(edited)` listed by default |
| `corpus text <book> <fileId> [--rev <id>]` | One page's transcription (Markdown), or an earlier version from its history |
| `corpus edit <book> <fileId> --old <text> --new <text> [--note <why>]` | Hand-edit a page: exact find-and-replace, `old` must match once. Several edits: `--edits <file.json>` (`[{"old","new"}]`), all or nothing |
| `corpus history <book> <fileId>` | Every change to the page's text (hand edits and re-OCRs), newest first |
| `corpus retry <book> [--states failed,rate_limited]` | Re-queue pages for OCR (default: failed + rate_limited; `done` re-applies new instructions) |
| `corpus ocr <book> <fileId...>` | Re-run OCR on specific pages: queues them, waits up to 4 minutes, and reports each (`blank page`, a text preview, or the failure reason). Use this, not `retry --states done`, to redo a few done pages |
| `corpus review <book> on [--yes \| --new-only]` / `off` | Switch the Opus review for a book. `on` with done pages asks whether to queue them too (page count × cost estimate); without a terminal pass `--yes` (queue them) or `--new-only` (only pages OCR'd from now on) |
| `corpus review <book> --all [--yes]` | Re-review every done page (works with review off). Asks first with count + estimate; refuses without a terminal unless `--yes` |
| `corpus review <book> <fileId\|page...>` | Review specific pages now (works with review off); starts a review run if none is running. 409 per page if it isn't done or is hand-edited |
| `corpus reviews [--days n] [--book <book>]` | Review totals: pages reviewed/changed, words added/removed, cost and cost per page, batch timing (duration p50/p90, polling lag, steps) |
| `corpus reviews <book> <fileId\|page>` | One page's review history: each review's status, cost, `rev` id, and words added/removed (older reviews: their find-and-replace edits). The desktop app's Usage → Reviewed pages shows each review as a word diff beside the scan |
| `corpus spend [--days n] [--book <book>]` | OCR vs review cost: by model, daily, top books (default 30 days) |
| `corpus jobs` | Running work: OCR per book, review batches (in flight, waiting, recent), and "gave up" messages that ran out of retries |
| `corpus search <query> [--book <book>] [--ratio 0..1] [--limit n]` | Hybrid search |
| `corpus auth status` / `auth login [--1password]` / `auth logout` | Credentials: where each value comes from (env/keychain) / store them in the keychain / delete them (see Setup) |

File states: `captured → queued → processing → done`, or `rate_limited` (transient, auto-retried) and `failed` (needs a manual retry). A paused book's pages stay `queued`.

## Workflows

**List books** — `corpus books`. Present title · page count · counts (e.g. `done 12 / failed 1`), and flag paused books.

**Create a book** — confirm the title (and slug, if any) with the user when it wasn't explicit, then `corpus create --title "<arabic title>"`. Report the returned id.

**Watch progress** — `corpus show <book>` gives counts and OCR cost cheaply. Use it for repeated checks while OCR runs; `corpus status` reads every page of the book from D1, and the free plan allows 5M row reads a day (a 1,150-page book is 1,150 reads per call).

**Status of a book** — `corpus status <book>`. Summarize counts per state; call out `failed` pages with their reason, and pages with no page number (`p?`, report the `file_id`).
- Blank pages come back as `done` with empty text (shown as "Blank page"). `no text (STOP)` is an empty reply Gemini gave without saying the page is blank; a re-run (`corpus ocr`) usually settles it.
- `no text (RECITATION)` is Gemini's copyright filter, often on Qur'an-heavy pages. A retry often passes (Tafsir as-Sa'di: 9 of 13 failed pages recovered on one retry); for pages that keep failing, the book's OCR instructions are the next lever.

**Re-run failed OCR** — check `corpus status <book> --state failed` first. Re-running costs a Gemini call per page (roughly $0.02–0.04 for dense pages), so confirm the count with the user before re-queuing many. Then `corpus retry <book>`. It's asynchronous: wait with `corpus show <book>` until nothing is queued or processing, then `corpus status <book> --state failed` once. One retry pass, then report what is still broken — don't loop.

**Pause / resume** — `corpus pause <book>` stops spending on that book immediately (the page in flight finishes). `corpus resume <book>` re-queues everything waiting; confirm with the user first when many pages are waiting, since it restarts the spend.

**Hand edits and history** — every change to a page's text (a hand edit or a re-OCR) first saves the text it replaces.
- **Re-OCR overwrites hand edits.** `corpus ocr` and `corpus retry --states done` replace hand-fixed pages with fresh OCR, which usually brings the fixed mistake back. Before re-OCRing done pages, run `corpus status <book>`: pages marked `(edited)` will lose their fixes. Tell the user and get a yes, or leave those pages out.
- **Edit a page:** read it (`corpus text`), then `corpus edit` with an `old` that occurs exactly once (add surrounding words for repeated ones) and a `--note` saying why. A 422 means an `old` didn't match once; nothing was applied, so fix it and resend.
- **Check what changed:** `corpus history <book> <fileId>`. Each entry is one change (`edit` with its note, or `ocr` with the model); `corpus text <book> <fileId> --rev <id>` is the text just before it. An `ocr` entry right after an `edit` means a re-run overwrote hand fixes, and that `ocr` entry's `--rev` holds the fixed text.
- **Restore:** read the version with `--rev <id>`, then replace the whole page with it (`corpus edit --edits` with one edit whose `old` is the full current text and `new` the earlier text, `--note "restore rev <id>"`). The restore is recorded too.

**Opus review** — Claude Opus proofreads OCR'd pages against the scan in batches (one every 3 hours, results within a day) returns the whole corrected page; the server compares it with the stored text and saves it if it changed. It rejects an answer that was cut off, empty, lost a large share of the page's letters, or dropped the footnotes, and the page keeps its text. Each applied review is a `review` entry in `corpus history` (undo it by restoring that entry's `--rev`).
- **Review costs money** (about $0.03 a page; `corpus reviews` shows the measured cost per page). **Confirm with the user before `corpus review <book> --all`, and before `corpus review <book> on` when the book already has done pages**: tell them the page count and the estimate the command prints, then pass `--yes` (or `--new-only` for `on` if they only want future pages). Never pass `--yes` on your own.
- **Review never overwrites hand-edited pages**: they are left out of every queue, and a page edited while in review is not changed. Re-OCR is the opposite: it does overwrite hand edits (see below).
- To review a few pages (e.g. ones the user doubts), `corpus review <book> <page...>`; it's cheap, so no confirmation needed beyond the user asking. Then `corpus jobs` to watch the batch and `corpus reviews <book> <page>` for what changed.
- **Turning review off** (`corpus review <book> off`) drops waiting pages from the next batch; a submitted batch still finishes.

**Activity and spend** — `corpus jobs` for "what's running / is anything stuck" (OCR per book, review batches with stage and timing, "gave up" failures with the last error). Run it once per question; don't loop it. `corpus spend` for "how much has this cost" (OCR vs review, by model, by day, top books; `--book` for one book, `--days` up to 90). `corpus reviews` for review quality and batch timing.

**Delete a book** — resolve the exact book (`corpus show <book>`), confirm with the user that its scans, text and rows will be wiped permanently, then `corpus delete <id> --yes`. Report the returned counts.

**Search the corpus** — `corpus search "<query>"` (default ratio 0.5). Raise `--ratio` toward 1 for concept queries, lower toward 0 for exact terms or names; scope with `--book <book>`. Render hits as `book_title · ص <page>` plus the snippet, and keep the `file_id` so the user can open the page (`corpus text <book> <fileId>` prints it). Abstract category words ("grammar", "fiqh") drift; suggest a concrete phrase instead ("rules of ablution").

## Notes

- Read-only commands (`books`, `show`, `status`, `text`, `history`, `search`, `reviews`, `spend`, `jobs`) are safe to run freely. `review` spends money (see "Opus review"). `edit` changes the stored text (recoverable from history); confirm edits the user didn't spell out.
- To get transcribed text into the vault, that's **arabic-ocr**, not this skill.
