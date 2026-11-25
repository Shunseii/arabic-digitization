// LLM-oriented API reference, served at GET /llms.txt (public — docs aren't
// secret; the API itself is gated by the master key). Keep this in sync with
// the routes; it's the single source a local skill fetches.

export const LLMS_TXT = `# Arabic Digitization API

Backend for digitizing scanned Arabic books: upload page images, they are OCR'd
to Markdown by an AI model (Inkling or Claude, chosen per book), and the text is
retrievable per-page or in bulk.

## Auth
Every /api/* request requires:
  Authorization: Bearer <MASTER_KEY>
Missing/wrong key -> 401. (GET /llms.txt and the docs UI at / are public.)
JSON request bodies need Content-Type: application/json; another type -> 415,
malformed JSON -> 400.

## Concepts
- A "book" is a collection of uploaded files. Books have an id (slug) and title.
- A "file" is one uploaded page image. Each file is OCR'd independently.
- "Pages" are not a stored entity: group files by page_number yourself when assembling.
- File state: captured | queued | processing | rate_limited | done | needs_review | approved | failed
- On upload a file is enqueued and OCR runs automatically (state queued -> processing -> done).
- rate_limited is transient: an OCR provider 429/5xx auto-re-queues with backoff (no action needed).
  Only 'failed' needs a manual re-run (POST .../ocr).
- A blank page is 'done' with empty text (and an empty preview), not 'failed'.
- OCR engine: each book has ocr_engine "inkling" | "claude" | null (null = default,
  inkling). That provider runs first; on a transient failure (429/5xx, network
  error or timeout) the other one transcribes the page instead (also when Inkling's
  output is cut off at its length cap; a cut-off page is never stored).
  The model that produced each page's text is recorded on the page and in history.
- Uploads are page images only (JPEG, PNG, WebP). PDFs are rejected with 415:
  export each page as an image first.

## Hand edits and text history
A page's text changes in three ways: OCR (upload, POST .../ocr, POST .../requeue),
hand edits (PATCH .../files/:fileId/text) and the Opus review (see below).
Every change keeps the text it replaced, so nothing is ever lost, but:

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
    model | "review" an applied Opus review, with model), note (why/who, for
    edits; the batch and edit counts, for reviews), created_at (epoch ms). Its id addresses
    the text as it was just BEFORE that change:
  GET .../files/:fileId/text?rev=<id>  -> that earlier text
  The current text is GET .../files/:fileId/text (no rev).
  A page whose newest revision is "ocr" right after an "edit" had its hand
  fixes overwritten by that re-run; ?rev=<that ocr revision's id> is the
  hand-fixed text.

Restoring an earlier version: read it with ?rev=<id>, then PATCH the page with
one edit whose "old" is the full current text and "new" is the earlier text
(note e.g. "restore rev 12"). The restore is itself recorded in history.
To undo an Opus review, restore the text of its "review" revision this way.

## Opus review (per book, off by default)
A book with review_enabled = true gets each page proofread by Claude Opus
after OCR: Opus compares the stored text with the scan and returns exact
find-and-replace edits, each with a category (tashkeel, spelling, quran,
footnotes, punctuation, layout). It runs through the Anthropic Message
Batches API (half price, results within 24 hours), not inline:
- A page of an opted-in book that reaches 'done' (with text) waits for review.
  Turning review on does not queue pages already done: POST .../review does.
- Every 3 hours, if pages are waiting, one batch of up to 100 is submitted.
  Results are applied page by page as they come back.
- Edits are applied like a hand edit: each "find" must match exactly once,
  in order; one that doesn't is counted as failed to apply and skipped. The
  applied change is one "review" revision in the page's history (undoable).
- Pages edited by hand (text_edited_at != null) are never reviewed or
  changed, nor is a page whose text changed while it was in review (it is
  queued again). A review does not set text_edited_at.
- review_effort (low | medium | high, default low) trades cost for depth.
  Rough cost per page at batch prices: $0.02-0.06.
- A request that errors on Anthropic's side (api_error, overloaded_error, ...),
  expires or is canceled is not billed; the page is queued again, up to 3
  tries in a row, then its review is marked failed with the last reason. An
  invalid_request_error is never retried.
- If a batch's Workflow instance dies (errored or terminated), the cron marks
  the batch failed once it is 28 hours old and puts its pages back in the
  queue (each counting a try).
- Each review is recorded in D1 (table page_reviews): status, each edit with
  its category and whether it applied, tokens and cost, model, batch id. Read
  them with GET .../files/:fileId/reviews, GET /api/reviews/summary and
  GET /api/jobs.

## Endpoints

POST /api/books
  Body (JSON): { "title": string, "id"?: slug, "ocr_instructions"?: string,
                "ocr_engine"?: "inkling"|"claude"|null }
  // id auto-generated if omitted; ocr_instructions are book-specific OCR notes
  // appended to the global system prompt at transcription time; ocr_engine picks
  // the provider that runs first (omitted/null = default, inkling).
  201 -> { success, book: { id, title, created_at, ocr_instructions, ocr_engine } }
  409 if id exists.

GET /api/books
  200 -> { success, books: [ { id, title, created_at, ocr_engine, files_total, counts: {state: n} } ] }

GET /api/books/:bookId
  200 -> { success, book: { id, title, created_at, ocr_instructions, ocr_engine, paused,
           review_enabled, review_effort, files_total, counts,
           usage: { input_tokens, output_tokens, cost_usd,
                    ocr: Spend, review: Spend, total_cost_usd } | null } }
  Spend = { cost_usd, input_tokens, output_tokens, calls, pages }
  // input_tokens/output_tokens/cost_usd: the OCR of the pages' current text.
  // ocr / review: everything billed for this book (re-runs and failed calls
  // that still produced tokens included; unbilled review results add $0);
  // calls = billed provider calls, pages = pages transcribed / reviewed.
  // usage is null if nothing was tracked yet.
  404 if missing.

PATCH /api/books/:bookId
  Update a book. Body (JSON): any of { "title"?: string, "ocr_instructions"?: string|null,
  "ocr_engine"?: "inkling"|"claude"|null, "review_enabled"?: boolean,
  "review_effort"?: "low"|"medium"|"high"|null }.
  review_enabled turns the Opus review on or off (it costs money; see "Opus
  review"); review_effort=null resets to the default (low).
  At least one field required; ocr_instructions=null clears them; ocr_engine=null
  resets to the default engine (inkling). Changing ocr_instructions or ocr_engine
  does NOT re-OCR done pages — requeue them (POST .../requeue with states:["done"])
  to apply the change, which overwrites hand-edited pages too (see "Hand edits
  and text history").
  200 -> { success, book: { id, title, created_at, ocr_instructions, ocr_engine, work_id,
           paused, review_enabled, review_effort } }
  404 if missing.

POST /api/books/:bookId/review
  Queue the book's pages that are already done for the Opus review (pages that
  finish OCR later are queued automatically). Leaves out hand-edited and blank
  pages. They are reviewed over the next runs, up to 100 pages per batch.
  200 -> { success, queued: <n newly queued> }
  404 if book missing, 409 if review_enabled is false.

DELETE /api/books/:bookId
  Delete a book and everything under it: its R2 objects (scans + text) and
  all its file rows, then the book row.
  200 -> { success, deleted: { book_id, files, r2_objects } }
  404 if missing.

GET /api/books/:bookId/status[?since=<epoch ms>]
  Per-file states (no text). Each file includes text_edited_at (epoch ms of the
  last hand edit, null if none).
  200 -> { success, files: [ { file_id, page_number, state, role, order_hint, preview, error, updated_at, text_edited_at, input_tokens, output_tokens, cost_usd, ocr_cost_usd, review_cost_usd } ], files_total }
  // ocr_cost_usd (= cost_usd) is the OCR of the page's current text;
  // review_cost_usd is what its Opus reviews cost (null if never reviewed).
  // With since, files holds only files whose updated_at > since; merge them
  // into the previous list by file_id. files_total always counts every file:
  // if the merged list is longer, files were deleted, so refetch without since.
  // Pass since a minute below the newest updated_at you hold: a slow write can
  // commit with an older timestamp than one you already saw.
  // input_tokens/output_tokens/cost_usd are null for pages OCR'd before usage
  // tracking (or not done yet); cost_usd is null if the model has no known price.

GET /api/files/recent[?limit=<1-100>]
  The most recently updated files across every book, newest first (default 25).
  Each has the same fields as a status file, plus its book_id and book_title.
  200 -> { success, files: [ { file_id, ..., cost_usd, book_id, book_title } ] }
  // For an activity feed: one cheap call instead of every book's status.
  400 if limit is not an integer 1-100.

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
  image/jpeg, image/png, image/webp. Anything else (e.g. application/pdf) -> 415.
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
  200 -> { success, file_id, text_edited_at, revisions: [ { id, change: "edit"|"ocr"|"review", model, note, created_at } ] }

GET /api/books/:bookId/files/:fileId/reviews
  The page's Opus reviews, newest first.
  200 -> { success, file_id, reviews: [ { batch_id, created_at, model, effort, attempt,
           status, error_type, error, edits_proposed, edits_applied, edits_failed,
           edits: [ { find, replace, category, applied } ], chars_changed, chars_total,
           cost_usd, revision_id } ] }
  // status: applied | no_changes | skipped_hand_edited | stale | conflict |
  // page_gone | invalid_output | refused | errored | expired | canceled (queued
  // again) | failed (not retried). revision_id is the "review" history entry.
  404 if file missing.

## Activity and usage (read-only)

GET /api/jobs
  Running work, for an activity screen. Reads D1 only (never Anthropic), so
  refresh it on demand; don't poll.
  200 -> { success, now,
    ocr: {
      books: [ { book_id, title, paused, queued, processing, rate_limited, failed,
                 oldest_queued_at, done_last_hour, recent_runs, fell_back, retried } ],
      recent_since,
      problem_pages: [ { file_id, book_id, created_at, status, final_model, fell_back,
                         fallback_reason, delivery_attempt, error_type } ] },
    failed: {
      count,
      recent: [ { id, kind: "ocr"|"review_apply"|"reindex", file_id, book_id,
                  book_title, page_number, ref, error, attempts, first_failed_at,
                  last_failed_at } ] },
    review: {
      in_flight: [ Batch ], waiting: [ { book_id, title, pages, retrying } ],
      recent: [ Batch ] } }
  Batch = { instance_id, batch_id, stage, instance_status, pages, reviewed,
            created_at, submitted_at, ended_at, anthropic_ended_at, checks, steps,
            request_counts: { processing, succeeded, errored, expired, canceled },
            edits_applied, edits_failed, errors, cost_usd, error }
  // failed: queue messages that ran out of retries (OCR of a page, applying
  // a page's review, a search rebuild step) and haven't been resolved by a
  // later success of the same page and kind: count, and the 10 newest by
  // first_failed_at. id is "<kind>:<file_id>"; ref is the review batch id
  // (review_apply) or the book id (reindex); error is the last error seen, or
  // null if it wasn't kept. An OCR failure resolves when the page is next
  // transcribed (POST .../ocr); a review_apply one when a later review of the
  // page is recorded.
  // books: those with pages not done, or OCR runs in the recent window
  // (recent_since: the last 300 runs within 24 hours). oldest_queued_at is
  // null for paused books. fell_back = runs finished by the fallback engine;
  // retried = runs on a redelivery. problem_pages: the latest runs that fell
  // back, failed, or ran on a third delivery or later.
  // stage: preparing | submitting | processing (waiting on Anthropic; request_counts as
  // of the last check that saw them change: checks run every minute for the
  // first hour, every 10 minutes to 3 hours, then hourly) | ingesting (ended_at:
  // when the batch ended, so ended_at - submitted_at is its duration) | applying
  // (pages being applied: reviewed of pages) | done | empty | timed_out |
  // failed. recent: the last 10 finished batches.

GET /api/spend[?days=<1-90, default 30>][&book=<bookId>]
  What OCR and the Opus review cost, from a daily rollup (UTC days, today
  included). Every billed call counts: OCR re-runs, fallbacks, failed calls
  that still produced tokens, and billed review results.
  200 -> { success, since_day, book_id, total_cost_usd,
           by_model: [ { kind: "ocr"|"review", model, cost_usd, input_tokens, output_tokens,
                         cache_creation_input_tokens, cache_read_input_tokens, calls, pages } ],
           daily: [ { day, ocr_cost_usd, review_cost_usd } ],
           top_books: [ { kind, book_id, title, cost_usd, pages } ] }
  // daily lists only days with spend, oldest first. top_books: the 5 costliest
  // books per kind (empty with book=).

GET /api/reviews/summary[?days=<1-90, default 30>][&book=<bookId>]
  Opus review totals over the window, for the usage dashboard.
  200 -> { success, since, book_id, pages_reviewed, pages_changed,
           pages_not_reviewed, pages_skipped, by_status: { status: n },
           edits: { proposed, applied, failed }, by_category: { tashkeel|spelling|
           quran|footnotes|punctuation|layout: { proposed, applied, failed } },
           text_changed_share, cost_usd, cost_per_page_usd, hand_edited_after_review,
           batches: { count, pages_avg, duration_ms: { p50, p90, max },
                      polling_lag_ms: { p50, max }, checks: { avg, max },
                      steps: { avg, max } } }
  // edits.failed = failed to apply (find didn't match exactly once).
  // text_changed_share = characters changed by applied edits / characters of
  // the reviewed pages. hand_edited_after_review = pages a review changed that
  // were then edited by hand.
  // batches: review batches started in the window (all books, since a batch
  // mixes books), for tuning how often batches are polled. duration_ms is
  // submission to Anthropic's ended_at; polling_lag_ms is Anthropic's ended_at
  // to the check that saw it; checks/steps are the status checks and Workflow
  // steps a batch used. Percentiles are nearest-rank; null with no data.

## OCR run history (admin)
Every OCR run of a page (primary engine plus any fallback) is recorded in D1
(table ocr_runs, never overwritten) with its trigger, outcome, engine and final
model, every provider call with tokens/cost/latency, the prompt versions used,
and neutral page metrics (word/char counts, header and footnote format, Qur'an
spans, Uthmani marks, glosses, footnote marker counts). The text each run
produced is kept in R2. There is no read endpoint yet; query D1 directly.

POST /api/admin/ocr-runs/recompute-metrics
  Recompute the metrics cache of runs computed by an older metrics version
  (after a metrics definition change). Paged: one call handles up to "limit"
  runs, reading each run's text from R2.
  Body (optional): { "after"?: <run id, default 0>, "limit"?: 1-25 (default 10) }
  200 -> { success, metrics_version, updated, missing, next_after }
  Call again with after = next_after until next_after is null. "missing" counts
  runs whose text is gone (book or page deleted); they are skipped.
  If a call fails with error 1102 (CPU limit exceeded), lower "limit".

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
