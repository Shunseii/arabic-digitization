-- Migration number: 0016 	 2026-11-25

-- GET /api/reviews?book=<id> lists one book's newest reviews: this index
-- walks them newest first and stops at the limit, instead of walking every
-- book's reviews in the window (idx_page_reviews_created) to find them. One
-- extra written row per reviewed page.
CREATE INDEX idx_page_reviews_book_created ON page_reviews (book_id, created_at);
