import { transcribe } from "./ocr";

// Message enqueued on upload; the consumer transcribes the file.
export interface OcrMessage {
  fileId: string;
}

// Queue consumer: mark processing → transcribe (sets 'done') → ack.
// On failure, record the error, set 'failed', and retry (up to max_retries in
// wrangler.jsonc; exhausted retries leave the file 'failed' for manual re-run).
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
      await env.DB.prepare(
        "UPDATE files SET state = 'failed', error = ?, updated_at = ? WHERE file_id = ?",
      )
        .bind(message, Date.now(), fileId)
        .run();
      msg.retry();
    }
  }
}
