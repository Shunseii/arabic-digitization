import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import type { AppContext } from "../types";
import { deleteDocsByBook } from "../lib/meili";

// Delete a book and everything under it: its R2 objects (scans + transcribed
// text, all under the `books/:bookId/` prefix) and its file rows, then the book
// row itself. R2 is cleared before the DB so a mid-way failure leaves the book
// intact and the call retriable.
export class BookDelete extends OpenAPIRoute {
  schema = {
    tags: ["Books"],
    summary: "Delete a book and all its files (R2 objects + rows)",
    request: {
      params: z.object({ bookId: z.string() }),
    },
    responses: {
      "200": {
        description: "The book was deleted",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              deleted: z.object({
                book_id: z.string(),
                files: z.number().int(),
                r2_objects: z.number().int(),
              }),
            }),
          },
        },
      },
      "404": {
        description: "No such book",
        content: {
          "application/json": {
            schema: z.object({ success: z.boolean(), error: z.string() }),
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    const { params } = await this.getValidatedData<typeof this.schema>();

    const book = await c.env.DB.prepare("SELECT id FROM books WHERE id = ?")
      .bind(params.bookId)
      .first<{ id: string }>();
    if (!book) {
      return c.json(
        { success: false, error: `Book '${params.bookId}' not found` },
        404,
      );
    }

    // Clear every R2 object for this book. All scans and text share the
    // `books/:bookId/` prefix; page through the listing and batch-delete.
    const prefix = `books/${params.bookId}/`;
    let r2Deleted = 0;
    let cursor: string | undefined;
    do {
      const listing = await c.env.BUCKET.list({ prefix, cursor });
      if (listing.objects.length > 0) {
        await c.env.BUCKET.delete(listing.objects.map((o) => o.key));
        r2Deleted += listing.objects.length;
      }
      cursor = listing.truncated ? listing.cursor : undefined;
    } while (cursor);

    const fileCount = await c.env.DB.prepare(
      "SELECT COUNT(*) AS c FROM files WHERE book_id = ?",
    )
      .bind(params.bookId)
      .first<{ c: number }>();

    await c.env.DB.prepare("DELETE FROM files WHERE book_id = ?")
      .bind(params.bookId)
      .run();
    await c.env.DB.prepare("DELETE FROM books WHERE id = ?")
      .bind(params.bookId)
      .run();

    // Drop the book's pages from search. Best-effort: a Meili outage (or
    // unconfigured MEILI_*) must not fail the delete — the source of truth is
    // already gone from R2/D1, and POST /api/search/reindex is the backstop
    // that reconciles any orphaned documents left behind.
    if (c.env.MEILI_URL && c.env.MEILI_KEY) {
      try {
        await deleteDocsByBook({ env: c.env, bookId: params.bookId });
      } catch (err) {
        console.error(`search delete failed for book ${params.bookId}: ${err}`);
      }
    }

    return c.json({
      success: true,
      deleted: {
        book_id: params.bookId,
        files: fileCount?.c ?? 0,
        r2_objects: r2Deleted,
      },
    });
  }
}
