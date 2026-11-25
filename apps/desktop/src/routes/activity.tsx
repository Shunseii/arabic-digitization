import type { BookWithStatus, FailedMessage, FileStatus } from "@qiraa/shared";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Centered, Loading, RefreshButton, StatusBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { useConfigState } from "@/lib/config-context";
import { recentKey } from "@/lib/status";
import { colors, statusColors } from "@/theme";

const READABLE: FileStatus["state"][] = ["done", "approved", "needs_review"];

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

const KIND_LABEL: Record<FailedMessage["kind"], string> = {
  ocr: "OCR",
  review_apply: "Review",
  reindex: "Reindex",
};

// Where a failure is acted on: an OCR failure on its book (where a page's OCR
// is re-run), a review failure on the page itself, a reindex on its book.
const failureTarget = (f: FailedMessage): string | null => {
  if (f.kind === "review_apply" && f.book_id) {
    return `/reader/${f.book_id}/${f.file_id}`;
  }
  return f.book_id ? `/book/${f.book_id}` : null;
};

const pageLabel = (f: FailedMessage): string =>
  f.page_number != null ? String(f.page_number) : "—";

// Errors are stored as the provider or database put them (often a JSON
// body). Show a short plain message; the raw text stays in the hover title.
const KNOWN_ERRORS: { test: RegExp; message: string }[] = [
  { test: /overloaded_error|Claude 529/i, message: "Claude overloaded (529)" },
  { test: /^Claude 429|rate_limit_error/i, message: "Claude rate limited (429)" },
  { test: /^Inkling 503/i, message: "Inkling unavailable (503)" },
  { test: /^Inkling 429/i, message: "Inkling rate limited (429)" },
  {
    test: /D1.*(network connection lost|reset|timed? ?out)/i,
    message: "Database connection lost",
  },
  { test: /timed out/i, message: "Timed out" },
];

const ERROR_SHORT_MAX = 80;

const shortError = (raw: string): string => {
  const known = KNOWN_ERRORS.find((k) => k.test.test(raw));
  if (known) return known.message;
  // Drop a trailing JSON body, keep the first sentence.
  const text = raw.split(/[{[]/, 1)[0]?.replace(/[:\s]+$/, "") || raw;
  const sentence = text.split(/(?<=\.)\s/, 1)[0] ?? text;
  return sentence.length > ERROR_SHORT_MAX
    ? `${sentence.slice(0, ERROR_SHORT_MAX - 1)}…`
    : sentence;
};

const FailedSection = ({
  count,
  recent,
}: {
  count: number;
  recent: FailedMessage[];
}) => {
  const navigate = useNavigate();
  return (
    <>
      <p className="mt-5 text-xs font-bold tracking-wide text-text-muted">
        GAVE UP · {count}
        {count > recent.length && (
          <span className="font-normal">
            {" "}
            (showing {recent.length} of {count})
          </span>
        )}
      </p>
      <div className="mt-2">
        {recent.map((f, i) => {
          const target = failureTarget(f);
          return (
            <button
              type="button"
              key={f.id}
              disabled={!target}
              onClick={() => target && navigate(target)}
              className="flex w-full flex-row items-center gap-3 py-3 text-left disabled:cursor-default"
              style={
                i > 0
                  ? { borderTop: `1px solid ${colors.hairline}` }
                  : undefined
              }
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-alt">
                <span className="text-sm font-semibold text-ink">
                  {pageLabel(f)}
                </span>
              </span>
              <span className="flex flex-1 flex-col gap-0.5 overflow-hidden">
                <span className="truncate text-base text-ink" dir="rtl">
                  {f.book_title ?? f.book_id ?? "—"}
                </span>
                <span
                  className="truncate text-xs text-text-secondary"
                  title={f.error ?? undefined}
                >
                  {f.error ? shortError(f.error) : "No error recorded"}
                </span>
                <span className="text-xs text-text-muted">
                  {relativeTime(f.last_failed_at)} ago
                </span>
              </span>
              <span
                className="rounded-full px-2.5 py-1 text-xs font-semibold"
                style={{
                  backgroundColor: `${statusColors.failed}22`,
                  color: statusColors.failed,
                }}
              >
                {KIND_LABEL[f.kind]}
              </span>
              {target && <ChevronRight size={16} color={colors.textMuted} />}
            </button>
          );
        })}
      </div>
    </>
  );
};

export const ActivityScreen = () => {
  const navigate = useNavigate();
  const { configured, ready } = useConfigState();

  const booksQuery = useQuery({
    queryKey: ["books"],
    queryFn: api.listBooks,
    enabled: configured,
  });
  const recentQuery = useQuery({
    queryKey: recentKey,
    queryFn: () => api.recentFiles(25),
    enabled: configured,
  });
  const jobsQuery = useQuery({
    queryKey: ["jobs"],
    queryFn: api.jobs,
    enabled: configured,
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
  const queued =
    sum(books, "queued") +
    sum(books, "processing") +
    sum(books, "rate_limited");
  const done = sum(books, "done") + sum(books, "approved");
  const failed = sum(books, "failed");
  const recent = recentQuery.data ?? [];

  const deadMessages = jobsQuery.data?.failed;

  const refetchAll = () => {
    booksQuery.refetch();
    recentQuery.refetch();
    jobsQuery.refetch();
  };

  return (
    <div className="flex-1 overflow-y-auto px-10 py-8">
      <div className="mx-auto max-w-3xl">
        <div className="flex flex-row items-center justify-between">
          <h1 className="text-[30px] font-semibold text-ink">Activity</h1>
          <RefreshButton
            onRefresh={refetchAll}
            refreshing={
              booksQuery.isFetching ||
              recentQuery.isFetching ||
              jobsQuery.isFetching
            }
          />
        </div>

        <div className="mt-4 flex flex-row items-center justify-around rounded-2xl border border-border bg-surface px-2 py-3.5">
          <Stat value={done} label="done" color="#46B97D" />
          <span className="h-8 w-px bg-hairline" />
          <Stat value={queued} label="queued" color="#5C8DF0" />
          <span className="h-8 w-px bg-hairline" />
          <Stat value={failed} label="failed" color="#EE6A4D" />
        </div>

        {deadMessages && deadMessages.count > 0 && (
          <FailedSection
            count={deadMessages.count}
            recent={deadMessages.recent}
          />
        )}

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
              const readable = READABLE.includes(r.state);
              const label = r.page_number != null ? String(r.page_number) : "—";
              return (
                <button
                  type="button"
                  key={r.file_id}
                  disabled={!readable}
                  onClick={() => navigate(`/reader/${r.book_id}/${r.file_id}`)}
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
                      {r.book_title}
                    </span>
                    <span className="text-xs text-text-muted">
                      {relativeTime(r.updated_at)} ago
                    </span>
                  </span>
                  <StatusBadge state={r.state} />
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
