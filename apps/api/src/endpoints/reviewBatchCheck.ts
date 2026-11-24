import { Effect, Schema } from "effect";
import { HttpApiEndpoint, HttpApiSchema, OpenApi } from "effect/http-api";
import { type EndpointHandler, WorkerContext } from "../http/context";
import {
  Conflict,
  conflict,
  NotFound,
  notFound,
  TooManyRequests,
} from "../http/errors";
import { respond } from "../http/respond";
import {
  CHECK_NOW_EVENT,
  MAX_NUDGED_WAKES,
  MIN_CHECK_GAP_MS,
} from "../review/poll";

// "Check now" for a submitted review batch: wakes the Workflow's current
// wait so it checks the batch status early (review/poll.ts). Reads one row
// and sends one event; never calls Anthropic and writes nothing. The
// Workflow stores the result on the row as usual (GET /api/jobs).
export const ReviewBatchCheck = HttpApiEndpoint.post(
  "reviewBatchCheck",
  "/api/reviews/batches/:instanceId/check",
  {
    params: { instanceId: Schema.String },
    success: Schema.Struct({
      success: Schema.Boolean,
      instance_id: Schema.String,
      batch_id: Schema.NullOr(Schema.String),
    }).pipe(HttpApiSchema.status(202)),
    error: [NotFound, Conflict, TooManyRequests],
  },
).annotate(OpenApi.Summary, "Ask a review batch's Workflow to check it now");

export const reviewBatchCheck: EndpointHandler<typeof ReviewBatchCheck> = ({
  params,
}) =>
  Effect.gen(function* () {
    const { env } = yield* WorkerContext;
    const row = yield* Effect.promise(() =>
      env.DB.prepare(
        "SELECT batch_id, stage, last_checked_at, nudged_checks FROM review_batches WHERE instance_id = ?",
      )
        .bind(params.instanceId)
        .first<{
          batch_id: string | null;
          stage: string;
          last_checked_at: number | null;
          nudged_checks: number;
        }>(),
    );
    if (!row) {
      return yield* notFound(`Review batch '${params.instanceId}' not found`);
    }
    if (row.stage !== "processing") {
      return yield* conflict(
        `The batch is '${row.stage}'; only a batch waiting on Anthropic ('processing') can be checked`,
      );
    }
    const sinceCheck =
      row.last_checked_at === null ? null : Date.now() - row.last_checked_at;
    if (sinceCheck !== null && sinceCheck < MIN_CHECK_GAP_MS) {
      return yield* new TooManyRequests({
        success: false,
        error: "Checked less than a minute ago",
        retry_after_seconds: Math.ceil((MIN_CHECK_GAP_MS - sinceCheck) / 1000),
      });
    }
    if (row.nudged_checks >= MAX_NUDGED_WAKES) {
      return yield* new TooManyRequests({
        success: false,
        error: `This batch has had ${MAX_NUDGED_WAKES} early checks; it is checked on schedule from now on`,
        retry_after_seconds: null,
      });
    }
    const sent = yield* Effect.tryPromise(async () => {
      const instance = await env.REVIEW_WORKFLOW.get(params.instanceId);
      await instance.sendEvent({ type: CHECK_NOW_EVENT, payload: null });
    }).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    );
    if (!sent) {
      return yield* conflict(
        "The batch's Workflow instance isn't running (it may have failed); GET /api/jobs shows its state",
      );
    }
    return respond({
      endpoint: ReviewBatchCheck,
      status: 202,
      body: {
        success: true,
        instance_id: params.instanceId,
        batch_id: row.batch_id,
      },
    });
  });
