// The dead-letter queue's consumer: records each OCR-queue message that ran
// out of retries in failed_messages (migration 0013), for GET /api/jobs.
//
// Queues hands a dead message over with its body only, not the error that
// killed it, so the last error comes from where the main consumer already
// keeps it: files.error for an OCR page, and a short-lived note
// (FailureNotes, written only on a message's last tries) for a review apply.
// Reindex steps log their errors only.

import { Effect } from "effect";
import type { StorageError } from "./effect/errors";
import {
  Database,
  FailureNotes,
  type Statement,
  statement,
  WallClock,
} from "./effect/services";
import type { QueueMessage } from "./queue";
import { isReviewApply } from "./review/message";

export type FailedKind = "ocr" | "review_apply" | "reindex";

// Where the main consumer leaves a review apply's last error.
export const reviewFailureNoteKey = ({
  fileId,
  batchId,
}: {
  fileId: string;
  batchId: string;
}) => `dlq-error:review_apply:${fileId}:${batchId}`;

// The queue's max_retries (wrangler.jsonc). A message on its last tries
// leaves a note of its error for the DLQ consumer.
export const OCR_QUEUE_MAX_RETRIES = 10;

const ERROR_MAX = 500;

// Insert, or update the page's row: a duplicate delivery keeps the counts
// (attempts is the message's, not a sum), and a page that dies again after
// it was resolved opens a new failure.
const UPSERT = `
  ON CONFLICT (kind, file_id) DO UPDATE SET
    book_id = excluded.book_id,
    ref = excluded.ref,
    last_error = COALESCE(excluded.last_error, failed_messages.last_error),
    attempts = MAX(failed_messages.attempts, excluded.attempts),
    first_failed_at = CASE WHEN failed_messages.resolved_at IS NULL
                           THEN failed_messages.first_failed_at
                           ELSE excluded.first_failed_at END,
    last_failed_at = excluded.last_failed_at,
    resolved_at = NULL`;

export interface DeadMessage {
  body: QueueMessage;
  // Deliveries on the dead-letter queue (the original's aren't passed on).
  attempts: number;
}

function recordStatement({
  message,
  at,
}: {
  message: DeadMessage;
  at: number;
}): Effect.Effect<Statement | null, never, FailureNotes> {
  return Effect.gen(function* () {
    const { body } = message;
    const attempts = OCR_QUEUE_MAX_RETRIES + 1;
    if (isReviewApply(body)) {
      const notes = yield* FailureNotes;
      const note = yield* notes.get(
        reviewFailureNoteKey({ fileId: body.fileId, batchId: body.batchId }),
      );
      return statement(
        `INSERT INTO failed_messages (kind, file_id, book_id, ref, last_error, attempts, first_failed_at, last_failed_at)
         VALUES ('review_apply', ?, ?, ?, ?, ?, ?, ?) ${UPSERT}`,
        [
          body.fileId,
          body.bookId,
          body.batchId,
          note?.slice(0, ERROR_MAX) ?? null,
          attempts,
          at,
          at,
        ],
      );
    }
    if ("kind" in body && body.kind === "reindex_chain") {
      return statement(
        `INSERT INTO failed_messages (kind, file_id, book_id, ref, last_error, attempts, first_failed_at, last_failed_at)
         VALUES ('reindex', '', ?, ?, NULL, ?, ?, ?) ${UPSERT}`,
        [
          body.bookIds[body.cursor] ?? null,
          body.bookIds[body.cursor] ?? null,
          attempts,
          at,
          at,
        ],
      );
    }
    if ("fileId" in body) {
      // The page's own last error and book, read in the same statement; a
      // page deleted since then records nothing.
      return statement(
        `INSERT INTO failed_messages (kind, file_id, book_id, ref, last_error, attempts, first_failed_at, last_failed_at)
         SELECT 'ocr', f.file_id, f.book_id, NULL, substr(f.error, 1, ?), ?, ?, ?
           FROM files f WHERE f.file_id = ? ${UPSERT}`,
        [ERROR_MAX, attempts, at, at, body.fileId],
      );
    }
    return null;
  });
}

// Record a batch of dead messages in one D1 round trip. Fails (typed) only if
// D1 does; the caller then retries the batch, a bounded number of times.
export function recordDeadMessages(
  messages: readonly DeadMessage[],
): Effect.Effect<number, StorageError, Database | FailureNotes | WallClock> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const clock = yield* WallClock;
    const at = clock.now();
    const statements: Statement[] = [];
    for (const message of messages) {
      const recorded = yield* recordStatement({ message, at });
      if (recorded) statements.push(recorded);
    }
    yield* db.batch(statements);
    return statements.length;
  });
}

// Marks a page's open failure of this kind resolved, in a write that already
// happens when the page succeeds. A primary-key lookup: no row written unless
// one matches.
export function resolveFailure({
  kind,
  fileId,
  at,
}: {
  kind: FailedKind;
  fileId: string;
  at: number;
}): Statement {
  return statement(
    "UPDATE failed_messages SET resolved_at = ? WHERE kind = ? AND file_id = ? AND resolved_at IS NULL",
    [at, kind, fileId],
  );
}
