// Applies one page's Opus review: the queue consumer's half of the review
// Workflow (review/workflow.ts). It reads the page's line from the batch
// results in R2, checks the corrected page Opus returned, and records the
// change the same way a hand edit is recorded (a text_revisions row holding
// the text it replaced), so the review shows in the page's history and can be
// undone.
//
// A page that a person edited by hand (files.text_edited_at) is never touched,
// and nor is a page whose text changed after it was sent for review. A
// correction is applied whole or not at all.

import { Effect, Option, Schema } from "effect";
import { resolveFailure } from "../dlq";
import type { StorageError } from "../effect/errors";
import {
  Bucket,
  Database,
  isRecord,
  numberOrNull,
  PageIndexer,
  readAnthropicMessage,
  type Statement,
  statement,
  WallClock,
} from "../effect/services";
import { REVIEW_MODEL, type ReviewUsage, reviewCostUsd } from "../lib/cost";
import { sha256Hex } from "../lib/ocrRuns";
import { reviewHistoryKey } from "../lib/pageText";
import { addSpend, spendDay } from "../lib/spend";
import {
  diffPageWords,
  type PageDiffStats,
  rejectCorrection,
} from "./correction";
import { REVIEW_MAX_ATTEMPTS, type ReviewApplyMessage } from "./message";
import { enqueueReview } from "./pending";
import { isLegacyEditsAnswer, REVIEW_MAX_TOKENS } from "./prompt";

export type ReviewStatus =
  | "applied"
  | "no_changes"
  | "skipped_hand_edited"
  | "stale"
  | "conflict"
  | "page_gone"
  | "invalid_output"
  | "refused"
  | "errored"
  | "expired"
  | "canceled"
  | "failed";

// page_reviews.error_type of an invalid_output row: why Opus's answer wasn't
// applied. The last three are the guards in review/correction.ts.
export type InvalidOutputReason =
  | "max_tokens"
  | "legacy_output"
  | "empty_text"
  | "text_loss"
  | "footnotes_lost";

// page_reviews.edits of a full-page review: the word diff of the correction.
// Rows of the older find-and-replace reviews hold a JSON array of
// {find, replace, category, applied} instead.
export interface PageReviewDetail {
  words_added: number;
  words_removed: number;
}

const NO_CHANGE: PageDiffStats = {
  wordsAdded: 0,
  wordsRemoved: 0,
  charsChanged: 0,
};

const CODE_FENCE = /^```[a-z]*\n([\s\S]*)\n```$/;

// The page Opus returned, as it would be stored: without a code fence it may
// have wrapped the page in, and with the original's leading and trailing
// whitespace, so whitespace around the page never counts as a change.
export function correctedText({
  answer,
  original,
}: {
  answer: string;
  original: string;
}): string {
  const trimmed = answer.trim();
  const page = (CODE_FENCE.exec(trimmed)?.[1] ?? trimmed).trim();
  if (page === "") return "";
  const leading = original.slice(
    0,
    original.length - original.trimStart().length,
  );
  const trailing = original.slice(original.trimEnd().length);
  return leading + page + trailing;
}

export const UNREADABLE_RESULT = "unreadable_result";
export const UNKNOWN_RESULT_TYPE = "unknown_result_type";

export type BatchResult =
  | { type: "succeeded"; message: unknown }
  | { type: "errored"; errorType: string; error: string }
  | { type: "expired" }
  | { type: "canceled" };

const ERROR_MAX = 500;

// The error's type and message, from {type: "error", error: {type, message}}
// (the API's error envelope) or a bare {type, message}.
function readError(raw: unknown): { errorType: string; error: string } {
  const outer = isRecord(raw) ? raw : {};
  const inner = isRecord(outer.error) ? outer.error : outer;
  const errorType =
    typeof inner.type === "string" ? inner.type : "unknown_error";
  const message =
    typeof inner.message === "string" ? inner.message : JSON.stringify(raw);
  return { errorType, error: message.slice(0, ERROR_MAX) };
}

// One line of the results JSONL, decoded with Schema. The result types are
// the four the Batches API documents; anything else is handled explicitly.
const ResultLine = Schema.Struct({
  custom_id: Schema.String,
  result: Schema.Struct({
    type: Schema.String,
    message: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Unknown),
  }),
});

const SucceededMessage = Schema.Struct({
  content: Schema.Array(Schema.Unknown),
  stop_reason: Schema.optional(Schema.NullOr(Schema.String)),
  usage: Schema.Struct({
    input_tokens: Schema.Number,
    output_tokens: Schema.Number,
    cache_creation_input_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
    cache_read_input_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  }),
});

const decodeResultLine = Schema.decodeUnknownOption(ResultLine);
const decodeSucceededMessage = Schema.decodeUnknownOption(SucceededMessage);

const unreadable = (error: string): BatchResult => ({
  type: "errored",
  errorType: UNREADABLE_RESULT,
  error,
});

// A line that can't be read is this page's failure alone (retried like a
// server error); the rest of the batch is unaffected.
export function readBatchResult({
  line,
  customId,
}: {
  line: string;
  customId: string;
}): BatchResult {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return unreadable("results line is not JSON");
  }
  const decoded = Option.getOrNull(decodeResultLine(raw));
  if (!decoded) return unreadable("results line has an unexpected shape");
  if (decoded.custom_id !== customId) {
    return unreadable("results line is not this page's");
  }
  const { result } = decoded;
  switch (result.type) {
    case "succeeded": {
      const message = Option.getOrNull(decodeSucceededMessage(result.message));
      return message
        ? { type: "succeeded", message }
        : unreadable("succeeded result has an unexpected message");
    }
    case "expired":
      return { type: "expired" };
    case "canceled":
      return { type: "canceled" };
    case "errored":
      return { type: "errored", ...readError(result.error) };
    default:
      return {
        type: "errored",
        errorType: UNKNOWN_RESULT_TYPE,
        error: `result type '${result.type}'`,
      };
  }
}

// An invalid request fails the same way every time, and a result type this
// code doesn't know won't change on a retry; anything else that errored
// (api_error, overloaded_error, an unreadable line, ...) is worth another try.
const PERMANENT_ERROR_TYPES = new Set([
  "invalid_request_error",
  UNKNOWN_RESULT_TYPE,
]);

function readUsage(message: unknown): ReviewUsage {
  const usage =
    isRecord(message) && isRecord(message.usage) ? message.usage : {};
  const count = (name: string) => numberOrNull(usage[name]) ?? 0;
  return {
    inputTokens: count("input_tokens"),
    cacheCreationInputTokens: count("cache_creation_input_tokens"),
    cacheReadInputTokens: count("cache_read_input_tokens"),
    outputTokens: count("output_tokens"),
  };
}

const NO_USAGE: ReviewUsage = {
  inputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 0,
};

interface ReviewRecord {
  status: ReviewStatus;
  errorType?: string | null;
  error?: string | null;
  // The word diff of the correction; null when it was never compared with
  // the page (skipped, or no answer).
  stats?: PageDiffStats | null;
  charsTotal?: number;
  usage?: ReviewUsage;
  // The revision id is last_insert_rowid() of the revision insert just before.
  revisionFromLastInsert?: boolean;
}

// edits_proposed/applied/failed and categories belong to the older
// find-and-replace reviews and are left at their defaults (0, NULL).
function insertPageReview({
  msg,
  at,
  record,
}: {
  msg: ReviewApplyMessage;
  at: number;
  record: ReviewRecord;
}): Statement {
  const usage = record.usage ?? NO_USAGE;
  const stats = record.stats ?? null;
  const detail: PageReviewDetail | null = stats && {
    words_added: stats.wordsAdded,
    words_removed: stats.wordsRemoved,
  };
  return statement(
    `INSERT OR IGNORE INTO page_reviews (
       file_id, batch_id, book_id, created_at, model, effort, attempt, status,
       error_type, error, edits, chars_changed, chars_total,
       input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
       output_tokens, cost_usd, revision_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${
       record.revisionFromLastInsert ? "last_insert_rowid()" : "NULL"
})`,
    [
      msg.fileId,
      msg.batchId,
      msg.bookId,
      at,
      REVIEW_MODEL,
      msg.effort,
      msg.attempt,
      record.status,
      record.errorType ?? null,
      record.error ?? null,
      detail ? JSON.stringify(detail) : null,
      stats?.charsChanged ?? 0,
      record.charsTotal ?? 0,
      usage.inputTokens,
      usage.cacheCreationInputTokens,
      usage.cacheReadInputTokens,
      usage.outputTokens,
      reviewCostUsd(usage),
    ],
  );
}

interface PageRow {
  state: string;
  text_key: string | null;
  text_edited_at: number | null;
}

// Apply (or record why not) one page's review. Idempotent: a redelivered
// message finds its page_reviews row and does nothing.
export function applyReview(
  msg: ReviewApplyMessage,
): Effect.Effect<
  ReviewStatus | "duplicate",
  StorageError,
  Database | Bucket | PageIndexer | WallClock
> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const bucket = yield* Bucket;
    const clock = yield* WallClock;
    const indexer = yield* PageIndexer;
    const key = [msg.fileId, msg.batchId];

    const seen = yield* db.first<{ status: string }>(
      statement(
        "SELECT status FROM page_reviews WHERE file_id = ? AND batch_id = ?",
        key,
      ),
    );
    if (seen) return "duplicate" as const;

    // Only the first record of this page's review counts: a twin delivery
    // adds no spend, cost or revision.
    const notRecorded = {
      sql: "NOT EXISTS (SELECT 1 FROM page_reviews WHERE file_id = ? AND batch_id = ?)",
      params: key,
    };
    // A billed result adds to the spend rollup and to the page's review cost
    // (with the new preview when the review changed the text), in the batch
    // that records it. Unbilled results (errored, expired, canceled) add
    // nothing.
    const costStatements = ({
      record,
      preview,
      at,
    }: {
      record: ReviewRecord;
      preview: string | null;
      at: number;
    }): Statement[] => {
      const usage = record.usage ?? NO_USAGE;
      const billed = usage.inputTokens > 0 || usage.outputTokens > 0;
      if (!billed && preview === null) return [];
      const cost = billed ? reviewCostUsd(usage) : 0;
      return [
        ...(billed
          ? [
              addSpend({
                row: {
                  day: spendDay(at),
                  bookId: msg.bookId,
                  kind: "review",
                  model: REVIEW_MODEL,
                  costUsd: cost,
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                  cacheCreationInputTokens: usage.cacheCreationInputTokens,
                  cacheReadInputTokens: usage.cacheReadInputTokens,
                  calls: 1,
                  pages:
                    record.status === "applied" ||
                    record.status === "no_changes"
                      ? 1
                      : 0,
                },
                onlyIf: notRecorded,
              }),
            ]
          : []),
        statement(
          `UPDATE files
              SET review_cost_usd = CASE WHEN ? THEN COALESCE(review_cost_usd, 0) + ? ELSE review_cost_usd END,
                  preview = COALESCE(?, preview), updated_at = ?
            WHERE file_id = ? AND ${notRecorded.sql}`,
          [billed ? 1 : 0, cost, preview, at, msg.fileId, ...key],
        ),
      ];
    };

    // A review that got through resolves an earlier dead apply of this page
    // (a no-op unless such a row exists).
    const finish = (
      record: ReviewRecord,
      extra: Statement[] = [],
      preview: string | null = null,
    ) =>
      db
        .batch([
          ...costStatements({ record, preview, at: clock.now() }),
          ...extra,
          insertPageReview({ msg, at: clock.now(), record }),
          ...(record.status === "applied" || record.status === "no_changes"
            ? [
                resolveFailure({
                  kind: "review_apply",
                  fileId: msg.fileId,
                  at: clock.now(),
                }),
              ]
            : []),
        ])
        .pipe(Effect.as(record.status));
    const requeue = (attempts = 0) =>
      enqueueReview({
        fileId: msg.fileId,
        bookId: msg.bookId,
        at: clock.now(),
        attempts,
        requested: msg.requested === true,
      });
    // A try that ended without a review: queue the page again, unless this
    // was its last allowed try. Such requests aren't billed.
    const retryLater = ({
      status,
      errorType,
      error,
    }: {
      status: "errored" | "expired" | "canceled";
      errorType: string;
      error: string | null;
    }) => {
      const attempts = msg.attempt + 1;
      return attempts >= REVIEW_MAX_ATTEMPTS
        ? finish({ status: "failed", errorType, error })
        : finish({ status, errorType, error }, [requeue(attempts)]);
    };

    const bytes = msg.line
      ? yield* bucket.getRange({ key: msg.resultsKey, ...msg.line })
      : null;
    if (!bytes) {
      return yield* retryLater({
        status: "errored",
        errorType: "missing_result",
        error: "the batch results have no line for this page",
      });
    }
    const result = readBatchResult({
      line: new TextDecoder().decode(bytes),
      customId: msg.customId,
    });
    if (result.type === "expired" || result.type === "canceled") {
      return yield* retryLater({
        status: result.type,
        errorType: result.type,
        error: null,
      });
    }
    if (result.type === "errored") {
      if (PERMANENT_ERROR_TYPES.has(result.errorType)) {
        return yield* finish({
          status: "failed",
          errorType: result.errorType,
          error: result.error,
        });
      }
      return yield* retryLater({ status: "errored", ...result });
    }

    const usage = readUsage(result.message);
    const stopReason = isRecord(result.message)
      ? result.message.stop_reason
      : undefined;
    if (stopReason === "refusal") {
      return yield* finish({ status: "refused", usage });
    }
    const invalid = ({
      reason,
      error,
      extra = [],
      stats = null,
      charsTotal,
    }: {
      reason: InvalidOutputReason;
      error: string;
      extra?: Statement[];
      stats?: PageDiffStats | null;
      charsTotal?: number;
    }) =>
      finish(
        {
          status: "invalid_output",
          errorType: reason,
          error,
          usage,
          stats,
          charsTotal,
        },
        extra,
      );
    // A cut-off answer is a page that ends early: never apply it.
    if (stopReason === "max_tokens") {
      return yield* invalid({
        reason: "max_tokens",
        error: `the answer was cut off at max_tokens (${REVIEW_MAX_TOKENS})`,
      });
    }
    const answer = readAnthropicMessage(result.message).text;
    // A batch sent before the full-page prompt: review the page again.
    if (isLegacyEditsAnswer(answer)) {
      return yield* invalid({
        reason: "legacy_output",
        error: "find-and-replace answer from before the full-page review",
        extra: [requeue()],
      });
    }

    const page = yield* db.first<PageRow>(
      statement(
        "SELECT state, text_key, text_edited_at FROM files WHERE file_id = ?",
        [msg.fileId],
      ),
    );
    if (page?.state !== "done" || !page.text_key) {
      return yield* finish({ status: "page_gone", usage });
    }
    if (page.text_edited_at !== null) {
      return yield* finish({ status: "skipped_hand_edited", usage });
    }
    const textKey = page.text_key;
    const current = yield* bucket.getVersionedText(textKey);
    if (!current) return yield* finish({ status: "page_gone", usage });
    const sha = (text: string) => Effect.promise(() => sha256Hex(text));
    const prevKey = reviewHistoryKey({
      bookId: msg.bookId,
      fileId: msg.fileId,
      batchId: msg.batchId,
    });

    // The text the review was made from: the page's current text, or, when
    // an earlier delivery already wrote the corrected text and then failed
    // before D1, the copy it saved first. The correction is deterministic, so
    // that copy re-derives exactly what was written.
    let original = current.text;
    let alreadyWritten = false;
    if ((yield* sha(current.text)) !== msg.textSha) {
      const saved = yield* bucket.getText(prevKey);
      const savedIsOriginal =
        saved !== null && (yield* sha(saved)) === msg.textSha;
      if (
        !saved ||
        !savedIsOriginal ||
        correctedText({ answer, original: saved }) !== current.text
      ) {
        return yield* finish({ status: "stale", usage }, [requeue()]);
      }
      original = saved;
      alreadyWritten = true;
    }

    const corrected = correctedText({ answer, original });
    const charsTotal = original.length;
    if (corrected === original) {
      return yield* finish({
        status: "no_changes",
        usage,
        stats: NO_CHANGE,
        charsTotal,
      });
    }
    const stats = diffPageWords({ before: original, after: corrected });
    const rejection = rejectCorrection({ original, corrected });
    if (rejection) {
      return yield* invalid({
        reason: rejection.reason,
        error: rejection.detail,
        stats,
        charsTotal,
      });
    }

    // R2 first, then D1. The old text is saved under a key fixed by the
    // batch, then the page is replaced only if it still has the text that
    // was read (etag), so a hand edit or re-OCR in between wins. A failure
    // before D1 is redelivered and lands in the alreadyWritten path above.
    if (!alreadyWritten) {
      yield* bucket.putText({ key: prevKey, text: original });
      const written = yield* bucket.putTextIfMatch({
        key: textKey,
        text: corrected,
        etag: current.etag,
      });
      if (!written) {
        // A twin delivery may have written the same text first; anything
        // else means a hand edit or re-OCR won the race.
        const now = yield* bucket.getText(textKey);
        if (now !== corrected) {
          return yield* finish({ status: "conflict", usage }, [requeue()]);
        }
      }
    }

    // One transaction. The revision is inserted only if this page's review
    // isn't recorded yet, so a twin delivery can't add a second one, and
    // insertPageReview (OR IGNORE) reads its id with last_insert_rowid().
    const at = clock.now();
    yield* finish(
      {
        status: "applied",
        usage,
        stats,
        charsTotal,
        revisionFromLastInsert: true,
      },
      [
        statement(
          `INSERT INTO text_revisions (file_id, book_id, change, model, note, prev_key, created_at)
           SELECT ?, ?, 'review', ?, ?, ?, ?
            WHERE NOT EXISTS (SELECT 1 FROM page_reviews WHERE file_id = ? AND batch_id = ?)`,
          [
            msg.fileId,
            msg.bookId,
            REVIEW_MODEL,
            `Opus review (${msg.batchId}): ${stats.wordsAdded} words added, ${stats.wordsRemoved} removed`,
            prevKey,
            at,
            ...key,
          ],
        ),
      ],
      corrected.slice(0, 120),
    );
    yield* indexer.index({ fileId: msg.fileId, text: corrected });
    return "applied" as const;
  });
}
