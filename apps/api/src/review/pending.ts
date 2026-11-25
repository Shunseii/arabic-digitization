import { type Statement, statement } from "../effect/services";

// Marks a page as waiting for an Opus review, only if its book opted in
// (books.review_enabled) or the page was asked for on demand (`requested`,
// kept on the row so the switch doesn't drop it). A page already waiting or
// in a batch keeps its row. `attempts` carries a page's earlier tries that
// ended without a review.
export function enqueueReview({
  fileId,
  bookId,
  at,
  attempts = 0,
  requested = false,
}: {
  fileId: string;
  bookId: string;
  at: number;
  attempts?: number;
  requested?: boolean;
}): Statement {
  return statement(
    `INSERT OR IGNORE INTO review_queue (file_id, book_id, queued_at, attempts, requested)
     SELECT ?, id, ?, ?, ? FROM books WHERE id = ? AND (review_enabled = 1 OR ? = 1)`,
    [fileId, at, attempts, requested ? 1 : 0, bookId, requested ? 1 : 0],
  );
}
