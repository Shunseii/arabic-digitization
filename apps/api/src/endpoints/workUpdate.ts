import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { reindexWork } from "../lib/reindex";
import { getWorkTags, setWorkTags } from "../lib/tags";
import { type AppContext, Work, WorkUpdateBody } from "../types";

export class WorkUpdate extends OpenAPIRoute {
  schema = {
    tags: ["Works"],
    summary: "Update a work (name, author, tags)",
    request: {
      params: z.object({ workId: z.string() }),
      body: {
        content: { "application/json": { schema: WorkUpdateBody } },
      },
    },
    responses: {
      "200": {
        description: "The updated work",
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
    const { params, body } = await this.getValidatedData<typeof this.schema>();

    const exists = await c.env.DB.prepare("SELECT id FROM works WHERE id = ?")
      .bind(params.workId)
      .first<{ id: string }>();
    if (!exists) {
      return c.json(
        { success: false, error: `Work '${params.workId}' not found` },
        404,
      );
    }

    const sets: string[] = [];
    const binds: (string | null)[] = [];
    if (body.name !== undefined) {
      sets.push("name = ?");
      binds.push(body.name);
    }
    if (body.author !== undefined) {
      sets.push("author = ?");
      binds.push(body.author); // null clears
    }
    if (sets.length > 0) {
      await c.env.DB.prepare(`UPDATE works SET ${sets.join(", ")} WHERE id = ?`)
        .bind(...binds, params.workId)
        .run();
    }

    if (body.tags !== undefined) {
      await setWorkTags({
        env: c.env,
        workId: params.workId,
        names: body.tags,
      });
    }

    // name/author/tags are all denormalized onto every chunk of this work's
    // copies — reindex them so search facets/hits reflect the edit. Best-effort:
    // staleness must not fail the write (POST /api/search/reindex is the backstop).
    if (c.env.MEILI_URL && c.env.MEILI_KEY) {
      try {
        await reindexWork({ env: c.env, workId: params.workId });
      } catch (err) {
        console.error(
          `search reindex failed for work ${params.workId}: ${err}`,
        );
      }
    }

    const row = await c.env.DB.prepare(
      "SELECT id, name, author, created_at FROM works WHERE id = ?",
    )
      .bind(params.workId)
      .first<{
        id: string;
        name: string;
        author: string | null;
        created_at: number;
      }>();
    const tags = await getWorkTags({ env: c.env, workId: params.workId });

    return c.json({ success: true, work: { ...row, tags } });
  }
}
