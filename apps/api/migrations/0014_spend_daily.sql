-- Migration number: 0014 	 2026-11-25

-- What OCR and the Opus review cost, rolled up per UTC day, book, kind and
-- model (src/lib/spend.ts). Every billed call adds to its row in the same D1
-- batch that records it (an ocr_runs row, a page_reviews row), so GET
-- /api/spend and the book usage read a few rows per day instead of every run.
--
-- calls: billed provider calls (an OCR re-run, a failed call that still
-- produced tokens, a review result). pages: pages whose text the call
-- produced (OCR) or that Opus reviewed (applied or no changes needed).
-- cost_usd is priced when the row is added (lib/cost.ts); the token counts
-- are the durable truth. Unbilled review results (errored, expired, canceled)
-- add nothing.
CREATE TABLE spend_daily (
  day                         TEXT NOT NULL,
  book_id                     TEXT NOT NULL,
  kind                        TEXT NOT NULL CHECK (kind IN ('ocr', 'review')),
  model                       TEXT NOT NULL,
  cost_usd                    REAL NOT NULL DEFAULT 0,
  input_tokens                INTEGER NOT NULL DEFAULT 0,
  output_tokens               INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens     INTEGER NOT NULL DEFAULT 0,
  calls                       INTEGER NOT NULL DEFAULT 0,
  pages                       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, book_id, kind, model)
) WITHOUT ROWID;

-- A book's spend (book usage, GET /api/spend?book=). Its key never changes,
-- so it is written only when a new day/book/kind/model row appears, not on
-- every add.
CREATE INDEX idx_spend_daily_book ON spend_daily (book_id, kind);

-- What the Opus review has cost for each page, summed over its reviews, so
-- the book status lists it without reading page_reviews. NULL = never billed
-- for a review. Written with the review's record.
ALTER TABLE files ADD COLUMN review_cost_usd REAL;

-- ---- Backfill (one-time) -----------------------------------------------------

-- OCR runs: one row per call, grouped by day, book and model. A page counts
-- once, for the model whose text the run stored.
INSERT INTO spend_daily (day, book_id, kind, model, cost_usd, input_tokens, output_tokens, calls, pages)
SELECT strftime('%Y-%m-%d', r.created_at / 1000, 'unixepoch'), r.book_id, 'ocr',
       json_extract(c.value, '$.model'),
       SUM(COALESCE(json_extract(c.value, '$.cost_usd'), 0)),
       SUM(COALESCE(json_extract(c.value, '$.input_tokens'), 0)),
       SUM(COALESCE(json_extract(c.value, '$.output_tokens'), 0)),
       COUNT(*),
       SUM(r.status = 'done' AND json_extract(c.value, '$.status') = 'ok'
           AND json_extract(c.value, '$.model') = r.final_model)
  FROM ocr_runs r, json_each(r.calls) c
 WHERE COALESCE(json_extract(c.value, '$.input_tokens'), 0) > 0
    OR COALESCE(json_extract(c.value, '$.output_tokens'), 0) > 0
 GROUP BY 1, 2, 4;

-- Pages OCR'd before run history existed (migration 0009) have only their
-- stored tokens: one call each, on the day they were last updated, priced as
-- lib/cost.ts prices them.
INSERT INTO spend_daily (day, book_id, kind, model, cost_usd, input_tokens, output_tokens, calls, pages)
SELECT strftime('%Y-%m-%d', f.updated_at / 1000, 'unixepoch'), f.book_id, 'ocr', f.ocr_model,
       SUM(f.input_tokens * CASE f.ocr_model
             WHEN 'inkling-2-small' THEN 0.3 WHEN 'claude-sonnet-5-5' THEN 2.0
             WHEN 'claude-haiku-5-5' THEN 0.1 WHEN 'claude-sonnet-5' THEN 3.0
             WHEN 'gemini-3.1-pro-preview' THEN 2.0 ELSE 0 END / 1000000.0
         + COALESCE(f.output_tokens, 0) * CASE f.ocr_model
             WHEN 'inkling-2-small' THEN 1.0 WHEN 'claude-sonnet-5-5' THEN 10.0
             WHEN 'claude-haiku-5-5' THEN 0.5 WHEN 'claude-sonnet-5' THEN 15.0
             WHEN 'gemini-3.1-pro-preview' THEN 12.0 ELSE 0 END / 1000000.0),
       SUM(f.input_tokens), SUM(COALESCE(f.output_tokens, 0)), COUNT(*), COUNT(*)
  FROM files f
 WHERE f.input_tokens IS NOT NULL AND f.ocr_model IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM ocr_runs r WHERE r.file_id = f.file_id)
 GROUP BY 1, 2, 4
ON CONFLICT (day, book_id, kind, model) DO UPDATE SET
  cost_usd = cost_usd + excluded.cost_usd,
  input_tokens = input_tokens + excluded.input_tokens,
  output_tokens = output_tokens + excluded.output_tokens,
  calls = calls + excluded.calls,
  pages = pages + excluded.pages;

-- Reviews that were billed (any with tokens).
INSERT INTO spend_daily (day, book_id, kind, model, cost_usd, input_tokens, output_tokens,
                         cache_creation_input_tokens, cache_read_input_tokens, calls, pages)
SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch'), book_id, 'review', model,
       SUM(cost_usd), SUM(input_tokens), SUM(output_tokens),
       SUM(cache_creation_input_tokens), SUM(cache_read_input_tokens),
       COUNT(*), SUM(status IN ('applied', 'no_changes'))
  FROM page_reviews
 WHERE input_tokens > 0 OR output_tokens > 0
 GROUP BY 1, 2, 4;

UPDATE files SET review_cost_usd = (
  SELECT SUM(r.cost_usd) FROM page_reviews r
   WHERE r.file_id = files.file_id AND (r.input_tokens > 0 OR r.output_tokens > 0))
 WHERE file_id IN (
  SELECT file_id FROM page_reviews WHERE input_tokens > 0 OR output_tokens > 0);
