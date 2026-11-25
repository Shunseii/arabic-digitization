// The Opus review of one Message Batch, as a Cloudflare Workflow. The cron
// (review/cron.ts) starts an instance when pages are waiting; the instance:
//
//   select       claim up to 100 waiting pages, open the review_batches row
//   prepare-N    build their requests into R2, 25 pages per step
//   submit       create the batch and put its id on the row (stage
//                'processing'); a retry adopts a batch an earlier attempt
//                created instead of creating another
//   wait-N/check-N  sleep, then read the batch status (review/poll.ts: every
//                minute for the first hour, every 10 minutes to 3 hours, then
//                hourly), until the batch has ended (stage 'ingesting') or 26
//                hours have passed
//   results      copy the results JSONL into R2, unparsed
//   release      take the pages off the review queue
//   dispatch     one review_apply queue message per page (review/apply.ts)
//   finalize     stage 'applying' (or 'timed_out')
//
// Each step gets its own CPU budget, sleeps cost nothing, and anything that
// must outlive the instance (kept 3 days on the Free plan) is in D1 or R2.
// The row's stage is what GET /api/jobs shows; the instance status only says
// whether the instance is still alive.

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { Cause, Effect, Exit, type Layer } from "effect";
import { type AppServices, liveLayer } from "../effect/services";
import { retryTransient, type StepError, stepFailureKind } from "./failures";
import { pollUntilEnded, workflowSteps } from "./poll";
import {
  abandonForeignBatch,
  type BatchCheck,
  checkBatch,
  claimPages,
  dispatchApplies,
  endBatch,
  finalizeBatch,
  PREPARE_CHUNK_PAGES,
  preparePart,
  releaseClaims,
  storeResults,
  submitBatch,
} from "./steps";

// A retried submit first looks for the batch an earlier attempt may have
// created (steps.ts submitBatch), so retries don't submit the pages twice.
const SUBMIT_RETRIES = {
  retries: { limit: 4, delay: "1 minute", backoff: "exponential" },
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

// What a step throws for the Workflow: a retryable failure as a plain Error
// (the Workflow retries the step), a terminal one as NonRetryableError (the
// instance fails at once and its pages are released). A defect is a bug and
// is thrown as it is.
function toWorkflowError(failure: unknown): unknown {
  switch (stepFailureKind(failure)) {
    case "retryable":
      return new Error(describe(failure));
    case "terminal":
      return new NonRetryableError(
        describe(failure),
        (failure as StepError)._tag,
      );
    case "defect":
      return failure;
  }
}

// Run one step's program: transient failures are retried briefly in place,
// then whatever is left is classified for the Workflow.
async function runIn<A, E extends StepError>({
  layer,
  program,
}: {
  layer: Layer.Layer<AppServices>;
  program: Effect.Effect<A, E, AppServices>;
}): Promise<A> {
  const exit = await Effect.runPromiseExit(
    retryTransient({ effect: program }).pipe(Effect.provide(layer)),
  );
  if (Exit.isSuccess(exit)) return exit.value;
  throw toWorkflowError(Cause.squash(exit.cause));
}

const describe = (error: unknown) =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

export class ReviewWorkflow extends WorkflowEntrypoint<Env, ReviewParams> {
  async run(
    event: Readonly<WorkflowEvent<ReviewParams>>,
    step: WorkflowStep,
  ): Promise<ReviewSummary> {
    const layer = liveLayer(this.env);
    const instanceId = event.instanceId;
    const run = <A, E extends StepError>(
      program: Effect.Effect<A, E, AppServices>,
    ) => runIn({ layer, program });

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
        if (fileIds.length > 0) {
          await step.do("release", () =>
            run(
              releaseClaims({ instanceId, retry: false }).pipe(
                Effect.andThen(endBatch({ instanceId, stage: "empty" })),
              ),
            ),
          );
        }
        return { pages: 0, batchId: null, ended: false, dispatched: 0 };
      }

      const { batchId, submittedAt } = await step.do(
        "submit",
        SUBMIT_RETRIES,
        () => run(submitBatch({ instanceId, parts, pages })),
      );

      const { last: check, checks } = await pollUntilEnded<BatchCheck>({
        step: { sleep: (name, durationMs) => step.sleep(name, durationMs) },
        submittedAt,
        check: ({ index, previous }) =>
          step.do(`check-${index}`, () =>
            run(
              checkBatch({
                instanceId,
                batchId,
                previous: previous?.counts ?? null,
              }),
            ),
          ),
      });
      if (!check?.ended) {
        await step.do("release", () =>
          run(
            releaseClaims({ instanceId, retry: true }).pipe(
              Effect.andThen(
                finalizeBatch({
                  instanceId,
                  ended: false,
                  resultsKey: null,
                  checks,
                  steps: workflowSteps({ parts, checks, ended: false }),
                }),
              ),
            ),
          ),
        );
        return { pages, batchId, ended: false, dispatched: 0 };
      }

      const results = await step.do("results", () =>
        run(storeResults({ instanceId, batchId, parts })),
      );
      if (!results.own) {
        // A retried submit adopted a batch that isn't ours: apply nothing,
        // and give the pages back untouched (no try counted).
        await step.do("release", () => run(abandonForeignBatch(instanceId)));
        return { pages, batchId, ended: true, dispatched: 0 };
      }
      await step.do("release", () =>
        run(releaseClaims({ instanceId, retry: false })),
      );
      const dispatched = await step.do("dispatch", () =>
        run(dispatchApplies({ instanceId, batchId, parts })),
      );
      await step.do("finalize", () =>
        run(
          finalizeBatch({
            instanceId,
            ended: true,
            resultsKey: results.key,
            checks,
            steps: workflowSteps({ parts, checks, ended: true }),
          }),
        ),
      );
      return { pages, batchId, ended: true, dispatched };
    } catch (error) {
      // A step that ran out of retries: put the pages back so the next run
      // can claim them, mark the batch failed, then fail the instance so the
      // error is visible.
      await step.do("release-after-error", () =>
        run(
          releaseClaims({ instanceId, retry: true }).pipe(
            Effect.andThen(
              endBatch({ instanceId, stage: "failed", error: describe(error) }),
            ),
          ),
        ),
      );
      throw error;
    }
  }
}
