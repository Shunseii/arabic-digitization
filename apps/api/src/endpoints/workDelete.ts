import { Effect, Schema } from "effect";
import { HttpApiEndpoint, OpenApi } from "effect/http-api";
import { type EndpointHandler, WorkerContext } from "../http/context";
import { NotFound, notFound } from "../http/errors";
import { respond } from "../http/respond";
import { deleteBook } from "../lib/deleteBook";
import { clearWorkFields } from "../lib/reindex";
import { WorkDeleteMode } from "../types";

// Delete a work. Two modes for its copies (books):
//   unlink (default): keep the copies, set their work_id NULL (they go flat).
//   delete:           cascade-delete every copy (R2 + file rows + book row +
//                     search docs) via the shared deleteBook helper.
// Tag links are removed either way; the tag vocabulary itself is left intact.
export const WorkDelete = HttpApiEndpoint.delete(
  "workDelete",
  "/api/works/:workId",
  {
    params: { workId: Schema.String },
    query: {
      copies: Schema.optionalKey(WorkDeleteMode),
    },
    success: Schema.Struct({
      success: Schema.Boolean,
      deleted: Schema.Struct({
        work_id: Schema.String,
        mode: WorkDeleteMode,
        copies: Schema.Int,
      }),
    }),
    error: NotFound,
  },
).annotate(
  OpenApi.Summary,
  "Delete a work; unlink or cascade-delete its copies",
);

export const workDelete: EndpointHandler<typeof WorkDelete> = ({
  params,
  query,
}) =>
  Effect.gen(function* () {
    const { env } = yield* WorkerContext;
    const mode = query.copies ?? "unlink";

    const work = yield* Effect.promise(() =>
      env.DB.prepare("SELECT id FROM works WHERE id = ?")
        .bind(params.workId)
        .first<{ id: string }>(),
    );
    if (!work) return yield* notFound(`Work '${params.workId}' not found`);

    const affected = yield* Effect.promise(async () => {
      const { results: copies } = await env.DB.prepare(
        "SELECT id FROM books WHERE work_id = ?",
      )
        .bind(params.workId)
        .all<{ id: string }>();

      if (mode === "delete") {
        // Cascade: remove every copy fully (R2 + D1 + search). Do this before
        // dropping the work row so a mid-way failure leaves the work as the anchor.
        let deleted = 0;
        for (const b of copies) {
          if (await deleteBook({ env, bookId: b.id })) deleted++;
        }
        return deleted;
      }

      // Unlink: copies survive, flattened. Clear the FK, then clear the copied
      // work fields (work_name/author/tags) from their search chunks.
      await env.DB.prepare("UPDATE books SET work_id = NULL WHERE work_id = ?")
        .bind(params.workId)
        .run();
      if (env.MEILI_URL && env.MEILI_KEY && copies.length > 0) {
        try {
          await clearWorkFields({ env, workId: params.workId });
        } catch (err) {
          console.error(`search sync failed for work ${params.workId}: ${err}`);
        }
      }
      return copies.length;
    });

    // Remove tag links, then the work row.
    yield* Effect.promise(async () => {
      await env.DB.prepare("DELETE FROM work_tags WHERE work_id = ?")
        .bind(params.workId)
        .run();
      await env.DB.prepare("DELETE FROM works WHERE id = ?")
        .bind(params.workId)
        .run();
    });

    return respond({
      endpoint: WorkDelete,
      body: {
        success: true,
        deleted: { work_id: params.workId, mode, copies: affected },
      },
    });
  });
