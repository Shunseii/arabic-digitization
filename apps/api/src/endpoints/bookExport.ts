import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { type AppContext, ExportFile } from "../types";

// Bulk pull: every file's metadata + transcription text in one payload, for
// local assembly (group by page_number, stitch into book.md in the vault).
export class BookExport extends OpenAPIRoute {
  schema = {
    tags: ["Books"],
    summary: "Export a book's files with their transcription text",
    request: {
      params: z.object({ bookId: z.string() }),
    },
    responses: {
      "200": {
        description: "All files with text, ordered by page number",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              book_id: z.string(),
              files: ExportFile.array(),
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
      `SELECT file_id, page_number, role, order_hint, state, text_key
			 FROM files WHERE book_id = ?
			 ORDER BY page_number IS NULL, page_number, order_hint`,
    )
      .bind(params.bookId)
      .all<{
        file_id: string;
        page_number: number | null;
        role: string | null;
        order_hint: number | null;
        state: z.infer<typeof ExportFile>["state"];
        text_key: string | null;
      }>();

    // Fetch each transcription from R2 in parallel.
    const files = await Promise.all(
      results.map(async (r) => {
        let text: string | null = null;
        if (r.text_key) {
          const obj = await c.env.BUCKET.get(r.text_key);
          if (obj) text = await obj.text();
        }
        return {
          file_id: r.file_id,
          page_number: r.page_number,
          role: r.role,
          order_hint: r.order_hint,
          state: r.state,
          text,
        };
      }),
    );

    return c.json({ success: true, book_id: params.bookId, files });
  }
}
