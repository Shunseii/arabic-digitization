import { Effect, Schema } from "effect";
import { HttpApiEndpoint, HttpApiSchema, OpenApi } from "effect/http-api";
import { type EndpointHandler, WorkerContext } from "../http/context";
import { NotFound, notFound } from "../http/errors";
import { respond } from "../http/respond";
import { enqueueOcr } from "../queue";

// Manual OCR (re-)trigger. Enqueues the file onto the OCR queue — the same
// throttled, auto-retrying path as upload — and returns immediately. Poll the
// book status/export endpoints for the result.
export const FileOcr = HttpApiEndpoint.post(
  "fileOcr",
  "/api/books/:bookId/files/:fileId/ocr",
  {
    params: { bookId: Schema.String, fileId: Schema.String },
    success: Schema.Struct({
      success: Schema.Boolean,
      file_id: Schema.String,
      state: Schema.Literal("queued"),
    }).pipe(HttpApiSchema.status(202)),
    error: NotFound,
  },
).annotate(OpenApi.Summary, "Queue a file for (re-)OCR");

export const fileOcr: EndpointHandler<typeof FileOcr> = ({ params }) =>
  Effect.gen(function* () {
    const { env } = yield* WorkerContext;
    const file = yield* Effect.promise(() =>
      env.DB.prepare(
        "SELECT file_id FROM files WHERE file_id = ? AND book_id = ?",
      )
        .bind(params.fileId, params.bookId)
        .first<{ file_id: string }>(),
    );
    if (!file) return yield* notFound(`File '${params.fileId}' not found`);

    yield* Effect.promise(() =>
      enqueueOcr({ env, fileId: params.fileId, trigger: "manual" }),
    );
    return respond({
      endpoint: FileOcr,
      status: 202,
      body: { success: true, file_id: params.fileId, state: "queued" as const },
    });
  });
