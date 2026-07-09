import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import {
  buildPageDocs,
  clearAllDocs,
  deleteDocsByBook,
  type SearchDoc,
  upsertDocs,
} from "../lib/meili";
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
    const bookId = body?.bookId;

    // Only pages with finished text are searchable.
    const sql = `SELECT f.file_id, f.book_id, f.page_number, f.role, f.text_key, b.title AS book_title
                 FROM files f JOIN books b ON f.book_id = b.id
                 WHERE f.text_key IS NOT NULL
                   AND f.state IN ('done','needs_review','approved')
                   ${bookId ? "AND f.book_id = ?" : ""}`;
    const stmt = bookId
      ? c.env.DB.prepare(sql).bind(bookId)
      : c.env.DB.prepare(sql);
    const { results } = await stmt.all<{
      file_id: string;
      book_id: string;
      page_number: number | null;
      role: string | null;
      text_key: string;
      book_title: string;
    }>();

    // Clear the scope first so the chunk id scheme doesn't leave stale docs
    // behind (a page's chunk count can change). Enqueued before the upsert;
    // Meili processes tasks FIFO, so the delete always lands first.
    if (bookId) {
      await deleteDocsByBook({ env: c.env, bookId });
    } else {
      await clearAllDocs({ env: c.env });
    }

    // Pull each transcription from R2, chunk it, and collect the chunk docs;
    // skip any page that's missing/empty.
    const docs: SearchDoc[] = [];
    for (const r of results) {
      const obj = await c.env.BUCKET.get(r.text_key);
      if (!obj) continue;
      const text = await obj.text();
      if (!text.trim()) continue;
      docs.push(
        ...buildPageDocs({
          file_id: r.file_id,
          book_id: r.book_id,
          book_title: r.book_title,
          page_number: r.page_number,
          role: r.role,
          text,
        }),
      );
    }

    if (docs.length === 0) {
      return c.json({ success: true, indexed: 0, taskUid: null });
    }

    const taskUid = await upsertDocs({ env: c.env, docs });
    return c.json({ success: true, indexed: docs.length, taskUid });
  }
}
