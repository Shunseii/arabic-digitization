import { Effect } from "effect";
import { liveLayer } from "../effect/services";
import { countPending } from "./steps";
import type { ReviewParams } from "./workflow";

// Cron trigger (wrangler.jsonc): start one review Workflow instance when pages
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
  const pending = await Effect.runPromise(
    countPending().pipe(Effect.provide(liveLayer(env))),
  );
  if (pending === 0) return;
  const params: ReviewParams = { reason: "cron" };
  await env.REVIEW_WORKFLOW.create({
    id: `review-${controller.scheduledTime}`,
    params,
  });
  console.log(JSON.stringify({ kind: "review_cron", pending, started: true }));
}
