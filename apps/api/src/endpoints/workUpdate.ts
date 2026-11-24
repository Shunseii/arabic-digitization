import { Effect, Schema } from "effect";
import { HttpApiEndpoint, OpenApi } from "effect/http-api";
import { type EndpointHandler, WorkerContext } from "../http/context";
import { NotFound, notFound } from "../http/errors";
import { respond } from "../http/respond";
import { reindexWork } from "../lib/reindex";
import { getWorkTags, setWorkTags } from "../lib/tags";
import { Work, WorkUpdateBody } from "../types";

export const WorkUpdate = HttpApiEndpoint.patch(
  "workUpdate",
  "/api/works/:workId",
  {
    params: { workId: Schema.String },
    payload: WorkUpdateBody,
    success: Schema.Struct({ success: Schema.Boolean, work: Work }),
    error: NotFound,
  },
).annotate(OpenApi.Summary, "Update a work (name, author, tags)");

export const workUpdate: EndpointHandler<typeof WorkUpdate> = ({
  params,
  payload: body,
}) =>
  Effect.gen(function* () {
    const { env } = yield* WorkerContext;
    const exists = yield* Effect.promise(() =>
      env.DB.prepare("SELECT id FROM works WHERE id = ?")
        .bind(params.workId)
        .first<{ id: string }>(),
    );
    if (!exists) return yield* notFound(`Work '${params.workId}' not found`);

    const sets: string[] = [];
    const binds: (string | null)[] = [];
    if (body.name !== undefined) {
      sets.push("name = ?");
      binds.push(body.name);
    }
    if (body.author !== undefined) {
      sets.push("author = ?");
      binds.push(body.author); // null clears
    }
    if (sets.length > 0) {
      yield* Effect.promise(() =>
        env.DB.prepare(`UPDATE works SET ${sets.join(", ")} WHERE id = ?`)
          .bind(...binds, params.workId)
          .run(),
      );
    }

    const tags = body.tags;
    if (tags !== undefined) {
      yield* Effect.promise(() =>
        setWorkTags({ env, workId: params.workId, names: [...tags] }),
      );
    }

    // name/author/tags are all denormalized onto every chunk of this work's
    // copies — reindex them so search facets/hits reflect the edit. Best-effort:
    // staleness must not fail the write (POST /api/search/reindex is the backstop).
    if (env.MEILI_URL && env.MEILI_KEY) {
      yield* Effect.promise(async () => {
        try {
          await reindexWork({ env, workId: params.workId });
        } catch (err) {
          console.error(
            `search reindex failed for work ${params.workId}: ${err}`,
          );
        }
      });
    }

    const row = yield* Effect.promise(() =>
      env.DB.prepare(
        "SELECT id, name, author, created_at FROM works WHERE id = ?",
      )
        .bind(params.workId)
        .first<{
          id: string;
          name: string;
          author: string | null;
          created_at: number;
        }>(),
    );
    const workTags = yield* Effect.promise(() =>
      getWorkTags({ env, workId: params.workId }),
    );

    // The row was checked above; a concurrent delete is the only way it's gone.
    if (!row) return yield* notFound(`Work '${params.workId}' not found`);
    return respond({
      endpoint: WorkUpdate,
      body: { success: true, work: { ...row, tags: workTags } },
    });
  });
