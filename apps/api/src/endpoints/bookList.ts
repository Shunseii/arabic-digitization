import { Effect, Schema } from "effect";
import { HttpApiEndpoint, OpenApi } from "effect/http-api";
import { type EndpointHandler, WorkerContext } from "../http/context";
import { respond } from "../http/respond";
import {
  BookWithStatus,
  type BookWithStatus as BookWithStatusType,
  type OcrEngine,
} from "../types";

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

export const BookList = HttpApiEndpoint.get("bookList", "/api/books", {
  success: Schema.Struct({
    success: Schema.Boolean,
    books: Schema.Array(BookWithStatus),
  }),
}).annotate(OpenApi.Summary, "List books with per-state file counts");

export const bookList: EndpointHandler<typeof BookList> = () =>
  Effect.gen(function* () {
    const { env } = yield* WorkerContext;
    // One row per (book, state) from the trigger-maintained counters; books
    // with no files yield a single row with NULL state.
    const { results } = yield* Effect.promise(() =>
      env.DB.prepare(
        `SELECT b.id, b.title, b.created_at, b.work_id, b.ocr_engine, b.paused,
			        s.state AS state, s.n AS state_count
			 FROM books b
			 LEFT JOIN book_state_counts s ON s.book_id = b.id AND s.n > 0
			 ORDER BY b.created_at DESC`,
      ).all<BookCountRow>(),
    );

    const byId = new Map<
      string,
      BookWithStatusType & {
        files_total: number;
        counts: Record<string, number>;
      }
    >();
    for (const row of results) {
      const existing = byId.get(row.id);
      const book = existing ?? {
        id: row.id,
        title: row.title,
        created_at: row.created_at,
        work_id: row.work_id,
        ocr_engine: row.ocr_engine,
        paused: row.paused === 1,
        files_total: 0,
        counts: {},
      };
      if (!existing) byId.set(row.id, book);
      if (row.state) {
        book.counts[row.state] = row.state_count;
        book.files_total += row.state_count;
      }
    }

    return respond({
      endpoint: BookList,
      body: { success: true, books: [...byId.values()] },
    });
  });
