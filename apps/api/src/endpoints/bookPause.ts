import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import type { AppContext } from "../types";

const RESUMABLE_STATES = ["queued", "rate_limited"] as const;

const bookParams = z.object({ bookId: z.string() });

// Pause OCR for one book. The queue consumer checks the flag and drops this
// book's messages without calling an OCR provider, leaving the pages 'queued'. Other
// books on the shared queue are unaffected. Pages uploaded while paused wait too.
export class BookPause extends OpenAPIRoute {
  schema = {
    tags: ["Books"],
    summary: "Pause OCR for a book",
    request: { params: bookParams },
    responses: {
      "200": {
        description: "Book paused",
        content: {
          "application/json": {
            schema: z.object({ success: z.boolean(), paused: z.boolean() }),
          },
        },
      },
      "404": { description: "No such book" },
    },
  };

  async handle(c: AppContext) {
    const { params } = await this.getValidatedData<typeof this.schema>();
    const { meta } = await c.env.DB.prepare(
      "UPDATE books SET paused = 1 WHERE id = ?",
    )
      .bind(params.bookId)
      .run();
    if (meta.changes === 0) {
      return c.json(
        { success: false, error: `Book '${params.bookId}' not found` },
        404,
      );
    }
    return c.json({ success: true, paused: true });
  }
}

// Resume OCR for a paused book: clear the flag and re-enqueue every page that
// was waiting. Messages dropped during the pause are replaced by these.
export class BookResume extends OpenAPIRoute {
  schema = {
    tags: ["Books"],
    summary: "Resume OCR for a paused book",
    request: { params: bookParams },
    responses: {
      "200": {
        description: "Book resumed; waiting pages re-enqueued",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              paused: z.boolean(),
              requeued: z.number().int(),
            }),
          },
        },
      },
      "404": { description: "No such book" },
    },
  };

  async handle(c: AppContext) {
    const { params } = await this.getValidatedData<typeof this.schema>();
    const { meta } = await c.env.DB.prepare(
      "UPDATE books SET paused = 0 WHERE id = ?",
    )
      .bind(params.bookId)
      .run();
    if (meta.changes === 0) {
      return c.json(
        { success: false, error: `Book '${params.bookId}' not found` },
        404,
      );
    }

    const placeholders = RESUMABLE_STATES.map(() => "?").join(", ");
    const { results } = await c.env.DB.prepare(
      `SELECT file_id FROM files WHERE book_id = ? AND state IN (${placeholders})`,
    )
      .bind(params.bookId, ...RESUMABLE_STATES)
      .all<{ file_id: string }>();
    const fileIds = results.map((r) => r.file_id);

    await c.env.DB.prepare(
      `UPDATE files SET state = 'queued', error = NULL, updated_at = ? WHERE book_id = ? AND state IN (${placeholders})`,
    )
      .bind(Date.now(), params.bookId, ...RESUMABLE_STATES)
      .run();

    // Cloudflare Queues cap a batch at 100 messages.
    for (let i = 0; i < fileIds.length; i += 100) {
      await c.env.OCR_Q.sendBatch(
        fileIds.slice(i, i + 100).map((fileId) => ({ body: { fileId } })),
      );
    }

    return c.json({ success: true, paused: false, requeued: fileIds.length });
  }
}
