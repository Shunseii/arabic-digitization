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

/** Content types the upload endpoint accepts for a page fragment. */
export const UPLOAD_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type UploadContentType = (typeof UPLOAD_CONTENT_TYPES)[number];

/** A book: one copy/scan of a work. Copies of one work share a work_id. */
export interface Book {
  id: string;
  title: string;
  created_at: number;
  /** The work this copy belongs to; null/undefined = ungrouped/standalone. */
  work_id?: string | null;
  ocr_instructions?: string | null;
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
  /** Attach to an existing work; if omitted a work is auto-created from the title. */
  work_id?: string;
  /** Tags for the auto-created work (created on write); ignored when work_id is given. */
  tags?: string[];
}

export interface BookUpdateBody {
  title?: string;
  /** null clears the stored instructions. */
  ocr_instructions?: string | null;
  /** Reassign to a work; null unlinks (flat). */
  work_id?: string | null;
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
}

export interface BookExportResponse {
  success: true;
  book_id: string;
  files: ExportFile[];
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

/** OCR is now enqueued (async); poll status/export for the result. */
export interface FileOcrResponse {
  success: true;
  file_id: string;
  state: "queued";
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
