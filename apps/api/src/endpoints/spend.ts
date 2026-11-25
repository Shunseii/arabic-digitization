import { Effect, Schema } from "effect";
import { HttpApiEndpoint, OpenApi } from "effect/http-api";
import { type EndpointHandler, WorkerContext } from "../http/context";
import { respond } from "../http/respond";
import { spendDay } from "../lib/spend";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;
const TOP_BOOKS = 5;

const Kind = Schema.Literals(["ocr", "review"]);

const Totals = {
  cost_usd: Schema.Number,
  input_tokens: Schema.Int,
  output_tokens: Schema.Int,
  calls: Schema.Int,
  pages: Schema.Int,
};

const ByModel = Schema.Struct({
  kind: Kind,
  model: Schema.String,
  ...Totals,
  cache_creation_input_tokens: Schema.Int,
  cache_read_input_tokens: Schema.Int,
});

const Daily = Schema.Struct({
  day: Schema.String,
  ocr_cost_usd: Schema.Number,
  review_cost_usd: Schema.Number,
});

const TopBook = Schema.Struct({
  kind: Kind,
  book_id: Schema.String,
  title: Schema.NullOr(Schema.String),
  cost_usd: Schema.Number,
  pages: Schema.Int,
});

// What OCR and the Opus review cost over a window, from the daily spend
// rollup (spend_daily) only.
export const Spend = HttpApiEndpoint.get("spend", "/api/spend", {
  query: {
    days: Schema.optionalKey(
      Schema.Int.check(
        Schema.isGreaterThanOrEqualTo(1),
        Schema.isLessThanOrEqualTo(MAX_DAYS),
      ).annotate({
        description: `Window in UTC days, today included (1-${MAX_DAYS}, default ${DEFAULT_DAYS})`,
      }),
    ),
    book: Schema.optionalKey(
      Schema.String.annotate({ description: "Only this book's spend" }),
    ),
  },
  success: Schema.Struct({
    success: Schema.Boolean,
    since_day: Schema.String,
    book_id: Schema.NullOr(Schema.String),
    total_cost_usd: Schema.Number,
    by_model: Schema.Array(ByModel),
    daily: Schema.Array(Daily).annotate({
      description: "Days with any spend, oldest first",
    }),
    top_books: Schema.Array(TopBook).annotate({
      description: `The ${TOP_BOOKS} costliest books per kind; empty when book is set`,
    }),
  }),
}).annotate(OpenApi.Summary, "OCR and review spend over a time window");

const COLUMNS =
  "day, book_id, kind, model, cost_usd, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, calls, pages";

interface SpendRow {
  day: string;
  book_id: string;
  kind: "ocr" | "review";
  model: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  calls: number;
  pages: number;
}

interface Rollup {
  byModel: (typeof ByModel.Type)[];
  daily: (typeof Daily.Type)[];
  books: {
    kind: "ocr" | "review";
    book_id: string;
    cost_usd: number;
    pages: number;
  }[];
}

// Totals per model, per day and per book from the window's rollup rows. A
// day holds one row per book, kind and model, so even 90 days of a busy
// library is a few thousand rows: summed here in one pass rather than read
// three times by three GROUP BYs (each of which D1 also bills for its sort).
export function rollUp(rows: readonly SpendRow[]): Rollup {
  const models = new Map<string, typeof ByModel.Type>();
  const days = new Map<
    string,
    { day: string; ocr_cost_usd: number; review_cost_usd: number }
  >();
  const books = new Map<string, Rollup["books"][number]>();
  for (const row of rows) {
    const modelKey = `${row.kind}:${row.model}`;
    const model = models.get(modelKey) ?? {
      kind: row.kind,
      model: row.model,
      cost_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      calls: 0,
      pages: 0,
    };
    models.set(modelKey, {
      ...model,
      cost_usd: model.cost_usd + row.cost_usd,
      input_tokens: model.input_tokens + row.input_tokens,
      output_tokens: model.output_tokens + row.output_tokens,
      cache_creation_input_tokens:
        model.cache_creation_input_tokens + row.cache_creation_input_tokens,
      cache_read_input_tokens:
        model.cache_read_input_tokens + row.cache_read_input_tokens,
      calls: model.calls + row.calls,
      pages: model.pages + row.pages,
    });

    const day = days.get(row.day) ?? {
      day: row.day,
      ocr_cost_usd: 0,
      review_cost_usd: 0,
    };
    if (row.kind === "ocr") day.ocr_cost_usd += row.cost_usd;
    else day.review_cost_usd += row.cost_usd;
    days.set(row.day, day);

    const bookKey = `${row.kind}:${row.book_id}`;
    const book = books.get(bookKey) ?? {
      kind: row.kind,
      book_id: row.book_id,
      cost_usd: 0,
      pages: 0,
    };
    book.cost_usd += row.cost_usd;
    book.pages += row.pages;
    books.set(bookKey, book);
  }
  const sortedBooks = [...books.values()].sort(
    (a, b) => b.cost_usd - a.cost_usd,
  );
  return {
    byModel: [...models.values()].sort((a, b) => b.cost_usd - a.cost_usd),
    daily: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    books: (["ocr", "review"] as const).flatMap((kind) =>
      sortedBooks.filter((book) => book.kind === kind).slice(0, TOP_BOOKS),
    ),
  };
}

export const spend: EndpointHandler<typeof Spend> = ({ query }) =>
  Effect.gen(function* () {
    const { env } = yield* WorkerContext;
    const days = query.days ?? DEFAULT_DAYS;
    const sinceDay = spendDay(Date.now() - (days - 1) * DAY_MS);
    const book = query.book ?? null;
    // All books: the day range is the primary key's prefix, so this reads
    // only the window's rows, in key order (no sort). One book: its rows
    // through idx_spend_daily_book.
    const { results } = yield* Effect.promise(() =>
      (book === null
        ? env.DB.prepare(
            `SELECT ${COLUMNS} FROM spend_daily WHERE day >= ?`,
          ).bind(sinceDay)
        : env.DB.prepare(
            `SELECT ${COLUMNS} FROM spend_daily WHERE book_id = ? AND day >= ?`,
          ).bind(book, sinceDay)
      ).all<SpendRow>(),
    );
    const rollup = rollUp(results);

    // One book's spend has nothing to rank, so top_books is empty then and
    // the title lookup is skipped. Otherwise titles of the listed books only
    // (primary-key lookups).
    const topBooks = book === null ? rollup.books : [];
    const ids = [...new Set(topBooks.map((b) => b.book_id))];
    const titles = new Map<string, string>();
    if (ids.length > 0) {
      const { results: rows } = yield* Effect.promise(() =>
        env.DB.prepare(
          `SELECT id, title FROM books WHERE id IN (${ids.map(() => "?").join(", ")})`,
        )
          .bind(...ids)
          .all<{ id: string; title: string }>(),
      );
      for (const row of rows) titles.set(row.id, row.title);
    }

    return respond({
      endpoint: Spend,
      body: {
        success: true,
        since_day: sinceDay,
        book_id: book,
        total_cost_usd: rollup.byModel.reduce((n, row) => n + row.cost_usd, 0),
        by_model: rollup.byModel,
        daily: rollup.daily,
        top_books: topBooks.map((b) => ({
          ...b,
          title: titles.get(b.book_id) ?? null,
        })),
      },
    });
  });
