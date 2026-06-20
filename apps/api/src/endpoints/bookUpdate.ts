import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { type AppContext, Book, BookUpdateBody } from "../types";

export class BookUpdate extends OpenAPIRoute {
  schema = {
    tags: ["Books"],
    summary: "Update a book (e.g. its OCR instructions)",
    request: {
      params: z.object({ bookId: z.string() }),
      body: {
        content: { "application/json": { schema: BookUpdateBody } },
      },
    },
    responses: {
      "200": {
        description: "The updated book",
        content: {
          "application/json": {
            schema: z.object({ success: z.boolean(), book: Book }),
          },
        },
      },
      "404": {
        description: "No such book",
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

    // Build the SET clause from only the provided fields.
    const sets: string[] = [];
    const binds: (string | null)[] = [];
    if (body.title !== undefined) {
      sets.push("title = ?");
      binds.push(body.title);
    }
    if (body.ocr_instructions !== undefined) {
      sets.push("ocr_instructions = ?");
      binds.push(body.ocr_instructions);
    }

    const result = await c.env.DB.prepare(
      `UPDATE books SET ${sets.join(", ")} WHERE id = ?`,
    )
      .bind(...binds, params.bookId)
      .run();

    if (result.meta.changes === 0) {
      return c.json(
        { success: false, error: `Book '${params.bookId}' not found` },
        404,
      );
    }

    const book = await c.env.DB.prepare(
      "SELECT id, title, created_at, ocr_instructions FROM books WHERE id = ?",
    )
      .bind(params.bookId)
      .first();

    return c.json({ success: true, book });
  }
}
