// What the Opus review asks for, and how its answer is read. Opus compares a
// page's stored transcription with the scan and returns only find-and-replace
// edits (never the full text), each tagged with a category.

import { isRecord } from "../effect/services";
import { REVIEW_MODEL } from "../lib/cost";
import { SYSTEM_PROMPT } from "../ocr";
import type { ReviewEffort } from "./message";

export const REVIEW_CATEGORIES = [
  "tashkeel",
  "spelling",
  "quran",
  "footnotes",
  "punctuation",
  "layout",
] as const;
export type ReviewCategory = (typeof REVIEW_CATEGORIES)[number];

export interface ReviewEdit {
  find: string;
  replace: string;
  category: ReviewCategory;
}

// Thinking counts against this too; a page's edits are short.
const REVIEW_MAX_TOKENS = 16000;

const REVIEW_RULES = `You proofread transcriptions of scanned pages of classical Arabic printed books. You get the page scan and the stored transcription of it. Compare them closely and report every place where the transcription differs from the printed page or breaks the transcription standard below.

Answer with find-and-replace edits only, never the full text:
- "find" is copied verbatim from the transcription (every letter, diacritic, space and line break) and must occur exactly once in it. If the wrong text is short or repeated, include enough surrounding words to make it unique.
- "replace" is what that exact span should be.
- Keep each edit as small as it can be while staying unique. Separate mistakes get separate edits; edits must not overlap.
- Fix only real mismatches with the scan or with the standard. Do not restyle, re-punctuate or reflow text that already matches the page.
- If the transcription is correct, return an empty list.

Give each edit one category:
- tashkeel: diacritics (harakat, shadda, sukun, tanwin) added, missing or wrong.
- spelling: wrong, missing or extra letters or words in the author's text.
- quran: Qur'an text not in the printed Uthmani spelling, or a wrong word in an ayah.
- footnotes: the footnote block, its heading or footnote markers.
- punctuation: punctuation marks and brackets.
- layout: headings, the running header and its divider, paragraph and line breaks, interlinear glosses (ruby).

## The transcription standard
The transcription was produced under these instructions. Judge it against them.

${SYSTEM_PROMPT}`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    edits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          find: { type: "string" },
          replace: { type: "string" },
          category: { type: "string", enum: [...REVIEW_CATEGORIES] },
        },
        required: ["find", "replace", "category"],
        additionalProperties: false,
      },
    },
  },
  required: ["edits"],
  additionalProperties: false,
} as const;

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
    output_config: {
      effort,
      format: { type: "json_schema", schema: OUTPUT_SCHEMA },
    },
    system,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "url", url: imageUrl } },
          {
            type: "text",
            text: `<transcription>\n${text}\n</transcription>\n\nReview this transcription against the scan.`,
          },
        ],
      },
    ],
  };
}

const isCategory = (value: unknown): value is ReviewCategory =>
  REVIEW_CATEGORIES.some((category) => category === value);

// The edits in Opus's JSON answer, or null if it isn't the expected shape.
export function parseReviewEdits(answer: string): ReviewEdit[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(answer);
  } catch {
    return null;
  }
  if (!isRecord(raw) || !Array.isArray(raw.edits)) return null;
  const edits: ReviewEdit[] = [];
  for (const item of raw.edits) {
    if (
      !isRecord(item) ||
      typeof item.find !== "string" ||
      typeof item.replace !== "string" ||
      !isCategory(item.category)
    ) {
      return null;
    }
    edits.push({
      find: item.find,
      replace: item.replace,
      category: item.category,
    });
  }
  return edits;
}
