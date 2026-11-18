import {
  deleteIndex,
  LIVE_INDEX,
  STAGING_INDEX,
  swapIndexes,
} from "./lib/meili";
import { reindexBook } from "./lib/reindex";
import { OcrError, transcribe } from "./ocr";

// Message enqueued on upload; the consumer transcribes the file.
export interface OcrMessage {
  fileId: string;
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

export type QueueMessage = OcrMessage | ReindexMessage;

function isReindex(body: QueueMessage): body is ReindexMessage {
  return (body as ReindexMessage).kind === "reindex_chain";
}

// Process one book of a rebuild into the staging index, then either chain the
// next book or, on the last, swap staging over live and drop the old data.
async function handleReindexStep(
  msg: Message<ReindexMessage>,
  env: Env,
): Promise<void> {
  const { bookIds, cursor } = msg.body;
  const bookId = bookIds[cursor];
  if (bookId === undefined) {
    msg.ack();
    return;
  }
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
    console.error(`reindex step ${cursor}/${bookIds.length} failed: ${err}`);
    msg.retry({ delaySeconds: 30 });
  }
}

// Set a file back to 'queued' and drop it on the OCR queue. The single entry
// point for (re-)processing a file: upload, manual re-run, and bulk requeue all
// route through here, so every OCR goes through the throttled, auto-retrying
// consumer rather than a synchronous call that could storm the rate limit.
export async function enqueueOcr({
  env,
  fileId,
}: {
  env: Env;
  fileId: string;
}): Promise<void> {
  await env.DB.prepare(
    "UPDATE files SET state = 'queued', error = NULL, updated_at = ? WHERE file_id = ?",
  )
    .bind(Date.now(), fileId)
    .run();
  await env.OCR_Q.send({ fileId });
}

// Honor Gemini's suggested retryDelay as a floor, layered with exponential
// backoff on the redelivery count, jittered to desync sibling messages, capped.
function backoffSeconds(attempts: number, suggested: number | null): number {
  const expo = Math.min(2 ** attempts, 120);
  const base = Math.max(suggested ?? 0, expo);
  return Math.ceil(base + Math.random() * 5);
}

// Queue consumer: mark processing → transcribe (sets 'done') → ack.
//
// Transient Gemini errors (429 rate limit, 5xx) are not the page's fault: set
// 'rate_limited' and re-queue with backoff instead of burning the page. The
// message keeps coming back until it succeeds or Cloudflare exhausts max_retries
// (wrangler.jsonc). Genuine failures set 'failed' and stop — retrying a missing
// R2 object or an empty response won't help; re-run those manually via /ocr.
export async function handleOcrQueue(
  batch: MessageBatch<QueueMessage>,
  env: Env,
): Promise<void> {
  for (const msg of batch.messages) {
    // Full-rebuild steps share this queue; dispatch them separately.
    if (isReindex(msg.body)) {
      await handleReindexStep(msg as Message<ReindexMessage>, env);
      continue;
    }
    const { fileId } = msg.body;
    try {
      // Claim the file only if its book isn't paused and it's still waiting.
      // A paused book's message is dropped (the page stays 'queued'; resume
      // re-enqueues it). The state guard also drops duplicate messages, e.g.
      // one left over from before a pause/resume, so a page is never billed
      // twice. 'processing' is claimable on redelivery after a crashed run.
      const claim = await env.DB.prepare(
        `UPDATE files SET state = 'processing', updated_at = ?
          WHERE file_id = ?
            AND (state IN ('queued', 'rate_limited') OR (state = 'processing' AND ? > 1))
            AND (SELECT paused FROM books WHERE id = files.book_id) = 0`,
      )
        .bind(Date.now(), fileId, msg.attempts)
        .run();
      if (claim.meta.changes === 0) {
        msg.ack();
        continue;
      }
      await transcribe({ env, fileId });
      msg.ack();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (err instanceof OcrError && err.isTransient) {
        await env.DB.prepare(
          "UPDATE files SET state = 'rate_limited', error = ?, updated_at = ? WHERE file_id = ?",
        )
          .bind(message.slice(0, 500), Date.now(), fileId)
          .run();
        msg.retry({
          delaySeconds: backoffSeconds(msg.attempts, err.retryAfterSeconds),
        });
        continue;
      }

      await env.DB.prepare(
        "UPDATE files SET state = 'failed', error = ?, updated_at = ? WHERE file_id = ?",
      )
        .bind(message, Date.now(), fileId)
        .run();
      msg.ack();
    }
  }
}
