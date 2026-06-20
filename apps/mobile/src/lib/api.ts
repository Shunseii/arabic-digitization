import type {
  Book,
  BookCreateBody,
  BookExportResponse,
  BookStatusResponse,
  CreateBookResponse,
  DeleteBookResponse,
  ExportFile,
  FetchBookResponse,
  FileOcrResponse,
  FileRecord,
  FileStatus,
  ListBooksResponse,
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
