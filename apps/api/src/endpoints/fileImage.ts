import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import type { AppContext } from "../types";

// Stream the original scanned image bytes for a file (from R2). Gated behind
// the master key like the rest of /api, so clients pass the Authorization
// header (e.g. React Native's <Image source={{ uri, headers }}>).
export class FileImage extends OpenAPIRoute {
  schema = {
    tags: ["Files"],
    summary: "Get the original scanned image bytes",
    request: {
      params: z.object({ bookId: z.string(), fileId: z.string() }),
    },
    responses: {
      "200": { description: "The scanned image bytes" },
      "404": {
        description: "No such file or scan object",
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

    const row = await c.env.DB.prepare(
      "SELECT r2_key FROM files WHERE file_id = ? AND book_id = ?",
    )
      .bind(params.fileId, params.bookId)
      .first<{ r2_key: string }>();
    if (!row) {
      return c.json(
        { success: false, error: `File '${params.fileId}' not found` },
        404,
      );
    }

    const obj = await c.env.BUCKET.get(row.r2_key);
    if (!obj) {
      return c.json({ success: false, error: "Scan object missing" }, 404);
    }

    return c.body(obj.body, 200, {
      "content-type":
        obj.httpMetadata?.contentType ?? "application/octet-stream",
      "cache-control": "private, max-age=3600",
    });
  }
}
