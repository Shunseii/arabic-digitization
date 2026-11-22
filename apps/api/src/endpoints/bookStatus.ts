import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { costUsd } from "../lib/cost";
import { type AppContext, FileStatus } from "../types";

// Per-file status for a book (no transcription text). With `since`, returns only
// files updated after that time; `files_total` lets the client detect deletions
// (a merged list longer than `files_total` means it must refetch in full).
export class BookStatus extends OpenAPIRoute {
  schema = {
    tags: ["Files"],
    summary: "List a book's files with their states",
    request: {
      params: z.object({ bookId: z.string() }),
      query: z.object({
        since: z.coerce
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "Epoch ms; only return files with updated_at > since. Omit for all files.",
          ),
      }),
    },
    responses: {
      "200": {
        description: "Files ordered by page number",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              files: FileStatus.array(),
              files_total: z.number().int(),
            }),
          },
        },
      },
      "404": { description: "No such book" },
    },
  };

  async handle(c: AppContext) {
    const { params, query } = await this.getValidatedData<typeof this.schema>();

    const book = await c.env.DB.prepare("SELECT id FROM books WHERE id = ?")
      .bind(params.bookId)
      .first<{ id: string }>();
    if (!book) {
      return c.json(
        { success: false, error: `Book '${params.bookId}' not found` },
        404,
      );
    }

    const columns =
      "file_id, page_number, state, role, order_hint, preview, error, updated_at, text_edited_at, input_tokens, output_tokens, ocr_model";
    const filesQuery =
      query.since === undefined
        ? c.env.DB.prepare(
            `SELECT ${columns} FROM files WHERE book_id = ?
			 ORDER BY page_number IS NULL, page_number, order_hint`,
          ).bind(params.bookId)
        : c.env.DB.prepare(
            `SELECT ${columns} FROM files WHERE book_id = ? AND updated_at > ?
			 ORDER BY page_number IS NULL, page_number, order_hint`,
          ).bind(params.bookId, query.since);

    const total = await c.env.DB.prepare(
      "SELECT COALESCE(SUM(n), 0) AS n FROM book_state_counts WHERE book_id = ?",
    )
      .bind(params.bookId)
      .first<{ n: number }>();

    const { results } = await filesQuery.all<
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

    return c.json({ success: true, files, files_total: total?.n ?? 0 });
  }
}
