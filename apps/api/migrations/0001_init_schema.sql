-- Migration number: 0001 	 2026-06-14T14:29:10.761Z

-- Books: top-level collection. Pages are NOT a stored entity — a "page" is
-- derived at assembly time by grouping files on page_number.
CREATE TABLE books (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Files: one row per uploaded image/PDF (a fragment). Dumb 1-1 unit.
-- OCR fills page_number / role / text_key / flags. Assembly (local) groups
-- these by page_number; the cloud never stitches.
CREATE TABLE files (
  file_id     TEXT PRIMARY KEY,
  book_id     TEXT NOT NULL REFERENCES books(id),
  r2_key      TEXT NOT NULL,            -- scan location in R2
  state       TEXT NOT NULL DEFAULT 'captured',
                                        -- captured|queued|processing|done|needs_review|approved|failed
  text_key    TEXT,                     -- R2 key of output .md (null until OCR done)
  page_number INTEGER,                  -- printed page number, OCR'd (null until known)
  role        TEXT,                     -- matn|footnote|... formatting hint from OCR
  order_hint  INTEGER,                  -- within-page ordering tiebreak
  flags       TEXT,                     -- JSON: uncertain spans (multi-pass disagreement)
  preview     TEXT,                     -- short excerpt for list views (avoid R2 fetch)
  error       TEXT,                     -- failure reason
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX idx_files_book        ON files (book_id);
CREATE INDEX idx_files_state       ON files (state);          -- poller / reconcile sweep
CREATE INDEX idx_files_book_page   ON files (book_id, page_number);  -- assembly export
