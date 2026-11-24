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
  type Statement,
  statement,
  type TransportError,
  WallClock,
} from "../effect/services";
import { REVIEW_MODEL } from "../lib/cost";
import { sha256Hex } from "../lib/ocrRuns";
import {
  DEFAULT_REVIEW_EFFORT,
  REVIEW_EFFORTS,
  type ReviewApplyMessage,
  type ReviewEffort,
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

const CUSTOM_ID = /^[a-zA-Z0-9_-]{1,64}$/;

export const reviewKeys = (instanceId: string) => {
  const base = `reviews/${instanceId}`;
  return {
    part: (index: number) => `${base}/requests-${index}.json`,
    manifest: (index: number) => `${base}/manifest-${index}.json`,
    results: `${base}/results.jsonl`,
  };
};

// ---- select ------------------------------------------------------------------

// Claim up to REVIEW_BATCH_PAGES waiting pages for this instance. A retry
// returns the pages the first attempt claimed instead of claiming more.
export function claimPages(
  instanceId: string,
): Effect.Effect<string[], StorageError, Database> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const claimed = statement(
      "SELECT file_id FROM review_queue WHERE instance_id = ? ORDER BY queued_at, file_id",
      [instanceId],
    );
    const existing = yield* db.all<{ file_id: string }>(claimed);
    if (existing.length > 0) return existing.map((r) => r.file_id);
    yield* db.run(
      statement(
        `UPDATE review_queue SET instance_id = ?
          WHERE file_id IN (SELECT file_id FROM review_queue
                             WHERE instance_id IS NULL
                             ORDER BY queued_at, file_id LIMIT ?)`,
        [instanceId, REVIEW_BATCH_PAGES],
      ),
    );
    return (yield* db.all<{ file_id: string }>(claimed)).map((r) => r.file_id);
  });
}

// ---- prepare -------------------------------------------------------------------

export interface ManifestEntry {
  fileId: string;
  bookId: string;
  effort: ReviewEffort;
  textSha: string;
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
                b.ocr_instructions, b.review_enabled, b.review_effort
           FROM files f JOIN books b ON b.id = f.book_id
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
        row.review_enabled === 1 &&
        CUSTOM_ID.test(row.file_id);
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
          custom_id: row.file_id,
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

// Join the stored request fragments into one body and create the batch. The
// fragments are concatenated as text, never parsed.
export function submitBatch({
  instanceId,
  parts,
}: {
  instanceId: string;
  parts: number;
}): Effect.Effect<
  string,
  StorageError | TransportError,
  Bucket | AnthropicBatches
> {
  return Effect.gen(function* () {
    const bucket = yield* Bucket;
    const batches = yield* AnthropicBatches;
    const keys = reviewKeys(instanceId);
    const fragments: string[] = [];
    for (let index = 0; index < parts; index++) {
      const fragment = yield* bucket.getText(keys.part(index));
      if (fragment) fragments.push(fragment);
    }
    return yield* batches.create(`{"requests":[${fragments.join(",")}]}`);
  });
}

export function recordBatch({
  batchId,
  instanceId,
  pages,
}: {
  batchId: string;
  instanceId: string;
  pages: number;
}): Effect.Effect<void, StorageError, Database | WallClock> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const clock = yield* WallClock;
    yield* db.run(
      statement(
        `INSERT OR IGNORE INTO review_batches (batch_id, instance_id, created_at, model, pages, status)
         VALUES (?, ?, ?, ?, ?, 'in_progress')`,
        [batchId, instanceId, clock.now(), REVIEW_MODEL, pages],
      ),
    );
  });
}

// ---- poll ------------------------------------------------------------------------

export interface BatchCheck {
  ended: boolean;
  counts: BatchCounts;
}

export function checkBatch(
  batchId: string,
): Effect.Effect<BatchCheck, TransportError, AnthropicBatches> {
  return Effect.gen(function* () {
    const batches = yield* AnthropicBatches;
    const status = yield* batches.retrieve(batchId);
    return {
      ended: status.processingStatus === "ended",
      counts: status.counts,
    };
  });
}

// ---- ingest ----------------------------------------------------------------------

// Copy the results JSONL into R2 as it came, without parsing it.
export function storeResults({
  instanceId,
  batchId,
}: {
  instanceId: string;
  batchId: string;
}): Effect.Effect<
  { key: string; bytes: number },
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
    return { key, bytes: bytes.byteLength };
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
    const messages: ReviewApplyMessage[] = [];
    for (let index = 0; index < parts; index++) {
      const manifest = yield* bucket.getText(keys.manifest(index));
      const entries: ManifestEntry[] = manifest ? JSON.parse(manifest) : [];
      for (const entry of entries) {
        messages.push({
          kind: "review_apply",
          batchId,
          fileId: entry.fileId,
          bookId: entry.bookId,
          effort: entry.effort,
          textSha: entry.textSha,
          resultsKey: keys.results,
          line: lineOf.get(entry.fileId) ?? null,
        });
      }
    }
    yield* queue.send(messages);
    return messages.length;
  });
}

export function finalizeBatch({
  batchId,
  check,
  resultsKey,
}: {
  batchId: string;
  check: BatchCheck;
  resultsKey: string | null;
}): Effect.Effect<void, StorageError, Database | WallClock> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const clock = yield* WallClock;
    const { counts } = check;
    const update: Statement = statement(
      `UPDATE review_batches
          SET status = ?, ended_at = ?, succeeded = ?, errored = ?, expired = ?,
              canceled = ?, results_key = ?
        WHERE batch_id = ?`,
      [
        check.ended ? "ended" : "timed_out",
        clock.now(),
        counts.succeeded,
        counts.errored,
        counts.expired,
        counts.canceled,
        resultsKey,
        batchId,
      ],
    );
    yield* db.run(update);
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
