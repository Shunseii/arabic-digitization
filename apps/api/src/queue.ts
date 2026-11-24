import { Cause, Effect } from "effect";
import type { AuditableLogger } from "evlog";
import { useLogger, withLogger } from "evlog/effect";
import { isTransient, retryAfterSeconds, StorageError } from "./effect/errors";
import {
  type AppServices,
  Database,
  liveLayer,
  statement,
} from "./effect/services";
import {
  deleteIndex,
  LIVE_INDEX,
  STAGING_INDEX,
  swapIndexes,
} from "./lib/meili";
import { OCR_TRIGGERS, type OcrTrigger } from "./lib/ocrRuns";
import { reindexBook } from "./lib/reindex";
import { effectLogger, toEvlogError } from "./logging";
import { transcribe } from "./ocr";
import { applyReview } from "./review/apply";
import { isReviewApply, type ReviewApplyMessage } from "./review/message";

// Message enqueued for OCR; the consumer transcribes the file. `trigger` says
// why it was enqueued (recorded on the run); messages queued before it existed
// have none.
export interface OcrMessage {
  fileId: string;
  trigger?: OcrTrigger;
}

// A step in a full search rebuild. Each message reindexes one book into the
// staging index, then chains the next; the final step atomically swaps staging
// into the live index. Sequential + one book per message keeps every invocation
// under the Worker's CPU/subrequest/memory limits, and the live index is only
// ever replaced by an atomic swap — never cleared mid-rebuild.
export interface ReindexMessage {
  kind: "reindex_chain";
  bookIds: string[];
  cursor: number;
}

export type QueueMessage = OcrMessage | ReindexMessage | ReviewApplyMessage;

function isReindex(body: QueueMessage): body is ReindexMessage {
  return (body as ReindexMessage).kind === "reindex_chain";
}

// Bulk requeue: re-running a failed or rate-limited page is a retry;
// re-running any other state (e.g. done, to apply new instructions) is a
// requeue.
export function requeueTrigger(state: string): OcrTrigger {
  return state === "failed" || state === "rate_limited" ? "retry" : "requeue";
}

function triggerOf(body: OcrMessage): OcrTrigger | null {
  return OCR_TRIGGERS.find((t) => t === body.trigger) ?? null;
}

// Process one book of a rebuild into the staging index, then either chain the
// next book or, on the last, swap staging over live and drop the old data.
async function handleReindexStep({
  msg,
  env,
  log,
}: {
  msg: Message<ReindexMessage>;
  env: Env;
  log: AuditableLogger;
}): Promise<void> {
  const { bookIds, cursor } = msg.body;
  const bookId = bookIds[cursor];
  if (bookId === undefined) {
    msg.ack();
    return;
  }
  log.set({ book_id: bookId, reindex: { cursor, books: bookIds.length } });
  try {
    await reindexBook({ env, bookId, index: STAGING_INDEX });
    if (cursor + 1 < bookIds.length) {
      await env.OCR_Q.send({
        kind: "reindex_chain",
        bookIds,
        cursor: cursor + 1,
      });
    } else {
      // All books built into staging → flip it live in one atomic step, then
      // delete the now-stale index (which holds the previous live data).
      await swapIndexes({ env, a: LIVE_INDEX, b: STAGING_INDEX });
      await deleteIndex({ env, index: STAGING_INDEX });
    }
    msg.ack();
  } catch (err) {
    // Retry this same book (reindexBook is idempotent per book). A persistent
    // failure just stalls the chain with no swap — the live index is untouched.
    log.error(err instanceof Error ? err : String(err));
    msg.retry({ delaySeconds: 30 });
  }
}

// Set a file back to 'queued' and drop it on the OCR queue. The single entry
// point for re-processing one file; upload and the bulk requeue/resume send
// their own messages, and every OCR goes through the throttled, auto-retrying
// consumer rather than a synchronous call that could storm the rate limit.
export async function enqueueOcr({
  env,
  fileId,
  trigger,
}: {
  env: Env;
  fileId: string;
  trigger: OcrTrigger;
}): Promise<void> {
  await env.DB.prepare(
    "UPDATE files SET state = 'queued', error = NULL, updated_at = ? WHERE file_id = ?",
  )
    .bind(Date.now(), fileId)
    .run();
  await env.OCR_Q.send({ fileId, trigger } satisfies OcrMessage);
}

// Honor the provider's retry-after hint as a floor, layered with exponential
// backoff on the redelivery count, jittered to desync sibling messages, capped.
export function backoffSeconds(
  attempts: number,
  suggested: number | null,
): number {
  const expo = Math.min(2 ** attempts, 120);
  const base = Math.max(suggested ?? 0, expo);
  return Math.ceil(base + Math.random() * 5);
}

// The parts of a queue message the OCR consumer uses (a fake in tests).
export interface OcrDelivery {
  body: OcrMessage;
  attempts: number;
  ack(): void;
  retry(options: { delaySeconds: number }): void;
}

// One OCR message: claim the file → transcribe (records the run) → ack, or
// retry with backoff when the run ended on a transient error.
//
// Transient provider errors (429, 5xx, network failure or timeout, after the
// fallback provider failed too) are not the page's fault: the run leaves the
// page 'rate_limited' and the message keeps coming back until it succeeds or
// Cloudflare exhausts max_retries (wrangler.jsonc). Genuine failures leave it
// 'failed' and stop — retrying a missing R2 object or an empty response won't
// help; re-run those manually via /ocr.
export function processOcrMessage(
  msg: OcrDelivery,
): Effect.Effect<void, never, AppServices> {
  const { fileId } = msg.body;
  return Effect.gen(function* () {
    const db = yield* Database;
    const log = yield* useLogger();

    // Claim the file only if its book isn't paused and it's still waiting.
    // A paused book's message is dropped (the page stays 'queued'; resume
    // re-enqueues it). The state guard also drops duplicate messages, e.g.
    // one left over from before a pause/resume, so a page is never billed
    // twice. 'processing' is claimable on redelivery after a crashed run.
    const claim = yield* db.run(
      statement(
        `UPDATE files SET state = 'processing', updated_at = ?
          WHERE file_id = ?
            AND (state IN ('queued', 'rate_limited') OR (state = 'processing' AND ? > 1))
            AND (SELECT paused FROM books WHERE id = files.book_id) = 0`,
        [Date.now(), fileId, msg.attempts],
      ),
    );
    if (claim.changes === 0) {
      log.set({ ocr: { status: "skipped" } });
      msg.ack();
      return;
    }

    const outcome = yield* transcribe({
      fileId,
      trigger: triggerOf(msg.body),
      deliveryAttempt: msg.attempts,
    });
    const { error } = outcome;
    if (!error) {
      msg.ack();
      return;
    }
    log.set({ error_type: error._tag });
    if (isTransient(error)) {
      log.warn(error.message.slice(0, 300));
      msg.retry({
        delaySeconds: backoffSeconds(msg.attempts, retryAfterSeconds(error)),
      });
      return;
    }
    log.error(toEvlogError(error));
    msg.ack();
  }).pipe(
    // D1/R2 couldn't record the run, or a bug: fail the page, as before. If
    // D1 can't even record that, retry the message rather than drop it, so
    // the page isn't left 'processing' with no message to finish it.
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        const db = yield* Database;
        const log = yield* useLogger();
        const error = Cause.squash(cause);
        const message = error instanceof Error ? error.message : String(error);
        log.error(
          error instanceof StorageError
            ? toEvlogError(error)
            : error instanceof Error
              ? error
              : message,
        );
        const markedFailed = yield* db
          .run(
            statement(
              "UPDATE files SET state = 'failed', error = ?, updated_at = ? WHERE file_id = ?",
              [message, Date.now(), fileId],
            ),
          )
          .pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          );
        if (markedFailed) {
          msg.ack();
        } else {
          msg.retry({ delaySeconds: backoffSeconds(msg.attempts, null) });
        }
      }),
    ),
    withLogger("ocr", {
      fields: {
        kind: "ocr",
        file_id: fileId,
        attempt: msg.attempts,
        trigger: triggerOf(msg.body),
      },
    }),
  );
}

// The parts of a queue message the review consumer uses (a fake in tests).
export interface ReviewDelivery {
  body: ReviewApplyMessage;
  attempts: number;
  ack(): void;
  retry(options: { delaySeconds: number }): void;
}

// Apply one page's Opus review (review/apply.ts). It writes its own record,
// so the only failure left is D1/R2 being unreachable: retry with backoff.
export function processReviewMessage(
  msg: ReviewDelivery,
): Effect.Effect<void, never, AppServices> {
  const { body } = msg;
  return Effect.gen(function* () {
    const log = yield* useLogger();
    const status = yield* applyReview(body);
    log.set({ review: { status } });
    msg.ack();
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        const log = yield* useLogger();
        const error = Cause.squash(cause);
        log.error(
          error instanceof StorageError
            ? toEvlogError(error)
            : error instanceof Error
              ? error
              : String(error),
        );
        msg.retry({ delaySeconds: backoffSeconds(msg.attempts, null) });
      }),
    ),
    withLogger("review", {
      fields: {
        kind: "review_apply",
        file_id: body.fileId,
        book_id: body.bookId,
        batch_id: body.batchId,
        attempt: msg.attempts,
      },
    }),
  );
}

// Queue consumer. Each message is its own unit of work with its own wide
// event (evlog/effect withLogger): the queue gives no Request to hang a
// logger on, so withLogger creates the event, provides it to the Effect
// program as EvlogLogger, and emits it when the message's program ends.
export async function handleOcrQueue(
  batch: MessageBatch<QueueMessage>,
  env: Env,
): Promise<void> {
  const services = liveLayer(env);
  for (const msg of batch.messages) {
    // Full-rebuild steps and review applies share this queue; dispatch them
    // separately.
    const body = msg.body;
    const program = isReviewApply(body)
      ? processReviewMessage({
          body,
          attempts: msg.attempts,
          ack: () => msg.ack(),
          retry: (options) => msg.retry(options),
        })
      : isReindex(body)
        ? Effect.gen(function* () {
            const log = yield* useLogger();
            yield* Effect.promise(() =>
              handleReindexStep({
                msg: msg as Message<ReindexMessage>,
                env,
                log,
              }),
            );
          }).pipe(
            withLogger("reindex", {
              fields: { kind: "reindex_chain", attempt: msg.attempts },
            }),
          )
        : processOcrMessage(msg as Message<OcrMessage>);
    await Effect.runPromise(
      program.pipe(Effect.provide(services), Effect.provide(effectLogger)),
    );
  }
}
