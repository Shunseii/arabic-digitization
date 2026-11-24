import { Effect, Schema } from "effect";
import { HttpApiEndpoint, OpenApi } from "effect/http-api";
import { type EndpointHandler, WorkerContext } from "../http/context";
import { NotFound, notFound } from "../http/errors";
import { respond } from "../http/respond";
import type { OcrMessage } from "../queue";

const RESUMABLE_STATES = ["queued", "rate_limited"] as const;

const bookParams = { bookId: Schema.String };

function setPaused({
  env,
  bookId,
  paused,
}: {
  env: Env;
  bookId: string;
  paused: boolean;
}) {
  return Effect.gen(function* () {
    const { meta } = yield* Effect.promise(() =>
      env.DB.prepare("UPDATE books SET paused = ? WHERE id = ?")
        .bind(paused ? 1 : 0, bookId)
        .run(),
    );
    if (meta.changes === 0) {
      return yield* notFound(`Book '${bookId}' not found`);
    }
  });
}

// Pause OCR for one book. The queue consumer checks the flag and drops this
// book's messages without calling an OCR provider, leaving the pages 'queued'. Other
// books on the shared queue are unaffected. Pages uploaded while paused wait too.
export const BookPause = HttpApiEndpoint.post(
  "bookPause",
  "/api/books/:bookId/pause",
  {
    params: bookParams,
    success: Schema.Struct({ success: Schema.Boolean, paused: Schema.Boolean }),
    error: NotFound,
  },
).annotate(OpenApi.Summary, "Pause OCR for a book");

export const bookPause: EndpointHandler<typeof BookPause> = ({ params }) =>
  Effect.gen(function* () {
    const { env } = yield* WorkerContext;
    yield* setPaused({ env, bookId: params.bookId, paused: true });
    return respond({
      endpoint: BookPause,
      body: { success: true, paused: true },
    });
  });

// Resume OCR for a paused book: clear the flag and re-enqueue every page that
// was waiting. Messages dropped during the pause are replaced by these.
export const BookResume = HttpApiEndpoint.post(
  "bookResume",
  "/api/books/:bookId/resume",
  {
    params: bookParams,
    success: Schema.Struct({
      success: Schema.Boolean,
      paused: Schema.Boolean,
      requeued: Schema.Int,
    }),
    error: NotFound,
  },
).annotate(OpenApi.Summary, "Resume OCR for a paused book");

export const bookResume: EndpointHandler<typeof BookResume> = ({ params }) =>
  Effect.gen(function* () {
    const { env } = yield* WorkerContext;
    yield* setPaused({ env, bookId: params.bookId, paused: false });

    const placeholders = RESUMABLE_STATES.map(() => "?").join(", ");
    const { results } = yield* Effect.promise(() =>
      env.DB.prepare(
        `SELECT file_id FROM files WHERE book_id = ? AND state IN (${placeholders})`,
      )
        .bind(params.bookId, ...RESUMABLE_STATES)
        .all<{ file_id: string }>(),
    );
    const fileIds = results.map((r) => r.file_id);

    yield* Effect.promise(() =>
      env.DB.prepare(
        `UPDATE files SET state = 'queued', error = NULL, updated_at = ? WHERE book_id = ? AND state IN (${placeholders})`,
      )
        .bind(Date.now(), params.bookId, ...RESUMABLE_STATES)
        .run(),
    );

    // Cloudflare Queues cap a batch at 100 messages.
    for (let i = 0; i < fileIds.length; i += 100) {
      const batch = fileIds.slice(i, i + 100);
      yield* Effect.promise(() =>
        env.OCR_Q.sendBatch(
          batch.map((fileId) => ({
            body: { fileId, trigger: "requeue" } satisfies OcrMessage,
          })),
        ),
      );
    }

    return respond({
      endpoint: BookResume,
      body: { success: true, paused: false, requeued: fileIds.length },
    });
  });
