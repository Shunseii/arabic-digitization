-- Per-book OCR pause. While paused = 1 the queue consumer drops this book's OCR
-- messages and leaves its pages 'queued'; resuming re-enqueues them.
ALTER TABLE books ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
