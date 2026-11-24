import { Effect, Schema } from "effect";
import { HttpApiEndpoint, OpenApi } from "effect/http-api";
import { type EndpointHandler, WorkerContext } from "../http/context";
import { NotFound, notFound } from "../http/errors";
import { respond } from "../http/respond";

const Revision = Schema.Struct({
  id: Schema.Int,
  change: Schema.Literals(["edit", "ocr", "review"]),
  model: Schema.NullOr(Schema.String),
  note: Schema.NullOr(Schema.String),
  created_at: Schema.Int,
});

// The changes made to one page's transcription, newest first. Each entry's
// earlier text is GET .../text?rev=<id> (the text just before that change).
export const FileTextHistory = HttpApiEndpoint.get(
  "fileTextHistory",
  "/api/books/:bookId/files/:fileId/text/history",
  {
    params: { bookId: Schema.String, fileId: Schema.String },
    success: Schema.Struct({
      success: Schema.Boolean,
      file_id: Schema.String,
      text_edited_at: Schema.NullOr(Schema.Int),
      revisions: Schema.Array(Revision),
    }),
    error: NotFound,
  },
).annotate(OpenApi.Summary, "List the changes to a file's transcription");

export const fileTextHistory: EndpointHandler<typeof FileTextHistory> = ({
  params,
}) =>
  Effect.gen(function* () {
    const { env } = yield* WorkerContext;
    const file = yield* Effect.promise(() =>
      env.DB.prepare(
        "SELECT text_edited_at FROM files WHERE file_id = ? AND book_id = ?",
      )
        .bind(params.fileId, params.bookId)
        .first<{ text_edited_at: number | null }>(),
    );
    if (!file) return yield* notFound(`File '${params.fileId}' not found`);

    const { results } = yield* Effect.promise(() =>
      env.DB.prepare(
        `SELECT id, change, model, note, created_at FROM text_revisions
          WHERE file_id = ? ORDER BY created_at DESC, id DESC`,
      )
        .bind(params.fileId)
        .all<typeof Revision.Type>(),
    );

    return respond({
      endpoint: FileTextHistory,
      body: {
        success: true,
        file_id: params.fileId,
        text_edited_at: file.text_edited_at,
        revisions: results,
      },
    });
  });
