import { Effect, Schema } from "effect";
import { HttpApiEndpoint, OpenApi } from "effect/http-api";
import { EvlogLogger } from "evlog/effect";
import { type EndpointHandler, WorkerContext } from "../http/context";
import { respond } from "../http/respond";
import {
  RECOMPUTE_DEFAULT_LIMIT,
  RECOMPUTE_MAX_LIMIT,
  recomputeRunMetrics,
} from "../lib/ocrRuns";
import { runInRequest } from "../logging";

// Backfill for the OCR run metrics cache: recompute one page of runs whose
// metrics predate METRICS_VERSION (lib/metrics.ts), reading each run's text
// from R2. Call repeatedly, passing next_after back as `after`, until
// next_after is null. Paged so each call stays inside the per-invocation
// subrequest and CPU limits.
export const OcrRunsRecomputeMetrics = HttpApiEndpoint.post(
  "ocrRunsRecomputeMetrics",
  "/api/admin/ocr-runs/recompute-metrics",
  {
    // The body is optional (empty or null): defaults apply.
    payload: [
      Schema.Struct({
        after: Schema.optionalKey(
          Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
            description: "Continue after this run id (next_after)",
          }),
        ),
        limit: Schema.optionalKey(
          Schema.Int.check(
            Schema.isGreaterThanOrEqualTo(1),
            Schema.isLessThanOrEqualTo(RECOMPUTE_MAX_LIMIT),
          ).annotate({
            description: `Runs per call (default ${RECOMPUTE_DEFAULT_LIMIT}, max ${RECOMPUTE_MAX_LIMIT}); lower it if a call fails with error 1102`,
          }),
        ),
      }),
      Schema.Null,
    ],
    success: Schema.Struct({
      success: Schema.Literal(true),
      metrics_version: Schema.Int,
      updated: Schema.Int,
      missing: Schema.Int,
      next_after: Schema.NullOr(Schema.Int),
    }),
  },
).annotate(
  OpenApi.Summary,
  "Recompute OCR run metrics older than the current version (paged)",
);

export const ocrRunsRecomputeMetrics: EndpointHandler<
  typeof OcrRunsRecomputeMetrics,
  WorkerContext | EvlogLogger
> = ({ payload }) =>
  Effect.gen(function* () {
    const { env } = yield* WorkerContext;
    const log = yield* EvlogLogger;
    const result = yield* runInRequest({
      env,
      effect: recomputeRunMetrics({
        after: payload?.after ?? 0,
        limit: payload?.limit ?? RECOMPUTE_DEFAULT_LIMIT,
      }),
    });
    log.set({ recompute: result });
    return respond({
      endpoint: OcrRunsRecomputeMetrics,
      body: { success: true as const, ...result },
    });
  });
