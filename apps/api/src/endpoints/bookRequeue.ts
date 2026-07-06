import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { type AppContext, FileState } from "../types";

const RequeueBody = z.object({
  // States to re-OCR; defaults to the ones worth retrying.
  states: FileState.array().nonempty().optional(),
});

// Bulk re-OCR: move every file in the given states back to 'queued' and drop
// them on the OCR queue. Defaults to 'failed' + 'rate_limited'. Everything flows
// through the throttled, auto-retrying consumer, so requeuing a whole book at
// once is safe — no rate-limit storm. Also the way to re-apply changed
// ocr_instructions to already-done pages (pass states: ["done"]).
export class BookRequeue extends OpenAPIRoute {
  schema = {
    tags: ["Books"],
    summary: "Re-queue a book's files for OCR (bulk)",
    request: {
      params: z.object({ bookId: z.string() }),
      body: {
        content: { "application/json": { schema: RequeueBody } },
      },
    },
    responses: {
      "200": {
        description: "Files re-queued",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              requeued: z.number().int(),
              states: z.string().array(),
            }),
          },
        },
      },
      "404": { description: "No such book" },
    },
  };

  async handle(c: AppContext) {
    const { params, body } = await this.getValidatedData<typeof this.schema>();

    const book = await c.env.DB.prepare("SELECT id FROM books WHERE id = ?")
      .bind(params.bookId)
      .first<{ id: string }>();
    if (!book) {
      return c.json(
        { success: false, error: `Book '${params.bookId}' not found` },
        404,
      );
    }

    const states = body?.states ?? ["failed", "rate_limited"];
    const placeholders = states.map(() => "?").join(", ");

    const { results } = await c.env.DB.prepare(
      `SELECT file_id FROM files WHERE book_id = ? AND state IN (${placeholders})`,
    )
      .bind(params.bookId, ...states)
      .all<{ file_id: string }>();

    const fileIds = results.map((r) => r.file_id);
    if (fileIds.length === 0) {
      return c.json({ success: true, requeued: 0, states });
    }

    const now = Date.now();
    await c.env.DB.prepare(
      `UPDATE files SET state = 'queued', updated_at = ? WHERE book_id = ? AND state IN (${placeholders})`,
    )
      .bind(now, params.bookId, ...states)
      .run();

    // Cloudflare Queues cap a batch at 100 messages.
    for (let i = 0; i < fileIds.length; i += 100) {
      await c.env.OCR_Q.sendBatch(
        fileIds.slice(i, i + 100).map((fileId) => ({ body: { fileId } })),
      );
    }

    return c.json({ success: true, requeued: fileIds.length, states });
  }
}
