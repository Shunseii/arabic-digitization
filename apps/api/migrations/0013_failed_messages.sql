-- Migration number: 0013 	 2026-11-25

-- Queue messages that ran out of retries (wrangler.jsonc: max_retries, then
-- the arabic-ocr-dlq dead-letter queue), recorded by the DLQ consumer
-- (src/dlq.ts) so GET /api/jobs can show them. One row per page and kind:
-- a duplicate delivery, or the same page dying again, updates the row
-- instead of adding one (WITHOUT ROWID: one written row per change, plus the
-- partial index below while the row is unresolved).
--
-- kind: 'ocr' (an OCR message), 'review_apply' (applying a page's Opus
-- review; ref = the batch id), 'reindex' (a search rebuild step; file_id =
-- '', ref = the book id). attempts is the deliveries the message had.
-- resolved_at is set when the page later succeeds the same way (OCR done, or
-- a review recorded) in the write that already records that.
CREATE TABLE failed_messages (
  kind            TEXT NOT NULL CHECK (kind IN ('ocr', 'review_apply', 'reindex')),
  file_id         TEXT NOT NULL,
  book_id         TEXT,
  ref             TEXT,
  last_error      TEXT,
  attempts        INTEGER NOT NULL,
  first_failed_at INTEGER NOT NULL,
  last_failed_at  INTEGER NOT NULL,
  resolved_at     INTEGER,
  PRIMARY KEY (kind, file_id)
) WITHOUT ROWID;

-- The unresolved ones, newest first (GET /api/jobs). Partial, so resolved
-- rows cost nothing here and the read stays as small as what's open.
CREATE INDEX idx_failed_messages_open ON failed_messages (first_failed_at)
  WHERE resolved_at IS NULL;
