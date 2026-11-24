import { Effect, Schema } from "effect";
import { HttpApiEndpoint, HttpApiSchema, OpenApi } from "effect/http-api";
import { type EndpointHandler, WorkerContext } from "../http/context";
import { Conflict, conflict } from "../http/errors";
import { respond } from "../http/respond";
import { setWorkTags } from "../lib/tags";
import { Work, WorkCreateBody } from "../types";

export const WorkCreate = HttpApiEndpoint.post("workCreate", "/api/works", {
  payload: WorkCreateBody,
  success: Schema.Struct({ success: Schema.Boolean, work: Work }).pipe(
    HttpApiSchema.status(201),
  ),
  error: Conflict,
}).annotate(
  OpenApi.Summary,
  "Create a work (the abstract book that copies belong to)",
);

export const workCreate: EndpointHandler<typeof WorkCreate> = ({
  payload: body,
}) =>
  Effect.gen(function* () {
    const { env } = yield* WorkerContext;
    const id = body.id ?? crypto.randomUUID();
    const created_at = Date.now();
    const author = body.author ?? null;

    const inserted = yield* Effect.tryPromise({
      try: () =>
        env.DB.prepare(
          "INSERT INTO works (id, name, author, created_at) VALUES (?, ?, ?, ?)",
        )
          .bind(id, body.name, author, created_at)
          .run(),
      catch: (error) => error,
    }).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) => error instanceof Error && /UNIQUE/i.test(error.message),
        () => Effect.succeed(false),
      ),
      Effect.orDie,
    );
    if (!inserted) return yield* conflict(`Work '${id}' already exists`);

    const tags = [...(body.tags ?? [])];
    if (tags.length > 0) {
      yield* Effect.promise(() =>
        setWorkTags({ env, workId: id, names: tags }),
      );
    }

    return respond({
      endpoint: WorkCreate,
      status: 201,
      body: {
        success: true,
        work: { id, name: body.name, author, created_at, tags },
      },
    });
  });
