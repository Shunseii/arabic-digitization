// Rows for the OCR run history (migrations/0009_ocr_runs.sql): one ocr_runs
// row per run, plus the prompt texts it used in prompt_versions.

import { Effect } from "effect";
import {
  type FallbackReason,
  fallbackReasonForTag,
  type StorageError,
} from "../effect/errors";
import {
  Bucket,
  Database,
  type Statement,
  statement,
} from "../effect/services";
import type { OcrEngine } from "../types";
import { costUsd } from "./cost";
import { METRICS_VERSION, measurePage, type PageMeasurement } from "./metrics";

export const OCR_TRIGGERS = ["upload", "retry", "requeue", "manual"] as const;
export type OcrTrigger = (typeof OCR_TRIGGERS)[number];

export type RunStatus = "done" | "failed" | "requeued";

export interface CallRecord {
  engine: OcrEngine;
  model: string;
  status: "ok" | "error";
  ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number;
  error_type: string | null;
}

export function callCost({
  model,
  inputTokens,
  outputTokens,
}: {
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}): number {
  return costUsd({ model, inputTokens, outputTokens }) ?? 0;
}

// A run falls back only after its first call failed, so a second call means a
// fallback, and the first call's error says why.
export function fallbackReasonOf(
  calls: readonly CallRecord[],
): FallbackReason | null {
  const first = calls[0];
  if (calls.length < 2 || !first?.error_type) return null;
  return fallbackReasonForTag(first.error_type);
}

export interface RunTotals {
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  wastedCostUsd: number;
}

// Totals over every call, failed ones included. Only a successful call's
// output is ever stored, so everything else was spent for nothing.
export function runTotals(calls: readonly CallRecord[]): RunTotals {
  let latencyMs = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let wastedCostUsd = 0;
  for (const call of calls) {
    latencyMs += call.ms;
    inputTokens += call.input_tokens ?? 0;
    outputTokens += call.output_tokens ?? 0;
    costUsd += call.cost_usd;
    if (call.status !== "ok") wastedCostUsd += call.cost_usd;
  }
  return { latencyMs, inputTokens, outputTokens, costUsd, wastedCostUsd };
}

export interface PromptVersion {
  hash: string;
  kind: "system" | "book_instructions";
  text: string;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function insertPromptVersion({
  prompt,
  seenAt,
}: {
  prompt: PromptVersion;
  seenAt: number;
}): Statement {
  return statement(
    "INSERT OR IGNORE INTO prompt_versions (hash, kind, text, first_seen_at) VALUES (?, ?, ?, ?)",
    [prompt.hash, prompt.kind, prompt.text, seenAt],
  );
}

export interface RunRecord {
  fileId: string;
  bookId: string;
  createdAt: number;
  trigger: OcrTrigger | null;
  status: RunStatus;
  errorType: string | null;
  errorMessage: string | null;
  primaryEngine: OcrEngine;
  finalModel: string | null;
  deliveryAttempt: number;
  calls: readonly CallRecord[];
  systemPromptHash: string | null;
  bookInstructionsHash: string | null;
  textKey: string | null;
  measurement: PageMeasurement | null;
}

const ERROR_MESSAGE_MAX = 300;

export function insertOcrRun(run: RunRecord): Statement {
  const totals = runTotals(run.calls);
  const reason = fallbackReasonOf(run.calls);
  const columns = run.measurement?.columns;
  return statement(
    `INSERT INTO ocr_runs (
       file_id, book_id, created_at, trigger, status, error_type, error_message,
       primary_engine, final_model, fell_back, fallback_reason, delivery_attempt,
       calls, latency_ms, input_tokens, output_tokens, cost_usd, wasted_cost_usd,
       system_prompt_hash, book_instructions_hash, text_key,
       words, chars, blank, has_header, footnote_block_ok, headings,
       metrics, metrics_version
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      run.fileId,
      run.bookId,
      run.createdAt,
      run.trigger,
      run.status,
      run.errorType,
      run.errorMessage?.slice(0, ERROR_MESSAGE_MAX) ?? null,
      run.primaryEngine,
      run.finalModel,
      reason ? 1 : 0,
      reason,
      run.deliveryAttempt,
      JSON.stringify(run.calls),
      totals.latencyMs,
      totals.inputTokens,
      totals.outputTokens,
      totals.costUsd,
      totals.wastedCostUsd,
      run.systemPromptHash,
      run.bookInstructionsHash,
      run.textKey,
      columns?.words ?? null,
      columns?.chars ?? null,
      columns?.blank ?? null,
      columns?.has_header ?? null,
      columns?.footnote_block_ok ?? null,
      columns?.headings ?? null,
      run.measurement ? JSON.stringify(run.measurement.metrics) : null,
      run.measurement ? METRICS_VERSION : null,
    ],
  );
}

export function updateRunMeasurement({
  runId,
  measurement,
}: {
  runId: number;
  measurement: PageMeasurement;
}): Statement {
  const { columns, metrics } = measurement;
  return statement(
    `UPDATE ocr_runs
        SET words = ?, chars = ?, blank = ?, has_header = ?, footnote_block_ok = ?,
            headings = ?, metrics = ?, metrics_version = ?
      WHERE id = ?`,
    [
      columns.words,
      columns.chars,
      columns.blank,
      columns.has_header,
      columns.footnote_block_ok,
      columns.headings,
      JSON.stringify(metrics),
      METRICS_VERSION,
      runId,
    ],
  );
}

// The immutable copy of one run's text. Under the book's prefix, so deleting
// the book removes it with everything else.
export const runTextKey = ({
  bookId,
  fileId,
  at,
}: {
  bookId: string;
  fileId: string;
  at: number;
}) =>
  `books/${bookId}/ocr-runs/${fileId}/${at}-${crypto.randomUUID().slice(0, 8)}.md`;

export const runTextPrefix = ({
  bookId,
  fileId,
}: {
  bookId: string;
  fileId: string;
}) => `books/${bookId}/ocr-runs/${fileId}/`;

// The most rows one call may recompute: one R2 read each, plus two D1 queries,
// stays well inside the 50 subrequests a Workers Free invocation allows.
export const RECOMPUTE_MAX_LIMIT = 25;
// Measuring a dense page takes CPU; 10 per call keeps a call well inside the
// Free plan's 10 ms CPU limit.
export const RECOMPUTE_DEFAULT_LIMIT = 10;
// R2 reads in flight at once (Workers allow 6 open connections).
const RECOMPUTE_CONCURRENCY = 6;

export interface RecomputeResult {
  metrics_version: number;
  updated: number;
  // Runs whose text object is gone (book or page deleted); left as they are.
  missing: number;
  // Pass as `after` to continue; null when no rows remain.
  next_after: number | null;
}

// Recompute the metrics cache for one page of done runs whose metrics are
// older than METRICS_VERSION, ordered by id after `after`. All updates go in
// one D1 batch.
export function recomputeRunMetrics({
  after,
  limit,
}: {
  after: number;
  limit: number;
}): Effect.Effect<RecomputeResult, StorageError, Database | Bucket> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const bucket = yield* Bucket;
    const rows = yield* db.all<{ id: number; text_key: string }>(
      statement(
        `SELECT id, text_key FROM ocr_runs
          WHERE status = 'done' AND text_key IS NOT NULL
            AND (metrics_version IS NULL OR metrics_version < ?)
            AND id > ?
          ORDER BY id
          LIMIT ?`,
        [METRICS_VERSION, after, limit],
      ),
    );
    const texts = yield* Effect.forEach(
      rows,
      (row) => bucket.getText(row.text_key),
      { concurrency: RECOMPUTE_CONCURRENCY },
    );
    const updates: Statement[] = [];
    rows.forEach((row, i) => {
      const text = texts[i];
      if (text === null || text === undefined) return;
      updates.push(
        updateRunMeasurement({ runId: row.id, measurement: measurePage(text) }),
      );
    });
    yield* db.batch(updates);
    return {
      metrics_version: METRICS_VERSION,
      updated: updates.length,
      missing: rows.length - updates.length,
      next_after: rows.length === limit ? (rows.at(-1)?.id ?? null) : null,
    };
  });
}
