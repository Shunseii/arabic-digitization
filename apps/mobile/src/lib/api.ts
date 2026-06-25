import type {
  Book,
  BookCreateBody,
  BookExportResponse,
  BookStatusResponse,
  BookUpdateBody,
  CreateBookResponse,
  DeleteBookResponse,
  ExportFile,
  FetchBookResponse,
  FileDeleteResponse,
  FileOcrResponse,
  FileRecord,
  FileStatus,
  FileUpdateResponse,
  HighlightResponse,
  ListBooksResponse,
  UpdateBookResponse,
  UploadContentType,
  UploadFileResponse,
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

  status: async (id: string): Promise<FileStatus[]> =>
    (
      await asJson<BookStatusResponse>(
        await fetch(`${base()}/api/books/${id}/status`, {
          headers: authHeaders(),
        }),
      )
    ).files,

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
   * body (not multipart) with the matching Content-Type.
   */
  uploadPage: async ({
    bookId,
    uri,
    page,
    mime = "image/jpeg",
  }: {
    bookId: string;
    uri: string;
    page?: number;
    mime?: UploadContentType;
  }): Promise<FileRecord> => {
    const blob = await (await fetch(uri)).blob();
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
  recentFiles: async (
    limit = 20,
  ): Promise<{ book_id: string; title: string; file: FileStatus }[]> => {
    const books = await api.listBooks();
    const groups = await Promise.all(
      books.map(async (b) =>
        (await api.status(b.id)).map((file) => ({
          book_id: b.id,
          title: b.title,
          file,
        })),
      ),
    );
    return groups
      .flat()
      .sort((a, b) => b.file.updated_at - a.file.updated_at)
      .slice(0, limit);
  },

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

  /** Image source (uri + auth header) for the original scan — pass to <Image>. */
  imageSource: ({
    bookId,
    fileId,
  }: {
    bookId: string;
    fileId: string;
  }): { uri: string; headers: Record<string, string> } => ({
    uri: `${base()}/api/books/${bookId}/files/${fileId}/image`,
    headers: authHeaders(),
  }),

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
