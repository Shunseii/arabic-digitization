import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { buildHighlight, hashQuery } from "../lib/highlight";
import type { AppContext } from "../types";

// Cached highlight results live 30 days; the cache key includes the file's
// updated_at so a re-OCR (which bumps it) misses and recomputes.
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;

// Given a search query, return the page text plus the passages worth
// highlighting (located as char ranges). Powers cross-lingual / semantic
// highlighting in the search preview, where Meilisearch's lexical _formatted
// can't mark anything (no shared token between an English query and an Arabic
// passage). See lib/highlight.ts.
export class FileHighlight extends OpenAPIRoute {
  schema = {
    tags: ["Files"],
    summary: "Find passages to highlight for a query on one page",
    request: {
      params: z.object({ bookId: z.string(), fileId: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({ query: z.string().min(1) }),
          },
        },
      },
    },
    responses: {
      "200": {
        description: "Cleaned page text + located highlight spans",
        content: {
          "application/json": {
            schema: z.object({
              success: z.literal(true),
              text: z.string(),
              spans: z.array(
                z.object({
                  text: z.string(),
                  ranges: z.array(z.tuple([z.number(), z.number()])),
                }),
              ),
            }),
          },
        },
      },
      "404": { description: "No such file" },
      "409": { description: "File not transcribed yet" },
    },
  };

  async handle(c: AppContext) {
    const { params, body } = await this.getValidatedData<typeof this.schema>();

    const row = await c.env.DB.prepare(
      "SELECT text_key, updated_at FROM files WHERE file_id = ? AND book_id = ?",
    )
      .bind(params.fileId, params.bookId)
      .first<{ text_key: string | null; updated_at: number }>();
    if (!row) {
      return c.json(
        { success: false, error: `File '${params.fileId}' not found` },
        404,
      );
    }
    if (!row.text_key) {
      return c.json({ success: false, error: "File not transcribed yet" }, 409);
    }

    // Deterministic result → cache it. Key binds the file + its version
    // (updated_at) + the query, so re-OCR or a different query misses.
    const cacheKey = `hl:${params.fileId}:${row.updated_at}:${await hashQuery(body.query)}`;
    const cached = await c.env.HIGHLIGHT_CACHE.get<{
      text: string;
      spans: { text: string; ranges: [number, number][] }[];
    }>(cacheKey, "json");
    if (cached) {
      return c.json({ success: true, ...cached }, 200);
    }

    const obj = await c.env.BUCKET.get(row.text_key);
    if (!obj) {
      return c.json({ success: false, error: "Transcription missing" }, 404);
    }

    const { text, spans } = await buildHighlight({
      env: c.env,
      query: body.query,
      pageMarkdown: await obj.text(),
    });
    // Best-effort cache write; a KV hiccup shouldn't fail the request.
    c.executionCtx.waitUntil(
      c.env.HIGHLIGHT_CACHE.put(cacheKey, JSON.stringify({ text, spans }), {
        expirationTtl: CACHE_TTL_SECONDS,
      }),
    );
    return c.json({ success: true, text, spans }, 200);
  }
}
