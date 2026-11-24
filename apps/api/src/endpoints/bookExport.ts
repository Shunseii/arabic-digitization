import { Effect, Schema } from "effect";
import { HttpApiEndpoint, OpenApi } from "effect/http-api";
import { type EndpointHandler, WorkerContext } from "../http/context";
import { BadRequest, badRequest, NotFound, notFound } from "../http/errors";
import { respond } from "../http/respond";
import { ExportFile, type FileState } from "../types";

const MAX_BATCH_LIMIT = 200;

// "page_number IS NULL, page_number, order_hint, file_id" (unnumbered pages
// last, a missing order_hint first), as the generated columns of migration
// 0010. idx_files_book_order walks this order, and a batch seeks straight to
// the row after the cursor instead of reading and sorting the whole book.
const ORDER_BY = "sort_page, sort_hint, file_id";
// The cursor carries the raw page_number/order_hint (so cursors issued before
// the sort columns existed still work); SQL maps NULLs to the same sentinels
// the columns use, which a JS number can't hold exactly.
const AFTER_CURSOR = `(sort_page, sort_hint, file_id) >
  (COALESCE(?, 9223372036854775807), COALESCE(?, -9223372036854775808), ?)`;
const COLUMNS = "file_id, page_number, role, order_hint, state, text_key";

const ExportCursor = Schema.Struct({
  page_number: Schema.NullOr(Schema.Int),
  order_hint: Schema.NullOr(Schema.Int),
  file_id: Schema.String,
});
type ExportCursor = typeof ExportCursor.Type;
const isExportCursor = Schema.is(ExportCursor);

type ExportRow = {
  file_id: string;
  page_number: number | null;
  role: string | null;
  order_hint: number | null;
  state: FileState;
  text_key: string | null;
};

function encodeCursor(cursor: ExportCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeCursor(raw: string): ExportCursor | null {
  try {
    const base64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isExportCursor(parsed)) return null;
    const { page_number, order_hint, file_id } = parsed;
    return { page_number, order_hint, file_id };
  } catch {
    return null;
  }
}

// Bulk pull: every file's metadata + transcription text, for local assembly
// (group by page_number, stitch into book.md in the vault). With `limit`, it
// returns one batch at a time, keyed on the last row returned (not an offset),
// so pages uploaded mid-import are neither skipped nor duplicated.
export const BookExport = HttpApiEndpoint.get(
  "bookExport",
  "/api/books/:bookId/export",
  {
    params: { bookId: Schema.String },
    query: {
      limit: Schema.optionalKey(
        Schema.Int.check(
          Schema.isGreaterThanOrEqualTo(1),
          Schema.isLessThanOrEqualTo(MAX_BATCH_LIMIT),
        ).annotate({
          description: `Batch size (1-${MAX_BATCH_LIMIT}). Omit to get every file in one response.`,
        }),
      ),
      cursor: Schema.optionalKey(
        Schema.String.annotate({
          description:
            "Opaque next_cursor from the previous batch. Requires limit.",
        }),
      ),
    },
    success: Schema.Struct({
      success: Schema.Boolean,
      book_id: Schema.String,
      files: Schema.Array(ExportFile),
      files_total: Schema.optionalKey(
        Schema.Int.annotate({
          description: "Every file in the book (batched requests only)",
        }),
      ),
      next_cursor: Schema.optionalKey(
        Schema.NullOr(Schema.String).annotate({
          description:
            "Pass as cursor for the next batch; null on the last batch (batched requests only)",
        }),
      ),
    }),
    error: [BadRequest, NotFound],
  },
).annotate(
  OpenApi.Summary,
  "Export a book's files with their transcription text",
);

export const bookExport: EndpointHandler<typeof BookExport> = ({
  params,
  query,
}) =>
  Effect.gen(function* () {
    const { env } = yield* WorkerContext;
    if (query.cursor !== undefined && query.limit === undefined) {
      return yield* badRequest("cursor requires limit");
    }
    const cursor =
      query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    if (cursor === null) {
      return yield* badRequest("Malformed cursor; pass next_cursor as-is");
    }

    const bookQuery = env.DB.prepare("SELECT id FROM books WHERE id = ?").bind(
      params.bookId,
    );

    if (query.limit === undefined) {
      // One round trip: the book check and every file.
      const [book, files] = yield* Effect.promise(() =>
        env.DB.batch<unknown>([
          bookQuery,
          env.DB.prepare(
            `SELECT ${COLUMNS} FROM files WHERE book_id = ? ORDER BY ${ORDER_BY}`,
          ).bind(params.bookId),
        ]),
      );
      if (!book?.results.length) {
        return yield* notFound(`Book '${params.bookId}' not found`);
      }
      const rows = (files?.results ?? []) as ExportRow[];
      return respond({
        endpoint: BookExport,
        body: {
          success: true,
          book_id: params.bookId,
          files: yield* Effect.promise(() => withText({ env, rows })),
        },
      });
    }

    const limit = query.limit;
    // One extra row tells us whether another batch follows.
    const batchQuery = cursor
      ? env.DB.prepare(
          `SELECT ${COLUMNS} FROM files
			 WHERE book_id = ? AND ${AFTER_CURSOR}
			 ORDER BY ${ORDER_BY} LIMIT ?`,
        ).bind(
          params.bookId,
          cursor.page_number,
          cursor.order_hint,
          cursor.file_id,
          limit + 1,
        )
      : env.DB.prepare(
          `SELECT ${COLUMNS} FROM files WHERE book_id = ?
			 ORDER BY ${ORDER_BY} LIMIT ?`,
        ).bind(params.bookId, limit + 1);

    // One round trip: the book check, the file count, and the batch.
    const [book, total, batchResult] = yield* Effect.promise(() =>
      env.DB.batch<unknown>([
        bookQuery,
        env.DB.prepare(
          "SELECT COALESCE(SUM(n), 0) AS n FROM book_state_counts WHERE book_id = ?",
        ).bind(params.bookId),
        batchQuery,
      ]),
    );
    if (!book?.results.length) {
      return yield* notFound(`Book '${params.bookId}' not found`);
    }
    const results = (batchResult?.results ?? []) as ExportRow[];
    const batch = results.slice(0, limit);
    const last = batch.at(-1);
    const next_cursor =
      results.length > limit && last
        ? encodeCursor({
            page_number: last.page_number,
            order_hint: last.order_hint,
            file_id: last.file_id,
          })
        : null;

    return respond({
      endpoint: BookExport,
      body: {
        success: true,
        book_id: params.bookId,
        files: yield* Effect.promise(() => withText({ env, rows: batch })),
        files_total: (total?.results[0] as { n: number } | undefined)?.n ?? 0,
        next_cursor,
      },
    });
  });

async function withText({ env, rows }: { env: Env; rows: ExportRow[] }) {
  return Promise.all(
    rows.map(async (r) => {
      let text: string | null = null;
      if (r.text_key) {
        const obj = await env.BUCKET.get(r.text_key);
        if (obj) text = await obj.text();
      }
      return {
        file_id: r.file_id,
        page_number: r.page_number,
        role: r.role,
        order_hint: r.order_hint,
        state: r.state,
        text,
      };
    }),
  );
}
