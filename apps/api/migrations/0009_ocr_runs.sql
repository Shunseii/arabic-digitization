-- Migration number: 0009 	 2026-11-23

-- A permanent history of OCR runs, for per-model performance stats.

-- Every distinct prompt text a run was given, keyed by its SHA-256 (hex).
-- 'system' is the global transcription prompt; 'book_instructions' is a book's
-- trimmed ocr_instructions. Inserted if absent when a run uses it; never changed.
CREATE TABLE prompt_versions (
  hash          TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('system', 'book_instructions')),
  text          TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL
);

-- One row per OCR run of one page: one transcription job, i.e. the primary
-- engine plus any fallback. Written once when the run ends and never updated,
-- except that the metrics cache (words .. metrics_version) can be recomputed
-- from the run's text by POST /api/admin/ocr-runs/recompute-metrics.
--
-- `calls` is a JSON array, one entry per provider call in the run:
--   {engine, model, status ('ok' | 'error'), ms, input_tokens, output_tokens,
--    cost_usd, error_type}
-- The token and cost totals cover every call, failed ones included;
-- wasted_cost_usd is the part spent on calls whose output wasn't stored.
-- cost_usd is priced at run time from lib/cost.ts; the token counts stay the
-- durable truth if prices change.
--
-- `text_key` is an R2 object holding exactly the text this run produced,
-- written once and never overwritten (the page's own text_key is replaced by
-- every re-OCR and hand edit). Null when the run stored no text.
CREATE TABLE ocr_runs (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id                TEXT NOT NULL,
  book_id                TEXT NOT NULL,
  created_at             INTEGER NOT NULL,
  -- How the job was enqueued; null for messages queued before this migration.
  trigger                TEXT CHECK (trigger IN ('upload', 'retry', 'requeue', 'manual')),
  status                 TEXT NOT NULL CHECK (status IN ('done', 'failed', 'requeued')),
  error_type             TEXT,
  error_message          TEXT,
  primary_engine         TEXT NOT NULL,
  final_model            TEXT,
  fell_back              INTEGER NOT NULL DEFAULT 0,
  fallback_reason        TEXT CHECK (fallback_reason IN ('cut_off', 'rate_limit', 'server_error', 'timeout', 'network')),
  delivery_attempt       INTEGER NOT NULL,
  calls                  TEXT NOT NULL,
  latency_ms             INTEGER NOT NULL,
  input_tokens           INTEGER NOT NULL,
  output_tokens          INTEGER NOT NULL,
  cost_usd               REAL NOT NULL,
  wasted_cost_usd        REAL NOT NULL,
  system_prompt_hash     TEXT,
  book_instructions_hash TEXT,
  text_key               TEXT,
  words                  INTEGER,
  chars                  INTEGER,
  blank                  INTEGER,
  has_header             INTEGER,
  -- Null when the page has no footnote block.
  footnote_block_ok      INTEGER,
  headings               INTEGER,
  metrics                TEXT,
  metrics_version        INTEGER
);

CREATE INDEX idx_ocr_runs_book ON ocr_runs (book_id, created_at);
CREATE INDEX idx_ocr_runs_file ON ocr_runs (file_id, created_at);
