import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { reindexAll } from "../lib/reindex";
import type { AppContext } from "../types";

// Rebuild the Meilisearch index from the source of truth (R2 transcriptions).
// The index is derived, disposable data — this is also the upgrade path: bring
// up a fresh Meili version and re-run this. Optionally scope to one book.
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
              .describe("Omit to reindex every book"),
          },
        },
      },
    },
    responses: {
      "200": {
        description: "Documents enqueued for indexing",
        content: {
          "application/json": {
            schema: z.object({
              success: z.literal(true),
              indexed: z.number().int(),
              taskUid: z.number().int().nullable(),
            }),
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    const { body } = await this.getValidatedData<typeof this.schema>();
    const { indexed, taskUid } = await reindexAll({
      env: c.env,
      bookId: body?.bookId,
    });
    return c.json({ success: true, indexed, taskUid });
  }
}
