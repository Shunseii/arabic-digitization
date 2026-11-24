import { Effect, Schema } from "effect";
import { HttpApiEndpoint, OpenApi } from "effect/http-api";
import { type EndpointHandler, WorkerContext } from "../http/context";
import { respond } from "../http/respond";
import { WorkWithCounts } from "../types";

interface WorkRow {
  id: string;
  name: string;
  author: string | null;
  created_at: number;
  copies_total: number;
}

export const WorkList = HttpApiEndpoint.get("workList", "/api/works", {
  success: Schema.Struct({
    success: Schema.Boolean,
    works: Schema.Array(WorkWithCounts),
  }),
}).annotate(OpenApi.Summary, "List works with copy counts and tags");

export const workList: EndpointHandler<typeof WorkList> = () =>
  Effect.gen(function* () {
    const { env } = yield* WorkerContext;
    // The works, then one query for all tag links, assembled into per-work
    // lists in JS; both in one round trip.
    const [worksResult, tagsResult] = yield* Effect.promise(() =>
      env.DB.batch<unknown>([
        env.DB.prepare(
          `SELECT w.id, w.name, w.author, w.created_at,
                  (SELECT COUNT(*) FROM books WHERE work_id = w.id) AS copies_total
             FROM works w
            ORDER BY w.created_at DESC`,
        ),
        env.DB.prepare(
          `SELECT wt.work_id, t.name
             FROM work_tags wt JOIN tags t ON wt.tag_id = t.id
            ORDER BY t.name`,
        ),
      ]),
    );
    const works = (worksResult?.results ?? []) as WorkRow[];
    const tagRows = (tagsResult?.results ?? []) as {
      work_id: string;
      name: string;
    }[];

    const tagsByWork = new Map<string, string[]>();
    for (const r of tagRows) {
      const list = tagsByWork.get(r.work_id) ?? [];
      list.push(r.name);
      tagsByWork.set(r.work_id, list);
    }

    return respond({
      endpoint: WorkList,
      body: {
        success: true,
        works: works.map((w) => ({ ...w, tags: tagsByWork.get(w.id) ?? [] })),
      },
    });
  });
