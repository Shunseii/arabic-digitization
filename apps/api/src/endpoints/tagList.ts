import { Effect, Schema } from "effect";
import { HttpApiEndpoint, OpenApi } from "effect/http-api";
import { type EndpointHandler, WorkerContext } from "../http/context";
import { respond } from "../http/respond";
import { Tag } from "../types";

// All tags in the vocabulary, alphabetized — powers the tag filter's option list
// on the library and search screens.
export const TagList = HttpApiEndpoint.get("tagList", "/api/tags", {
  success: Schema.Struct({ success: Schema.Boolean, tags: Schema.Array(Tag) }),
}).annotate(OpenApi.Summary, "List all tags");

export const tagList: EndpointHandler<typeof TagList> = () =>
  Effect.gen(function* () {
    const { env } = yield* WorkerContext;
    const { results } = yield* Effect.promise(() =>
      env.DB.prepare("SELECT id, name FROM tags ORDER BY name").all<{
        id: string;
        name: string;
      }>(),
    );
    return respond({
      endpoint: TagList,
      body: { success: true, tags: results },
    });
  });
