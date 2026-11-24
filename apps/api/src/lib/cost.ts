// OCR cost estimation. We store token counts (the durable truth) and derive
// dollars here, so a price change re-values history without a data migration.

// USD per 1M tokens, per model. Thinking tokens bill at the output rate, so
// they're folded into output_tokens upstream (see ocr.ts). Re-check on model
// changes; update here only — token counts never change.
//
// inkling-2-small is the default OCR engine: $0.30 in / $1.00 out (ollama.com
// pricing, checked 2026-11-23).
// claude-sonnet-5-5 is the OCR fallback (see ocr.ts), $2 in / $10 out.
// The rest are no longer called but stay so older pages still get a cost:
// claude-sonnet-5 was the fallback before Sonnet 5.5, and
// gemini-3.1-pro-preview was the default OCR engine before Inkling (its
// <=200k-prompt tier rate; a single-page OCR prompt never reached the higher
// tier).
const PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  "inkling-2-small": { inputPer1M: 0.3, outputPer1M: 1.0 },
  "claude-sonnet-5-5": { inputPer1M: 2.0, outputPer1M: 10.0 },
  "claude-sonnet-5": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "gemini-3.1-pro-preview": { inputPer1M: 2.0, outputPer1M: 12.0 },
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
