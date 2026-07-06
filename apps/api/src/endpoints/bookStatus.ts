import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { costUsd } from "../lib/cost";
import { type AppContext, FileStatus } from "../types";

// Per-file status for a book (no transcription text) — poll this to watch the
// pipeline (queued/processing/done/needs_review/failed).
export class BookStatus extends OpenAPIRoute {
  schema = {
    tags: ["Files"],
    summary: "List a book's files with their states",
    request: {
      params: z.object({ bookId: z.string() }),
    },
    responses: {
      "200": {
        description: "Files ordered by page number",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              files: FileStatus.array(),
            }),
          },
        },
      },
      "404": { description: "No such book" },
    },
  };

  async handle(c: AppContext) {
    const { params } = await this.getValidatedData<typeof this.schema>();

    const book = await c.env.DB.prepare("SELECT id FROM books WHERE id = ?")
      .bind(params.bookId)
      .first<{ id: string }>();
    if (!book) {
      return c.json(
        { success: false, error: `Book '${params.bookId}' not found` },
        404,
      );
    }

    const { results } = await c.env.DB.prepare(
      `SELECT file_id, page_number, state, role, order_hint, preview, error, updated_at, input_tokens, output_tokens, ocr_model
			 FROM files WHERE book_id = ?
			 ORDER BY page_number IS NULL, page_number, order_hint`,
    )
      .bind(params.bookId)
      .all<
        Omit<z.infer<typeof FileStatus>, "cost_usd"> & {
          ocr_model: string | null;
        }
      >();

    const files = results.map(({ ocr_model, ...f }) => ({
      ...f,
      cost_usd: costUsd({
        model: ocr_model,
        inputTokens: f.input_tokens,
        outputTokens: f.output_tokens,
      }),
    }));

    return c.json({ success: true, files });
  }
}
