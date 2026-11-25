// The work inside each step of the review Workflow (review/workflow.ts), as
// Effect programs over the app's services so tests can run them on fakes.
//
// Each step makes one or two service calls and returns only ids, keys and
// counts. Every step is safe to retry: claims are by instance id, R2 objects
// are written under fixed keys, and the queue consumer ignores a page it has
// already recorded.

import { Effect } from "effect";
import type { StorageError } from "../effect/errors";
import {
  AnthropicBatches,
  type BatchCounts,
  Bucket,
  Database,
  ReviewQueue,
  ScanLinks,
  statement,
  type TransportError,
  WallClock,
} from "../effect/services";
import { REVIEW_MODEL } from "../lib/cost";
import { sha256Hex } from "../lib/ocrRuns";
import {
  DEFAULT_REVIEW_EFFORT,
  isValidCustomId,
  REVIEW_EFFORTS,
  type ReviewApplyMessage,
  type ReviewEffort,
  reviewCustomId,
} from "./message";
import { reviewRequestParams } from "./prompt";

// Pages per batch. Keeps a batch's results (a few KB per page) small enough
// to index in one step, and bounds what one batch can spend (~$6 at medium
// effort on older OCR text).
export const REVIEW_BATCH_PAGES = 100;
// Pages read, signed and serialized per prepare step, to stay well inside the
// Free plan's 10 ms CPU per step.
export const PREPARE_CHUNK_PAGES = 25;
// The scan link must outlive the batch: Anthropic fetches the image when it
// processes the request, up to 24 hours after submission.
export const REVIEW_SCAN_LINK_TTL_SECONDS = 48 * 60 * 60;

export const reviewKeys = (instanceId: string) => {
  const base = `reviews/${instanceId}`;
  return {
    part: (index: number) => `${base}/requests-${index}.json`,
    manifest: (index: number) => `${base}/manifest-${index}.json`,
    results: `${base}/results.jsonl`,
  };
};

// ---- select ------------------------------------------------------------------

// Claim up to REVIEW_BATCH_PAGES waiting pages for this instance and open its
// review_batches row (stage 'preparing'). A retry returns the pages the first
// attempt claimed instead of claiming more.
export function claimPages(
  instanceId: string,
): Effect.Effect<string[], StorageError, Database | WallClock> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const clock = yield* WallClock;
    const claimed = statement(
      "SELECT file_id FROM review_queue WHERE instance_id = ? ORDER BY queued_at, file_id",
      [instanceId],
    );
    let fileIds = (yield* db.all<{ file_id: string }>(claimed)).map(
      (r) => r.file_id,
    );
    if (fileIds.length === 0) {
      yield* db.run(
        statement(
          `UPDATE review_queue SET instance_id = ?
            WHERE file_id IN (SELECT file_id FROM review_queue
                               WHERE instance_id IS NULL
                               ORDER BY queued_at, file_id LIMIT ?)`,
          [instanceId, REVIEW_BATCH_PAGES],
        ),
      );
      fileIds = (yield* db.all<{ file_id: string }>(claimed)).map(
        (r) => r.file_id,
      );
    }
    if (fileIds.length > 0) {
      yield* db.run(
        statement(
          `INSERT OR IGNORE INTO review_batches (instance_id, created_at, model, pages, stage)
           VALUES (?, ?, ?, ?, 'preparing')`,
          [instanceId, clock.now(), REVIEW_MODEL, fileIds.length],
        ),
      );
    }
    return fileIds;
  });
}

// Moves the instance's review_batches row to a stage that ends it early.
export function endBatch({
  instanceId,
  stage,
  error = null,
}: {
  instanceId: string;
  stage: "empty" | "failed";
  error?: string | null;
}): Effect.Effect<void, StorageError, Database | WallClock> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const clock = yield* WallClock;
    yield* db.run(
      statement(
        "UPDATE review_batches SET stage = ?, error = ?, ended_at = ? WHERE instance_id = ?",
        [stage, error?.slice(0, 500) ?? null, clock.now(), instanceId],
      ),
    );
  });
}

// ---- prepare -------------------------------------------------------------------

export interface ManifestEntry {
  fileId: string;
  bookId: string;
  effort: ReviewEffort;
  textSha: string;
  attempt: number;
  requested: boolean;
}

export interface PreparedPart {
  pages: number;
  dropped: number;
}

interface CandidateRow {
  file_id: string;
  book_id: string;
  state: string;
  text_key: string | null;
  text_edited_at: number | null;
  ocr_instructions: string | null;
  review_enabled: number;
  review_effort: string | null;
  attempts: number | null;
  requested: number | null;
}

const effortOf = (value: string | null): ReviewEffort =>
  REVIEW_EFFORTS.find((effort) => effort === value) ?? DEFAULT_REVIEW_EFFORT;

// Build the batch requests for one chunk of the claimed pages and store them
// in R2 as a fragment of the request JSON (requests joined by commas), with a
// manifest of what was sent. Pages that are no longer eligible (gone, not
// done, hand-edited, blank, or their book opted out) leave the queue here and
// are not sent.
export function preparePart({
  instanceId,
  index,
  fileIds,
}: {
  instanceId: string;
  index: number;
  fileIds: readonly string[];
}): Effect.Effect<PreparedPart, StorageError, Database | Bucket | ScanLinks> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const bucket = yield* Bucket;
    const scanLinks = yield* ScanLinks;
    const keys = reviewKeys(instanceId);

    const rows = yield* db.all<CandidateRow>(
      statement(
        `SELECT f.file_id, f.book_id, f.state, f.text_key, f.text_edited_at,
                b.ocr_instructions, b.review_enabled, b.review_effort, q.attempts, q.requested
           FROM files f JOIN books b ON b.id = f.book_id
           LEFT JOIN review_queue q ON q.file_id = f.file_id
          WHERE f.file_id IN (${fileIds.map(() => "?").join(", ")})`,
        fileIds,
      ),
    );
    const requests: string[] = [];
    const manifest: ManifestEntry[] = [];
    for (const row of rows) {
      const eligible =
        row.state === "done" &&
        row.text_key !== null &&
        row.text_edited_at === null &&
        (row.review_enabled === 1 || row.requested === 1) &&
        isValidCustomId(reviewCustomId({ instanceId, fileId: row.file_id }));
      const text =
        eligible && row.text_key ? yield* bucket.getText(row.text_key) : null;
      if (!text) continue;
      const effort = effortOf(row.review_effort);
      const imageUrl = yield* scanLinks.urlFor({
        fileId: row.file_id,
        ttlSeconds: REVIEW_SCAN_LINK_TTL_SECONDS,
      });
      requests.push(
        JSON.stringify({
          custom_id: reviewCustomId({ instanceId, fileId: row.file_id }),
          params: reviewRequestParams({
            text,
            imageUrl,
            bookInstructions: row.ocr_instructions?.trim() || null,
            effort,
          }),
        }),
      );
      manifest.push({
        fileId: row.file_id,
        bookId: row.book_id,
        effort,
        textSha: yield* Effect.promise(() => sha256Hex(text)),
        attempt: row.attempts ?? 0,
        requested: row.requested === 1,
      });
    }

    const sent = new Set(manifest.map((entry) => entry.fileId));
    const dropped = fileIds.filter((id) => !sent.has(id));
    if (dropped.length > 0) {
      yield* db.run(
        statement(
          `DELETE FROM review_queue WHERE instance_id = ? AND file_id IN (${dropped.map(() => "?").join(", ")})`,
          [instanceId, ...dropped],
        ),
      );
    }
    yield* bucket.putText({ key: keys.part(index), text: requests.join(",") });
    yield* bucket.putText({
      key: keys.manifest(index),
      text: JSON.stringify(manifest),
    });
    return { pages: manifest.length, dropped: dropped.length };
  });
}

// ---- submit ----------------------------------------------------------------------

// Clock skew allowed between our submit_attempted_at and Anthropic's
// created_at when matching a batch that a failed attempt may have created.
const ADOPT_SKEW_MS = 5 * 60 * 1000;
// A create returns within seconds; a batch created later than this after the
// attempt isn't the attempt's.
const ADOPT_WITHIN_MS = 10 * 60 * 1000;

export interface Submitted {
  batchId: string;
  submittedAt: number;
}

interface SubmitRow {
  stage: string;
  batch_id: string | null;
  submitted_at: number | null;
  submit_attempted_at: number | null;
}

// The batch a failed submit attempt created, if one can be found: created
// within minutes of that attempt, holding exactly `pages` requests, and not
// already another instance's batch. Creating a batch has no idempotency key,
// so this is a best guess; the results step proves ownership from the
// custom_ids before anything is applied (resultsAreOwn).
function findOwnBatch({
  attemptedAt,
  pages,
}: {
  attemptedAt: number;
  pages: number;
}): Effect.Effect<
  { id: string; createdAt: number } | null,
  StorageError | TransportError,
  AnthropicBatches | Database
> {
  return Effect.gen(function* () {
    const batches = yield* AnthropicBatches;
    const db = yield* Database;
    const candidates = (yield* batches.list()).filter(
      (batch) =>
        batch.createdAt > attemptedAt - ADOPT_SKEW_MS &&
        batch.createdAt < attemptedAt + ADOPT_WITHIN_MS &&
        batch.requests === pages,
    );
    if (candidates.length === 0) return null;
    const taken = new Set(
      (yield* db.all<{ batch_id: string }>(
        statement(
          `SELECT batch_id FROM review_batches WHERE batch_id IN (${candidates.map(() => "?").join(", ")})`,
          candidates.map((batch) => batch.id),
        ),
      )).map((row) => row.batch_id),
    );
    const own = candidates
      .filter((batch) => !taken.has(batch.id))
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    return own ?? null;
  });
}

// Create the batch from the stored request fragments (joined as text, never
// parsed) and put its id on the instance's row (stage 'processing'). Safe to
// retry: the row is marked 'submitting' before the create, so a retry knows
// an earlier attempt may have created a batch and adopts it instead of
// creating a second one.
export function submitBatch({
  instanceId,
  parts,
  pages,
}: {
  instanceId: string;
  parts: number;
  pages: number;
}): Effect.Effect<
  Submitted,
  StorageError | TransportError,
  Bucket | AnthropicBatches | Database | WallClock
> {
  return Effect.gen(function* () {
    const bucket = yield* Bucket;
    const batches = yield* AnthropicBatches;
    const db = yield* Database;
    const clock = yield* WallClock;

    const row = yield* db.first<SubmitRow>(
      statement(
        "SELECT stage, batch_id, submitted_at, submit_attempted_at FROM review_batches WHERE instance_id = ?",
        [instanceId],
      ),
    );
    if (row?.batch_id && row.submitted_at !== null) {
      return { batchId: row.batch_id, submittedAt: row.submitted_at };
    }
    if (row?.stage === "submitting" && row.submit_attempted_at !== null) {
      const own = yield* findOwnBatch({
        attemptedAt: row.submit_attempted_at,
        pages,
      });
      if (own) {
        yield* recordBatch({
          instanceId,
          batchId: own.id,
          pages,
          submittedAt: own.createdAt,
        });
        return { batchId: own.id, submittedAt: own.createdAt };
      }
    }

    yield* db.run(
      statement(
        "UPDATE review_batches SET stage = 'submitting', submit_attempted_at = ? WHERE instance_id = ?",
        [clock.now(), instanceId],
      ),
    );
    const keys = reviewKeys(instanceId);
    const fragments: string[] = [];
    for (let index = 0; index < parts; index++) {
      const fragment = yield* bucket.getText(keys.part(index));
      if (fragment) fragments.push(fragment);
    }
    const batchId = yield* batches.create(
      `{"requests":[${fragments.join(",")}]}`,
    );
    const submittedAt = clock.now();
    yield* recordBatch({ instanceId, batchId, pages, submittedAt });
    return { batchId, submittedAt };
  });
}

// Puts the batch id on the instance's row (stage 'processing'). The
// submission time is what the poll loop's schedule and 26-hour cap count from.
export function recordBatch({
  batchId,
  instanceId,
  pages,
  submittedAt,
}: {
  batchId: string;
  instanceId: string;
  pages: number;
  submittedAt: number;
}): Effect.Effect<void, StorageError, Database> {
  return Effect.gen(function* () {
    const db = yield* Database;
    yield* db.run(
      statement(
        `UPDATE review_batches
            SET batch_id = ?, pages = ?, stage = 'processing', submitted_at = ?
          WHERE instance_id = ?`,
        [batchId, pages, submittedAt, instanceId],
      ),
    );
  });
}

// ---- poll ------------------------------------------------------------------------

export interface BatchCheck {
  ended: boolean;
  // When the check ran (its own clock): the poll loop times the next wait
  // from step results, so a replay times it the same way.
  checkedAt: number;
  counts: BatchCounts;
}

const sameCounts = (a: BatchCounts, b: BatchCounts) =>
  a.processing === b.processing &&
  a.succeeded === b.succeeded &&
  a.errored === b.errored &&
  a.expired === b.expired &&
  a.canceled === b.canceled;

// Read the batch status and keep it on the instance's row (GET /api/jobs
// shows it without calling Anthropic). The row is written only when the
// counts moved since `previous` (the last check's) or the batch ended, which
// also stamps ended_at: polling is dense, and most checks change nothing.
export function checkBatch({
  instanceId,
  batchId,
  previous,
}: {
  instanceId: string;
  batchId: string;
  previous: BatchCounts | null;
}): Effect.Effect<
  BatchCheck,
  StorageError | TransportError,
  AnthropicBatches | Database | WallClock
> {
  return Effect.gen(function* () {
    const batches = yield* AnthropicBatches;
    const db = yield* Database;
    const clock = yield* WallClock;
    const status = yield* batches.retrieve(batchId);
    const ended = status.processingStatus === "ended";
    const checkedAt = clock.now();
    const { counts } = status;
    if (ended || !previous || !sameCounts(previous, counts)) {
      yield* db.run(
        statement(
          `UPDATE review_batches
              SET stage = ?, processing_status = ?, ended_at = ?, anthropic_ended_at = ?,
                  processing = ?, succeeded = ?, errored = ?, expired = ?, canceled = ?
            WHERE instance_id = ?`,
          [
            ended ? "ingesting" : "processing",
            status.processingStatus,
            ended ? checkedAt : null,
            ended ? status.endedAt : null,
            counts.processing,
            counts.succeeded,
            counts.errored,
            counts.expired,
            counts.canceled,
            instanceId,
          ],
        ),
      );
    }
    return { ended, checkedAt, counts };
  });
}

// ---- ingest ----------------------------------------------------------------------

function readManifest({
  instanceId,
  parts,
}: {
  instanceId: string;
  parts: number;
}): Effect.Effect<ManifestEntry[], StorageError, Bucket> {
  return Effect.gen(function* () {
    const bucket = yield* Bucket;
    const keys = reviewKeys(instanceId);
    const entries: ManifestEntry[] = [];
    for (let index = 0; index < parts; index++) {
      const manifest = yield* bucket.getText(keys.manifest(index));
      if (manifest) entries.push(...(JSON.parse(manifest) as ManifestEntry[]));
    }
    return entries;
  });
}

function countLines(bytes: Uint8Array): number {
  let lines = 0;
  let start = 0;
  while (start < bytes.length) {
    const newline = bytes.indexOf(NEWLINE, start);
    const end = newline === -1 ? bytes.length : newline;
    if (end > start) lines += 1;
    start = end + 1;
  }
  return lines;
}

// Whether the results are this instance's requests: no line carries a
// custom_id this instance didn't send, and every page it sent has a line,
// except as many as there are lines too garbled to read a custom_id from
// (those pages fail on their own, see review/apply.ts). False means the batch
// isn't ours (a retried submit adopted a stranger's).
export function resultsAreOwn({
  instanceId,
  bytes,
  manifest,
}: {
  instanceId: string;
  bytes: Uint8Array;
  manifest: readonly ManifestEntry[];
}): boolean {
  const expected = new Set(
    manifest.map((entry) =>
      reviewCustomId({ instanceId, fileId: entry.fileId }),
    ),
  );
  const lines = indexResultLines(bytes);
  const seen = new Set<string>();
  for (const line of lines) {
    if (!expected.has(line.customId)) return false;
    seen.add(line.customId);
  }
  const unreadable = countLines(bytes) - lines.length;
  return seen.size > 0 && expected.size - seen.size <= unreadable;
}

export const FOREIGN_BATCH = "adopted_foreign_batch";

// For a batch that turned out not to be ours: apply nothing, give the pages
// back to the queue untouched (no try counted), and fail the batch.
export function abandonForeignBatch(
  instanceId: string,
): Effect.Effect<void, StorageError, Database | WallClock> {
  return releaseClaims({ instanceId, retry: true }).pipe(
    Effect.andThen(
      endBatch({ instanceId, stage: "failed", error: FOREIGN_BATCH }),
    ),
  );
}

// Copy the results JSONL into R2 as it came (never parsed whole), and check
// it belongs to this instance before anything is applied.
export function storeResults({
  instanceId,
  batchId,
  parts,
}: {
  instanceId: string;
  batchId: string;
  parts: number;
}): Effect.Effect<
  { key: string; bytes: number; own: boolean },
  StorageError | TransportError,
  Bucket | AnthropicBatches
> {
  return Effect.gen(function* () {
    const bucket = yield* Bucket;
    const batches = yield* AnthropicBatches;
    const key = reviewKeys(instanceId).results;
    const bytes = yield* batches.results(batchId);
    yield* bucket.putBytes({
      key,
      bytes,
      contentType: "application/x-ndjson",
    });
    const manifest = yield* readManifest({ instanceId, parts });
    return {
      key,
      bytes: bytes.byteLength,
      own: resultsAreOwn({ instanceId, bytes, manifest }),
    };
  });
}

// Pages leave the queue once their batch has ended; the consumer re-adds any
// that need another try (expired, or changed while in review). When the
// Workflow gives up on a batch, `retry` returns them to the queue unclaimed.
export function releaseClaims({
  instanceId,
  retry,
}: {
  instanceId: string;
  retry: boolean;
}): Effect.Effect<void, StorageError, Database> {
  return Effect.gen(function* () {
    const db = yield* Database;
    yield* db.run(
      retry
        ? statement(
            "UPDATE review_queue SET instance_id = NULL WHERE instance_id = ?",
            [instanceId],
          )
        : statement("DELETE FROM review_queue WHERE instance_id = ?", [
            instanceId,
          ]),
    );
  });
}

export interface ResultLine {
  customId: string;
  offset: number;
  length: number;
}

const NEWLINE = 0x0a;
// custom_id is the first key of a results line; a longer prefix is decoded
// only if it isn't.
const PREFIX_BYTES = 200;
const CUSTOM_ID_FIELD = /"custom_id"\s*:\s*"([A-Za-z0-9_-]{1,64})"/;

// Byte range and custom_id of every line of a results JSONL, found by
// scanning for newlines (native) and decoding only each line's start, so the
// cost doesn't grow with how much Opus wrote.
export function indexResultLines(bytes: Uint8Array): ResultLine[] {
  const decoder = new TextDecoder();
  const lines: ResultLine[] = [];
  let start = 0;
  while (start < bytes.length) {
    const newline = bytes.indexOf(NEWLINE, start);
    const end = newline === -1 ? bytes.length : newline;
    if (end > start) {
      const line = bytes.subarray(start, end);
      const match =
        CUSTOM_ID_FIELD.exec(decoder.decode(line.subarray(0, PREFIX_BYTES))) ??
        CUSTOM_ID_FIELD.exec(decoder.decode(line));
      if (match?.[1]) {
        lines.push({ customId: match[1], offset: start, length: end - start });
      }
    }
    start = end + 1;
  }
  return lines;
}

// Send one review_apply message per page that was in the batch. The queue
// consumer applies each one (review/apply.ts).
export function dispatchApplies({
  instanceId,
  batchId,
  parts,
}: {
  instanceId: string;
  batchId: string;
  parts: number;
}): Effect.Effect<number, StorageError, Bucket | ReviewQueue> {
  return Effect.gen(function* () {
    const bucket = yield* Bucket;
    const queue = yield* ReviewQueue;
    const keys = reviewKeys(instanceId);

    const results = yield* bucket.getBytes(keys.results);
    const lineOf = new Map(
      indexResultLines(results?.bytes ?? new Uint8Array()).map((line) => [
        line.customId,
        { offset: line.offset, length: line.length },
      ]),
    );
    const messages = (yield* readManifest({ instanceId, parts })).map(
      (entry): ReviewApplyMessage => {
        const customId = reviewCustomId({ instanceId, fileId: entry.fileId });
        return {
          kind: "review_apply",
          batchId,
          fileId: entry.fileId,
          customId,
          bookId: entry.bookId,
          effort: entry.effort,
          textSha: entry.textSha,
          attempt: entry.attempt,
          requested: entry.requested,
          resultsKey: keys.results,
          line: lineOf.get(customId) ?? null,
        };
      },
    );
    yield* queue.send(messages);
    return messages.length;
  });
}

// The batch's last stage: 'applying' once every page has been handed to the
// queue (GET /api/jobs shows it done when every page has a review row), or
// 'timed_out' when the Workflow gave up waiting. Also records how many status
// checks and Workflow steps the batch took, for tuning the poll schedule.
export function finalizeBatch({
  instanceId,
  ended,
  resultsKey,
  checks,
  steps,
}: {
  instanceId: string;
  ended: boolean;
  resultsKey: string | null;
  checks: number;
  steps: number;
}): Effect.Effect<void, StorageError, Database | WallClock> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const clock = yield* WallClock;
    yield* db.run(
      statement(
        `UPDATE review_batches
            SET stage = ?, ended_at = COALESCE(ended_at, ?), results_key = ?,
                checks = ?, steps = ?
          WHERE instance_id = ?`,
        [
          ended ? "applying" : "timed_out",
          clock.now(),
          resultsKey,
          checks,
          steps,
          instanceId,
        ],
      ),
    );
  });
}

// ---- cron ------------------------------------------------------------------------

// Waiting pages no instance has claimed yet.
export function countPending(): Effect.Effect<number, StorageError, Database> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const row = yield* db.first<{ n: number }>(
      statement(
        "SELECT COUNT(*) AS n FROM review_queue WHERE instance_id IS NULL",
      ),
    );
    return row?.n ?? 0;
  });
}
