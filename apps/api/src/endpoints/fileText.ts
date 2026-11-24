import { Effect, Schema } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiEndpoint, HttpApiSchema, OpenApi } from "effect/http-api";
import { type EndpointHandler, WorkerContext } from "../http/context";
import { Conflict, conflict, NotFound, notFound } from "../http/errors";

export const MARKDOWN = "text/markdown; charset=utf-8";

// Return one file's transcribed Markdown (raw text/markdown body, from R2).
// With ?rev=<id>, the earlier text saved by that change (see .../text/history).
export const FileText = HttpApiEndpoint.get(
  "fileText",
  "/api/books/:bookId/files/:fileId/text",
  {
    params: { bookId: Schema.String, fileId: Schema.String },
    query: {
      rev: Schema.optionalKey(
        Schema.Int.check(Schema.isGreaterThan(0)).annotate({
          description:
            "A revision id from .../text/history: return the text as it was just before that change",
        }),
      ),
    },
    success: Schema.String.pipe(
      HttpApiSchema.asText({ contentType: "text/markdown" }),
    ),
    error: [NotFound, Conflict],
  },
).annotate(OpenApi.Summary, "Get a file's transcription (raw Markdown)");

export const fileText: EndpointHandler<typeof FileText> = ({ params, query }) =>
  Effect.gen(function* () {
    const { env } = yield* WorkerContext;
    const row = yield* Effect.promise(() =>
      env.DB.prepare(
        "SELECT text_key FROM files WHERE file_id = ? AND book_id = ?",
      )
        .bind(params.fileId, params.bookId)
        .first<{ text_key: string | null }>(),
    );
    if (!row) return yield* notFound(`File '${params.fileId}' not found`);

    let key = row.text_key;
    if (query.rev !== undefined) {
      const rev = query.rev;
      const revision = yield* Effect.promise(() =>
        env.DB.prepare(
          "SELECT prev_key FROM text_revisions WHERE id = ? AND file_id = ?",
        )
          .bind(rev, params.fileId)
          .first<{ prev_key: string }>(),
      );
      if (!revision) return yield* notFound(`Revision ${rev} not found`);
      key = revision.prev_key;
    }
    if (!key) return yield* conflict("File not transcribed yet");

    const textKey = key;
    const obj = yield* Effect.promise(() => env.BUCKET.get(textKey));
    if (!obj) return yield* notFound("Transcription missing");

    // Streamed as stored: every text object the Worker writes is UTF-8 Markdown.
    return HttpServerResponse.raw(obj.body, { contentType: MARKDOWN });
  });
