import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { search } from "../lib/meili";
import type { AppContext } from "../types";

// Hybrid search across the digitized corpus (lexical + semantic), proxied to
// Meilisearch. semanticRatio tunes the keyword/vector balance.
export class Search extends OpenAPIRoute {
  schema = {
    tags: ["Search"],
    summary: "Hybrid search across all books (or one)",
    request: {
      query: z.object({
        q: z.string().min(1).describe("Search query (Arabic or English)"),
        book: z.string().optional().describe("Restrict to one book_id"),
        semanticRatio: z.coerce
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("0 = keyword only, 1 = semantic only. Default 0.5"),
        limit: z.coerce.number().int().min(1).max(50).optional(),
      }),
    },
    responses: {
      "200": {
        description: "Ranked hits",
        content: {
          "application/json": {
            schema: z.object({
              success: z.literal(true),
              hits: z.array(
                z.object({
                  id: z.string(),
                  book_id: z.string(),
                  book_title: z.string(),
                  page_number: z.number().int().nullable(),
                  text: z.string(),
                }),
              ),
            }),
          },
        },
      },
      "502": { description: "Search backend unavailable" },
    },
  };

  async handle(c: AppContext) {
    const { query } = await this.getValidatedData<typeof this.schema>();
    try {
      const hits = await search({
        env: c.env,
        query: query.q,
        bookId: query.book,
        semanticRatio: query.semanticRatio ?? 0.5,
        limit: query.limit ?? 20,
      });
      return c.json({ success: true, hits });
    } catch (err) {
      // Meili may be cold-starting (Fly autostop) or down; surface as 502.
      return c.json(
        { success: false, error: `Search unavailable: ${String(err)}` },
        502,
      );
    }
  }
}
