import { Effect, Schema } from "effect";
import { HttpApiEndpoint, HttpApiSchema, OpenApi } from "effect/http-api";
import { type EndpointHandler, WorkerContext } from "../http/context";
import { Conflict, conflict } from "../http/errors";
import { respond } from "../http/respond";
import { setWorkTags } from "../lib/tags";
import { Book, BookCreateBody } from "../types";

export const BookCreate = HttpApiEndpoint.post("bookCreate", "/api/books", {
  payload: BookCreateBody,
  success: Schema.Struct({ success: Schema.Boolean, book: Book }).pipe(
    HttpApiSchema.status(201),
  ),
  error: Conflict,
}).annotate(OpenApi.Summary, "Create a book");

export const bookCreate: EndpointHandler<typeof BookCreate> = ({
  payload: body,
}) =>
  Effect.gen(function* () {
    const { env } = yield* WorkerContext;
    const id = body.id ?? crypto.randomUUID();
    const created_at = Date.now();
    const ocr_instructions = body.ocr_instructions ?? null;
    const ocr_engine = body.ocr_engine ?? null;

    // A copy always belongs to a work: attach to the given one, or auto-create a
    // work named after the copy so nothing lands ungrouped going forward.
    // (Legacy books predate this and stay work_id NULL until manually assigned.)
    const autoCreatedWork = !body.work_id;
    const work_id = body.work_id || crypto.randomUUID();
    const statements: D1PreparedStatement[] = [];
    if (autoCreatedWork) {
      statements.push(
        env.DB.prepare(
          "INSERT INTO works (id, name, author, created_at) VALUES (?, ?, NULL, ?)",
        ).bind(work_id, body.title, created_at),
      );
    }
    statements.push(
      env.DB.prepare(
        "INSERT INTO books (id, title, created_at, ocr_instructions, ocr_engine, work_id) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(id, body.title, created_at, ocr_instructions, ocr_engine, work_id),
    );

    const inserted = yield* Effect.tryPromise({
      try: () => env.DB.batch(statements),
      catch: (error) => error,
    }).pipe(
      Effect.as(true),
      // UNIQUE constraint on the primary key → id collision
      Effect.catchIf(
        (error) => error instanceof Error && /UNIQUE/i.test(error.message),
        () => Effect.succeed(false),
      ),
      Effect.orDie,
    );
    if (!inserted) return yield* conflict(`Book '${id}' already exists`);

    // Tags belong to the work, so only meaningful for an auto-created one.
    if (autoCreatedWork && body.tags && body.tags.length > 0) {
      const names = [...body.tags];
      yield* Effect.promise(() => setWorkTags({ env, workId: work_id, names }));
    }

    return respond({
      endpoint: BookCreate,
      status: 201,
      body: {
        success: true,
        book: {
          id,
          title: body.title,
          created_at,
          ocr_instructions,
          ocr_engine,
          work_id,
        },
      },
    });
  });
