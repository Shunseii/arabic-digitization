// What the Opus review asks for, and how its answer is read. Opus compares a
// page's stored transcription with the scan and answers with the whole page,
// corrected, as plain Markdown and nothing else; the server compares it with
// the stored text (review/apply.ts). It used to return find-and-replace edits,
// but long quotes it re-typed (often with tashkeel added) didn't match the
// page, so the biggest fixes were the ones skipped.

import { isRecord } from "../effect/services";
import { REVIEW_MODEL } from "../lib/cost";
import { SYSTEM_PROMPT } from "../ocr";
import type { ReviewEffort } from "./message";

// The answer is the whole page (a dense page with footnotes is a few thousand
// tokens; the OCR fits a page and its thinking in 16k) plus the review's
// thinking. Twice the OCR's cap leaves room for the longest pages. Only
// generated tokens are billed, so the headroom costs nothing unless used; an
// answer cut off here is never applied.
export const REVIEW_MAX_TOKENS = 32000;

const REVIEW_RULES = `You proofread transcriptions of scanned pages of classical Arabic printed books. You get the page scan and the stored transcription of it. Compare them closely and correct every place where the transcription differs from the printed page or breaks the transcription standard below.

Answer with the whole corrected transcription and nothing else:
- Output the complete page in the Markdown format the standard below describes. No preamble, no notes, no list of changes, no code fences.
- Change only what the scan shows is wrong, or what breaks the standard. Copy everything else exactly as it is in the transcription, character for character: do not add or remove tashkeel unless the scan shows it is wrong, do not normalise hamza, alif or ya, and do not tidy punctuation, spacing or line breaks that already match the page.
- Never drop, shorten or summarise any text. Keep the running header, the whole matn, the footnote block and every gloss.
- If the transcription is already correct, output it exactly as it is.

## The transcription standard
The transcription was produced under these instructions. Judge it against them.

${SYSTEM_PROMPT}`;

// Batches can take an hour or more between requests that share the prefix,
// so the prompt is cached with the 1-hour TTL.
const CACHE_1H = { type: "ephemeral", ttl: "1h" } as const;

// One request of the batch. The system prompt is the cached part: the review
// rules plus the OCR standard (shared by every page), then the book's own OCR
// notes (shared by the book's pages). The scan and the text vary per page.
export function reviewRequestParams({
  text,
  imageUrl,
  bookInstructions,
  effort,
}: {
  text: string;
  imageUrl: string;
  bookInstructions: string | null;
  effort: ReviewEffort;
}) {
  const system = [
    { type: "text", text: REVIEW_RULES, cache_control: CACHE_1H },
  ];
  if (bookInstructions) {
    system.push({
      type: "text",
      text: `## Book-specific notes\nThe standard for this particular book adds these notes:\n${bookInstructions}`,
      cache_control: CACHE_1H,
    });
  }
  return {
    model: REVIEW_MODEL,
    max_tokens: REVIEW_MAX_TOKENS,
    thinking: { type: "adaptive" },
    output_config: { effort },
    system,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "url", url: imageUrl } },
          {
            type: "text",
            text: `<transcription>\n${text}\n</transcription>\n\nReview this transcription against the scan and output the corrected transcription.`,
          },
        ],
      },
    ],
  };
}

// The find-and-replace JSON a batch sent before the full-page prompt answers
// with ({"edits": [...]}); such an answer is not a page.
export function isLegacyEditsAnswer(answer: string): boolean {
  const trimmed = answer.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    const raw: unknown = JSON.parse(trimmed);
    return isRecord(raw) && Array.isArray(raw.edits);
  } catch {
    return false;
  }
}
