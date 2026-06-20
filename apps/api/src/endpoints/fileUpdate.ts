import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { type AppContext, FileRecord } from "../types";

// Update a page fragment's metadata. Currently just page_number — the scan and
// its transcription both live under file_id (R2 keys are uuid-based, not page
// based), so changing the page number re-labels and re-orders both without
// touching R2. Pass null to clear it.
export class FileUpdate extends OpenAPIRoute {
  schema = {
    tags: ["Files"],
    summary: "Update a file's page number",
    request: {
      params: z.object({ bookId: z.string(), fileId: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              page_number: z.number().int().positive().nullable(),
            }),
          },
        },
      },
    },
    responses: {
      "200": {
        description: "The updated file record",
        content: {
          "application/json": {
            schema: z.object({ success: z.boolean(), file: FileRecord }),
          },
        },
      },
      "404": {
        description: "No such file",
        content: {
          "application/json": {
            schema: z.object({ success: z.boolean(), error: z.string() }),
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    const { params, body } = await this.getValidatedData<typeof this.schema>();

    const now = Date.now();
    const result = await c.env.DB.prepare(
      "UPDATE files SET page_number = ?, updated_at = ? WHERE file_id = ? AND book_id = ?",
    )
      .bind(body.page_number, now, params.fileId, params.bookId)
      .run();

    if (result.meta.changes === 0) {
      return c.json(
        { success: false, error: `File '${params.fileId}' not found` },
        404,
      );
    }

    const file = await c.env.DB.prepare(
      `SELECT file_id, book_id, r2_key, state, text_key, page_number, role, order_hint, created_at, updated_at
       FROM files WHERE file_id = ?`,
    )
      .bind(params.fileId)
      .first();

    return c.json({ success: true, file });
  }
}
