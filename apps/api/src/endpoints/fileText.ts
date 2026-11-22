import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import type { AppContext } from "../types";

// Return one file's transcribed Markdown (raw text/markdown body, from R2).
// With ?rev=<id>, the earlier text saved by that change (see .../text/history).
export class FileText extends OpenAPIRoute {
  schema = {
    tags: ["Files"],
    summary: "Get a file's transcription (raw Markdown)",
    request: {
      params: z.object({ bookId: z.string(), fileId: z.string() }),
      query: z.object({
        rev: z.coerce
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "A revision id from .../text/history: return the text as it was just before that change",
          ),
      }),
    },
    responses: {
      "200": {
        description: "The transcription",
        content: { "text/markdown": { schema: z.string() } },
      },
      "404": { description: "No such file or revision" },
      "409": { description: "File not transcribed yet" },
    },
  };

  async handle(c: AppContext) {
    const { params, query } = await this.getValidatedData<typeof this.schema>();

    const row = await c.env.DB.prepare(
      "SELECT text_key FROM files WHERE file_id = ? AND book_id = ?",
    )
      .bind(params.fileId, params.bookId)
      .first<{ text_key: string | null }>();
    if (!row) {
      return c.json(
        { success: false, error: `File '${params.fileId}' not found` },
        404,
      );
    }
    let key = row.text_key;
    if (query.rev !== undefined) {
      const rev = await c.env.DB.prepare(
        "SELECT prev_key FROM text_revisions WHERE id = ? AND file_id = ?",
      )
        .bind(query.rev, params.fileId)
        .first<{ prev_key: string }>();
      if (!rev) {
        return c.json(
          { success: false, error: `Revision ${query.rev} not found` },
          404,
        );
      }
      key = rev.prev_key;
    }
    if (!key) {
      return c.json({ success: false, error: "File not transcribed yet" }, 409);
    }

    const obj = await c.env.BUCKET.get(key);
    if (!obj) {
      return c.json({ success: false, error: "Transcription missing" }, 404);
    }

    return c.body(await obj.text(), 200, {
      "content-type": "text/markdown; charset=utf-8",
    });
  }
}
