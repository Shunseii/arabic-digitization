import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { type AppContext, Tag } from "../types";

// All tags in the vocabulary, alphabetized — powers the tag filter's option list
// on the library and search screens.
export class TagList extends OpenAPIRoute {
  schema = {
    tags: ["Works"],
    summary: "List all tags",
    responses: {
      "200": {
        description: "All tags, alphabetized",
        content: {
          "application/json": {
            schema: z.object({ success: z.boolean(), tags: Tag.array() }),
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    const { results } = await c.env.DB.prepare(
      "SELECT id, name FROM tags ORDER BY name",
    ).all<{ id: string; name: string }>();
    return c.json({ success: true, tags: results });
  }
}
