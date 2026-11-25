-- Migration number: 0012 	 2026-11-24

-- Opus review: after OCR, Claude Opus checks a page's text against its scan
-- through the Message Batches API and returns find-and-replace edits, which
-- are applied as a tracked change (see src/review/).

-- Per-book opt-in. Review spends money, so it is off unless a book enables it.
-- review_effort is the Opus effort level; NULL = the default (low).
ALTER TABLE books ADD COLUMN review_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE books ADD COLUMN review_effort TEXT
  CHECK (review_effort IN ('low', 'medium', 'high'));


-- Pages waiting for review. A row is added when a page of an opted-in book
-- reaches 'done' (or by POST /api/books/:bookId/review), claimed by a review
-- Workflow instance (instance_id), and deleted when that batch ends. Small by
-- design: it holds only the pages in flight, so scanning it is cheap and it
-- needs no index (WITHOUT ROWID: the primary key is the table, one written row
-- per change). `attempts` counts the page's consecutive tries that ended
-- without a review (server error, expired, canceled); the third ends in
-- 'failed'.
CREATE TABLE review_queue (
  file_id     TEXT PRIMARY KEY,
  book_id     TEXT NOT NULL,
  queued_at   INTEGER NOT NULL,
  instance_id TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

-- One row per review Workflow instance (one Message Batch), written at each
-- stage so GET /api/jobs can show progress without asking Anthropic:
--   preparing  pages claimed, requests being built
--   submitting create sent at submit_attempted_at; a retried submit finds
--              a batch that attempt created instead of creating another
--   processing batch submitted; a status check stores Anthropic's counts
--              when they changed (most checks change nothing)
--   ingesting  batch ended (ended_at: when a check first saw it;
--              anthropic_ended_at: when Anthropic says it finished, so the
--              difference is the polling lag), results being copied to R2
--   applying   one queue message per page sent; pages are applied as they land
--   empty      nothing eligible to send (no batch)
--   timed_out  the batch didn't end within 26 hours; pages went back to the queue
--   failed     a step ran out of retries; pages went back to the queue
-- checks and steps (status checks run, and Workflow steps used counting
-- sleeps) are written by the final write, to tune the poll schedule.
-- The index on created_at serves the recent-batches list and the in-flight
-- window (one extra written row per batch).
CREATE TABLE review_batches (
  instance_id       TEXT PRIMARY KEY,
  batch_id          TEXT,
  created_at        INTEGER NOT NULL,
  model             TEXT NOT NULL,
  pages             INTEGER NOT NULL,
  stage             TEXT NOT NULL CHECK (stage IN (
                      'preparing', 'submitting', 'processing', 'ingesting', 'applying',
                      'empty', 'timed_out', 'failed')),
  submit_attempted_at INTEGER,
  submitted_at      INTEGER,
  processing_status TEXT,
  processing        INTEGER NOT NULL DEFAULT 0,
  succeeded         INTEGER NOT NULL DEFAULT 0,
  errored           INTEGER NOT NULL DEFAULT 0,
  expired           INTEGER NOT NULL DEFAULT 0,
  canceled          INTEGER NOT NULL DEFAULT 0,
  ended_at          INTEGER,
  anthropic_ended_at INTEGER,
  checks            INTEGER,
  steps             INTEGER,
  results_key       TEXT,
  error             TEXT
) WITHOUT ROWID;

CREATE INDEX idx_review_batches_created ON review_batches (created_at);

-- One row per reviewed page per batch: the outcome, the edits, and the tokens
-- and cost (at batch prices), for the usage dashboard. Written once by the
-- queue consumer that applies the review (the primary key makes a redelivered
-- message a no-op, and serves a page's own review list). The created_at index
-- serves the time-window reads (summary, recent batches): one extra written
-- row per reviewed page.
--
-- status: applied | no_changes | skipped_hand_edited | stale | conflict |
-- page_gone | invalid_output | refused; errored, expired, canceled (the page
-- went back to the queue); failed (it won't be retried: an invalid request,
-- or the third try in a row without a review). error_type/error say why.
--
-- edits is JSON: [{"find", "replace", "category", "applied"}]. categories is
-- JSON keyed by category (tashkeel, spelling, quran, footnotes, punctuation,
-- layout): {"tashkeel": {"proposed": 2, "applied": 2, "failed": 0}}; totals
-- are the edits_* columns. chars_changed is the length of the text the
-- applied edits replaced or inserted (the larger of find and replace),
-- against chars_total, the page's length. cost_usd is priced when the row is
-- written (lib/cost.ts); the token counts stay the durable truth.
CREATE TABLE page_reviews (
  file_id                     TEXT NOT NULL,
  batch_id                    TEXT NOT NULL,
  book_id                     TEXT NOT NULL,
  created_at                  INTEGER NOT NULL,
  model                       TEXT NOT NULL,
  effort                      TEXT NOT NULL,
  attempt                     INTEGER NOT NULL DEFAULT 0,
  status                      TEXT NOT NULL CHECK (status IN (
                                'applied', 'no_changes', 'skipped_hand_edited',
                                'stale', 'conflict', 'page_gone', 'invalid_output',
                                'refused', 'errored', 'expired', 'canceled',
                                'failed')),
  error_type                  TEXT,
  error                       TEXT,
  edits_proposed              INTEGER NOT NULL DEFAULT 0,
  edits_applied               INTEGER NOT NULL DEFAULT 0,
  edits_failed                INTEGER NOT NULL DEFAULT 0,
  categories                  TEXT,
  edits                       TEXT,
  chars_changed               INTEGER NOT NULL DEFAULT 0,
  chars_total                 INTEGER NOT NULL DEFAULT 0,
  input_tokens                INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens               INTEGER NOT NULL DEFAULT 0,
  cost_usd                    REAL NOT NULL DEFAULT 0,
  revision_id                 INTEGER,
  PRIMARY KEY (file_id, batch_id)
) WITHOUT ROWID;

CREATE INDEX idx_page_reviews_created ON page_reviews (created_at);

-- text_revisions.change gains 'review' (an applied Opus review, with model).
-- SQLite can't alter a CHECK constraint, so the table is rebuilt.
CREATE TABLE text_revisions_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id    TEXT NOT NULL,
  book_id    TEXT NOT NULL,
  change     TEXT NOT NULL CHECK (change IN ('edit', 'ocr', 'review')),
  model      TEXT,
  note       TEXT,
  prev_key   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
INSERT INTO text_revisions_new (id, file_id, book_id, change, model, note, prev_key, created_at)
  SELECT id, file_id, book_id, change, model, note, prev_key, created_at FROM text_revisions;
DROP TABLE text_revisions;
ALTER TABLE text_revisions_new RENAME TO text_revisions;
CREATE INDEX idx_text_revisions_file ON text_revisions (file_id, created_at);
