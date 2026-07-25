import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { deleteBook } from "../lib/deleteBook";
import type { AppContext } from "../types";

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

    const deleted = await deleteBook({ env: c.env, bookId: params.bookId });
    if (!deleted) {
      return c.json(
        { success: false, error: `Book '${params.bookId}' not found` },
        404,
      );
    }

    return c.json({ success: true, deleted });
  }
}
