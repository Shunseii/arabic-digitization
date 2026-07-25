import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { getWorkTags } from "../lib/tags";
import { type AppContext, Work } from "../types";

export class WorkFetch extends OpenAPIRoute {
  schema = {
    tags: ["Works"],
    summary: "Fetch one work with its tags",
    request: {
      params: z.object({ workId: z.string() }),
    },
    responses: {
      "200": {
        description: "The work",
        content: {
          "application/json": {
            schema: z.object({ success: z.boolean(), work: Work }),
          },
        },
      },
      "404": {
        description: "No such work",
        content: {
          "application/json": {
            schema: z.object({ success: z.boolean(), error: z.string() }),
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    const { params } = await this.getValidatedData<typeof this.schema>();

    const work = await c.env.DB.prepare(
      "SELECT id, name, author, created_at FROM works WHERE id = ?",
    )
      .bind(params.workId)
      .first<{
        id: string;
        name: string;
        author: string | null;
        created_at: number;
      }>();

    if (!work) {
      return c.json(
        { success: false, error: `Work '${params.workId}' not found` },
        404,
      );
    }

    const tags = await getWorkTags({ env: c.env, workId: params.workId });
    return c.json({ success: true, work: { ...work, tags } });
  }
}
