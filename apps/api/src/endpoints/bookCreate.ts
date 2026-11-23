import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { setWorkTags } from "../lib/tags";
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
    const ocr_engine = body.ocr_engine ?? null;

    // A copy always belongs to a work: attach to the given one, or auto-create a
    // work named after the copy so nothing lands ungrouped going forward.
    // (Legacy books predate this and stay work_id NULL until manually assigned.)
    let work_id = body.work_id ?? null;
    const autoCreatedWork = !work_id;
    const statements: D1PreparedStatement[] = [];
    if (!work_id) {
      work_id = crypto.randomUUID();
      statements.push(
        c.env.DB.prepare(
          "INSERT INTO works (id, name, author, created_at) VALUES (?, ?, NULL, ?)",
        ).bind(work_id, body.title, created_at),
      );
    }
    statements.push(
      c.env.DB.prepare(
        "INSERT INTO books (id, title, created_at, ocr_instructions, ocr_engine, work_id) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(id, body.title, created_at, ocr_instructions, ocr_engine, work_id),
    );

    try {
      await c.env.DB.batch(statements);
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

    // Tags belong to the work, so only meaningful for an auto-created one.
    if (autoCreatedWork && body.tags && body.tags.length > 0 && work_id) {
      await setWorkTags({ env: c.env, workId: work_id, names: body.tags });
    }

    return c.json(
      {
        success: true,
        book: {
          id,
          title: body.title,
          created_at,
          ocr_instructions,
          ocr_engine,
          work_id,
        },
      },
      201,
    );
  }
}
