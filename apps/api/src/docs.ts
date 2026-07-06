// LLM-oriented API reference, served at GET /llms.txt (public — docs aren't
// secret; the API itself is gated by the master key). Keep this in sync with
// the routes; it's the single source a local skill fetches.

export const LLMS_TXT = `# Arabic Digitization API

Backend for digitizing scanned Arabic books: upload page images, they are OCR'd
to Markdown by Gemini, and the text is retrievable per-page or in bulk.

## Auth
Every /api/* request requires:
  Authorization: Bearer <MASTER_KEY>
Missing/wrong key -> 401. (GET /llms.txt and the docs UI at / are public.)

## Concepts
- A "book" is a collection of uploaded files. Books have an id (slug) and title.
- A "file" is one uploaded page image/PDF. Each file is OCR'd independently.
- "Pages" are not a stored entity: group files by page_number yourself when assembling.
- File state: captured | queued | processing | rate_limited | done | needs_review | approved | failed
- On upload a file is enqueued and OCR runs automatically (state queued -> processing -> done).
- rate_limited is transient: a Gemini 429/5xx auto-re-queues with backoff (no action needed).
  Only 'failed' needs a manual re-run (POST .../ocr).

## Endpoints

POST /api/books
  Body (JSON): { "title": string, "id"?: slug, "ocr_instructions"?: string }
  // id auto-generated if omitted; ocr_instructions are book-specific OCR notes
  // appended to the global system prompt at transcription time.
  201 -> { success, book: { id, title, created_at, ocr_instructions } }
  409 if id exists.

GET /api/books
  200 -> { success, books: [ { id, title, created_at, files_total, counts: {state: n} } ] }

GET /api/books/:bookId
  200 -> { success, book: { id, title, created_at, ocr_instructions, files_total, counts } }
  404 if missing.

PATCH /api/books/:bookId
  Update a book. Body (JSON): any of { "title"?: string, "ocr_instructions"?: string|null }.
  At least one field required; ocr_instructions=null clears them. Does NOT re-OCR
  done pages — requeue them (POST .../requeue with states:["done"]) to apply them.
  200 -> { success, book: { id, title, created_at, ocr_instructions } }
  404 if missing.

DELETE /api/books/:bookId
  Delete a book and everything under it: its R2 objects (scans + text) and
  all its file rows, then the book row.
  200 -> { success, deleted: { book_id, files, r2_objects } }
  404 if missing.

GET /api/books/:bookId/status
  Per-file states (no text). Poll this to watch progress.
  200 -> { success, files: [ { file_id, page_number, state, role, order_hint, preview, error, updated_at } ] }

GET /api/books/:bookId/export
  All files + their transcription text in one payload (for local assembly).
  200 -> { success, book_id, files: [ { file_id, page_number, role, order_hint, state, text } ] }
  text is null if not transcribed yet. Files ordered by page_number.

POST /api/books/:bookId/requeue
  Bulk re-OCR. Body (JSON): { "states"?: FileState[] }. Moves every file in those
  states back to 'queued' and enqueues it. Defaults to ["failed","rate_limited"].
  All work flows through the throttled, auto-retrying consumer, so requeuing a
  whole book at once is safe. Pass states:["done"] to re-apply new ocr_instructions.
  200 -> { success, requeued: <n>, states: [...] }
  404 if book missing.

POST /api/books/:bookId/files?page=<n>
  Upload one page. Body = raw image/PDF bytes. Content-Type must be one of:
  image/jpeg, image/png, image/webp, application/pdf.
  ?page is optional (printed page number, when not detectable from the image).
  Inserts state=queued and triggers OCR automatically.
  201 -> { success, file: { file_id, book_id, r2_key, state, page_number, ... } }
  404 if book missing, 415 unsupported type, 400 missing body.

POST /api/books/:bookId/files/:fileId/ocr
  (Re-)queue a single file for OCR. Enqueues onto the same throttled, auto-retrying
  path as upload and returns immediately; poll status/export for the result.
  202 -> { success, file_id, state: "queued" }
  404 if file missing.

GET /api/books/:bookId/files/:fileId/text
  Raw Markdown transcription (Content-Type: text/markdown).
  404 if file missing, 409 if not transcribed yet.

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
