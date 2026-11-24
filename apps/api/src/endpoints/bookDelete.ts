import { Effect, Schema } from "effect";
import { HttpApiEndpoint, OpenApi } from "effect/http-api";
import { type EndpointHandler, WorkerContext } from "../http/context";
import { NotFound, notFound } from "../http/errors";
import { respond } from "../http/respond";
import { deleteBook } from "../lib/deleteBook";

// Delete a book and everything under it: its R2 objects (scans + transcribed
// text, all under the `books/:bookId/` prefix) and its file rows, then the book
// row itself. R2 is cleared before the DB so a mid-way failure leaves the book
// intact and the call retriable.
export const BookDelete = HttpApiEndpoint.delete(
  "bookDelete",
  "/api/books/:bookId",
  {
    params: { bookId: Schema.String },
    success: Schema.Struct({
      success: Schema.Boolean,
      deleted: Schema.Struct({
        book_id: Schema.String,
        files: Schema.Int,
        r2_objects: Schema.Int,
      }),
    }),
    error: NotFound,
  },
).annotate(
  OpenApi.Summary,
  "Delete a book and all its files (R2 objects + rows)",
);

export const bookDelete: EndpointHandler<typeof BookDelete> = ({ params }) =>
  Effect.gen(function* () {
    const { env } = yield* WorkerContext;
    const deleted = yield* Effect.promise(() =>
      deleteBook({ env, bookId: params.bookId }),
    );
    if (!deleted) return yield* notFound(`Book '${params.bookId}' not found`);
    return respond({ endpoint: BookDelete, body: { success: true, deleted } });
  });
