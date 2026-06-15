import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { type AppContext, BookWithStatus } from "../types";

// Row shape returned by the aggregate query (one row per book).
interface BookCountRow {
  id: string;
  title: string;
  created_at: number;
  files_total: number;
  state: string | null;
  state_count: number;
}

export class BookList extends OpenAPIRoute {
  schema = {
    tags: ["Books"],
    summary: "List books with per-state file counts",
    responses: {
      "200": {
        description: "All books, newest first",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              books: BookWithStatus.array(),
            }),
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    // One row per (book, state); books with no files yield a single row with
    // NULL state. Assemble into per-book count maps in JS.
    const { results } = await c.env.DB.prepare(
      `SELECT b.id, b.title, b.created_at,
			        (SELECT COUNT(*) FROM files WHERE book_id = b.id) AS files_total,
			        f.state AS state,
			        COUNT(f.file_id) AS state_count
			 FROM books b
			 LEFT JOIN files f ON f.book_id = b.id
			 GROUP BY b.id, f.state
			 ORDER BY b.created_at DESC`,
    ).all<BookCountRow>();

    const byId = new Map<string, z.infer<typeof BookWithStatus>>();
    for (const row of results) {
      const existing = byId.get(row.id);
      const book =
        existing ??
        ({
          id: row.id,
          title: row.title,
          created_at: row.created_at,
          files_total: row.files_total,
          counts: {},
        } satisfies z.infer<typeof BookWithStatus>);
      if (!existing) byId.set(row.id, book);
      if (row.state) book.counts[row.state] = row.state_count;
    }

    return c.json({ success: true, books: [...byId.values()] });
  }
}
