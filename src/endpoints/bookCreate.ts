import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { type AppContext, Book, BookCreateBody } from "../types";

export class BookCreate extends OpenAPIRoute {
  schema = {
    tags: ["Books"],
    summary: "Create a book",
    request: {
      body: {
        content: { "application/json": { schema: BookCreateBody } },
      },
    },
    responses: {
      "201": {
        description: "The created book",
        content: {
          "application/json": {
            schema: z.object({ success: z.boolean(), book: Book }),
          },
        },
      },
      "409": {
        description: "A book with this id already exists",
        content: {
          "application/json": {
            schema: z.object({ success: z.boolean(), error: z.string() }),
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    const { body } = await this.getValidatedData<typeof this.schema>();

    const id = body.id ?? crypto.randomUUID();
    const created_at = Date.now();
    const ocr_instructions = body.ocr_instructions ?? null;

    try {
      await c.env.DB.prepare(
        "INSERT INTO books (id, title, created_at, ocr_instructions) VALUES (?, ?, ?, ?)",
      )
        .bind(id, body.title, created_at, ocr_instructions)
        .run();
    } catch (err) {
      // UNIQUE constraint on the primary key → id collision
      if (err instanceof Error && /UNIQUE/i.test(err.message)) {
        return c.json(
          { success: false, error: `Book '${id}' already exists` },
          409,
        );
      }
      throw err;
    }

    return c.json(
      {
        success: true,
        book: { id, title: body.title, created_at, ocr_instructions },
      },
      201,
    );
  }
}
