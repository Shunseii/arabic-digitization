import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { setWorkTags } from "../lib/tags";
import { type AppContext, Work, WorkCreateBody } from "../types";

export class WorkCreate extends OpenAPIRoute {
  schema = {
    tags: ["Works"],
    summary: "Create a work (the abstract book that copies belong to)",
    request: {
      body: {
        content: { "application/json": { schema: WorkCreateBody } },
      },
    },
    responses: {
      "201": {
        description: "The created work",
        content: {
          "application/json": {
            schema: z.object({ success: z.boolean(), work: Work }),
          },
        },
      },
      "409": {
        description: "A work with this id already exists",
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
    const author = body.author ?? null;

    try {
      await c.env.DB.prepare(
        "INSERT INTO works (id, name, author, created_at) VALUES (?, ?, ?, ?)",
      )
        .bind(id, body.name, author, created_at)
        .run();
    } catch (err) {
      if (err instanceof Error && /UNIQUE/i.test(err.message)) {
        return c.json(
          { success: false, error: `Work '${id}' already exists` },
          409,
        );
      }
      throw err;
    }

    const tags = body.tags ?? [];
    if (tags.length > 0)
      await setWorkTags({ env: c.env, workId: id, names: tags });

    return c.json(
      {
        success: true,
        work: { id, name: body.name, author, created_at, tags },
      },
      201,
    );
  }
}
