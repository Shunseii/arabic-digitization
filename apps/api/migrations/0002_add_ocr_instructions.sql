-- Migration number: 0002 	 2026-06-16

-- Per-book OCR instructions: free-text notes appended to the global system
-- prompt at transcription time, for book-specific formatting quirks
-- (footnote conventions, header layout, script peculiarities). Null = none.
ALTER TABLE books ADD COLUMN ocr_instructions TEXT;
