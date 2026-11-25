-- Migration number: 0015 	 2026-11-25

-- A page queued for review on demand (POST /api/books/:id/review with
-- all: true) is reviewed even if its book's review switch is off; the batch
-- builder keeps it (src/review/steps.ts). Pages queued because their book
-- has review on keep 0 and are dropped if the switch goes off first.
ALTER TABLE review_queue ADD COLUMN requested INTEGER NOT NULL DEFAULT 0;
