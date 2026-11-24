import { Effect, Schema } from "effect";
import { HttpApiEndpoint, HttpApiSchema, OpenApi } from "effect/http-api";
import { type RawEndpointHandler, WorkerContext } from "../http/context";
import {
  BadRequest,
  badRequest,
  NotFound,
  notFound,
  UnsupportedMediaType,
} from "../http/errors";
import { respond } from "../http/respond";
import type { OcrMessage } from "../queue";
import { FileRecord, UPLOAD_CONTENT_TYPES } from "../types";

// Upload one page fragment (image) into a book.
//
// Binding-through-Worker: the raw request body is streamed straight to R2, and
// the same request inserts the files row and enqueues it for OCR. Bytes +
// bookkeeping in one call.
//
// The handler is registered raw (handleRaw), so HttpApi never reads or decodes
// the body; the payload schema below only documents it.
export const FileUpload = HttpApiEndpoint.post(
  "fileUpload",
  "/api/books/:bookId/files",
  {
    params: { bookId: Schema.String },
    query: {
      page: Schema.optionalKey(
        Schema.Int.check(Schema.isGreaterThan(0)).annotate({
          description: "Printed page number, if known/hidden in the image",
        }),
      ),
    },
    payload: HttpApiSchema.StreamUint8Array({
      contentType: [...UPLOAD_CONTENT_TYPES],
    }),
    success: Schema.Struct({ success: Schema.Boolean, file: FileRecord }).pipe(
      HttpApiSchema.status(201),
    ),
    error: [BadRequest, NotFound, UnsupportedMediaType],
  },
)
  .annotate(
    OpenApi.Summary,
    "Upload a page fragment (raw image body) to a book",
  )
  .annotate(
    OpenApi.Description,
    "Send the file bytes as the raw request body with a matching Content-Type " +
      "(image/jpeg, image/png, image/webp). Optionally pass ?page " +
      "when the printed page number is hidden in the shot.",
  );

export const fileUpload: RawEndpointHandler<typeof FileUpload> = ({
  params,
  query,
  request,
}) =>
  Effect.gen(function* () {
    const { env } = yield* WorkerContext;

    // Book must exist before we accept files for it.
    const book = yield* Effect.promise(() =>
      env.DB.prepare("SELECT id FROM books WHERE id = ?")
        .bind(params.bookId)
        .first<{ id: string }>(),
    );
    if (!book) return yield* notFound(`Book '${params.bookId}' not found`);

    const contentType =
      (request.headers["content-type"] ?? "").split(";")[0]?.trim() ?? "";
    if (!(UPLOAD_CONTENT_TYPES as readonly string[]).includes(contentType)) {
      return yield* new UnsupportedMediaType({
        success: false,
        error: `Unsupported Content-Type '${contentType}'. Upload a page image (${UPLOAD_CONTENT_TYPES.join(", ")}); PDFs aren't supported, export each page as an image first.`,
      });
    }

    const body = (request.source as Request).body;
    if (!body) return yield* badRequest("Missing request body");

    const fileId = crypto.randomUUID();
    const r2Key = `books/${params.bookId}/scans/${fileId}`;
    yield* Effect.promise(() =>
      env.BUCKET.put(r2Key, body, { httpMetadata: { contentType } }),
    );

    const now = Date.now();
    const pageNumber = query.page ?? null;
    yield* Effect.promise(() =>
      env.DB.prepare(
        `INSERT INTO files (file_id, book_id, r2_key, state, page_number, created_at, updated_at)
			 VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
      )
        .bind(fileId, params.bookId, r2Key, pageNumber, now, now)
        .run(),
    );

    // Trigger OCR off the request path.
    yield* Effect.promise(() =>
      env.OCR_Q.send({ fileId, trigger: "upload" } satisfies OcrMessage),
    );

    return respond({
      endpoint: FileUpload,
      status: 201,
      body: {
        success: true,
        file: {
          file_id: fileId,
          book_id: params.bookId,
          r2_key: r2Key,
          state: "queued" as const,
          text_key: null,
          page_number: pageNumber,
          role: null,
          order_hint: null,
          created_at: now,
          updated_at: now,
        },
      },
    });
  });
