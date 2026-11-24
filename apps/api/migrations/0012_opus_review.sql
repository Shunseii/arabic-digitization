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
-- per change).
CREATE TABLE review_queue (
  file_id     TEXT PRIMARY KEY,
  book_id     TEXT NOT NULL,
  queued_at   INTEGER NOT NULL,
  instance_id TEXT
) WITHOUT ROWID;

-- One row per submitted Message Batch: written when it is submitted and
-- updated once when its results are in.
CREATE TABLE review_batches (
  batch_id    TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  model       TEXT NOT NULL,
  pages       INTEGER NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('in_progress', 'ended', 'timed_out')),
  ended_at    INTEGER,
  succeeded   INTEGER,
  errored     INTEGER,
  expired     INTEGER,
  canceled    INTEGER,
  results_key TEXT
) WITHOUT ROWID;

-- One row per reviewed page per batch: the outcome, the edits by category,
-- and the tokens and cost (at batch prices), for the usage dashboard. Written
-- once by the queue consumer that applies the review (the primary key makes a
-- redelivered message a no-op). No secondary index, to keep it at one written
-- row per page; add (book_id, created_at) if the dashboard needs per-book reads.
--
-- categories is JSON keyed by category (tashkeel, spelling, quran, footnotes,
-- punctuation, layout): {"tashkeel": {"proposed": 2, "applied": 2, "failed": 0}}.
-- Totals across categories are the edits_* columns. cost_usd is priced when the
-- row is written (lib/cost.ts); the token counts stay the durable truth.
CREATE TABLE page_reviews (
  batch_id                    TEXT NOT NULL,
  file_id                     TEXT NOT NULL,
  book_id                     TEXT NOT NULL,
  created_at                  INTEGER NOT NULL,
  model                       TEXT NOT NULL,
  effort                      TEXT NOT NULL,
  status                      TEXT NOT NULL CHECK (status IN (
                                'applied', 'no_changes', 'skipped_hand_edited',
                                'stale', 'conflict', 'page_gone', 'invalid_output',
                                'refused', 'errored', 'expired', 'canceled')),
  error                       TEXT,
  edits_proposed              INTEGER NOT NULL DEFAULT 0,
  edits_applied               INTEGER NOT NULL DEFAULT 0,
  edits_failed                INTEGER NOT NULL DEFAULT 0,
  categories                  TEXT,
  input_tokens                INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens               INTEGER NOT NULL DEFAULT 0,
  cost_usd                    REAL NOT NULL DEFAULT 0,
  revision_id                 INTEGER,
  PRIMARY KEY (batch_id, file_id)
) WITHOUT ROWID;

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
