import { Effect, Schema } from "effect";
import { HttpApiEndpoint, OpenApi } from "effect/http-api";
import { type EndpointHandler, WorkerContext } from "../http/context";
import { Conflict, conflict, NotFound, notFound } from "../http/errors";
import { respond } from "../http/respond";

// The body is optional (empty or null): that queues the pages for a book
// whose review is on, as before `all` existed.
const ReviewBody = [
  Schema.Struct({
    all: Schema.optionalKey(
      Schema.Boolean.annotate({
        description:
          "Review every done page now, already-reviewed ones included, even if the book's review is off (a one-off)",
      }),
    ),
  }),
  Schema.Null,
];

// Queue a book's already-transcribed pages for the Opus review.
//
// Without `all`, the book's review must be on: this adds the pages done
// before it was turned on (pages that finish OCR later are queued anyway).
// With `all: true`, it is a one-off: every done page is queued, already
// reviewed or not, and marked as asked for, so the batch keeps it even with
// the book's review off. Either way hand-edited and blank pages are left out
// (a review never overwrites a hand edit), and a page already waiting or in a
// running batch isn't queued twice. The next review run picks them up, at
// most 100 pages per batch.
export const BookReview = HttpApiEndpoint.post(
  "bookReview",
  "/api/books/:bookId/review",
  {
    params: { bookId: Schema.String },
    payload: ReviewBody,
    success: Schema.Struct({
      success: Schema.Boolean,
      queued: Schema.Int.annotate({
        description: "Pages newly added to the review queue",
      }),
      skipped_hand_edited: Schema.Int,
      already_queued: Schema.Int.annotate({
        description: "Pages already waiting or in a running batch",
      }),
    }),
    error: [NotFound, Conflict],
  },
).annotate(OpenApi.Summary, "Queue a book's done pages for the Opus review");

// Done pages with text (a blank page has an empty preview).
const DONE_WITH_TEXT =
  "f.book_id = ? AND f.state = 'done' AND (f.preview IS NULL OR f.preview <> '')";

export const bookReview: EndpointHandler<typeof BookReview> = ({
  params,
  payload,
}) =>
  Effect.gen(function* () {
    const { env } = yield* WorkerContext;
    const all = payload?.all === true;
    const book = yield* Effect.promise(() =>
      env.DB.prepare("SELECT review_enabled FROM books WHERE id = ?")
        .bind(params.bookId)
        .first<{ review_enabled: number }>(),
    );
    if (!book) return yield* notFound(`Book '${params.bookId}' not found`);
    if (!all && book.review_enabled !== 1) {
      return yield* conflict(
        "Review is off for this book; PATCH it with review_enabled: true first, or pass all: true for a one-off",
      );
    }

    const now = Date.now();
    const requested = all ? 1 : 0;
    // One round trip: count the pages left out, then (for a one-off) mark the
    // book's waiting pages as asked for, then queue the rest. The counts are
    // read before the insert, so already_queued is what was there before.
    const [counts, , inserted] = yield* Effect.promise(() =>
      env.DB.batch([
        env.DB.prepare(
          `SELECT COALESCE(SUM(f.text_edited_at IS NOT NULL), 0) AS hand_edited,
                  COALESCE(SUM(f.text_edited_at IS NULL AND q.file_id IS NOT NULL), 0) AS already_queued
             FROM files f LEFT JOIN review_queue q ON q.file_id = f.file_id
            WHERE ${DONE_WITH_TEXT}`,
        ).bind(params.bookId),
        env.DB.prepare(
          `UPDATE review_queue SET requested = 1, attempts = 0
            WHERE ? = 1 AND book_id = ? AND instance_id IS NULL AND requested = 0`,
        ).bind(requested, params.bookId),
        env.DB.prepare(
          `INSERT OR IGNORE INTO review_queue (file_id, book_id, queued_at, attempts, requested)
           SELECT f.file_id, f.book_id, ?, 0, ? FROM files f
            WHERE ${DONE_WITH_TEXT} AND f.text_edited_at IS NULL`,
        ).bind(now, requested, params.bookId),
      ]),
    );
    const left = counts?.results[0] as
      | { hand_edited: number; already_queued: number }
      | undefined;
    return respond({
      endpoint: BookReview,
      body: {
        success: true,
        queued: inserted?.meta.changes ?? 0,
        skipped_hand_edited: left?.hand_edited ?? 0,
        already_queued: left?.already_queued ?? 0,
      },
    });
  });
