import { Effect, Schema } from "effect";
import { HttpApiEndpoint, OpenApi } from "effect/http-api";
import { type EndpointHandler, WorkerContext } from "../http/context";
import { NotFound, notFound } from "../http/errors";
import { respond } from "../http/respond";
import { runTextPrefix } from "../lib/ocrRuns";
import { historyPrefix } from "../lib/pageText";

// Delete a single page fragment: its scan and transcription R2 objects plus the
// row. R2 is cleared before the DB row so a mid-way failure is retriable.
export const FileDelete = HttpApiEndpoint.delete(
  "fileDelete",
  "/api/books/:bookId/files/:fileId",
  {
    params: { bookId: Schema.String, fileId: Schema.String },
    success: Schema.Struct({
      success: Schema.Boolean,
      deleted: Schema.Struct({
        file_id: Schema.String,
        r2_objects: Schema.Int,
      }),
    }),
    error: NotFound,
  },
).annotate(OpenApi.Summary, "Delete a file (scan + transcription text + row)");

export const fileDelete: EndpointHandler<typeof FileDelete> = ({ params }) =>
  Effect.gen(function* () {
    const { env } = yield* WorkerContext;
    const file = yield* Effect.promise(() =>
      env.DB.prepare(
        "SELECT file_id, r2_key, text_key FROM files WHERE file_id = ? AND book_id = ?",
      )
        .bind(params.fileId, params.bookId)
        .first<{ file_id: string; r2_key: string; text_key: string | null }>(),
    );
    if (!file) return yield* notFound(`File '${params.fileId}' not found`);

    const r2Objects = yield* Effect.promise(async () => {
      const history = await env.BUCKET.list({
        prefix: historyPrefix({ bookId: params.bookId, fileId: params.fileId }),
      });
      // The text each OCR run produced. Its ocr_runs rows stay: they are the
      // permanent run history.
      const runTexts = await env.BUCKET.list({
        prefix: runTextPrefix({ bookId: params.bookId, fileId: params.fileId }),
      });
      const keys = [
        file.r2_key,
        ...(file.text_key ? [file.text_key] : []),
        ...history.objects.map((o) => o.key),
        ...runTexts.objects.map((o) => o.key),
      ];
      await env.BUCKET.delete(keys);
      await env.DB.prepare("DELETE FROM text_revisions WHERE file_id = ?")
        .bind(params.fileId)
        .run();
      await env.DB.prepare("DELETE FROM files WHERE file_id = ?")
        .bind(params.fileId)
        .run();
      return keys.length;
    });

    return respond({
      endpoint: FileDelete,
      body: {
        success: true,
        deleted: { file_id: params.fileId, r2_objects: r2Objects },
      },
    });
  });
