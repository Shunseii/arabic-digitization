// The OCR queue message that applies one page's review (see review/apply.ts).
// The Workflow sends one per page once a batch's results are in R2; the
// message points at the page's line in the results file rather than carrying
// it, so it stays tiny whatever Opus returned.

export const REVIEW_EFFORTS = ["low", "medium", "high"] as const;
export type ReviewEffort = (typeof REVIEW_EFFORTS)[number];
export const DEFAULT_REVIEW_EFFORT: ReviewEffort = "low";

export interface ReviewApplyMessage {
  kind: "review_apply";
  batchId: string;
  fileId: string;
  bookId: string;
  effort: ReviewEffort;
  // SHA-256 of the text that was sent for review: the edits apply only if the
  // page still has exactly that text.
  textSha: string;
  resultsKey: string;
  // Byte range of the page's line in the results JSONL; null when the results
  // have no line for the page.
  line: { offset: number; length: number } | null;
}

export function isReviewApply(body: unknown): body is ReviewApplyMessage {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { kind?: unknown }).kind === "review_apply"
  );
}
