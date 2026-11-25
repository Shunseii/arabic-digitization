/**
 * Shared API contract types for the Qira'a digitization API.
 *
 * The Cloudflare Worker (apps/api) owns the canonical Zod schemas in
 * apps/api/src/types.ts. These hand-written types mirror the public request
 * and response shapes so clients (apps/mobile) get typed access with zero
 * runtime dependencies. Keep them in sync with the Zod schemas when the
 * contract changes.
 */

/** States a page fragment moves through, server-side. */
export type FileState =
  | "captured"
  | "queued"
  | "processing"
  | "rate_limited"
  | "done"
  | "needs_review"
  | "approved"
  | "failed";

/** Content types the upload endpoint accepts for a page fragment: raster images only (no PDF). */
export const UPLOAD_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type UploadContentType = (typeof UPLOAD_CONTENT_TYPES)[number];

/** OCR provider a book runs first; the other is the fallback on a transient failure. */
export type OcrEngine = "inkling" | "claude";

/** A book: one copy/scan of a work. Copies of one work share a work_id. */
export interface Book {
  id: string;
  title: string;
  created_at: number;
  /** The work this copy belongs to; null/undefined = ungrouped/standalone. */
  work_id?: string | null;
  ocr_instructions?: string | null;
  /** OCR provider that runs first; null/undefined = default (inkling). */
  ocr_engine?: OcrEngine | null;
  /** OCR paused for this book: its pages wait in 'queued' until resumed. */
  paused?: boolean;
  /** Opus review on: pages are proofread against the scan after OCR (costs money). */
  review_enabled?: boolean;
  /** Opus effort for reviews; null/undefined = default (low). */
  review_effort?: ReviewEffort | null;
}

/** Opus review effort level. */
export type ReviewEffort = "low" | "medium" | "high";

/** Category of an Opus review edit, as stored in page_reviews.categories. */
export type ReviewCategory =
  | "tashkeel"
  | "spelling"
  | "quran"
  | "footnotes"
  | "punctuation"
  | "layout";

/** Display labels for review categories (the usage dashboard's names). */
export const REVIEW_CATEGORY_LABELS: Record<ReviewCategory, string> = {
  tashkeel: "Tashkeel",
  spelling: "Spelling",
  quran: "Qur'an text",
  footnotes: "Footnotes",
  punctuation: "Punctuation",
  layout: "Layout",
};

/** POST /api/books/:bookId/review */
export interface QueueReviewResponse {
  success: true;
  /** Pages newly added to the review queue. */
  queued: number;
}

/** Outcome of one page's review try (page_reviews.status). */
export type PageReviewStatus =
  | "applied"
  | "no_changes"
  | "skipped_hand_edited"
  | "stale"
  | "conflict"
  | "page_gone"
  | "invalid_output"
  | "refused"
  /** errored, expired, canceled: queued again for another try. */
  | "errored"
  | "expired"
  | "canceled"
  /** Not retried: an invalid request, or the third try in a row without a review. */
  | "failed";

export interface ReviewedEdit {
  find: string;
  replace: string;
  category: ReviewCategory;
  /** False when `find` didn't match exactly once (failed to apply). */
  applied: boolean;
}

export interface PageReview {
  batch_id: string;
  created_at: number;
  model: string;
  effort: string;
  /** Earlier tries of this page that ended without a review. */
  attempt: number;
  status: PageReviewStatus;
  error_type: string | null;
  error: string | null;
  edits_proposed: number;
  edits_applied: number;
  edits_failed: number;
  edits: ReviewedEdit[];
  chars_changed: number;
  chars_total: number;
  cost_usd: number;
  /** The "review" history entry; GET .../text?rev=<id> is the text before it. */
  revision_id: number | null;
}

/** GET /api/books/:bookId/files/:fileId/reviews (newest first). */
export interface PageReviewsResponse {
  success: true;
  file_id: string;
  reviews: PageReview[];
}

export interface EditCounts {
  proposed: number;
  applied: number;
  /** Failed to apply. */
  failed: number;
}

/** GET /api/reviews/summary */
export interface ReviewSummaryResponse {
  success: true;
  since: number;
  book_id: string | null;
  pages_reviewed: number;
  pages_changed: number;
  pages_not_reviewed: number;
  pages_skipped: number;
  by_status: Partial<Record<PageReviewStatus, number>>;
  edits: EditCounts;
  by_category: Record<ReviewCategory, EditCounts>;
  /** Characters changed by applied edits / characters of the reviewed pages. */
  text_changed_share: number | null;
  cost_usd: number;
  cost_per_page_usd: number | null;
  hand_edited_after_review: number;
}

export type ReviewBatchStage =
  | "preparing"
  | "processing"
  | "ingesting"
  | "applying"
  | "done"
  | "empty"
  | "timed_out"
  | "failed";

export interface ReviewBatchJob {
  instance_id: string;
  batch_id: string | null;
  stage: ReviewBatchStage;
  /** The Workflow instance's coarse status, for in-flight batches only. */
  instance_status: string | null;
  pages: number;
  /** Pages whose review has been recorded. */
  reviewed: number;
  created_at: number;
  submitted_at: number | null;
  /** When a check saw the batch ended (ended_at - submitted_at = duration). */
  ended_at: number | null;
  /** Anthropic's counts as of the last check that saw them change. */
  request_counts: {
    processing: number;
    succeeded: number;
    errored: number;
    expired: number;
    canceled: number;
  };
  edits_applied: number;
  edits_failed: number;
  /** Pages that ended without a review (failed or retried). */
  errors: number;
  cost_usd: number;
  error: string | null;
}

export interface OcrBookJob {
  book_id: string;
  title: string;
  paused: boolean;
  queued: number;
  processing: number;
  rate_limited: number;
  failed: number;
  /** Null for paused books. */
  oldest_queued_at: number | null;
  done_last_hour: number;
  /** Counts over the recent window (JobsResponse.ocr.recent_since). */
  recent_runs: number;
  fell_back: number;
  retried: number;
}

export interface OcrProblemPage {
  file_id: string;
  book_id: string;
  created_at: number;
  status: string;
  final_model: string | null;
  fell_back: boolean;
  fallback_reason: string | null;
  delivery_attempt: number;
  error_type: string | null;
}

/** GET /api/jobs: running work. Refresh on demand; don't poll. */
export interface JobsResponse {
  success: true;
  now: number;
  ocr: {
    books: OcrBookJob[];
    recent_since: number;
    problem_pages: OcrProblemPage[];
  };
  review: {
    in_flight: ReviewBatchJob[];
    waiting: {
      book_id: string;
      title: string;
      pages: number;
      retrying: number;
    }[];
    /** The last 10 finished batches. */
    recent: ReviewBatchJob[];
  };
}

/** A tag (subject/genre), shared across works. */
export interface Tag {
  id: string;
  name: string;
}

/** A work: the abstract book that copies (Book rows) belong to. */
export interface Work {
  id: string;
  name: string;
  author?: string | null;
  created_at: number;
  /** Tag names attached to this work. */
  tags: string[];
}

/** Work plus a count of its copies (the library group header). */
export interface WorkWithCounts extends Work {
  copies_total: number;
}

/** Aggregate OCR token usage + derived cost. */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  /** null if any contributing model has no known price. */
  cost_usd: number | null;
}

/** Book plus a per-state file count (the dashboard/library summary). */
export interface BookWithStatus extends Book {
  files_total: number;
  /** File count keyed by state; only present states appear. */
  counts: Partial<Record<FileState, number>>;
  /** Aggregate usage across done pages. Present on book fetch; null if no
   *  page has usage data yet. Omitted by the list endpoint. */
  usage?: Usage | null;
}

/** A stored page fragment. Mirrors the `files` table. */
export interface FileRecord {
  file_id: string;
  book_id: string;
  r2_key: string;
  state: FileState;
  text_key: string | null;
  page_number: number | null;
  role: string | null;
  order_hint: number | null;
  created_at: number;
  updated_at: number;
}

/** Per-file status row (no heavy text) — the status endpoint payload. */
export interface FileStatus {
  file_id: string;
  page_number: number | null;
  state: FileState;
  role: string | null;
  order_hint: number | null;
  preview: string | null;
  error: string | null;
  updated_at: number;
  /** When the text was last edited by hand (epoch ms); null if never. */
  text_edited_at: number | null;
  /** OCR usage; null for pages done before tracking, or not yet done. */
  input_tokens: number | null;
  output_tokens: number | null;
  /** Derived (tokens x model price); null if the model has no known price. */
  cost_usd: number | null;
}

/** One file in a bulk export: metadata + transcribed text (null if none yet). */
export interface ExportFile {
  file_id: string;
  page_number: number | null;
  role: string | null;
  order_hint: number | null;
  state: FileState;
  text: string | null;
}

// --- Request bodies ---

export interface BookCreateBody {
  title: string;
  /** Optional explicit slug id (a-z0-9-); a UUID is generated if omitted. */
  id?: string;
  ocr_instructions?: string;
  /** OCR provider that runs first; omitted/null = default (inkling). */
  ocr_engine?: OcrEngine | null;
  /** Attach to an existing work; if omitted a work is auto-created from the title. */
  work_id?: string;
  /** Tags for the auto-created work (created on write); ignored when work_id is given. */
  tags?: string[];
}

export interface BookUpdateBody {
  title?: string;
  /** null clears the stored instructions. */
  ocr_instructions?: string | null;
  /** null resets to the default engine. Does not re-OCR existing pages. */
  ocr_engine?: OcrEngine | null;
  /** Reassign to a work; null unlinks (flat). */
  work_id?: string | null;
  /** Turn the Opus review on/off for pages that finish OCR from now on. */
  review_enabled?: boolean;
  /** null resets to the default effort (low). */
  review_effort?: ReviewEffort | null;
}

export interface WorkCreateBody {
  name: string;
  author?: string;
  /** Tag names; created on write if new. */
  tags?: string[];
  /** Optional explicit slug id (a-z0-9-); a UUID is generated if omitted. */
  id?: string;
}

export interface WorkUpdateBody {
  name?: string;
  /** null clears the author. */
  author?: string | null;
  /** Replaces the full tag set; tags created on write if new. */
  tags?: string[];
}

/** How to treat a work's copies when the work is deleted. */
export type WorkDeleteMode = "unlink" | "delete";

// --- Response envelopes (the api wraps payloads in { success, ... }) ---

export interface CreateBookResponse {
  success: true;
  book: Book;
}

export interface UpdateBookResponse {
  success: true;
  book: Book;
}

export interface ListBooksResponse {
  success: true;
  books: BookWithStatus[];
}

export interface FetchBookResponse {
  success: true;
  book: BookWithStatus;
}

export interface BookStatusResponse {
  success: true;
  files: FileStatus[];
  /** All of the book's files, even when `since` filtered `files`. */
  files_total: number;
}

/** A file in the cross-book recent list: its status plus the book it's in. */
export interface RecentFile extends FileStatus {
  book_id: string;
  book_title: string;
}

/** GET /api/files/recent: newest updated_at first. */
export interface RecentFilesResponse {
  success: true;
  files: RecentFile[];
}

export interface BookExportResponse {
  success: true;
  book_id: string;
  files: ExportFile[];
  /** Every file in the book at request time. Only set when `limit` is passed. */
  files_total?: number;
  /** Pass as `cursor` to fetch the next batch; null on the last batch. Only set when `limit` is passed. */
  next_cursor?: string | null;
}

export interface UploadFileResponse {
  success: true;
  file: FileRecord;
}

export interface FileUpdateBody {
  /** null clears the page number. */
  page_number: number | null;
}

export interface FileUpdateResponse {
  success: true;
  file: FileRecord;
}

export interface FileDeleteResponse {
  success: true;
  deleted: {
    file_id: string;
    r2_objects: number;
  };
}

export interface PauseBookResponse {
  success: true;
  paused: true;
}

/** Resume clears the pause and re-enqueues the book's waiting pages. */
export interface ResumeBookResponse {
  success: true;
  paused: false;
  requeued: number;
}

/** OCR is now enqueued (async); poll status/export for the result. */
export interface FileOcrResponse {
  success: true;
  file_id: string;
  state: "queued";
}

/** One exact find-and-replace edit; `old` must occur exactly once. */
export interface TextEdit {
  old: string;
  new: string;
}

/** PATCH .../files/:fileId/text */
export interface EditTextResponse {
  success: true;
  file_id: string;
  /** False when the edits left the text as it was (nothing recorded). */
  changed: boolean;
  /** History entry holding the text before this edit; null if unchanged. */
  revision_id: number | null;
  text_edited_at: number | null;
}

/** One change to a page's text; GET .../text?rev=<id> is the text before it. */
export interface TextRevision {
  id: number;
  /** "review": an applied Opus review (model set). */
  change: "edit" | "ocr" | "review";
  model: string | null;
  note: string | null;
  created_at: number;
}

/** GET .../files/:fileId/text/history (newest first). */
export interface TextHistoryResponse {
  success: true;
  file_id: string;
  text_edited_at: number | null;
  revisions: TextRevision[];
}

export interface DeleteBookResponse {
  success: true;
  deleted: {
    book_id: string;
    files: number;
    r2_objects: number;
  };
}

export interface CreateWorkResponse {
  success: true;
  work: Work;
}

export interface UpdateWorkResponse {
  success: true;
  work: Work;
}

export interface ListWorksResponse {
  success: true;
  works: WorkWithCounts[];
}

export interface FetchWorkResponse {
  success: true;
  work: Work;
}

export interface ListTagsResponse {
  success: true;
  tags: Tag[];
}

/** unlink: copies flattened (work_id -> null). delete: copies cascade-deleted. */
export interface DeleteWorkResponse {
  success: true;
  deleted: {
    work_id: string;
    mode: WorkDeleteMode;
    /** Copies unlinked (mode=unlink) or deleted (mode=delete). */
    copies: number;
  };
}

// One relevant passage to highlight, with every occurrence located as a
// [start, end) char range into HighlightResponse.text.
export interface HighlightSpan {
  text: string;
  ranges: [number, number][];
}

// Search-result highlighting: the page text the ranges index into (cleaned of
// OCR markup) plus the spans an LLM judged relevant to the query. Spans that
// couldn't be located verbatim are dropped server-side, so every range is
// safe to wrap.
export interface HighlightResponse {
  success: true;
  text: string;
  spans: HighlightSpan[];
}
