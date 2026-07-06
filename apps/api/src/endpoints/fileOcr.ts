import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { enqueueOcr } from "../queue";
import type { AppContext } from "../types";

// Manual OCR (re-)trigger. Enqueues the file onto the OCR queue — the same
// throttled, auto-retrying path as upload — and returns immediately. Poll the
// book status/export endpoints for the result.
export class FileOcr extends OpenAPIRoute {
  schema = {
    tags: ["Files"],
    summary: "Queue a file for (re-)OCR",
    request: {
      params: z.object({ bookId: z.string(), fileId: z.string() }),
    },
    responses: {
      "202": {
        description: "File enqueued for OCR",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              file_id: z.string(),
              state: z.literal("queued"),
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
      "SELECT file_id FROM files WHERE file_id = ? AND book_id = ?",
    )
      .bind(params.fileId, params.bookId)
      .first<{ file_id: string }>();
    if (!file) {
      return c.json(
        { success: false, error: `File '${params.fileId}' not found` },
        404,
      );
    }

    await enqueueOcr({ env: c.env, fileId: params.fileId });
    return c.json(
      { success: true, file_id: params.fileId, state: "queued" },
      202,
    );
  }
}
