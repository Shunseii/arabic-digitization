import { Effect, Schema } from "effect";
import { HttpApiEndpoint, OpenApi } from "effect/http-api";
import { type EndpointHandler, WorkerContext } from "../http/context";
import { NotFound, notFound } from "../http/errors";
import { respond } from "../http/respond";
import { FileRecord } from "../types";

// Update a page fragment's metadata. Currently just page_number — the scan and
// its transcription both live under file_id (R2 keys are uuid-based, not page
// based), so changing the page number re-labels and re-orders both without
// touching R2. Pass null to clear it.
export const FileUpdate = HttpApiEndpoint.patch(
  "fileUpdate",
  "/api/books/:bookId/files/:fileId",
  {
    params: { bookId: Schema.String, fileId: Schema.String },
    payload: Schema.Struct({
      page_number: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
    }),
    success: Schema.Struct({ success: Schema.Boolean, file: FileRecord }),
    error: NotFound,
  },
).annotate(OpenApi.Summary, "Update a file's page number");

export const fileUpdate: EndpointHandler<typeof FileUpdate> = ({
  params,
  payload: body,
}) =>
  Effect.gen(function* () {
    const { env } = yield* WorkerContext;
    const now = Date.now();
    const result = yield* Effect.promise(() =>
      env.DB.prepare(
        "UPDATE files SET page_number = ?, updated_at = ? WHERE file_id = ? AND book_id = ?",
      )
        .bind(body.page_number, now, params.fileId, params.bookId)
        .run(),
    );
    if (result.meta.changes === 0) {
      return yield* notFound(`File '${params.fileId}' not found`);
    }

    const file = yield* Effect.promise(() =>
      env.DB.prepare(
        `SELECT file_id, book_id, r2_key, state, text_key, page_number, role, order_hint, created_at, updated_at
         FROM files WHERE file_id = ?`,
      )
        .bind(params.fileId)
        .first<typeof FileRecord.Type>(),
    );
    // Only a concurrent delete between the two statements gets here.
    if (!file) return yield* notFound(`File '${params.fileId}' not found`);
    return respond({ endpoint: FileUpdate, body: { success: true, file } });
  });
