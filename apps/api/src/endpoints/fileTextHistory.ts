import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import type { AppContext } from "../types";

const Revision = z.object({
  id: z.number().int(),
  change: z.enum(["edit", "ocr"]),
  model: z.string().nullable(),
  note: z.string().nullable(),
  created_at: z.number().int(),
});

// The changes made to one page's transcription, newest first. Each entry's
// earlier text is GET .../text?rev=<id> (the text just before that change).
export class FileTextHistory extends OpenAPIRoute {
  schema = {
    tags: ["Files"],
    summary: "List the changes to a file's transcription",
    request: {
      params: z.object({ bookId: z.string(), fileId: z.string() }),
    },
    responses: {
      "200": {
        description: "Changes, newest first",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              file_id: z.string(),
              text_edited_at: z.number().int().nullable(),
              revisions: Revision.array(),
            }),
          },
        },
      },
      "404": { description: "No such file" },
    },
  };

  async handle(c: AppContext) {
    const { params } = await this.getValidatedData<typeof this.schema>();

    const file = await c.env.DB.prepare(
      "SELECT text_edited_at FROM files WHERE file_id = ? AND book_id = ?",
    )
      .bind(params.fileId, params.bookId)
      .first<{ text_edited_at: number | null }>();
    if (!file) {
      return c.json(
        { success: false, error: `File '${params.fileId}' not found` },
        404,
      );
    }

    const { results } = await c.env.DB.prepare(
      `SELECT id, change, model, note, created_at FROM text_revisions
        WHERE file_id = ? ORDER BY created_at DESC, id DESC`,
    )
      .bind(params.fileId)
      .all<z.infer<typeof Revision>>();

    return c.json({
      success: true,
      file_id: params.fileId,
      text_edited_at: file.text_edited_at,
      revisions: results,
    });
  }
}
