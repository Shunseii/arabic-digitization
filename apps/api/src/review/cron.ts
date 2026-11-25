import { Effect } from "effect";
import { liveLayer } from "../effect/services";
import { countPending } from "./steps";
import { sweepStuckBatches } from "./sweep";
import type { ReviewParams } from "./workflow";

// Cron trigger (wrangler.jsonc): free the pages of batches whose instance
// died (review/sweep.ts), then start one review Workflow instance when pages
// are waiting. The instance claims its pages itself; one per run bounds the
// spend to one batch (100 pages) every 3 hours. The id comes from the
// scheduled time, so a retried cron run can't start a second instance.
export async function startReviewIfPending({
  controller,
  env,
}: {
  controller: ScheduledController;
  env: Env;
}): Promise<void> {
  const layer = liveLayer(env);
  const swept = await Effect.runPromise(
    sweepStuckBatches().pipe(Effect.provide(layer)),
  );
  if (swept.failed.length > 0) {
    console.log(JSON.stringify({ kind: "review_sweep", ...swept }));
  }
  const pending = await Effect.runPromise(
    countPending().pipe(Effect.provide(layer)),
  );
  if (pending === 0) return;
  const params: ReviewParams = { reason: "cron" };
  await env.REVIEW_WORKFLOW.create({
    id: `review-${controller.scheduledTime}`,
    params,
  });
  console.log(JSON.stringify({ kind: "review_cron", pending, started: true }));
}
