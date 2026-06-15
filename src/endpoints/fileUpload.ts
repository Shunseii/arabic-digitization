import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { type AppContext, FileRecord, UPLOAD_CONTENT_TYPES } from "../types";

// Upload one page fragment (image or PDF) into a book.
//
// Binding-through-Worker: the raw request body is streamed straight to R2, and
// the same request inserts the files row (state='captured'). Bytes + bookkeeping
// in one call. (Queue enqueue will be added here later to trigger OCR.)
//
// The body is read raw from the request, so it is intentionally NOT declared in
// the OpenAPI request schema (chanfana would otherwise try to parse it).
export class FileUpload extends OpenAPIRoute {
  schema = {
    tags: ["Files"],
    summary: "Upload a page fragment (raw image/PDF body) to a book",
    description:
      "Send the file bytes as the raw request body with a matching Content-Type " +
      "(image/jpeg, image/png, image/webp, application/pdf). Optionally pass ?page " +
      "when the printed page number is hidden in the shot.",
    request: {
      params: z.object({ bookId: z.string() }),
      query: z.object({
        page: z.coerce
          .number()
          .int()
          .positive()
          .optional()
          .describe("Printed page number, if known/hidden in the image"),
      }),
    },
    responses: {
      "201": {
        description: "The created file record",
        content: {
          "application/json": {
            schema: z.object({ success: z.boolean(), file: FileRecord }),
          },
        },
      },
      "400": { description: "Missing request body" },
      "404": { description: "No such book" },
      "415": { description: "Unsupported Content-Type" },
    },
  };

  async handle(c: AppContext) {
    const { params, query } = await this.getValidatedData<typeof this.schema>();

    // Book must exist before we accept files for it.
    const book = await c.env.DB.prepare("SELECT id FROM books WHERE id = ?")
      .bind(params.bookId)
      .first<{ id: string }>();
    if (!book) {
      return c.json(
        { success: false, error: `Book '${params.bookId}' not found` },
        404,
      );
    }

    const contentType =
      (c.req.header("content-type") ?? "").split(";")[0]?.trim() ?? "";
    if (!(UPLOAD_CONTENT_TYPES as readonly string[]).includes(contentType)) {
      return c.json(
        {
          success: false,
          error: `Unsupported Content-Type '${contentType}'. Allowed: ${UPLOAD_CONTENT_TYPES.join(", ")}`,
        },
        415,
      );
    }

    const body = c.req.raw.body;
    if (!body) {
      return c.json({ success: false, error: "Missing request body" }, 400);
    }

    const fileId = crypto.randomUUID();
    const r2Key = `books/${params.bookId}/scans/${fileId}`;

    await c.env.BUCKET.put(r2Key, body, {
      httpMetadata: { contentType },
    });

    const now = Date.now();
    const pageNumber = query.page ?? null;
    await c.env.DB.prepare(
      `INSERT INTO files (file_id, book_id, r2_key, state, page_number, created_at, updated_at)
			 VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
    )
      .bind(fileId, params.bookId, r2Key, pageNumber, now, now)
      .run();

    // Trigger OCR off the request path.
    await c.env.OCR_Q.send({ fileId });

    return c.json(
      {
        success: true,
        file: {
          file_id: fileId,
          book_id: params.bookId,
          r2_key: r2Key,
          state: "queued",
          text_key: null,
          page_number: pageNumber,
          role: null,
          order_hint: null,
          created_at: now,
          updated_at: now,
        },
      },
      201,
    );
  }
}
