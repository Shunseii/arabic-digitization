// LLM-oriented API reference, served at GET /llms.txt (public — docs aren't
// secret; the API itself is gated by the master key). Keep this in sync with
// the routes; it's the single source a local skill fetches.

export const LLMS_TXT = `# Arabic Digitization API

Backend for digitizing scanned Arabic books: upload page images, they are OCR'd
to Markdown by an AI model (Gemini or Claude, chosen per book), and the text is
retrievable per-page or in bulk.

## Auth
Every /api/* request requires:
  Authorization: Bearer <MASTER_KEY>
Missing/wrong key -> 401. (GET /llms.txt and the docs UI at / are public.)

## Concepts
- A "book" is a collection of uploaded files. Books have an id (slug) and title.
- A "file" is one uploaded page image. Each file is OCR'd independently.
- "Pages" are not a stored entity: group files by page_number yourself when assembling.
- File state: captured | queued | processing | rate_limited | done | needs_review | approved | failed
- On upload a file is enqueued and OCR runs automatically (state queued -> processing -> done).
- rate_limited is transient: an OCR provider 429/5xx auto-re-queues with backoff (no action needed).
  Only 'failed' needs a manual re-run (POST .../ocr).
- A blank page is 'done' with empty text (and an empty preview), not 'failed'.
- OCR engine: each book has ocr_engine "gemini" | "claude" | null (null = default,
  gemini). That provider runs first; on a transient failure (429/5xx) the other one
  transcribes the page instead (also when Gemini blocks a page for recitation).
  The model that produced each page's text is recorded on the page and in history.
  Claude only reads images, so non-image files always start on Gemini.

## Hand edits and text history
A page's text changes in two ways: OCR (upload, POST .../ocr, POST .../requeue)
and hand edits (PATCH .../files/:fileId/text). Every change keeps the text it
replaced, so nothing is ever lost, but:

- Re-OCR OVERWRITES hand edits. Nothing is skipped or protected: re-running a
  single page, or requeueing a book with states:["done"] (e.g. after changing
  ocr_instructions or ocr_engine), replaces hand-fixed pages with fresh OCR, which usually
  brings back the mistake that was fixed.
- Before re-OCRing done pages, check GET .../status: a file with
  text_edited_at != null has hand edits that the re-run will replace. Tell the
  user, or leave those pages out (re-OCR the others one by one).
- After a re-OCR, text_edited_at is null again; the edited text is in history.

Checking a page's history (agents: do this before overwriting or restoring):
  GET .../files/:fileId/text/history   -> revisions, newest first
    Each revision is one change: change ("edit" by hand | "ocr" re-run, with
    model), note (why/who, for edits), created_at (epoch ms). Its id addresses
    the text as it was just BEFORE that change:
  GET .../files/:fileId/text?rev=<id>  -> that earlier text
  The current text is GET .../files/:fileId/text (no rev).
  A page whose newest revision is "ocr" right after an "edit" had its hand
  fixes overwritten by that re-run; ?rev=<that ocr revision's id> is the
  hand-fixed text.

Restoring an earlier version: read it with ?rev=<id>, then PATCH the page with
one edit whose "old" is the full current text and "new" is the earlier text
(note e.g. "restore rev 12"). The restore is itself recorded in history.

## Endpoints

POST /api/books
  Body (JSON): { "title": string, "id"?: slug, "ocr_instructions"?: string,
                "ocr_engine"?: "gemini"|"claude"|null }
  // id auto-generated if omitted; ocr_instructions are book-specific OCR notes
  // appended to the global system prompt at transcription time; ocr_engine picks
  // the provider that runs first (omitted/null = default, gemini).
  201 -> { success, book: { id, title, created_at, ocr_instructions, ocr_engine } }
  409 if id exists.

GET /api/books
  200 -> { success, books: [ { id, title, created_at, ocr_engine, files_total, counts: {state: n} } ] }

GET /api/books/:bookId
  200 -> { success, book: { id, title, created_at, ocr_instructions, ocr_engine, files_total, counts,
           usage: { input_tokens, output_tokens, cost_usd } | null } }
  // usage aggregates the book's done pages; null if none tracked yet.
  404 if missing.

PATCH /api/books/:bookId
  Update a book. Body (JSON): any of { "title"?: string, "ocr_instructions"?: string|null,
  "ocr_engine"?: "gemini"|"claude"|null }.
  At least one field required; ocr_instructions=null clears them; ocr_engine=null
  resets to the default engine (gemini). Changing ocr_instructions or ocr_engine
  does NOT re-OCR done pages — requeue them (POST .../requeue with states:["done"])
  to apply the change, which overwrites hand-edited pages too (see "Hand edits
  and text history").
  200 -> { success, book: { id, title, created_at, ocr_instructions, ocr_engine } }
  404 if missing.

DELETE /api/books/:bookId
  Delete a book and everything under it: its R2 objects (scans + text) and
  all its file rows, then the book row.
  200 -> { success, deleted: { book_id, files, r2_objects } }
  404 if missing.

GET /api/books/:bookId/status[?since=<epoch ms>]
  Per-file states (no text). Each file includes text_edited_at (epoch ms of the
  last hand edit, null if none).
  200 -> { success, files: [ { file_id, page_number, state, role, order_hint, preview, error, updated_at, text_edited_at, input_tokens, output_tokens, cost_usd } ], files_total }
  // With since, files holds only files whose updated_at > since; merge them
  // into the previous list by file_id. files_total always counts every file:
  // if the merged list is longer, files were deleted, so refetch without since.
  // Pass since a minute below the newest updated_at you hold: a slow write can
  // commit with an older timestamp than one you already saw.
  // input_tokens/output_tokens/cost_usd are null for pages OCR'd before usage
  // tracking (or not done yet); cost_usd is null if the model has no known price.

GET /api/books/:bookId/export[?limit=<1-200>[&cursor=<next_cursor>]]
  All files + their transcription text in one payload (for local assembly).
  200 -> { success, book_id, files: [ { file_id, page_number, role, order_hint, state, text } ] }
  text is null if not transcribed yet. Files ordered by page_number, then
  order_hint, then file_id; files with no page_number come last.
  // With limit, returns at most limit files plus files_total (every file in the
  // book, recounted each batch) and next_cursor (null on the last batch):
  //   200 -> { success, book_id, files: [...], files_total, next_cursor }
  // Pass next_cursor back as cursor (with limit) for the next batch. The cursor
  // marks the last file returned, so files added mid-import are neither skipped
  // nor repeated; a new file that sorts before the cursor arrives in no batch,
  // so the final count may differ from files_total.
  400 if limit is not an integer 1-200, cursor is malformed, or cursor is
  passed without limit. 404 if book missing.

POST /api/books/:bookId/requeue
  Bulk re-OCR. Body (JSON): { "states"?: FileState[] }. Moves every file in those
  states back to 'queued' and enqueues it. Defaults to ["failed","rate_limited"].
  All work flows through the throttled, auto-retrying consumer, so requeuing a
  whole book at once is safe. Pass states:["done"] to re-apply new ocr_instructions
  or a new ocr_engine.
  This OVERWRITES hand-edited pages too (check text_edited_at in status first);
  the replaced text is kept in each page's history.
  200 -> { success, requeued: <n>, states: [...] }
  404 if book missing.

POST /api/books/:bookId/pause
  Pause OCR for one book (other books keep processing). Its pages stay 'queued'
  and queued messages are dropped without calling an OCR model; pages uploaded while
  paused wait too. Book responses carry paused: boolean.
  200 -> { success, paused: true }
  404 if book missing.

POST /api/books/:bookId/resume
  Clear the pause and re-enqueue every 'queued' / 'rate_limited' page of the book.
  200 -> { success, paused: false, requeued: <n> }
  404 if book missing.

POST /api/books/:bookId/files?page=<n>
  Upload one page. Body = raw image bytes. Content-Type must be one of:
  image/jpeg, image/png, image/webp.
  ?page is optional (printed page number, when not detectable from the image).
  Inserts state=queued and triggers OCR automatically.
  201 -> { success, file: { file_id, book_id, r2_key, state, page_number, ... } }
  404 if book missing, 415 unsupported type, 400 missing body.

POST /api/books/:bookId/files/:fileId/ocr
  (Re-)queue a single file for OCR. Enqueues onto the same throttled, auto-retrying
  path as upload and returns immediately; poll status/export for the result.
  OVERWRITES hand edits too (text_edited_at in status); the replaced text is kept
  in the page's history.
  202 -> { success, file_id, state: "queued" }
  404 if file missing.

GET /api/books/:bookId/files/:fileId/text
  Raw Markdown transcription (Content-Type: text/markdown).
  ?rev=<id> returns the text as it was just before that change (see history).
  404 if file or revision missing, 409 if not transcribed yet.

PATCH /api/books/:bookId/files/:fileId/text
  Hand-edit a transcription with exact find-and-replace edits.
  Body: { "edits": [ { "old": "<exact text>", "new": "<replacement>" }, ... ], "note"?: "<why/who>" }
  Each "old" must occur exactly once in the text as it stands after the previous
  edits; include surrounding text to disambiguate. All or nothing. To replace the
  whole page, use one edit whose "old" is the full current text.
  200 -> { success, file_id, changed, revision_id, text_edited_at }
  422 -> { success: false, failed_edit, reason } (nothing applied)
  409 if the page isn't 'done', or changed during the edit (re-read and retry).
  The replaced text is saved to the history, and the page is marked hand-edited
  (text_edited_at in status) until a re-OCR replaces it.

GET /api/books/:bookId/files/:fileId/text/history
  Every change to the page's text, newest first. Hand edits and re-OCRs both
  save the text they replace; GET .../text?rev=<id> reads it back. Changes made
  before history existed (2026-11-21) are not listed.
  200 -> { success, file_id, text_edited_at, revisions: [ { id, change: "edit"|"ocr", model, note, created_at } ] }

## Output Markdown conventions (what the OCR produces)
- First line = the running page header (topic + page number), then a blank line,
  then "---", then a blank line, then the body.
- Section/chapter titles (كتاب/باب/فصل ...) become Markdown headings (##, ###).
- Bottom footnotes (حاشية): after the matn, a blank line, "---", blank line,
  "### الحاشية", then the footnotes.
- Interlinear glosses (small text between lines) are <ruby>span<rt>gloss</rt></ruby>.
- Tashkeel (diacritics) preserved as printed.

## Typical workflow
1. Create a book:
   curl -X POST $BASE/api/books -H "Authorization: Bearer $KEY" \\
     -H 'content-type: application/json' -d '{"id":"my-book","title":"..."}'
2. Upload pages (auto-OCR'd):
   curl -X POST "$BASE/api/books/my-book/files?page=12" -H "Authorization: Bearer $KEY" \\
     -H 'content-type: image/jpeg' --data-binary @page12.jpg
3. Poll status until done:
   curl $BASE/api/books/my-book/status -H "Authorization: Bearer $KEY"
4. Pull everything for local assembly:
   curl $BASE/api/books/my-book/export -H "Authorization: Bearer $KEY"
`;
