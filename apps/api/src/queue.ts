import { GeminiError, transcribe } from "./ocr";

// Message enqueued on upload; the consumer transcribes the file.
export interface OcrMessage {
  fileId: string;
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
  batch: MessageBatch<OcrMessage>,
  env: Env,
): Promise<void> {
  for (const msg of batch.messages) {
    const { fileId } = msg.body;
    try {
      await env.DB.prepare(
        "UPDATE files SET state = 'processing', updated_at = ? WHERE file_id = ?",
      )
        .bind(Date.now(), fileId)
        .run();
      await transcribe({ env, fileId });
      msg.ack();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (err instanceof GeminiError && err.isTransient) {
        await env.DB.prepare(
          "UPDATE files SET state = 'rate_limited', error = ?, updated_at = ? WHERE file_id = ?",
        )
          .bind(message.slice(0, 500), Date.now(), fileId)
          .run();
        msg.retry({ delaySeconds: backoffSeconds(msg.attempts, err.retryAfterSeconds) });
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
