// OCR cost estimation. We store token counts (the durable truth) and derive
// dollars here, so a price change re-values history without a data migration.

// USD per 1M tokens, per model. Thinking tokens bill at the output rate, so
// they're folded into output_tokens upstream (see ocr.ts).
//
// These are the <=200k-prompt tier rates (confirmed 2026-07-06 against
// ai.google.dev/gemini-api/docs/pricing). Gemini 3.1 Pro has a higher tier for
// prompts >200k tokens ($4 in / $18 out), but a single-page OCR prompt is ~2k
// tokens and never reaches it, so the flat rate is exact here. Re-check on model
// changes; update here only — token counts never change.
// claude-sonnet-5 is the OCR fallback (see ocr.ts). Standard rates ($3 in /
// $15 out); intro pricing ($2 / $10) runs through 2026-08-31, so this slightly
// overestimates cost until then — safe (over, not under). Drop to intro rates
// if you want exact numbers before that date.
const PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  "gemini-3.1-pro-preview": { inputPer1M: 2.0, outputPer1M: 12.0 },
  "claude-sonnet-5": { inputPer1M: 3.0, outputPer1M: 15.0 },
};

// Cost in USD for a file's usage, or null if the model has no known price (so
// callers/UI can hide cost rather than show a wrong or zero number).
export function costUsd({
  model,
  inputTokens,
  outputTokens,
}: {
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}): number | null {
  if (!model || inputTokens == null || outputTokens == null) return null;
  const price = PRICING[model];
  if (!price) return null;
  return (
    (inputTokens / 1_000_000) * price.inputPer1M +
    (outputTokens / 1_000_000) * price.outputPer1M
  );
}
