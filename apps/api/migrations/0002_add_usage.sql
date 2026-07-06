-- Migration number: 0002 	 2026-07-06T00:00:00.000Z

-- Per-file OCR token usage, captured from Gemini's usageMetadata at transcription
-- time. Cost is derived on read (tokens x price) rather than stored, so a price
-- change re-values history correctly. ocr_model records which model's price to
-- apply. All nullable: rows OCR'd before this migration stay null (no cost shown).
ALTER TABLE files ADD COLUMN input_tokens  INTEGER;
ALTER TABLE files ADD COLUMN output_tokens INTEGER;
ALTER TABLE files ADD COLUMN ocr_model     TEXT;
