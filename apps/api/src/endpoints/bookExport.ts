import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { type AppContext, ExportFile } from "../types";

const MAX_BATCH_LIMIT = 200;

// Same order as "page_number IS NULL, page_number, order_hint, file_id", but
// with NULLs folded into flags so every term is non-null and the whole key can
// be compared as one row value. COALESCE(x, 0) is only reached when its flag
// already separates the NULL rows, so the 0 never collides with a real value.
const SORT_KEY_TERMS = [
  "page_number IS NULL",
  "COALESCE(page_number, 0)",
  "order_hint IS NOT NULL",
  "COALESCE(order_hint, 0)",
  "file_id",
] as const;
const ORDER_BY = SORT_KEY_TERMS.join(", ");
const SORT_KEY_ROW = `(${ORDER_BY})`;

const ExportCursor = z.object({
  page_number: z.number().int().nullable(),
  order_hint: z.number().int().nullable(),
  file_id: z.string(),
});
type ExportCursor = z.infer<typeof ExportCursor>;

type ExportRow = {
  file_id: string;
  page_number: number | null;
  role: string | null;
  order_hint: number | null;
  state: z.infer<typeof ExportFile>["state"];
  text_key: string | null;
};

function encodeCursor(cursor: ExportCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeCursor(raw: string): ExportCursor | null {
  try {
    const base64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
    const parsed = ExportCursor.safeParse(
      JSON.parse(new TextDecoder().decode(bytes)),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function sortKeyParams(cursor: ExportCursor) {
  return [
    cursor.page_number === null ? 1 : 0,
    cursor.page_number ?? 0,
    cursor.order_hint === null ? 0 : 1,
    cursor.order_hint ?? 0,
    cursor.file_id,
  ];
}

// Bulk pull: every file's metadata + transcription text, for local assembly
// (group by page_number, stitch into book.md in the vault). With `limit`, it
// returns one batch at a time, keyed on the last row returned (not an offset),
// so pages uploaded mid-import are neither skipped nor duplicated.
export class BookExport extends OpenAPIRoute {
  schema = {
    tags: ["Books"],
    summary: "Export a book's files with their transcription text",
    request: {
      params: z.object({ bookId: z.string() }),
      query: z.object({
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(MAX_BATCH_LIMIT)
          .optional()
          .describe(
            `Batch size (1-${MAX_BATCH_LIMIT}). Omit to get every file in one response.`,
          ),
        cursor: z
          .string()
          .optional()
          .describe(
            "Opaque next_cursor from the previous batch. Requires limit.",
          ),
      }),
    },
    responses: {
      "200": {
        description: "Files with text, ordered by page number",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              book_id: z.string(),
              files: ExportFile.array(),
              files_total: z
                .number()
                .int()
                .optional()
                .describe("Every file in the book (batched requests only)"),
              next_cursor: z
                .string()
                .nullable()
                .optional()
                .describe(
                  "Pass as cursor for the next batch; null on the last batch (batched requests only)",
                ),
            }),
          },
        },
      },
      "400": { description: "Invalid limit or cursor" },
      "404": { description: "No such book" },
    },
  };

  async handle(c: AppContext) {
    const { params, query } = await this.getValidatedData<typeof this.schema>();

    if (query.cursor !== undefined && query.limit === undefined) {
      return c.json({ success: false, error: "cursor requires limit" }, 400);
    }
    const cursor =
      query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    if (cursor === null) {
      return c.json(
        { success: false, error: "Malformed cursor; pass next_cursor as-is" },
        400,
      );
    }

    const book = await c.env.DB.prepare("SELECT id FROM books WHERE id = ?")
      .bind(params.bookId)
      .first<{ id: string }>();
    if (!book) {
      return c.json(
        { success: false, error: `Book '${params.bookId}' not found` },
        404,
      );
    }

    const columns = "file_id, page_number, role, order_hint, state, text_key";

    if (query.limit === undefined) {
      const { results } = await c.env.DB.prepare(
        `SELECT ${columns} FROM files WHERE book_id = ? ORDER BY ${ORDER_BY}`,
      )
        .bind(params.bookId)
        .all<ExportRow>();
      const files = await withText({ c, rows: results });
      return c.json({ success: true, book_id: params.bookId, files });
    }

    // One extra row tells us whether another batch follows.
    const batchQuery = cursor
      ? c.env.DB.prepare(
          `SELECT ${columns} FROM files
			 WHERE book_id = ? AND ${SORT_KEY_ROW} > (?, ?, ?, ?, ?)
			 ORDER BY ${ORDER_BY} LIMIT ?`,
        ).bind(params.bookId, ...sortKeyParams(cursor), query.limit + 1)
      : c.env.DB.prepare(
          `SELECT ${columns} FROM files WHERE book_id = ?
			 ORDER BY ${ORDER_BY} LIMIT ?`,
        ).bind(params.bookId, query.limit + 1);

    const [total, { results }] = await Promise.all([
      c.env.DB.prepare(
        "SELECT COALESCE(SUM(n), 0) AS n FROM book_state_counts WHERE book_id = ?",
      )
        .bind(params.bookId)
        .first<{ n: number }>(),
      batchQuery.all<ExportRow>(),
    ]);

    const batch = results.slice(0, query.limit);
    const last = batch.at(-1);
    const next_cursor =
      results.length > query.limit && last
        ? encodeCursor({
            page_number: last.page_number,
            order_hint: last.order_hint,
            file_id: last.file_id,
          })
        : null;

    const files = await withText({ c, rows: batch });
    return c.json({
      success: true,
      book_id: params.bookId,
      files,
      files_total: total?.n ?? 0,
      next_cursor,
    });
  }
}

async function withText({ c, rows }: { c: AppContext; rows: ExportRow[] }) {
  return Promise.all(
    rows.map(async (r) => {
      let text: string | null = null;
      if (r.text_key) {
        const obj = await c.env.BUCKET.get(r.text_key);
        if (obj) text = await obj.text();
      }
      return {
        file_id: r.file_id,
        page_number: r.page_number,
        role: r.role,
        order_hint: r.order_hint,
        state: r.state,
        text,
      };
    }),
  );
}
