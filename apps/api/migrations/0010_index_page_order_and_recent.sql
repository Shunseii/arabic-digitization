-- Migration number: 0010 	 2026-11-24

-- Index walks for a book's page order (status, export) and for the most
-- recently updated files across books (GET /api/files/recent), so neither
-- reads every row and sorts it in a temp B-tree.

-- The page order "page_number IS NULL, page_number, order_hint" (unnumbered
-- pages last, a missing order_hint first) as two plain sort keys. SQLite can
-- only seek an index on a row value of plain columns, not of expressions, so
-- the export cursor compares these. VIRTUAL: computed on read, nothing stored
-- (ALTER TABLE ADD COLUMN can only add VIRTUAL generated columns).
ALTER TABLE files ADD COLUMN sort_page INTEGER
  GENERATED ALWAYS AS (COALESCE(page_number, 9223372036854775807)) VIRTUAL;
ALTER TABLE files ADD COLUMN sort_hint INTEGER
  GENERATED ALWAYS AS (COALESCE(order_hint, -9223372036854775808)) VIRTUAL;

CREATE INDEX idx_files_book_order ON files (book_id, sort_page, sort_hint, file_id);

-- Only ever used to order a book's files, which idx_files_book_order now does.
DROP INDEX idx_files_book_page;

CREATE INDEX idx_files_updated ON files (updated_at);
