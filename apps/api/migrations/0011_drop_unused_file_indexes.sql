-- Migration number: 0011 	 2026-11-24

-- Every index on files costs a written row whenever a write touches its
-- columns, and the free plan allows 100k rows written a day against 5M read.
-- These four cost about 10 written rows per OCR'd page (upload, claim, done)
-- and no query needs them:
-- - idx_files_book: idx_files_book_order already leads with book_id.
-- - idx_files_state: nothing filters on state across all books.
-- - idx_files_book_state: only pause and requeue, both rare; they now read
--   the book's rows through idx_files_book_order.
-- - idx_files_book_updated: status deltas use idx_files_updated (all books),
--   which GET /api/files/recent needs anyway.
-- Re-add one with a migration if a feature needs it.
DROP INDEX idx_files_book;
DROP INDEX idx_files_state;
DROP INDEX idx_files_book_state;
DROP INDEX idx_files_book_updated;
