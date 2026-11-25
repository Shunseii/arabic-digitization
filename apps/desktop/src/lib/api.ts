import type {
  Book,
  BookCreateBody,
  BookExportResponse,
  BookStatusResponse,
  BookUpdateBody,
  CreateBookResponse,
  CreateWorkResponse,
  DeleteBookResponse,
  DeleteWorkResponse,
  ExportFile,
  FetchBookResponse,
  FetchWorkResponse,
  FileDeleteResponse,
  FileOcrResponse,
  FileRecord,
  FileUpdateResponse,
  HighlightResponse,
  JobsResponse,
  ListBooksResponse,
  ListTagsResponse,
  ListWorksResponse,
  QueueReviewResponse,
  RecentFile,
  RecentFilesResponse,
  ReviewSummaryResponse,
  SpendResponse,
  UpdateBookResponse,
  UpdateWorkResponse,
  UploadContentType,
  UploadFileResponse,
  Work,
  WorkCreateBody,
  WorkDeleteMode,
  WorkUpdateBody,
} from "@qiraa/shared";
import { getConfig } from "./config";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const authHeaders = (): Record<string, string> => ({
  Authorization: `Bearer ${getConfig().key}`,
});

const base = (): string => getConfig().endpoint;

const safeText = async (res: Response): Promise<string> => {
  try {
    return await res.text();
  } catch {
    return res.statusText;
  }
};

const asJson = async <T>(res: Response): Promise<T> => {
  if (!res.ok) throw new ApiError(res.status, await safeText(res));
  return (await res.json()) as T;
};

export const api = {
  listBooks: async (): Promise<ListBooksResponse["books"]> =>
    (
      await asJson<ListBooksResponse>(
        await fetch(`${base()}/api/books`, { headers: authHeaders() }),
      )
    ).books,

  getBook: async (id: string): Promise<FetchBookResponse["book"]> =>
    (
      await asJson<FetchBookResponse>(
        await fetch(`${base()}/api/books/${id}`, { headers: authHeaders() }),
      )
    ).book,

  createBook: async (body: BookCreateBody): Promise<Book> =>
    (
      await asJson<CreateBookResponse>(
        await fetch(`${base()}/api/books`, {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      )
    ).book,

  /** Update a book's title and/or OCR instructions. null clears instructions. */
  updateBook: async ({
    id,
    body,
  }: {
    id: string;
    body: BookUpdateBody;
  }): Promise<Book> =>
    (
      await asJson<UpdateBookResponse>(
        await fetch(`${base()}/api/books/${id}`, {
          method: "PATCH",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      )
    ).book,

  deleteBook: async (id: string): Promise<DeleteBookResponse> =>
    asJson<DeleteBookResponse>(
      await fetch(`${base()}/api/books/${id}`, {
        method: "DELETE",
        headers: authHeaders(),
      }),
    ),

  // --- Works & tags ---

  listWorks: async (): Promise<ListWorksResponse["works"]> =>
    (
      await asJson<ListWorksResponse>(
        await fetch(`${base()}/api/works`, { headers: authHeaders() }),
      )
    ).works,

  getWork: async (id: string): Promise<Work> =>
    (
      await asJson<FetchWorkResponse>(
        await fetch(`${base()}/api/works/${id}`, { headers: authHeaders() }),
      )
    ).work,

  createWork: async (body: WorkCreateBody): Promise<Work> =>
    (
      await asJson<CreateWorkResponse>(
        await fetch(`${base()}/api/works`, {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      )
    ).work,

  updateWork: async ({
    id,
    body,
  }: {
    id: string;
    body: WorkUpdateBody;
  }): Promise<Work> =>
    (
      await asJson<UpdateWorkResponse>(
        await fetch(`${base()}/api/works/${id}`, {
          method: "PATCH",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      )
    ).work,

  /** Delete a work. mode "unlink" flattens its copies; "delete" cascade-deletes them. */
  deleteWork: async ({
    id,
    mode = "unlink",
  }: {
    id: string;
    mode?: WorkDeleteMode;
  }): Promise<DeleteWorkResponse> =>
    asJson<DeleteWorkResponse>(
      await fetch(`${base()}/api/works/${id}?copies=${mode}`, {
        method: "DELETE",
        headers: authHeaders(),
      }),
    ),

  listTags: async (): Promise<ListTagsResponse["tags"]> =>
    (
      await asJson<ListTagsResponse>(
        await fetch(`${base()}/api/tags`, { headers: authHeaders() }),
      )
    ).tags,

  /** A book's files; with `since`, only those updated after it (see lib/status). */
  status: async ({
    bookId,
    since,
  }: {
    bookId: string;
    since?: number;
  }): Promise<BookStatusResponse> =>
    asJson<BookStatusResponse>(
      await fetch(
        `${base()}/api/books/${bookId}/status${since === undefined ? "" : `?since=${since}`}`,
        { headers: authHeaders() },
      ),
    ),

  exportBook: async (id: string): Promise<ExportFile[]> =>
    (
      await asJson<BookExportResponse>(
        await fetch(`${base()}/api/books/${id}/export`, {
          headers: authHeaders(),
        }),
      )
    ).files,

  fileText: async ({
    bookId,
    fileId,
  }: {
    bookId: string;
    fileId: string;
  }): Promise<string> => {
    const res = await fetch(
      `${base()}/api/books/${bookId}/files/${fileId}/text`,
      { headers: authHeaders() },
    );
    if (!res.ok) throw new ApiError(res.status, await safeText(res));
    return res.text();
  },

  /**
   * Ask the API which passages on a page to highlight for a search query.
   * Returns the cleaned page text plus located [start,end) ranges into it.
   * Cross-lingual / semantic: an English query can light up an Arabic passage.
   */
  highlight: async ({
    bookId,
    fileId,
    query,
  }: {
    bookId: string;
    fileId: string;
    query: string;
  }): Promise<HighlightResponse> =>
    asJson<HighlightResponse>(
      await fetch(`${base()}/api/books/${bookId}/files/${fileId}/highlight`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      }),
    ),

  /**
   * Upload one scanned page. The API takes the raw image bytes as the request
   * body (not multipart) with the matching Content-Type. On desktop the bytes
   * come from a file the user picked, so we pass the Blob directly rather than
   * resolving a `file://` uri like the mobile client does.
   */
  uploadPage: async ({
    bookId,
    blob,
    page,
    mime = "image/jpeg",
  }: {
    bookId: string;
    blob: Blob;
    page?: number;
    mime?: UploadContentType;
  }): Promise<FileRecord> => {
    const url = `${base()}/api/books/${bookId}/files${page != null ? `?page=${page}` : ""}`;
    return (
      await asJson<UploadFileResponse>(
        await fetch(url, {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": mime },
          body: blob,
        }),
      )
    ).file;
  },

  /** Change a page's number (re-labels/re-orders scan + text). null clears it. */
  updatePageNumber: async ({
    bookId,
    fileId,
    page,
  }: {
    bookId: string;
    fileId: string;
    page: number | null;
  }): Promise<FileRecord> =>
    (
      await asJson<FileUpdateResponse>(
        await fetch(`${base()}/api/books/${bookId}/files/${fileId}`, {
          method: "PATCH",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ page_number: page }),
        }),
      )
    ).file,

  /** Delete a page: its scan, transcription, and row. */
  deleteFile: async ({
    bookId,
    fileId,
  }: {
    bookId: string;
    fileId: string;
  }): Promise<FileDeleteResponse> =>
    asJson<FileDeleteResponse>(
      await fetch(`${base()}/api/books/${bookId}/files/${fileId}`, {
        method: "DELETE",
        headers: authHeaders(),
      }),
    ),

  /** Recent page-fragments across all books, newest first (for Activity). */
  /** Running work and queue messages that ran out of retries. */
  jobs: async (): Promise<JobsResponse> =>
    asJson<JobsResponse>(
      await fetch(`${base()}/api/jobs`, { headers: authHeaders() }),
    ),

  /**
   * Queue the book's done pages for the Opus review. Without `all`, the pages
   * done before review was switched on; with it, every done page (a one-off,
   * even with review off). Hand-edited pages are always left out.
   */
  queueReview: async ({
    bookId,
    all = false,
  }: {
    bookId: string;
    all?: boolean;
  }): Promise<QueueReviewResponse> =>
    asJson<QueueReviewResponse>(
      await fetch(`${base()}/api/books/${bookId}/review`, {
        method: "POST",
        headers: all
          ? { ...authHeaders(), "Content-Type": "application/json" }
          : authHeaders(),
        body: all ? JSON.stringify({ all: true }) : undefined,
      }),
    ),

  /** Opus review totals over the last `days` (for review cost estimates). */
  reviewSummary: async ({
    days,
  }: {
    days: number;
  }): Promise<ReviewSummaryResponse> =>
    asJson<ReviewSummaryResponse>(
      await fetch(`${base()}/api/reviews/summary?days=${days}`, {
        headers: authHeaders(),
      }),
    ),

  /** What OCR and the Opus review cost over the last `days` (Usage). */
  spend: async ({
    days,
    bookId,
  }: {
    days: number;
    bookId?: string;
  }): Promise<SpendResponse> =>
    asJson<SpendResponse>(
      await fetch(
        `${base()}/api/spend?days=${days}${bookId ? `&book=${encodeURIComponent(bookId)}` : ""}`,
        { headers: authHeaders() },
      ),
    ),

  recentFiles: async (limit = 25): Promise<RecentFile[]> =>
    (
      await asJson<RecentFilesResponse>(
        await fetch(`${base()}/api/files/recent?limit=${limit}`, {
          headers: authHeaders(),
        }),
      )
    ).files,

  /** Re-run OCR on a single file now (synchronous server-side). */
  rerunOcr: async ({
    bookId,
    fileId,
  }: {
    bookId: string;
    fileId: string;
  }): Promise<FileOcrResponse> =>
    asJson<FileOcrResponse>(
      await fetch(`${base()}/api/books/${bookId}/files/${fileId}/ocr`, {
        method: "POST",
        headers: authHeaders(),
      }),
    ),

  /**
   * Fetch the original scan and return an object URL for an <img>. A browser
   * <img> can't carry an Authorization header, so we pull the bytes through
   * the authed fetch and wrap them in a blob URL. Caller must revokeObjectURL.
   */
  fetchImageObjectUrl: async ({
    bookId,
    fileId,
  }: {
    bookId: string;
    fileId: string;
  }): Promise<string> => {
    const res = await fetch(
      `${base()}/api/books/${bookId}/files/${fileId}/image`,
      { headers: authHeaders() },
    );
    if (!res.ok) throw new ApiError(res.status, await safeText(res));
    return URL.createObjectURL(await res.blob());
  },

  /** Validate an endpoint + key pair before saving (used by Settings). */
  ping: async ({
    endpoint,
    key,
  }: {
    endpoint: string;
    key: string;
  }): Promise<boolean> => {
    const res = await fetch(`${endpoint.replace(/\/+$/, "")}/api/books`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    return res.ok;
  },
};
