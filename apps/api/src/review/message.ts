// The OCR queue message that applies one page's review (see review/apply.ts).
// The Workflow sends one per page once a batch's results are in R2; the
// message points at the page's line in the results file rather than carrying
// it, so it stays tiny whatever Opus returned.

export const REVIEW_EFFORTS = ["low", "medium", "high"] as const;
export type ReviewEffort = (typeof REVIEW_EFFORTS)[number];
export const DEFAULT_REVIEW_EFFORT: ReviewEffort = "low";

// Tries in a row that may end without a review (a server-side error, an
// expired or canceled request) before the page's review is marked failed.
// Anthropic doesn't bill these requests, so retrying costs nothing but time.
export const REVIEW_MAX_ATTEMPTS = 3;

// A request's custom_id: the instance id, then the page's file id, so a
// batch's results prove which instance submitted them (a batch adopted by
// mistake has foreign ids). Anthropic allows ^[a-zA-Z0-9_-]{1,64}$; a file id
// is a 36-character UUID, leaving 27 for the instance (kept from the end,
// where an instance id's timestamp is).
const CUSTOM_ID_MAX = 64;

export function reviewCustomId({
  instanceId,
  fileId,
}: {
  instanceId: string;
  fileId: string;
}): string {
  const room = Math.max(CUSTOM_ID_MAX - fileId.length - 1, 0);
  const prefix = instanceId.replace(/[^a-zA-Z0-9_-]/g, "").slice(-room);
  return `${prefix}-${fileId}`;
}

export const isValidCustomId = (customId: string) =>
  /^[a-zA-Z0-9_-]{1,64}$/.test(customId);

export interface ReviewApplyMessage {
  kind: "review_apply";
  batchId: string;
  fileId: string;
  // The page's custom_id in the batch (reviewCustomId).
  customId: string;
  bookId: string;
  effort: ReviewEffort;
  // Earlier tries of this page that ended without a review (server error,
  // expired, canceled); see REVIEW_MAX_ATTEMPTS.
  attempt: number;
  // Asked for on demand: reviewed even if the book's switch is off, and
  // queued again on the same terms. Absent on messages from before it.
  requested?: boolean;
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
