import { Effect, Schema } from "effect";
import { HttpApiEndpoint, OpenApi } from "effect/http-api";
import { type EndpointHandler, WorkerContext } from "../http/context";
import { NotFound, notFound } from "../http/errors";
import { respond } from "../http/respond";
import { type OcrMessage, requeueTrigger } from "../queue";
import { FileState } from "../types";

const DEFAULT_STATES = ["failed", "rate_limited"];

// The body is optional (empty or null): that requeues the default states.
const RequeueBody = [
  Schema.Struct({
    // States to re-OCR; defaults to the ones worth retrying.
    states: Schema.optionalKey(
      Schema.Array(FileState).check(Schema.isMinLength(1)),
    ),
  }),
  Schema.Null,
];

// Bulk re-OCR: move every file in the given states back to 'queued' and drop
// them on the OCR queue. Defaults to 'failed' + 'rate_limited'. Everything flows
// through the throttled, auto-retrying consumer, so requeuing a whole book at
// once is safe — no rate-limit storm. Also the way to re-apply changed
// ocr_instructions or ocr_engine to already-done pages (pass states: ["done"]).
export const BookRequeue = HttpApiEndpoint.post(
  "bookRequeue",
  "/api/books/:bookId/requeue",
  {
    params: { bookId: Schema.String },
    payload: RequeueBody,
    success: Schema.Struct({
      success: Schema.Boolean,
      requeued: Schema.Int,
      states: Schema.Array(Schema.String),
    }),
    error: NotFound,
  },
).annotate(OpenApi.Summary, "Re-queue a book's files for OCR (bulk)");

export const bookRequeue: EndpointHandler<typeof BookRequeue> = ({
  params,
  payload,
}) =>
  Effect.gen(function* () {
    const { env } = yield* WorkerContext;
    const book = yield* Effect.promise(() =>
      env.DB.prepare("SELECT id FROM books WHERE id = ?")
        .bind(params.bookId)
        .first<{ id: string }>(),
    );
    if (!book) return yield* notFound(`Book '${params.bookId}' not found`);

    const states = [...(payload?.states ?? DEFAULT_STATES)];
    const placeholders = states.map(() => "?").join(", ");

    const { results } = yield* Effect.promise(() =>
      env.DB.prepare(
        `SELECT file_id, state FROM files WHERE book_id = ? AND state IN (${placeholders})`,
      )
        .bind(params.bookId, ...states)
        .all<{ file_id: string; state: string }>(),
    );

    const messages = results.map(
      (r): OcrMessage => ({
        fileId: r.file_id,
        trigger: requeueTrigger(r.state),
      }),
    );
    if (messages.length === 0) {
      return respond({
        endpoint: BookRequeue,
        body: { success: true, requeued: 0, states },
      });
    }

    yield* Effect.promise(() =>
      env.DB.prepare(
        `UPDATE files SET state = 'queued', error = NULL, updated_at = ? WHERE book_id = ? AND state IN (${placeholders})`,
      )
        .bind(Date.now(), params.bookId, ...states)
        .run(),
    );

    // Cloudflare Queues cap a batch at 100 messages.
    for (let i = 0; i < messages.length; i += 100) {
      const batch = messages.slice(i, i + 100);
      yield* Effect.promise(() =>
        env.OCR_Q.sendBatch(batch.map((body) => ({ body }))),
      );
    }

    return respond({
      endpoint: BookRequeue,
      body: { success: true, requeued: messages.length, states },
    });
  });
