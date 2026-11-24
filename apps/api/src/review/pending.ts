import { type Statement, statement } from "../effect/services";

// Marks a page as waiting for an Opus review, only if its book opted in
// (books.review_enabled). A page already waiting or in a batch keeps its row.
export function enqueueReview({
  fileId,
  bookId,
  at,
}: {
  fileId: string;
  bookId: string;
  at: number;
}): Statement {
  return statement(
    `INSERT OR IGNORE INTO review_queue (file_id, book_id, queued_at)
     SELECT ?, id, ? FROM books WHERE id = ? AND review_enabled = 1`,
    [fileId, at, bookId],
  );
}
