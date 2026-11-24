import { Effect, Schema } from "effect";
import { HttpApiEndpoint, OpenApi } from "effect/http-api";
import { type EndpointHandler, WorkerContext } from "../http/context";
import { respond } from "../http/respond";
import {
  applySettings,
  buildIndexSettings,
  createIndex,
  deleteIndex,
  STAGING_INDEX,
} from "../lib/meili";
import { reindexBook } from "../lib/reindex";

// (Re)index transcribed pages into Meilisearch.
//
// - Scoped to one book (bookId): rebuild that book's docs in the live index,
//   synchronously. Small and bounded — used by the work/book edit hooks too.
// - Full rebuild (no bookId): build a fresh staging index and atomically swap it
//   in. The build is fanned out over the queue, one book per message, so no
//   single invocation hits the Worker's CPU/subrequest/memory limits, and the
//   live index is only ever replaced by an atomic swap — never emptied mid-run.
export const SearchReindex = HttpApiEndpoint.post(
  "searchReindex",
  "/api/search/reindex",
  {
    // No body (or null) means a full rebuild.
    payload: [
      Schema.Struct({ bookId: Schema.optionalKey(Schema.String) }).annotate({
        description:
          "Omit for a full atomic rebuild (queued); pass bookId to rebuild one book now",
      }),
      Schema.Null,
    ],
    success: Schema.Struct({
      success: Schema.Literal(true),
      mode: Schema.Literals(["book", "swap"]),
      indexed: Schema.NullOr(Schema.Int),
      books: Schema.NullOr(Schema.Int),
    }),
  },
).annotate(OpenApi.Summary, "(Re)index transcribed pages into Meilisearch");

export const searchReindex: EndpointHandler<typeof SearchReindex> = ({
  payload,
}) =>
  Effect.gen(function* () {
    const { env } = yield* WorkerContext;

    // Single book: synchronous, into the live index.
    const bookId = payload?.bookId;
    if (bookId) {
      const { indexed } = yield* Effect.promise(() =>
        reindexBook({ env, bookId }),
      );
      return respond({
        endpoint: SearchReindex,
        body: {
          success: true as const,
          mode: "book" as const,
          indexed,
          books: null,
        },
      });
    }

    // Full rebuild: prepare a clean staging index (drop any leftover, create,
    // apply the same settings + embedder as live), then fan the build out over
    // the queue. The last queued step swaps staging in and drops the old index.
    const books = yield* Effect.promise(async () => {
      await deleteIndex({ env, index: STAGING_INDEX });
      await createIndex({ env, index: STAGING_INDEX });
      await applySettings({
        env,
        index: STAGING_INDEX,
        settings: buildIndexSettings(env),
      });

      const { results } = await env.DB.prepare(
        "SELECT id FROM books ORDER BY created_at",
      ).all<{ id: string }>();
      const bookIds = results.map((r) => r.id);
      if (bookIds.length > 0) {
        await env.OCR_Q.send({ kind: "reindex_chain", bookIds, cursor: 0 });
      }
      return bookIds.length;
    });

    return respond({
      endpoint: SearchReindex,
      body: {
        success: true as const,
        mode: "swap" as const,
        indexed: null,
        books,
      },
    });
  });
