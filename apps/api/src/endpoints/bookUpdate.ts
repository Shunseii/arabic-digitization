import { Effect, Schema } from "effect";
import { HttpApiEndpoint, OpenApi } from "effect/http-api";
import { type EndpointHandler, WorkerContext } from "../http/context";
import { NotFound, notFound } from "../http/errors";
import { respond } from "../http/respond";
import { reindexBook } from "../lib/reindex";
import type { ReviewEffort } from "../review/message";
import { Book, BookUpdateBody, type OcrEngine } from "../types";

export const BookUpdate = HttpApiEndpoint.patch(
  "bookUpdate",
  "/api/books/:bookId",
  {
    params: { bookId: Schema.String },
    payload: BookUpdateBody,
    success: Schema.Struct({
      success: Schema.Boolean,
      book: Schema.NullOr(Book),
    }),
    error: NotFound,
  },
).annotate(
  OpenApi.Summary,
  "Update a book (e.g. its OCR instructions or engine)",
);

export const bookUpdate: EndpointHandler<typeof BookUpdate> = ({
  params,
  payload: body,
}) =>
  Effect.gen(function* () {
    const { env } = yield* WorkerContext;

    // Build the SET clause from only the provided fields.
    const sets: string[] = [];
    const binds: (string | number | null)[] = [];
    if (body.title !== undefined) {
      sets.push("title = ?");
      binds.push(body.title);
    }
    if (body.ocr_instructions !== undefined) {
      sets.push("ocr_instructions = ?");
      binds.push(body.ocr_instructions);
    }
    if (body.ocr_engine !== undefined) {
      sets.push("ocr_engine = ?");
      binds.push(body.ocr_engine); // null resets to the default engine
    }
    if (body.work_id !== undefined) {
      sets.push("work_id = ?");
      binds.push(body.work_id); // null unlinks (flat)
    }
    if (body.review_enabled !== undefined) {
      sets.push("review_enabled = ?");
      binds.push(body.review_enabled ? 1 : 0);
    }
    if (body.review_effort !== undefined) {
      sets.push("review_effort = ?");
      binds.push(body.review_effort); // null resets to the default effort
    }

    const result = yield* Effect.promise(() =>
      env.DB.prepare(`UPDATE books SET ${sets.join(", ")} WHERE id = ?`)
        .bind(...binds, params.bookId)
        .run(),
    );
    if (result.meta.changes === 0) {
      return yield* notFound(`Book '${params.bookId}' not found`);
    }

    // Both title (indexed as book_title) and work_id (drives work_name/author/
    // tags) are denormalized onto this book's search docs — reindex to resync.
    // Best-effort: search staleness must not fail the write (reindex is the
    // backstop). Only when Meili is configured and a denormalized field moved.
    const denormChanged =
      body.title !== undefined || body.work_id !== undefined;
    if (denormChanged && env.MEILI_URL && env.MEILI_KEY) {
      yield* Effect.promise(async () => {
        try {
          await reindexBook({ env, bookId: params.bookId });
        } catch (err) {
          console.error(
            `search reindex failed for book ${params.bookId}: ${err}`,
          );
        }
      });
    }

    const book = yield* Effect.promise(() =>
      env.DB.prepare(
        "SELECT id, title, created_at, ocr_instructions, ocr_engine, work_id, paused, review_enabled, review_effort FROM books WHERE id = ?",
      )
        .bind(params.bookId)
        .first<{
          id: string;
          title: string;
          created_at: number;
          ocr_instructions: string | null;
          ocr_engine: OcrEngine | null;
          work_id: string | null;
          paused: number;
          review_enabled: number;
          review_effort: ReviewEffort | null;
        }>(),
    );

    return respond({
      endpoint: BookUpdate,
      body: {
        success: true,
        book: book && {
          ...book,
          paused: book.paused === 1,
          review_enabled: book.review_enabled === 1,
        },
      },
    });
  });
