import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { deleteBook } from "../lib/deleteBook";
import { reindexBook } from "../lib/reindex";
import { type AppContext, WorkDeleteMode } from "../types";

// Delete a work. Two modes for its copies (books):
//   unlink (default): keep the copies, set their work_id NULL (they go flat).
//   delete:           cascade-delete every copy (R2 + file rows + book row +
//                     search docs) via the shared deleteBook helper.
// Tag links are removed either way; the tag vocabulary itself is left intact.
export class WorkDelete extends OpenAPIRoute {
  schema = {
    tags: ["Works"],
    summary: "Delete a work; unlink or cascade-delete its copies",
    request: {
      params: z.object({ workId: z.string() }),
      query: z.object({
        copies: WorkDeleteMode.default("unlink"),
      }),
    },
    responses: {
      "200": {
        description: "The work was deleted",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              deleted: z.object({
                work_id: z.string(),
                mode: WorkDeleteMode,
                copies: z.number().int(),
              }),
            }),
          },
        },
      },
      "404": {
        description: "No such work",
        content: {
          "application/json": {
            schema: z.object({ success: z.boolean(), error: z.string() }),
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    const { params, query } = await this.getValidatedData<typeof this.schema>();
    const mode = query.copies;

    const work = await c.env.DB.prepare("SELECT id FROM works WHERE id = ?")
      .bind(params.workId)
      .first<{ id: string }>();
    if (!work) {
      return c.json(
        { success: false, error: `Work '${params.workId}' not found` },
        404,
      );
    }

    const { results: copies } = await c.env.DB.prepare(
      "SELECT id FROM books WHERE work_id = ?",
    )
      .bind(params.workId)
      .all<{ id: string }>();

    let affected = 0;
    if (mode === "delete") {
      // Cascade: remove every copy fully (R2 + D1 + search). Do this before
      // dropping the work row so a mid-way failure leaves the work as the anchor.
      for (const b of copies) {
        const deleted = await deleteBook({ env: c.env, bookId: b.id });
        if (deleted) affected++;
      }
    } else {
      // Unlink: copies survive, flattened. Clear the FK, then reindex each so its
      // denormalized work fields (work_name/author/tags) drop from search.
      await c.env.DB.prepare(
        "UPDATE books SET work_id = NULL WHERE work_id = ?",
      )
        .bind(params.workId)
        .run();
      affected = copies.length;
      if (c.env.MEILI_URL && c.env.MEILI_KEY) {
        for (const b of copies) {
          try {
            await reindexBook({ env: c.env, bookId: b.id });
          } catch (err) {
            console.error(`search reindex failed for book ${b.id}: ${err}`);
          }
        }
      }
    }

    // Remove tag links, then the work row.
    await c.env.DB.prepare("DELETE FROM work_tags WHERE work_id = ?")
      .bind(params.workId)
      .run();
    await c.env.DB.prepare("DELETE FROM works WHERE id = ?")
      .bind(params.workId)
      .run();

    return c.json({
      success: true,
      deleted: { work_id: params.workId, mode, copies: affected },
    });
  }
}
