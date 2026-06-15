import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { type AppContext, BookWithStatus, type FileState } from "../types";

export class BookFetch extends OpenAPIRoute {
  schema = {
    tags: ["Books"],
    summary: "Fetch one book with its full status breakdown",
    request: {
      params: z.object({ bookId: z.string() }),
    },
    responses: {
      "200": {
        description: "The book and its per-state file counts",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              book: BookWithStatus,
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

    const book = await c.env.DB.prepare(
      "SELECT id, title, created_at FROM books WHERE id = ?",
    )
      .bind(params.bookId)
      .first<{ id: string; title: string; created_at: number }>();

    if (!book) {
      return c.json(
        { success: false, error: `Book '${params.bookId}' not found` },
        404,
      );
    }

    const { results } = await c.env.DB.prepare(
      "SELECT state, COUNT(*) AS c FROM files WHERE book_id = ? GROUP BY state",
    )
      .bind(params.bookId)
      .all<{ state: string; c: number }>();

    const counts: Record<string, number> = {};
    let files_total = 0;
    for (const row of results) {
      counts[row.state] = row.c;
      files_total += row.c;
    }

    return c.json({
      success: true,
      book: {
        ...book,
        files_total,
        counts: counts as Record<z.infer<typeof FileState>, number>,
      },
    });
  }
}
