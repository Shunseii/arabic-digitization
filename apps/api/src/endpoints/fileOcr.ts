import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { transcribe } from "../ocr";
import type { AppContext } from "../types";

// Manual OCR trigger — runs transcription synchronously and returns the result.
// Model is fixed (the default in ocr.ts); not overridable per request.
// The queue consumer will call the same transcribe() function.
export class FileOcr extends OpenAPIRoute {
  schema = {
    tags: ["Files"],
    summary: "Run OCR on a file now (manual)",
    request: {
      params: z.object({ bookId: z.string(), fileId: z.string() }),
    },
    responses: {
      "200": {
        description: "Transcription result",
        content: {
          "application/json": {
            schema: z.object({
              success: z.boolean(),
              file_id: z.string(),
              model: z.string(),
              text: z.string(),
              text_key: z.string(),
              usage: z.unknown(),
            }),
          },
        },
      },
      "404": { description: "No such file" },
      "502": { description: "OCR / model call failed" },
    },
  };

  async handle(c: AppContext) {
    const { params } = await this.getValidatedData<typeof this.schema>();

    try {
      const result = await transcribe({ env: c.env, fileId: params.fileId });
      return c.json({ success: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = /not found|missing/i.test(message) ? 404 : 502;
      return c.json({ success: false, error: message }, status);
    }
  }
}
