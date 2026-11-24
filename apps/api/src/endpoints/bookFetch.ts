import { Effect, Schema } from "effect";
import { HttpApiEndpoint, OpenApi } from "effect/http-api";
import { type EndpointHandler, WorkerContext } from "../http/context";
import { NotFound, notFound } from "../http/errors";
import { respond } from "../http/respond";
import { costUsd } from "../lib/cost";
import { BookWithStatus, type OcrEngine } from "../types";

export const BookFetch = HttpApiEndpoint.get(
  "bookFetch",
  "/api/books/:bookId",
  {
    params: { bookId: Schema.String },
    success: Schema.Struct({ success: Schema.Boolean, book: BookWithStatus }),
    error: NotFound,
  },
).annotate(OpenApi.Summary, "Fetch one book with its full status breakdown");

interface UsageRow {
  ocr_model: string | null;
  input_tokens: number;
  output_tokens: number;
}

// Aggregate token usage + cost, grouped by model so mixed-model books price
// correctly. cost_usd is null if any contributing model has no known price.
function totalUsage(rows: UsageRow[]) {
  if (rows.length === 0) return null;
  let input_tokens = 0;
  let output_tokens = 0;
  let cost = 0;
  let fullyPriced = true;
  for (const row of rows) {
    input_tokens += row.input_tokens;
    output_tokens += row.output_tokens;
    const rowCost = costUsd({
      model: row.ocr_model,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
    });
    if (rowCost == null) fullyPriced = false;
    else cost += rowCost;
  }
  return { input_tokens, output_tokens, cost_usd: fullyPriced ? cost : null };
}

export const bookFetch: EndpointHandler<typeof BookFetch> = ({ params }) =>
  Effect.gen(function* () {
    const { env } = yield* WorkerContext;
    const book = yield* Effect.promise(() =>
      env.DB.prepare(
        "SELECT id, title, created_at, ocr_instructions, ocr_engine, work_id, paused FROM books WHERE id = ?",
      )
        .bind(params.bookId)
        .first<{
          id: string;
          title: string;
          created_at: number;
          ocr_instructions: string | null;
          ocr_engine: OcrEngine | null;
          work_id: string | null;
          paused: number;
        }>(),
    );
    if (!book) return yield* notFound(`Book '${params.bookId}' not found`);

    const { results } = yield* Effect.promise(() =>
      env.DB.prepare(
        "SELECT state, n AS c FROM book_state_counts WHERE book_id = ? AND n > 0",
      )
        .bind(params.bookId)
        .all<{ state: string; c: number }>(),
    );
    const counts: Record<string, number> = {};
    let files_total = 0;
    for (const row of results) {
      counts[row.state] = row.c;
      files_total += row.c;
    }

    const { results: usageRows } = yield* Effect.promise(() =>
      env.DB.prepare(
        `SELECT NULLIF(ocr_model, '') AS ocr_model, input_tokens, output_tokens
           FROM book_usage WHERE book_id = ? AND n > 0`,
      )
        .bind(params.bookId)
        .all<UsageRow>(),
    );

    return respond({
      endpoint: BookFetch,
      body: {
        success: true,
        book: {
          ...book,
          paused: book.paused === 1,
          files_total,
          counts,
          usage: totalUsage(usageRows),
        },
      },
    });
  });
