---
name: arabic-books
description: Manage books and read status on the Arabic digitization API (the deployed Cloudflare Worker), and search the digitized corpus via Meilisearch. Create books, list them with per-state counts, inspect a single book, delete a book (and all its files), poll per-file OCR status, re-run OCR on failed files, and run hybrid (lexical + semantic) search across the library. Manually invoked — use for "/arabic-books", "create a book for <title>", "list my books", "delete <book>", "what's the OCR status of <book>", "re-run OCR on the failed pages of <book>", "search the corpus for <query>", "find pages about <topic>". Does NOT upload scans and does NOT pull/reformat transcriptions — uploading is done out of band, and pulling finished text into Obsidian is the separate arabic-ocr skill.
---

# Arabic Books — manage + monitor the digitization pipeline

The digitization API (a Cloudflare Worker) OCRs uploaded scans server-side. This skill is the **management + monitoring** side: create and inspect books, watch OCR progress, and re-trigger OCR on files that failed. It does **not** upload scans, and it does **not** pull or reformat finished text — that download/Obsidian-footnote step is the separate **arabic-ocr** skill.

## Config (1Password)

Read these secret references — prefer the **1Password MCP**; fall back to the `op` CLI (`op read "<ref>"`):

- URL: `op://Arabic Digitization/API Connection Vars/ARABIC_OCR_URL`
- Key: `op://Arabic Digitization/API Connection Vars/ARABIC_OCR_KEY`

For **search** (separate Meilisearch instance on Fly, not the Worker):

- Meili URL: `op://Arabic Digitization/Meilisearch/url`
- Search key: `op://Arabic Digitization/Meilisearch/client read key` (read-only; `search` only)

Both keys are bearer secrets — use them only in the `Authorization` header, never print or echo them. If a needed ref can't be read, stop and tell the user to check 1Password / `op` sign-in.

API requests send `Authorization: Bearer <ARABIC_OCR_KEY>`; Meilisearch requests send `Authorization: Bearer <client read key>`.

## Endpoints this skill uses

Inlined for self-sufficiency. **Full, always-current reference** (use if anything looks off or you need a field not listed here): `GET <URL>/llms.txt` (public, no auth).

| Method | Path                                   | Purpose                                                                                                                                |
| ------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/books`                           | Create a book. Body `{ "title": string, "id"?: slug }` (id auto-generated if omitted). → `201 { success, book }`, `409` if id exists.  |
| GET    | `/api/books`                           | List books → `{ books: [ { id, title, created_at, files_total, counts: {state: n} } ] }`.                                              |
| GET    | `/api/books/:bookId`                   | One book + status summary → `{ book: { id, title, created_at, files_total, counts } }`. `404` if missing.                              |
| DELETE | `/api/books/:bookId`                   | Delete a book + all its files (R2 scans + text, then rows) → `{ deleted: { book_id, files, r2_objects } }`. `404` if missing. **Irreversible.** |
| GET    | `/api/books/:bookId/status`            | Per-file states (no text) → `{ files: [ { file_id, page_number, state, role, order_hint, preview, error, updated_at } ] }`. Poll this. |
| POST   | `/api/books/:bookId/files/:fileId/ocr` | Re-run OCR on one file, synchronous → `{ file_id, model, text, text_key, usage }`. Use for `failed` files.                             |

File state machine: `captured → queued → processing → done` (or `failed` after retries; `needs_review` / `approved` reserved).

## Search the corpus (Meilisearch)

Search runs against the **Meilisearch** instance directly (not the Worker), using the read-only key. Hybrid = lexical (charabia, Arabic-aware) + semantic (bge-m3 embeddings); `semanticRatio` 0 = keyword only, 1 = semantic only.

`POST <MEILI_URL>/indexes/books/search`

```json
{
  "q": "<query>",
  "hybrid": { "embedder": "cfbge", "semanticRatio": 0.5 },
  "limit": 20,
  "attributesToRetrieve": ["book_id", "book_title", "page_number", "text"],
  "attributesToCrop": ["text"],
  "cropLength": 40
}
```

→ `{ hits: [ { id, book_id, book_title, page_number, text, _formatted: { text } } ] }`. `id` is the `file_id`; `_formatted.text` is the cropped snippet (strip `__ais-highlight__` / ruby / markdown markers when displaying).

Notes: concept/phrase queries work well; **abstract category words** ("grammar", "fiqh") drift — vector matches what pages *say*, not their category. Search is read-only and safe to run freely.

## What this skill does NOT do

- **Upload scans** — `POST /api/books/:bookId/files` is out of scope here.
- **Pull / export / reformat text** — `GET .../export` and `.../text` plus Obsidian-footnote conversion are the **arabic-ocr** skill. If the user wants finished pages in the vault, hand off to that skill.

## Workflows

**Create a book**

1. Resolve config (above).
2. `POST <URL>/api/books` with `{ "title": "<arabic title>", "id"?: "<slug>" }`.
3. On `409`, report the id is taken and show the existing book (`GET /api/books/:id`).
4. Confirm: print the returned `id` + `title`.

**List books**

1. `GET <URL>/api/books`.
2. Render a table: `title` · `id` · `files_total` · the `counts` breakdown (e.g. `done 12 / processing 2 / failed 1`).

**Status of a book**

1. Match the user's named book to a `title`/`id` via `GET /api/books`; if ambiguous, list and ask.
2. `GET <URL>/api/books/:bookId/status`.
3. Summarize: counts per state, and call out any `failed` (with `error`) or files with null `page_number` (report `file_id`).

**Re-run OCR on failures**

1. Get status (above); collect files where `state == "failed"`.
2. For each, `POST <URL>/api/books/:bookId/files/:fileId/ocr` (synchronous — returns when done).
3. Report per file: now `done`, or still failing (with the error). Don't loop endlessly — one retry pass, then summarize what's still broken.

**Delete a book**

1. Match the user's named book to a `title`/`id` via `GET /api/books`; if ambiguous, list and ask.
2. Confirm with the user — this wipes all the book's R2 scans, transcribed text, and rows. Irreversible.
3. `DELETE <URL>/api/books/:bookId`.
4. Report the returned counts: `files` rows and `r2_objects` removed.

**Search the corpus**

1. Resolve the Meili config (URL + read key, above).
2. `POST <MEILI_URL>/indexes/books/search` with the body shown in "Search the corpus" (default `semanticRatio` 0.5; raise toward 1 for concept queries, lower toward 0 for exact terms/names). To scope to one book, add `"filter": "book_id = '<bookId>'"`.
3. Render hits: `book_title` · `ص <page_number>` · cleaned snippet (strip `__ais-highlight__`, ruby, and markdown markers). Note the `file_id` (`id`) so the user can open it.
4. If nothing comes back for an abstract term, suggest a concrete phrase (e.g. "rules of ablution" instead of "fiqh").

## Notes

- Read-only ops (list, fetch, status) are safe to run freely. Creating a book mutates state — confirm the title/id with the user first if it wasn't explicit.
- Deleting a book is **irreversible** and removes its scans + text from R2. Always confirm the exact book id with the user before calling `DELETE`.
- Re-running OCR costs a Gemini call per file; before re-running a large batch, confirm the count with the user.
- To get the transcribed text into the vault, that's **arabic-ocr**, not this skill.
