// OCR cost estimation. We store token counts (the durable truth) and derive
// dollars here, so a price change re-values history without a data migration.

// USD per 1M tokens, per model. Thinking tokens bill at the output rate, so
// they're folded into output_tokens upstream (see ocr.ts).
//
// ⚠️ CONFIRM these against current Google pricing — preview-model rates shift.
// Update here only; token counts never change.
const PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
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
