import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { type AppContext, BookWithStatus, type OcrEngine } from "../types";

// Row shape returned by the aggregate query (one row per book).
interface BookCountRow {
  id: string;
  title: string;
  created_at: number;
  work_id: string | null;
  ocr_engine: OcrEngine | null;
  paused: number;
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
    // One row per (book, state) from the trigger-maintained counters; books
    // with no files yield a single row with NULL state.
    const { results } = await c.env.DB.prepare(
      `SELECT b.id, b.title, b.created_at, b.work_id, b.ocr_engine, b.paused,
			        s.state AS state, s.n AS state_count
			 FROM books b
			 LEFT JOIN book_state_counts s ON s.book_id = b.id AND s.n > 0
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
          work_id: row.work_id,
          ocr_engine: row.ocr_engine,
          paused: row.paused === 1,
          files_total: 0,
          counts: {},
        } satisfies z.infer<typeof BookWithStatus>);
      if (!existing) byId.set(row.id, book);
      if (row.state) {
        book.counts[row.state] = row.state_count;
        book.files_total += row.state_count;
      }
    }

    return c.json({ success: true, books: [...byId.values()] });
  }
}
