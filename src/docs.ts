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
- File state: captured | queued | processing | done | needs_review | approved | failed
- On upload a file is enqueued and OCR runs automatically (state queued -> processing -> done).

## Endpoints

POST /api/books
  Body (JSON): { "title": string, "id"?: slug }   // id auto-generated if omitted
  201 -> { success, book: { id, title, created_at } }
  409 if id exists.

GET /api/books
  200 -> { success, books: [ { id, title, created_at, files_total, counts: {state: n} } ] }

GET /api/books/:bookId
  200 -> { success, book: { id, title, created_at, files_total, counts } }
  404 if missing.

GET /api/books/:bookId/status
  Per-file states (no text). Poll this to watch progress.
  200 -> { success, files: [ { file_id, page_number, state, role, order_hint, preview, error, updated_at } ] }

GET /api/books/:bookId/export
  All files + their transcription text in one payload (for local assembly).
  200 -> { success, book_id, files: [ { file_id, page_number, role, order_hint, state, text } ] }
  text is null if not transcribed yet. Files ordered by page_number.

POST /api/books/:bookId/files?page=<n>
  Upload one page. Body = raw image/PDF bytes. Content-Type must be one of:
  image/jpeg, image/png, image/webp, application/pdf.
  ?page is optional (printed page number, when not detectable from the image).
  Inserts state=queued and triggers OCR automatically.
  201 -> { success, file: { file_id, book_id, r2_key, state, page_number, ... } }
  404 if book missing, 415 unsupported type, 400 missing body.

POST /api/books/:bookId/files/:fileId/ocr
  Re-run OCR on a file synchronously (model is fixed: Gemini). Returns when done.
  200 -> { success, file_id, model, text, text_key, usage }

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
