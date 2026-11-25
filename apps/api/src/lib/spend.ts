// The daily spend rollup (spend_daily, migration 0014): what OCR and the Opus
// review cost, per UTC day, book and model. Each billed call adds to its row
// in the same D1 batch that records the call (an OCR run, a page review), so
// the rollup never disagrees with the records and costs one written row per
// model touched (two the first time a day/book/model row appears: the row and
// its book index entry).

import { type Statement, statement } from "../effect/services";
import type { CallRecord } from "./ocrRuns";

export type SpendKind = "ocr" | "review";

// UTC day of an epoch-ms time, as 'YYYY-MM-DD'.
export const spendDay = (at: number): string =>
  new Date(at).toISOString().slice(0, 10);

export interface SpendRow {
  day: string;
  bookId: string;
  kind: SpendKind;
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  calls: number;
  pages: number;
}

// Add to a rollup row. `onlyIf` is an SQL condition (with its params) that
// must hold for the add to happen, so a record that turns out to be a
// duplicate adds nothing.
export function addSpend({
  row,
  onlyIf,
}: {
  row: SpendRow;
  onlyIf?: { sql: string; params: readonly (string | number | null)[] };
}): Statement {
  return statement(
    `INSERT INTO spend_daily (day, book_id, kind, model, cost_usd, input_tokens, output_tokens,
                              cache_creation_input_tokens, cache_read_input_tokens, calls, pages)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${onlyIf?.sql ?? "1"}
     ON CONFLICT (day, book_id, kind, model) DO UPDATE SET
       cost_usd = cost_usd + excluded.cost_usd,
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       cache_creation_input_tokens = cache_creation_input_tokens + excluded.cache_creation_input_tokens,
       cache_read_input_tokens = cache_read_input_tokens + excluded.cache_read_input_tokens,
       calls = calls + excluded.calls,
       pages = pages + excluded.pages`,
    [
      row.day,
      row.bookId,
      row.kind,
      row.model,
      row.costUsd,
      row.inputTokens,
      row.outputTokens,
      row.cacheCreationInputTokens,
      row.cacheReadInputTokens,
      row.calls,
      row.pages,
      ...(onlyIf?.params ?? []),
    ],
  );
}

// One OCR run's billed calls, one row per model. A call is billed when it
// reported tokens (failed calls included: a cut-off or empty answer was still
// generated). `pages` counts the page once, for the model whose text was
// stored.
export function ocrSpend({
  bookId,
  at,
  calls,
  storedModel,
}: {
  bookId: string;
  at: number;
  calls: readonly CallRecord[];
  storedModel: string | null;
}): Statement[] {
  const byModel = new Map<string, SpendRow>();
  for (const call of calls) {
    const billed =
      (call.input_tokens ?? 0) > 0 ||
      (call.output_tokens ?? 0) > 0 ||
      call.cost_usd > 0;
    if (!billed) continue;
    const row = byModel.get(call.model) ?? {
      day: spendDay(at),
      bookId,
      kind: "ocr",
      model: call.model,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      calls: 0,
      pages: 0,
    };
    row.costUsd += call.cost_usd;
    row.inputTokens += call.input_tokens ?? 0;
    row.outputTokens += call.output_tokens ?? 0;
    row.calls += 1;
    if (call.status === "ok" && call.model === storedModel) row.pages = 1;
    byModel.set(call.model, row);
  }
  return [...byModel.values()].map((row) => addSpend({ row }));
}
