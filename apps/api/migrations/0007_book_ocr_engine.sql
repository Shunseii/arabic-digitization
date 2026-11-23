-- Migration number: 0007 	 2026-11-22

-- Per-book OCR engine: which provider transcribes this book's pages first.
-- 'gemini' or 'claude'; NULL = the default (Gemini). The other provider is the
-- fallback on a transient failure. Changing it does not re-OCR existing pages.
ALTER TABLE books ADD COLUMN ocr_engine TEXT;
