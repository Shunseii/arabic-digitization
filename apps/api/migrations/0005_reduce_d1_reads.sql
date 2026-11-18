-- Running per-book counters, kept by triggers on `files`, so the book list and
-- book screen read a handful of rows instead of counting every page per call.

-- Lets book-scoped state filters (requeue, resume, counters backfill) use an index.
CREATE INDEX idx_files_book_state ON files (book_id, state);
-- Delta reads for GET /status?since=.
CREATE INDEX idx_files_book_updated ON files (book_id, updated_at);

-- Pages per (book, state). Rows can reach n = 0; readers filter them out.
CREATE TABLE book_state_counts (
  book_id TEXT NOT NULL,
  state   TEXT NOT NULL,
  n       INTEGER NOT NULL,
  PRIMARY KEY (book_id, state)
);

-- OCR token usage per (book, model). `ocr_model` is '' when the file has none,
-- since a NULL can't take part in the primary key. `n` counts contributing files.
CREATE TABLE book_usage (
  book_id       TEXT NOT NULL,
  ocr_model     TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  n             INTEGER NOT NULL,
  PRIMARY KEY (book_id, ocr_model)
);

INSERT INTO book_state_counts (book_id, state, n)
SELECT book_id, state, COUNT(*) FROM files GROUP BY book_id, state;

INSERT INTO book_usage (book_id, ocr_model, input_tokens, output_tokens, n)
SELECT book_id, COALESCE(ocr_model, ''), SUM(input_tokens),
       SUM(COALESCE(output_tokens, 0)), COUNT(*)
  FROM files WHERE input_tokens IS NOT NULL
 GROUP BY book_id, COALESCE(ocr_model, '');

CREATE TRIGGER files_counters_insert AFTER INSERT ON files
BEGIN
  INSERT INTO book_state_counts (book_id, state, n)
  VALUES (NEW.book_id, NEW.state, 1)
  ON CONFLICT (book_id, state) DO UPDATE SET n = n + 1;

  INSERT INTO book_usage (book_id, ocr_model, input_tokens, output_tokens, n)
  SELECT NEW.book_id, COALESCE(NEW.ocr_model, ''), NEW.input_tokens,
         COALESCE(NEW.output_tokens, 0), 1
   WHERE NEW.input_tokens IS NOT NULL
  ON CONFLICT (book_id, ocr_model) DO UPDATE SET
    input_tokens = input_tokens + excluded.input_tokens,
    output_tokens = output_tokens + excluded.output_tokens,
    n = n + 1;
END;

CREATE TRIGGER files_counters_delete AFTER DELETE ON files
BEGIN
  UPDATE book_state_counts SET n = n - 1
   WHERE book_id = OLD.book_id AND state = OLD.state;

  UPDATE book_usage SET
    input_tokens = input_tokens - OLD.input_tokens,
    output_tokens = output_tokens - COALESCE(OLD.output_tokens, 0),
    n = n - 1
   WHERE OLD.input_tokens IS NOT NULL
     AND book_id = OLD.book_id AND ocr_model = COALESCE(OLD.ocr_model, '');
END;

CREATE TRIGGER files_counters_state AFTER UPDATE OF state, book_id ON files
WHEN OLD.state IS NOT NEW.state OR OLD.book_id IS NOT NEW.book_id
BEGIN
  UPDATE book_state_counts SET n = n - 1
   WHERE book_id = OLD.book_id AND state = OLD.state;

  INSERT INTO book_state_counts (book_id, state, n)
  VALUES (NEW.book_id, NEW.state, 1)
  ON CONFLICT (book_id, state) DO UPDATE SET n = n + 1;
END;

CREATE TRIGGER files_counters_usage
AFTER UPDATE OF input_tokens, output_tokens, ocr_model, book_id ON files
WHEN OLD.input_tokens IS NOT NEW.input_tokens
  OR OLD.output_tokens IS NOT NEW.output_tokens
  OR OLD.ocr_model IS NOT NEW.ocr_model
  OR OLD.book_id IS NOT NEW.book_id
BEGIN
  UPDATE book_usage SET
    input_tokens = input_tokens - OLD.input_tokens,
    output_tokens = output_tokens - COALESCE(OLD.output_tokens, 0),
    n = n - 1
   WHERE OLD.input_tokens IS NOT NULL
     AND book_id = OLD.book_id AND ocr_model = COALESCE(OLD.ocr_model, '');

  INSERT INTO book_usage (book_id, ocr_model, input_tokens, output_tokens, n)
  SELECT NEW.book_id, COALESCE(NEW.ocr_model, ''), NEW.input_tokens,
         COALESCE(NEW.output_tokens, 0), 1
   WHERE NEW.input_tokens IS NOT NULL
  ON CONFLICT (book_id, ocr_model) DO UPDATE SET
    input_tokens = input_tokens + excluded.input_tokens,
    output_tokens = output_tokens + excluded.output_tokens,
    n = n + 1;
END;

CREATE TRIGGER books_counters_delete AFTER DELETE ON books
BEGIN
  DELETE FROM book_state_counts WHERE book_id = OLD.id;
  DELETE FROM book_usage WHERE book_id = OLD.id;
END;
