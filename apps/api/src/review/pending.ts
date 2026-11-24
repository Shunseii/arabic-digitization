import { type Statement, statement } from "../effect/services";

// Marks a page as waiting for an Opus review, only if its book opted in
// (books.review_enabled). A page already waiting or in a batch keeps its row.
// `attempts` carries a page's earlier tries that ended without a review.
export function enqueueReview({
  fileId,
  bookId,
  at,
  attempts = 0,
}: {
  fileId: string;
  bookId: string;
  at: number;
  attempts?: number;
}): Statement {
  return statement(
    `INSERT OR IGNORE INTO review_queue (file_id, book_id, queued_at, attempts)
     SELECT ?, id, ?, ? FROM books WHERE id = ? AND review_enabled = 1`,
    [fileId, at, attempts, bookId],
  );
}
