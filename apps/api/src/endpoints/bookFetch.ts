import { Effect, Schema } from "effect";
import { HttpApiEndpoint, OpenApi } from "effect/http-api";
import { type EndpointHandler, WorkerContext } from "../http/context";
import { NotFound, notFound } from "../http/errors";
import { respond } from "../http/respond";
import { costUsd } from "../lib/cost";
import type { ReviewEffort } from "../review/message";
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

interface SpendTotalsRow {
  kind: "ocr" | "review";
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  calls: number;
  pages: number;
}

const NO_SPEND = {
  cost_usd: 0,
  input_tokens: 0,
  output_tokens: 0,
  calls: 0,
  pages: 0,
};

function bookUsage({
  usageRows,
  spendRows,
}: {
  usageRows: UsageRow[];
  spendRows: SpendTotalsRow[];
}) {
  if (usageRows.length === 0 && spendRows.length === 0) return null;
  const current = totalUsage(usageRows) ?? {
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
  };
  const spendOf = (kind: SpendTotalsRow["kind"]) => {
    const row = spendRows.find((r) => r.kind === kind);
    return row
      ? {
          cost_usd: row.cost_usd,
          input_tokens: row.input_tokens,
          output_tokens: row.output_tokens,
          calls: row.calls,
          pages: row.pages,
        }
      : NO_SPEND;
  };
  const ocr = spendOf("ocr");
  const review = spendOf("review");
  return {
    ...current,
    ocr,
    review,
    total_cost_usd: ocr.cost_usd + review.cost_usd,
  };
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
        "SELECT id, title, created_at, ocr_instructions, ocr_engine, work_id, paused, review_enabled, review_effort FROM books WHERE id = ?",
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
          review_enabled: number;
          review_effort: ReviewEffort | null;
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

    const [usageResult, spendResult] = yield* Effect.promise(() =>
      env.DB.batch([
        env.DB.prepare(
          `SELECT NULLIF(ocr_model, '') AS ocr_model, input_tokens, output_tokens
             FROM book_usage WHERE book_id = ? AND n > 0`,
        ).bind(params.bookId),
        // The book's rows of the spend rollup, through idx_spend_daily_book.
        env.DB.prepare(
          `SELECT kind, SUM(cost_usd) AS cost_usd, SUM(input_tokens) AS input_tokens,
                  SUM(output_tokens) AS output_tokens, SUM(calls) AS calls,
                  SUM(pages) AS pages
             FROM spend_daily WHERE book_id = ? GROUP BY kind`,
        ).bind(params.bookId),
      ]),
    );
    const usageRows = (usageResult?.results ?? []) as UsageRow[];
    const spendRows = (spendResult?.results ?? []) as SpendTotalsRow[];

    return respond({
      endpoint: BookFetch,
      body: {
        success: true,
        book: {
          ...book,
          paused: book.paused === 1,
          review_enabled: book.review_enabled === 1,
          files_total,
          counts,
          usage: bookUsage({ usageRows, spendRows }),
        },
      },
    });
  });
