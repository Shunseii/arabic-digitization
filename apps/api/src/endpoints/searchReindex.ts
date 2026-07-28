import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import {
  applySettings,
  buildIndexSettings,
  createIndex,
  deleteIndex,
  STAGING_INDEX,
} from "../lib/meili";
import { reindexBook } from "../lib/reindex";
import type { AppContext } from "../types";

// (Re)index transcribed pages into Meilisearch.
//
// - Scoped to one book (bookId): rebuild that book's docs in the live index,
//   synchronously. Small and bounded — used by the work/book edit hooks too.
// - Full rebuild (no bookId): build a fresh staging index and atomically swap it
//   in. The build is fanned out over the queue, one book per message, so no
//   single invocation hits the Worker's CPU/subrequest/memory limits, and the
//   live index is only ever replaced by an atomic swap — never emptied mid-run.
export class SearchReindex extends OpenAPIRoute {
  schema = {
    tags: ["Search"],
    summary: "(Re)index transcribed pages into Meilisearch",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z
              .object({ bookId: z.string().optional() })
              .optional()
              .describe(
                "Omit for a full atomic rebuild (queued); pass bookId to rebuild one book now",
              ),
          },
        },
      },
    },
    responses: {
      "200": {
        description: "Reindex done (bookId) or enqueued (full rebuild)",
        content: {
          "application/json": {
            schema: z.object({
              success: z.literal(true),
              mode: z.enum(["book", "swap"]),
              indexed: z.number().int().nullable(),
              books: z.number().int().nullable(),
            }),
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    const { body } = await this.getValidatedData<typeof this.schema>();

    // Single book: synchronous, into the live index.
    if (body?.bookId) {
      const { indexed } = await reindexBook({
        env: c.env,
        bookId: body.bookId,
      });
      return c.json({ success: true, mode: "book", indexed, books: null });
    }

    // Full rebuild: prepare a clean staging index (drop any leftover, create,
    // apply the same settings + embedder as live), then fan the build out over
    // the queue. The last queued step swaps staging in and drops the old index.
    await deleteIndex({ env: c.env, index: STAGING_INDEX });
    await createIndex({ env: c.env, index: STAGING_INDEX });
    await applySettings({
      env: c.env,
      index: STAGING_INDEX,
      settings: buildIndexSettings(c.env),
    });

    const { results } = await c.env.DB.prepare(
      "SELECT id FROM books ORDER BY created_at",
    ).all<{ id: string }>();
    const bookIds = results.map((r) => r.id);

    if (bookIds.length > 0) {
      await c.env.OCR_Q.send({ kind: "reindex_chain", bookIds, cursor: 0 });
    }

    return c.json({
      success: true,
      mode: "swap",
      indexed: null,
      books: bookIds.length,
    });
  }
}
