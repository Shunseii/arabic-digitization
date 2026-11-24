import { Effect, Schema } from "effect";
import { HttpApiEndpoint, OpenApi } from "effect/http-api";
import { type EndpointHandler, WorkerContext } from "../http/context";
import { NotFound, notFound } from "../http/errors";
import { respond } from "../http/respond";
import { getWorkTags } from "../lib/tags";
import { Work } from "../types";

export const WorkFetch = HttpApiEndpoint.get(
  "workFetch",
  "/api/works/:workId",
  {
    params: { workId: Schema.String },
    success: Schema.Struct({ success: Schema.Boolean, work: Work }),
    error: NotFound,
  },
).annotate(OpenApi.Summary, "Fetch one work with its tags");

export const workFetch: EndpointHandler<typeof WorkFetch> = ({ params }) =>
  Effect.gen(function* () {
    const { env } = yield* WorkerContext;
    const work = yield* Effect.promise(() =>
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
    if (!work) return yield* notFound(`Work '${params.workId}' not found`);

    const tags = yield* Effect.promise(() =>
      getWorkTags({ env, workId: params.workId }),
    );
    return respond({
      endpoint: WorkFetch,
      body: { success: true, work: { ...work, tags } },
    });
  });
