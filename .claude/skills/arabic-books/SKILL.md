---
name: arabic-books
description: Manage books and read status on the Arabic digitization API (the deployed Cloudflare Worker), and search the digitized corpus via Meilisearch, through the `corpus` CLI. Create books, list them with per-state counts, inspect a single book, delete a book (and all its files), poll per-file OCR status, re-run OCR on failed files, pause/resume OCR for a book, and run hybrid (lexical + semantic) search across the library. Manually invoked — use for "/arabic-books", "create a book for <title>", "list my books", "delete <book>", "what's the OCR status of <book>", "re-run OCR on the failed pages of <book>", "pause/resume <book>", "search the corpus for <query>", "find pages about <topic>". Does NOT upload scans and does NOT pull/reformat transcriptions — uploading is done out of band, and pulling finished text into Obsidian is the separate arabic-ocr skill.
---

# Arabic Books — manage + monitor the digitization pipeline

The digitization API (a Cloudflare Worker) OCRs uploaded scans server-side. This skill is the **management + monitoring** side: create and inspect books, watch OCR progress, pause/resume OCR, re-queue failed pages, and search the corpus. It does **not** upload scans, and it does **not** pull or reformat finished text — that is the **arabic-ocr** skill.

## The `corpus` CLI

Everything goes through `corpus` (repo: `~/Projects/arabic-digitization/packages/cli`, setup in its README). It reads the API and Meilisearch secrets from 1Password **once** and caches them in RAM for 12 hours, so the user isn't prompted on every call.

- **Never run `op read` or curl the API/Meilisearch directly.** Secrets never appear in commands or output.
- If `corpus` is not found, stop and point the user at `packages/cli/README.md` (setup is `pnpm install`, one symlink, `corpus auth login`).
- If a command fails with an `op read` error, ask the user to unlock 1Password and run `! corpus auth login`, then retry.
- Add `--json` when you need to process the output; the default is a short human summary.
- `<book>` is a book id, an exact title, or a unique part of a title. Ambiguous titles exit `2` and list the matching ids — pick one or ask.
- Exit codes: `0` ok, `1` request/1Password failure, `2` usage error.

| Command | Purpose |
| --- | --- |
| `corpus books` | List books: id, title, `[paused]`, page count, per-state counts |
| `corpus show <book>` | One book: counts, OCR cost, paused, work, OCR instructions |
| `corpus create --title <t> [--id <slug>] [--instructions <text>] [--work <id>]` | Create a book |
| `corpus delete <book> --yes` | Delete a book with all its scans and text. **Irreversible**; refuses without `--yes` |
| `corpus pause <book>` / `corpus resume <book>` | Stop OCR for one book (other books keep going) / resume and re-queue its waiting pages |
| `corpus status <book> [--state <s>]` | Per-page states; failed pages listed with a short reason |
| `corpus text <book> <fileId>` | One page's transcription (Markdown) |
| `corpus retry <book> [--states failed,rate_limited]` | Re-queue pages for OCR (default: failed + rate_limited; `done` re-applies new instructions) |
| `corpus ocr <book> <fileId...>` | Re-run OCR on specific pages: queues them, waits up to 4 minutes, and reports each (`blank page`, a text preview, or the failure reason). Use this, not `retry --states done`, to redo a few done pages |
| `corpus search <query> [--book <book>] [--ratio 0..1] [--limit n]` | Hybrid search |
| `corpus auth status` / `auth login` / `auth logout` | Secret cache: when it expires / refresh it / wipe it |

File states: `captured → queued → processing → done`, or `rate_limited` (transient, auto-retried) and `failed` (needs a manual retry). A paused book's pages stay `queued`.

## Workflows

**List books** — `corpus books`. Present title · page count · counts (e.g. `done 12 / failed 1`), and flag paused books.

**Create a book** — confirm the title (and slug, if any) with the user when it wasn't explicit, then `corpus create --title "<arabic title>"`. Report the returned id.

**Watch progress** — `corpus show <book>` gives counts and OCR cost cheaply. Use it for repeated checks while OCR runs; `corpus status` reads every page of the book from D1, and the free plan allows 5M row reads a day (a 1,150-page book is 1,150 reads per call).

**Status of a book** — `corpus status <book>`. Summarize counts per state; call out `failed` pages with their reason, and pages with no page number (`p?`, report the `file_id`).
- Blank pages come back as `done` with empty text (shown as "Blank page").
- Failed pages show the provider and HTTP status (e.g. `Claude 400`), or the start of the error. Rate limits and outages don't fail a page: it waits as `rate_limited` and re-queues itself, and the other provider takes it if one is down. A page that keeps failing usually needs the book's OCR instructions adjusted.

**Re-run failed OCR** — check `corpus status <book> --state failed` first. Re-running costs an OCR call per page (Inkling, roughly $0.004 for a dense page; more if it falls back to Claude), so confirm the count with the user before re-queuing many. Then `corpus retry <book>`. It's asynchronous: wait with `corpus show <book>` until nothing is queued or processing, then `corpus status <book> --state failed` once. One retry pass, then report what is still broken — don't loop.

**Pause / resume** — `corpus pause <book>` stops spending on that book immediately (the page in flight finishes). `corpus resume <book>` re-queues everything waiting; confirm with the user first when many pages are waiting, since it restarts the spend.

**Delete a book** — resolve the exact book (`corpus show <book>`), confirm with the user that its scans, text and rows will be wiped permanently, then `corpus delete <id> --yes`. Report the returned counts.

**Search the corpus** — `corpus search "<query>"` (default ratio 0.5). Raise `--ratio` toward 1 for concept queries, lower toward 0 for exact terms or names; scope with `--book <book>`. Render hits as `book_title · ص <page>` plus the snippet, and keep the `file_id` so the user can open the page (`corpus text <book> <fileId>` prints it). Abstract category words ("grammar", "fiqh") drift; suggest a concrete phrase instead ("rules of ablution").

## Notes

- Read-only commands (`books`, `show`, `status`, `search`) are safe to run freely.
- To get transcribed text into the vault, that's **arabic-ocr**, not this skill.
