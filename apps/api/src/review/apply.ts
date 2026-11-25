// Applies one page's Opus review: the queue consumer's half of the review
// Workflow (review/workflow.ts). It reads the page's line from the batch
// results in R2, applies the edits that still match, and records the change
// the same way a hand edit is recorded (a text_revisions row holding the text
// it replaced), so the review shows in the page's history and can be undone.
//
// A page that a person edited by hand (files.text_edited_at) is never touched,
// and nor is a page whose text changed after it was sent for review.

import { Effect } from "effect";
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
import { applyEdits } from "../endpoints/fileTextEdit";
import { REVIEW_MODEL, type ReviewUsage, reviewCostUsd } from "../lib/cost";
import { sha256Hex } from "../lib/ocrRuns";
import { reviewHistoryKey } from "../lib/pageText";
import { REVIEW_MAX_ATTEMPTS, type ReviewApplyMessage } from "./message";
import { enqueueReview } from "./pending";
import {
  parseReviewEdits,
  type ReviewCategory,
  type ReviewEdit,
} from "./prompt";

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

export interface CategoryCounts {
  proposed: number;
  applied: number;
  failed: number;
}

export type CategoryStats = Partial<Record<ReviewCategory, CategoryCounts>>;

export interface ReviewedEdit extends ReviewEdit {
  applied: boolean;
}

export interface EditsOutcome {
  text: string;
  applied: number;
  failed: number;
  categories: CategoryStats;
  edits: ReviewedEdit[];
  // Characters the applied edits replaced or inserted (per edit, the longer
  // of find and replace): a cheap measure of how much of the page changed.
  charsChanged: number;
}

// Apply the edits in order. Each `find` must occur exactly once in the text as
// it stands after the previous edits, the same rule as a hand edit; one that
// doesn't is counted as failed to apply and skipped, never forced.
export function applyReviewEdits({
  text,
  edits,
}: {
  text: string;
  edits: readonly ReviewEdit[];
}): EditsOutcome {
  let current = text;
  let applied = 0;
  let failed = 0;
  let charsChanged = 0;
  const categories: CategoryStats = {};
  const reviewed: ReviewedEdit[] = [];
  for (const edit of edits) {
    const counts = categories[edit.category] ?? {
      proposed: 0,
      applied: 0,
      failed: 0,
    };
    categories[edit.category] = counts;
    counts.proposed += 1;
    const result =
      edit.find === ""
        ? null
        : applyEdits({
            text: current,
            edits: [{ old: edit.find, new: edit.replace }],
          });
    if (result?.ok) {
      current = result.text;
      counts.applied += 1;
      applied += 1;
      charsChanged += Math.max(edit.find.length, edit.replace.length);
    } else {
      counts.failed += 1;
      failed += 1;
    }
    reviewed.push({ ...edit, applied: result?.ok === true });
  }
  return {
    text: current,
    applied,
    failed,
    categories,
    edits: reviewed,
    charsChanged,
  };
}

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

// One line of the results JSONL: {"custom_id": ..., "result": {...}}.
export function readBatchResult({
  line,
  fileId,
}: {
  line: string;
  fileId: string;
}): BatchResult {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return {
      type: "errored",
      errorType: "unreadable_result",
      error: "results line is not JSON",
    };
  }
  if (!isRecord(raw) || raw.custom_id !== fileId || !isRecord(raw.result)) {
    return {
      type: "errored",
      errorType: "unreadable_result",
      error: "results line is not this page's",
    };
  }
  const result = raw.result;
  switch (result.type) {
    case "succeeded":
      return { type: "succeeded", message: result.message };
    case "expired":
      return { type: "expired" };
    case "canceled":
      return { type: "canceled" };
    default:
      return { type: "errored", ...readError(result.error) };
  }
}

// An invalid request fails the same way every time; anything else that
// errored (api_error, overloaded_error, ...) is on Anthropic's side and
// worth another try.
const PERMANENT_ERROR_TYPES = new Set(["invalid_request_error"]);

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
  proposed?: number;
  outcome?: EditsOutcome | null;
  charsTotal?: number;
  usage?: ReviewUsage;
  // The revision id is last_insert_rowid() of the revision insert just before.
  revisionFromLastInsert?: boolean;
}

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
  const outcome = record.outcome ?? null;
  return statement(
    `INSERT OR IGNORE INTO page_reviews (
       file_id, batch_id, book_id, created_at, model, effort, attempt, status,
       error_type, error, edits_proposed, edits_applied, edits_failed,
       categories, edits, chars_changed, chars_total,
       input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
       output_tokens, cost_usd, revision_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${
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
      record.proposed ?? 0,
      outcome?.applied ?? 0,
      outcome?.failed ?? 0,
      outcome ? JSON.stringify(outcome.categories) : null,
      outcome ? JSON.stringify(outcome.edits) : null,
      outcome?.charsChanged ?? 0,
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

    const finish = (record: ReviewRecord, extra: Statement[] = []) =>
      db
        .batch([...extra, insertPageReview({ msg, at: clock.now(), record })])
        .pipe(Effect.as(record.status));
    const requeue = (attempts = 0) =>
      enqueueReview({
        fileId: msg.fileId,
        bookId: msg.bookId,
        at: clock.now(),
        attempts,
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
      fileId: msg.fileId,
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
    const edits = parseReviewEdits(readAnthropicMessage(result.message).text);
    if (!edits) {
      return yield* finish({
        status: "invalid_output",
        error: `stop_reason=${String(stopReason)}`,
        usage,
      });
    }
    const unapplied = { usage, proposed: edits.length };

    const page = yield* db.first<PageRow>(
      statement(
        "SELECT state, text_key, text_edited_at FROM files WHERE file_id = ?",
        [msg.fileId],
      ),
    );
    if (page?.state !== "done" || !page.text_key) {
      return yield* finish({ status: "page_gone", ...unapplied });
    }
    if (page.text_edited_at !== null) {
      return yield* finish({ status: "skipped_hand_edited", ...unapplied });
    }
    const textKey = page.text_key;
    const current = yield* bucket.getVersionedText(textKey);
    if (!current) return yield* finish({ status: "page_gone", ...unapplied });
    const sha = (text: string) => Effect.promise(() => sha256Hex(text));
    const prevKey = reviewHistoryKey({
      bookId: msg.bookId,
      fileId: msg.fileId,
      batchId: msg.batchId,
    });

    // The text the review was made from: the page's current text, or, when
    // an earlier delivery already wrote the reviewed text and then failed
    // before D1, the copy it saved first. The edits are deterministic, so
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
        applyReviewEdits({ text: saved, edits }).text !== current.text
      ) {
        return yield* finish({ status: "stale", ...unapplied }, [requeue()]);
      }
      original = saved;
      alreadyWritten = true;
    }

    const outcome = applyReviewEdits({ text: original, edits });
    const reviewed = {
      ...unapplied,
      outcome,
      charsTotal: original.length,
    };
    if (outcome.text === original) {
      return yield* finish({ status: "no_changes", ...reviewed });
    }

    // R2 first, then D1. The old text is saved under a key fixed by the
    // batch, then the page is replaced only if it still has the text that
    // was read (etag), so a hand edit or re-OCR in between wins. A failure
    // before D1 is redelivered and lands in the alreadyWritten path above.
    if (!alreadyWritten) {
      yield* bucket.putText({ key: prevKey, text: original });
      const written = yield* bucket.putTextIfMatch({
        key: textKey,
        text: outcome.text,
        etag: current.etag,
      });
      if (!written) {
        // A twin delivery may have written the same text first; anything
        // else means a hand edit or re-OCR won the race.
        const now = yield* bucket.getText(textKey);
        if (now !== outcome.text) {
          return yield* finish({ status: "conflict", ...unapplied }, [
            requeue(),
          ]);
        }
      }
    }

    // One transaction. The revision is inserted only if this page's review
    // isn't recorded yet, so a twin delivery can't add a second one, and
    // insertPageReview (OR IGNORE) reads its id with last_insert_rowid().
    const at = clock.now();
    yield* finish(
      { status: "applied", ...reviewed, revisionFromLastInsert: true },
      [
        statement(
          "UPDATE files SET preview = ?, updated_at = ? WHERE file_id = ?",
          [outcome.text.slice(0, 120), at, msg.fileId],
        ),
        statement(
          `INSERT INTO text_revisions (file_id, book_id, change, model, note, prev_key, created_at)
           SELECT ?, ?, 'review', ?, ?, ?, ?
            WHERE NOT EXISTS (SELECT 1 FROM page_reviews WHERE file_id = ? AND batch_id = ?)`,
          [
            msg.fileId,
            msg.bookId,
            REVIEW_MODEL,
            `Opus review (${msg.batchId}): ${outcome.applied} applied, ${outcome.failed} failed to apply`,
            prevKey,
            at,
            ...key,
          ],
        ),
      ],
    );
    yield* indexer.index({ fileId: msg.fileId, text: outcome.text });
    return "applied" as const;
  });
}
