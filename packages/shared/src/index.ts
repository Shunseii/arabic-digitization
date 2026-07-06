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
  "application/pdf",
] as const;

export type UploadContentType = (typeof UPLOAD_CONTENT_TYPES)[number];

/** A book: top-level collection of scanned page fragments. */
export interface Book {
  id: string;
  title: string;
  created_at: number;
  ocr_instructions?: string | null;
}

/** Book plus a per-state file count (the dashboard/library summary). */
export interface BookWithStatus extends Book {
  files_total: number;
  /** File count keyed by state; only present states appear. */
  counts: Partial<Record<FileState, number>>;
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
}

export interface BookUpdateBody {
  title?: string;
  /** null clears the stored instructions. */
  ocr_instructions?: string | null;
}

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
