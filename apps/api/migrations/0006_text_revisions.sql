-- Hand edits to a page's transcription, and a history of every change to it.

-- Set when the text was last changed by hand (PATCH .../text); cleared when a
-- re-OCR replaces it (the edited text stays in text_revisions).
ALTER TABLE files ADD COLUMN text_edited_at INTEGER;

-- One row per change to a page's text. `prev_key` is the R2 copy of the text
-- as it was just before the change, so any earlier version can be read back.
-- `change` says what replaced it: 'edit' (by hand) or 'ocr' (a re-run, with
-- `model`). Rows are written only when the text actually changed.
CREATE TABLE text_revisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id    TEXT NOT NULL,
  book_id    TEXT NOT NULL,
  change     TEXT NOT NULL CHECK (change IN ('edit', 'ocr')),
  model      TEXT,
  note       TEXT,
  prev_key   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_text_revisions_file ON text_revisions (file_id, created_at);
