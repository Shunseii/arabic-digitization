import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import type { AppContext } from "../types";

// Delete a single page fragment: its scan and transcription R2 objects plus the
// row. R2 is cleared before the DB row so a mid-way failure is retriable.
export class FileDelete extends OpenAPIRoute {
  schema = {
    tags: ["Files"],
    summary: "Delete a file (scan + transcription text + row)",
    request: {
      params: z.object({ bookId: z.string(), fileId: z.string() }),
    },
    responses: {
      "200": {
        description: "The file was deleted",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              deleted: z.object({
                file_id: z.string(),
                r2_objects: z.number().int(),
              }),
            }),
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
    const { params } = await this.getValidatedData<typeof this.schema>();

    const file = await c.env.DB.prepare(
      "SELECT file_id, r2_key, text_key FROM files WHERE file_id = ? AND book_id = ?",
    )
      .bind(params.fileId, params.bookId)
      .first<{ file_id: string; r2_key: string; text_key: string | null }>();
    if (!file) {
      return c.json(
        { success: false, error: `File '${params.fileId}' not found` },
        404,
      );
    }

    const keys = [file.r2_key, ...(file.text_key ? [file.text_key] : [])];
    await c.env.BUCKET.delete(keys);
    await c.env.DB.prepare("DELETE FROM files WHERE file_id = ?")
      .bind(params.fileId)
      .run();

    return c.json({
      success: true,
      deleted: { file_id: params.fileId, r2_objects: keys.length },
    });
  }
}
