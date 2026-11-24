import { Effect, Schema } from "effect";
import { HttpApiEndpoint, OpenApi } from "effect/http-api";
import { type EndpointHandler, WorkerContext } from "../http/context";
import { Conflict, conflict, NotFound, notFound } from "../http/errors";
import { respond } from "../http/respond";

// Queue a book's already-transcribed pages for the Opus review. Turning
// review_enabled on only covers pages that finish OCR afterwards; this adds
// the ones done before. Hand-edited and blank pages are left out (and would
// be dropped when the batch is built anyway). The next review run picks them
// up, at most 100 pages per batch.
export const BookReview = HttpApiEndpoint.post(
  "bookReview",
  "/api/books/:bookId/review",
  {
    params: { bookId: Schema.String },
    success: Schema.Struct({
      success: Schema.Boolean,
      queued: Schema.Int.annotate({
        description: "Pages newly added to the review queue",
      }),
    }),
    error: [NotFound, Conflict],
  },
).annotate(OpenApi.Summary, "Queue a book's done pages for the Opus review");

export const bookReview: EndpointHandler<typeof BookReview> = ({ params }) =>
  Effect.gen(function* () {
    const { env } = yield* WorkerContext;
    const book = yield* Effect.promise(() =>
      env.DB.prepare("SELECT review_enabled FROM books WHERE id = ?")
        .bind(params.bookId)
        .first<{ review_enabled: number }>(),
    );
    if (!book) return yield* notFound(`Book '${params.bookId}' not found`);
    if (book.review_enabled !== 1) {
      return yield* conflict(
        "Review is off for this book; PATCH it with review_enabled: true first",
      );
    }
    const { meta } = yield* Effect.promise(() =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO review_queue (file_id, book_id, queued_at)
         SELECT file_id, book_id, ? FROM files
          WHERE book_id = ? AND state = 'done' AND text_edited_at IS NULL
            AND (preview IS NULL OR preview <> '')`,
      )
        .bind(Date.now(), params.bookId)
        .run(),
    );
    return respond({
      endpoint: BookReview,
      body: { success: true, queued: meta.changes },
    });
  });
