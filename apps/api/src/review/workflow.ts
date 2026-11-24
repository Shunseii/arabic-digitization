// The Opus review of one Message Batch, as a Cloudflare Workflow. The cron
// (review/cron.ts) starts an instance when pages are waiting; the instance:
//
//   select       claim up to 100 waiting pages
//   prepare-N    build their requests into R2, 25 pages per step
//   submit       create the batch (returns only its id)
//   record       write the review_batches row
//   wait-N/check-N  sleep, then read the batch status, until it has ended
//   results      copy the results JSONL into R2, unparsed
//   release      take the pages off the review queue
//   dispatch     one review_apply queue message per page (review/apply.ts)
//   finalize     write the batch summary
//
// Each step gets its own CPU budget, sleeps cost nothing, and anything that
// must outlive the instance (kept 3 days on the Free plan) is in D1 or R2.

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { Effect, type Layer } from "effect";
import { type AppServices, liveLayer } from "../effect/services";
import {
  type BatchCheck,
  checkBatch,
  claimPages,
  dispatchApplies,
  finalizeBatch,
  PREPARE_CHUNK_PAGES,
  preparePart,
  recordBatch,
  releaseClaims,
  storeResults,
  submitBatch,
} from "./steps";

// 4 checks 30 minutes apart, then hourly: 28 checks over 26 hours. A batch
// ends within 24 hours (unfinished requests expire), so the last checks are
// a margin, not the normal path.
export const POLL_SCHEDULE = [
  ...Array.from({ length: 4 }, () => "30 minutes" as const),
  ...Array.from({ length: 24 }, () => "1 hour" as const),
];

// Creating a batch spends money, so a failed create is retried only a little:
// a create that succeeded but whose step failed afterwards would be repeated.
const SUBMIT_RETRIES = {
  retries: { limit: 2, delay: "1 minute", backoff: "exponential" },
} as const;

export interface ReviewParams {
  // Why the instance was started (logged only).
  reason: "cron" | "manual";
}

export interface ReviewSummary {
  pages: number;
  batchId: string | null;
  ended: boolean;
  dispatched: number;
}

function runIn<A, E>({
  layer,
  program,
}: {
  layer: Layer.Layer<AppServices>;
  program: Effect.Effect<A, E, AppServices>;
}): Promise<A> {
  return Effect.runPromise(program.pipe(Effect.provide(layer)));
}

export class ReviewWorkflow extends WorkflowEntrypoint<Env, ReviewParams> {
  async run(
    event: Readonly<WorkflowEvent<ReviewParams>>,
    step: WorkflowStep,
  ): Promise<ReviewSummary> {
    const layer = liveLayer(this.env);
    const instanceId = event.instanceId;
    const run = <A, E>(program: Effect.Effect<A, E, AppServices>) =>
      runIn({ layer, program });

    try {
      const fileIds = await step.do("select", () =>
        run(claimPages(instanceId)),
      );
      let pages = 0;
      const parts = Math.ceil(fileIds.length / PREPARE_CHUNK_PAGES);
      for (let index = 0; index < parts; index++) {
        const chunk = fileIds.slice(
          index * PREPARE_CHUNK_PAGES,
          (index + 1) * PREPARE_CHUNK_PAGES,
        );
        const prepared = await step.do(`prepare-${index}`, () =>
          run(preparePart({ instanceId, index, fileIds: chunk })),
        );
        pages += prepared.pages;
      }
      if (pages === 0) {
        await step.do("release", () =>
          run(releaseClaims({ instanceId, retry: false })),
        );
        return { pages: 0, batchId: null, ended: false, dispatched: 0 };
      }

      const batchId = await step.do("submit", SUBMIT_RETRIES, () =>
        run(submitBatch({ instanceId, parts })),
      );
      await step.do("record", () =>
        run(recordBatch({ batchId, instanceId, pages })),
      );

      let check: BatchCheck | null = null;
      for (const [index, wait] of POLL_SCHEDULE.entries()) {
        await step.sleep(`wait-${index}`, wait);
        check = await step.do(`check-${index}`, () => run(checkBatch(batchId)));
        if (check.ended) break;
      }
      if (!check?.ended) {
        await step.do("release", () =>
          run(releaseClaims({ instanceId, retry: true })),
        );
        if (check) {
          const lastCheck = check;
          await step.do("finalize", () =>
            run(finalizeBatch({ batchId, check: lastCheck, resultsKey: null })),
          );
        }
        return { pages, batchId, ended: false, dispatched: 0 };
      }
      const ended = check;

      const results = await step.do("results", () =>
        run(storeResults({ instanceId, batchId })),
      );
      await step.do("release", () =>
        run(releaseClaims({ instanceId, retry: false })),
      );
      const dispatched = await step.do("dispatch", () =>
        run(dispatchApplies({ instanceId, batchId, parts })),
      );
      await step.do("finalize", () =>
        run(finalizeBatch({ batchId, check: ended, resultsKey: results.key })),
      );
      return { pages, batchId, ended: true, dispatched };
    } catch (error) {
      // A step that ran out of retries: put the pages back so the next run
      // can claim them, then fail the instance so the error is visible.
      await step.do("release-after-error", () =>
        run(releaseClaims({ instanceId, retry: true })),
      );
      throw error;
    }
  }
}
