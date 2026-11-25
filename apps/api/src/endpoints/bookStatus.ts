import { Effect, Schema } from "effect";
import { HttpApiEndpoint, OpenApi } from "effect/http-api";
import { type EndpointHandler, WorkerContext } from "../http/context";
import { NotFound, notFound } from "../http/errors";
import { respond } from "../http/respond";
import { costUsd } from "../lib/cost";
import { FileStatus } from "../types";

export type FileStatusRow = Omit<
  typeof FileStatus.Type,
  "cost_usd" | "ocr_cost_usd"
> & {
  ocr_model: string | null;
};

export const FILE_STATUS_COLUMNS =
  "file_id, page_number, state, role, order_hint, preview, error, updated_at, text_edited_at, input_tokens, output_tokens, ocr_model, review_cost_usd";

export const toFileStatus = ({
  ocr_model,
  ...f
}: FileStatusRow): typeof FileStatus.Type => {
  const ocrCost = costUsd({
    model: ocr_model,
    inputTokens: f.input_tokens,
    outputTokens: f.output_tokens,
  });
  return { ...f, cost_usd: ocrCost, ocr_cost_usd: ocrCost };
};

// Page order: unnumbered pages last, a missing order_hint first (the
// generated columns of migration 0010, walked by idx_files_book_order).
const ORDER_BY = "sort_page, sort_hint, file_id";

// Per-file status for a book (no transcription text). With `since`, returns only
// files updated after that time; `files_total` lets the client detect deletions
// (a merged list longer than `files_total` means it must refetch in full).
export const BookStatus = HttpApiEndpoint.get(
  "bookStatus",
  "/api/books/:bookId/status",
  {
    params: { bookId: Schema.String },
    query: {
      // An empty `since=` means 0, as it always has (Number("") is 0).
      since: Schema.optionalKey(
        Schema.Union([
          Schema.Literal(""),
          Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        ]).annotate({
          description:
            "Epoch ms; only return files with updated_at > since. Omit for all files.",
        }),
      ),
    },
    success: Schema.Struct({
      success: Schema.Boolean,
      files: Schema.Array(FileStatus),
      files_total: Schema.Int,
    }),
    error: NotFound,
  },
).annotate(OpenApi.Summary, "List a book's files with their states");

export const bookStatus: EndpointHandler<typeof BookStatus> = ({
  params,
  query,
}) =>
  Effect.gen(function* () {
    const { env } = yield* WorkerContext;
    const since = query.since === "" ? 0 : query.since;
    const filesQuery =
      since === undefined
        ? env.DB.prepare(
            `SELECT ${FILE_STATUS_COLUMNS} FROM files WHERE book_id = ? ORDER BY ${ORDER_BY}`,
          ).bind(params.bookId)
        : // Pinned to the updated_at index: with table stats the planner may
          // prefer walking the page-order index to skip the sort, which reads
          // every file in the book to return the few that changed. The index
          // spans all books, so this also reads other books' recent changes;
          // that's a few rows, and a per-book index would cost a write per
          // page update.
          env.DB.prepare(
            `SELECT ${FILE_STATUS_COLUMNS} FROM files INDEXED BY idx_files_updated
			 WHERE book_id = ? AND updated_at > ? ORDER BY ${ORDER_BY}`,
          ).bind(params.bookId, since);

    // One round trip: the book check, the file count, and the files.
    const [bookResult, totalResult, filesResult] = yield* Effect.promise(() =>
      env.DB.batch<unknown>([
        env.DB.prepare("SELECT id FROM books WHERE id = ?").bind(params.bookId),
        env.DB.prepare(
          "SELECT COALESCE(SUM(n), 0) AS n FROM book_state_counts WHERE book_id = ?",
        ).bind(params.bookId),
        filesQuery,
      ]),
    );
    if (!bookResult?.results.length) {
      return yield* notFound(`Book '${params.bookId}' not found`);
    }
    const total = totalResult?.results[0] as { n: number } | undefined;
    const rows = (filesResult?.results ?? []) as FileStatusRow[];

    const files = rows.map(toFileStatus);

    return respond({
      endpoint: BookStatus,
      body: { success: true, files, files_total: total?.n ?? 0 },
    });
  });
