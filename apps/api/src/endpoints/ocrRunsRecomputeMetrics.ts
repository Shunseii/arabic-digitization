import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import {
  RECOMPUTE_DEFAULT_LIMIT,
  RECOMPUTE_MAX_LIMIT,
  recomputeRunMetrics,
} from "../lib/ocrRuns";
import { runInRequest } from "../logging";
import type { AppContext } from "../types";

// Backfill for the OCR run metrics cache: recompute one page of runs whose
// metrics predate METRICS_VERSION (lib/metrics.ts), reading each run's text
// from R2. Call repeatedly, passing next_after back as `after`, until
// next_after is null. Paged so each call stays inside the per-invocation
// subrequest and CPU limits.
export class OcrRunsRecomputeMetrics extends OpenAPIRoute {
  schema = {
    tags: ["Admin"],
    summary: "Recompute OCR run metrics older than the current version (paged)",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z
              .object({
                after: z
                  .number()
                  .int()
                  .min(0)
                  .optional()
                  .describe("Continue after this run id (next_after)"),
                limit: z
                  .number()
                  .int()
                  .min(1)
                  .max(RECOMPUTE_MAX_LIMIT)
                  .optional()
                  .describe(
                    `Runs per call (default ${RECOMPUTE_DEFAULT_LIMIT}, max ${RECOMPUTE_MAX_LIMIT}); lower it if a call fails with error 1102`,
                  ),
              })
              .optional(),
          },
        },
      },
    },
    responses: {
      "200": {
        description: "One page recomputed",
        content: {
          "application/json": {
            schema: z.object({
              success: z.literal(true),
              metrics_version: z.number().int(),
              updated: z.number().int(),
              missing: z.number().int(),
              next_after: z.number().int().nullable(),
            }),
          },
        },
      },
    },
  };

  async handle(c: AppContext) {
    const { body } = await this.getValidatedData<typeof this.schema>();
    const result = await runInRequest({
      c,
      effect: recomputeRunMetrics({
        after: body?.after ?? 0,
        limit: body?.limit ?? RECOMPUTE_DEFAULT_LIMIT,
      }),
    });
    c.get("log").set({ recompute: result });
    return c.json({ success: true, ...result });
  }
}
