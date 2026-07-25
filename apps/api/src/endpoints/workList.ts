import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { type AppContext, WorkWithCounts } from "../types";

interface WorkRow {
  id: string;
  name: string;
  author: string | null;
  created_at: number;
  copies_total: number;
}

export class WorkList extends OpenAPIRoute {
  schema = {
    tags: ["Works"],
    summary: "List works with copy counts and tags",
    responses: {
      "200": {
        description: "All works, newest first",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              works: WorkWithCounts.array(),
            }),
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    const { results: works } = await c.env.DB.prepare(
      `SELECT w.id, w.name, w.author, w.created_at,
              (SELECT COUNT(*) FROM books WHERE work_id = w.id) AS copies_total
         FROM works w
        ORDER BY w.created_at DESC`,
    ).all<WorkRow>();

    // One query for all tag links, assembled into per-work lists in JS.
    const { results: tagRows } = await c.env.DB.prepare(
      `SELECT wt.work_id, t.name
         FROM work_tags wt JOIN tags t ON wt.tag_id = t.id
        ORDER BY t.name`,
    ).all<{ work_id: string; name: string }>();
    const tagsByWork = new Map<string, string[]>();
    for (const r of tagRows) {
      const list = tagsByWork.get(r.work_id) ?? [];
      list.push(r.name);
      tagsByWork.set(r.work_id, list);
    }

    return c.json({
      success: true,
      works: works.map((w) => ({ ...w, tags: tagsByWork.get(w.id) ?? [] })),
    });
  }
}
