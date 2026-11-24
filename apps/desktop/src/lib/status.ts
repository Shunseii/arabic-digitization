import type { FileStatus } from "@qiraa/shared";
import { api } from "@/lib/api";
import { queryClient } from "@/lib/query";

// A slow write can commit with an older updated_at than one already seen, so
// each delta re-asks for the last minute rather than strictly after the newest.
const OVERLAP_MS = 60_000;

export const statusKey = (bookId: string) => ["status", bookId] as const;
export const recentKey = ["recent"] as const;

// Matches the server order: page_number IS NULL, page_number, order_hint.
const byPage = (a: FileStatus, b: FileStatus): number => {
  if ((a.page_number === null) !== (b.page_number === null)) {
    return a.page_number === null ? 1 : -1;
  }
  const page = (a.page_number ?? 0) - (b.page_number ?? 0);
  if (page !== 0) return page;
  return (a.order_hint ?? -Infinity) - (b.order_hint ?? -Infinity) || 0;
};

/**
 * A book's files. When the cache already holds them, fetches only files
 * changed since then and merges; falls back to a full fetch when the merged
 * count disagrees with the server's total (files were deleted, or missed).
 */
export const loadStatus = async (bookId: string): Promise<FileStatus[]> => {
  const previous = queryClient.getQueryData<FileStatus[]>(statusKey(bookId));
  if (!previous || previous.length === 0) {
    return (await api.status({ bookId })).files;
  }

  const newest = previous.reduce((max, f) => Math.max(max, f.updated_at), 0);
  const delta = await api.status({
    bookId,
    since: Math.max(0, newest - OVERLAP_MS),
  });
  const byId = new Map(previous.map((f) => [f.file_id, f]));
  for (const f of delta.files) byId.set(f.file_id, f);
  if (byId.size !== delta.files_total) {
    return (await api.status({ bookId })).files;
  }
  return [...byId.values()].sort(byPage);
};

/** Drops a deleted file from the cache, so the next refresh stays a delta. */
export const forgetFile = ({
  bookId,
  fileId,
}: {
  bookId: string;
  fileId: string;
}) =>
  queryClient.setQueryData<FileStatus[]>(statusKey(bookId), (files) =>
    files?.filter((f) => f.file_id !== fileId),
  );
