import { Effect, Schema } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiEndpoint, HttpApiSchema, OpenApi } from "effect/http-api";
import { type EndpointHandler, WorkerContext } from "../http/context";
import { NotFound, notFound } from "../http/errors";

// Stream the original scanned image bytes for a file (from R2). Gated behind
// the master key like the rest of /api, so clients pass the Authorization
// header (e.g. React Native's <Image source={{ uri, headers }}>).
export const FileImage = HttpApiEndpoint.get(
  "fileImage",
  "/api/books/:bookId/files/:fileId/image",
  {
    params: { bookId: Schema.String, fileId: Schema.String },
    success: HttpApiSchema.StreamUint8Array({
      contentType: ["image/jpeg", "image/png", "image/webp"],
    }),
    error: NotFound,
  },
).annotate(OpenApi.Summary, "Get the original scanned image bytes");

export const fileImage: EndpointHandler<typeof FileImage> = ({ params }) =>
  Effect.gen(function* () {
    const { env } = yield* WorkerContext;
    const row = yield* Effect.promise(() =>
      env.DB.prepare(
        "SELECT r2_key FROM files WHERE file_id = ? AND book_id = ?",
      )
        .bind(params.fileId, params.bookId)
        .first<{ r2_key: string }>(),
    );
    if (!row) return yield* notFound(`File '${params.fileId}' not found`);

    const obj = yield* Effect.promise(() => env.BUCKET.get(row.r2_key));
    if (!obj) return yield* notFound("Scan object missing");

    return HttpServerResponse.raw(obj.body, {
      contentType: obj.httpMetadata?.contentType ?? "application/octet-stream",
      headers: { "cache-control": "private, max-age=3600" },
    });
  });
