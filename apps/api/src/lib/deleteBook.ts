// Delete a book and everything under it: its R2 objects (scans + transcribed
// text, all under the `books/:bookId/` prefix), its file rows, then the book row
// itself, and finally its search docs. R2 is cleared before the DB so a mid-way
// failure leaves the book intact and the call retriable.
//
// Shared by DELETE /api/books/:bookId and the cascade mode of DELETE
// /api/works/:workId. Returns null if the book does not exist.

import { deleteDocsByBook } from "./meili";

export interface DeleteBookResult {
  book_id: string;
  files: number;
  r2_objects: number;
}

export async function deleteBook({
  env,
  bookId,
}: {
  env: Env;
  bookId: string;
}): Promise<DeleteBookResult | null> {
  const book = await env.DB.prepare("SELECT id FROM books WHERE id = ?")
    .bind(bookId)
    .first<{ id: string }>();
  if (!book) return null;

  // Clear every R2 object for this book. All scans and text share the
  // `books/:bookId/` prefix; page through the listing and batch-delete.
  const prefix = `books/${bookId}/`;
  let r2Deleted = 0;
  let cursor: string | undefined;
  do {
    const listing = await env.BUCKET.list({ prefix, cursor });
    if (listing.objects.length > 0) {
      await env.BUCKET.delete(listing.objects.map((o) => o.key));
      r2Deleted += listing.objects.length;
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);

  const fileCount = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM files WHERE book_id = ?",
  )
    .bind(bookId)
    .first<{ c: number }>();

  await env.DB.prepare("DELETE FROM text_revisions WHERE book_id = ?")
    .bind(bookId)
    .run();
  await env.DB.prepare("DELETE FROM files WHERE book_id = ?")
    .bind(bookId)
    .run();
  await env.DB.prepare("DELETE FROM books WHERE id = ?").bind(bookId).run();

  // Drop the book's pages from search. Best-effort: a Meili outage (or
  // unconfigured MEILI_*) must not fail the delete — the source of truth is
  // already gone from R2/D1, and POST /api/search/reindex is the backstop that
  // reconciles any orphaned documents left behind.
  if (env.MEILI_URL && env.MEILI_KEY) {
    try {
      await deleteDocsByBook({ env, bookId });
    } catch (err) {
      console.error(`search delete failed for book ${bookId}: ${err}`);
    }
  }

  return { book_id: bookId, files: fileCount?.c ?? 0, r2_objects: r2Deleted };
}
