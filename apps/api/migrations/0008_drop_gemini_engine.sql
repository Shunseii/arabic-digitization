-- Migration number: 0008 	 2026-11-23

-- Gemini is no longer an OCR engine. Books that picked it go back to the
-- default (Inkling, with Claude as the fallback). Existing pages keep their text
-- and their recorded ocr_model.
UPDATE books SET ocr_engine = NULL WHERE ocr_engine = 'gemini';
