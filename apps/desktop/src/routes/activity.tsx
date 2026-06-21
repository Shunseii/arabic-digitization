import type { BookWithStatus, FileStatus } from "@qiraa/shared";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, RefreshCw } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Centered, Loading, StatusBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { useConfigState } from "@/lib/config-context";
import { colors } from "@/theme";

const READABLE: FileStatus["state"][] = ["done", "approved", "needs_review"];
const isPending = (f: FileStatus): boolean =>
  f.state === "queued" || f.state === "processing";

const sum = (
  books: BookWithStatus[],
  key: keyof BookWithStatus["counts"],
): number => books.reduce((n, b) => n + (b.counts[key] ?? 0), 0);

const relativeTime = (raw: number): string => {
  const ms = raw < 1e12 ? raw * 1000 : raw; // tolerate seconds or ms
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

const Stat = ({
  value,
  label,
  color,
}: {
  value: number;
  label: string;
  color: string;
}) => (
  <div className="flex flex-col items-center gap-1">
    <span className="text-[22px] font-semibold" style={{ color }}>
      {value}
    </span>
    <span className="text-xs text-text-muted">{label}</span>
  </div>
);

export const ActivityScreen = () => {
  const navigate = useNavigate();
  const { configured, ready } = useConfigState();

  const booksQuery = useQuery({
    queryKey: ["books"],
    queryFn: api.listBooks,
    enabled: configured,
    refetchInterval: (q) =>
      q.state.data?.some(
        (b) => (b.counts.queued ?? 0) + (b.counts.processing ?? 0) > 0,
      )
        ? 5000
        : false,
  });
  const recentQuery = useQuery({
    queryKey: ["recent"],
    queryFn: () => api.recentFiles(25),
    enabled: configured,
    refetchInterval: (query) =>
      query.state.data?.some((r) => isPending(r.file)) ? 5000 : false,
  });

  if (!ready) return <Loading />;
  if (!configured)
    return (
      <Centered>
        <p className="text-sm text-text-secondary">
          Configure the API in Settings to see activity.
        </p>
      </Centered>
    );

  const books = booksQuery.data ?? [];
  const queued = sum(books, "queued") + sum(books, "processing");
  const done = sum(books, "done") + sum(books, "approved");
  const failed = sum(books, "failed");
  const recent = recentQuery.data ?? [];

  const refetchAll = () => {
    booksQuery.refetch();
    recentQuery.refetch();
  };

  return (
    <div className="flex-1 overflow-y-auto px-10 py-8">
      <div className="mx-auto max-w-3xl">
        <div className="flex flex-row items-center justify-between">
          <h1 className="text-[30px] font-semibold text-ink">Activity</h1>
          <button
            type="button"
            onClick={refetchAll}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-surface"
          >
            <RefreshCw size={17} color={colors.textSecondary} />
          </button>
        </div>

        <div className="mt-4 flex flex-row items-center justify-around rounded-2xl border border-border bg-surface px-2 py-3.5">
          <Stat value={done} label="done" color="#46B97D" />
          <span className="h-8 w-px bg-hairline" />
          <Stat value={queued} label="queued" color="#5C8DF0" />
          <span className="h-8 w-px bg-hairline" />
          <Stat value={failed} label="failed" color="#EE6A4D" />
        </div>

        <p className="mt-5 text-xs font-bold tracking-wide text-text-muted">
          RECENTLY SCANNED
        </p>

        {recentQuery.isLoading ? (
          <div className="mt-10">
            <Loading />
          </div>
        ) : recent.length === 0 ? (
          <p className="mt-3 text-sm text-text-secondary">
            No pages yet. Open a book and upload some scans.
          </p>
        ) : (
          <div className="mt-2">
            {recent.map((r, i) => {
              const readable = READABLE.includes(r.file.state);
              const label =
                r.file.page_number != null ? String(r.file.page_number) : "—";
              return (
                <button
                  type="button"
                  key={r.file.file_id}
                  disabled={!readable}
                  onClick={() =>
                    navigate(`/reader/${r.book_id}/${r.file.file_id}`)
                  }
                  className="flex w-full flex-row items-center gap-3 py-3 text-left disabled:cursor-default"
                  style={
                    i > 0
                      ? { borderTop: `1px solid ${colors.hairline}` }
                      : undefined
                  }
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-alt">
                    <span className="text-sm font-semibold text-ink">
                      {label}
                    </span>
                  </span>
                  <span className="flex flex-1 flex-col gap-0.5 overflow-hidden">
                    <span className="truncate text-base text-ink" dir="rtl">
                      {r.title}
                    </span>
                    <span className="text-xs text-text-muted">
                      {relativeTime(r.file.updated_at)} ago
                    </span>
                  </span>
                  <StatusBadge state={r.file.state} />
                  {readable && (
                    <ChevronRight size={16} color={colors.textMuted} />
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
