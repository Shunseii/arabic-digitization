import type { BookWithStatus, FailedMessage } from "@qiraa/shared";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronRight,
  CloudOff,
  Plug,
  RefreshCw,
  ScanLine,
} from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { HeaderCell, LeadCell, Stat } from "@/components/table";
import {
  Button,
  cx,
  EmptyState,
  PageHeader,
  RefreshControl,
  StatusPill,
} from "@/components/ui";
import { api } from "@/lib/api";
import { useConfigState } from "@/lib/config-context";
import { errorMessage } from "@/lib/errors";
import { ago, count } from "@/lib/format";
import { recentKey } from "@/lib/status";
import { statusLabel, statusTone } from "@/theme";

const sum = (
  books: BookWithStatus[],
  key: keyof BookWithStatus["counts"],
): number => books.reduce((n, b) => n + (b.counts[key] ?? 0), 0);

const when = (ms: number) => {
  const a = ago(ms);
  return a === "now" ? a : `${a} ago`;
};

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

// Errors are stored as the provider or database put them (often a JSON
// body). Show a short plain message; the raw text stays in the hover title.
const KNOWN_ERRORS: { test: RegExp; message: string }[] = [
  { test: /overloaded_error|Claude 529/i, message: "Claude overloaded (529)" },
  {
    test: /^Claude 429|rate_limit_error/i,
    message: "Claude rate limited (429)",
  },
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

const COL = {
  page: "w-[100px]",
  status: "w-[140px]",
  when: "w-[100px]",
  go: "w-12",
};

const Card = ({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}) => (
  <section className="flex flex-col gap-2 rounded-lg border border-line bg-surface px-6 pb-2 pt-5">
    <h2 className="font-display text-section font-semibold leading-[1.2] tracking-[-0.01em] text-ink">
      {title}
    </h2>
    <div className="flex flex-col">{children}</div>
  </section>
);

const TableHead = ({ second }: { second: string }) => (
  <div className="flex items-center border-b border-line">
    <HeaderCell className={COL.page}>Page</HeaderCell>
    <HeaderCell className="flex-1">{second}</HeaderCell>
    <HeaderCell className={COL.status}>Status</HeaderCell>
    <HeaderCell className={cx(COL.when, "justify-end")}>When</HeaderCell>
    <HeaderCell className={COL.go} />
  </div>
);

const Row = ({
  lead,
  primary,
  status,
  when: time,
  onOpen,
  title,
}: {
  lead: string;
  primary: ReactNode;
  status: ReactNode;
  when: string;
  onOpen: (() => void) | null;
  title?: string;
}) => (
  <button
    type="button"
    disabled={!onOpen}
    onClick={() => onOpen?.()}
    title={title}
    className="flex w-full items-center border-b border-line py-3 text-left last:border-b-0 hover:bg-surface-2 disabled:cursor-default"
  >
    <LeadCell className={COL.page}>{lead}</LeadCell>
    <span className="flex min-w-0 flex-1 flex-col px-3">{primary}</span>
    <span className={cx(COL.status, "flex shrink-0 px-3")}>{status}</span>
    <span
      className={cx(
        COL.when,
        "shrink-0 px-3 text-right text-small tabular-nums text-ink",
      )}
    >
      {time}
    </span>
    <span className={cx(COL.go, "flex shrink-0 justify-end px-3 text-ink-3")}>
      {onOpen && <ChevronRight size={16} />}
    </span>
  </button>
);

const BookTitle = ({ children }: { children: ReactNode }) => (
  <span
    dir="rtl"
    className="truncate text-left font-ar text-body font-medium leading-[1.6] text-ink"
  >
    {children}
  </span>
);

const GaveUp = ({
  count: total,
  recent,
}: {
  count: number;
  recent: FailedMessage[];
}) => {
  const navigate = useNavigate();
  return (
    <Card
      title={
        <>
          Gave up{" "}
          <span className="font-body text-small font-normal tracking-normal text-ink-3">
            {total > recent.length
              ? `showing ${count(recent.length)} of ${count(total)}`
              : count(total)}
          </span>
        </>
      }
    >
      <TableHead second="Book" />
      {recent.map((f) => {
        const target = failureTarget(f);
        return (
          <Row
            key={f.id}
            lead={f.page_number != null ? count(f.page_number) : "—"}
            primary={
              <>
                <BookTitle>{f.book_title ?? f.book_id ?? "—"}</BookTitle>
                <span className="truncate text-small text-danger">
                  {f.error ? shortError(f.error) : "No error recorded"}
                </span>
              </>
            }
            title={f.error ?? undefined}
            status={<StatusPill tone="danger">{KIND_LABEL[f.kind]}</StatusPill>}
            when={when(f.last_failed_at)}
            onOpen={target ? () => navigate(target) : null}
          />
        );
      })}
    </Card>
  );
};

export const ActivityScreen = () => {
  const navigate = useNavigate();
  const { configured } = useConfigState();

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

  if (!configured)
    return (
      <>
        <PageHeader title="Activity" />
        <EmptyState
          icon={Plug}
          title="Connect to your API"
          body="Configure the API in Settings to see activity."
        >
          <Button onClick={() => navigate("/settings")}>Open Settings</Button>
        </EmptyState>
      </>
    );

  const refreshing =
    booksQuery.isFetching || recentQuery.isFetching || jobsQuery.isFetching;
  const refresh = () => {
    booksQuery.refetch();
    recentQuery.refetch();
    jobsQuery.refetch();
  };
  const header = (
    <PageHeader
      title="Activity"
      actions={
        <RefreshControl
          onRefresh={refresh}
          refreshing={refreshing}
          updatedAt={recentQuery.dataUpdatedAt}
          failed={recentQuery.isError}
        />
      }
    />
  );

  if (recentQuery.isError && !recentQuery.data)
    return (
      <>
        {header}
        <EmptyState
          icon={CloudOff}
          tone="danger"
          title="Couldn't load activity"
          body={errorMessage(recentQuery.error)}
        >
          <Button icon={RefreshCw} onClick={refresh} loading={refreshing}>
            Try again
          </Button>
        </EmptyState>
      </>
    );

  const recent = recentQuery.data ?? [];
  if (recentQuery.isSuccess && recent.length === 0)
    return (
      <>
        {header}
        <EmptyState
          icon={ScanLine}
          title="No pages yet"
          body="Open a book and upload some scans. They'll show up here as they're transcribed."
        >
          <Button onClick={() => navigate("/")}>Go to Library</Button>
        </EmptyState>
      </>
    );

  const books = booksQuery.data ?? [];
  const statsLoading = booksQuery.isLoading;
  const failed = sum(books, "failed");
  const deadMessages = jobsQuery.data?.failed;

  return (
    <>
      {header}
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-10 pb-10">
        <div className="flex items-center gap-4">
          <Stat
            className="flex-1"
            label="In queue"
            loading={statsLoading}
            value={count(sum(books, "queued") + sum(books, "rate_limited"))}
          />
          <Stat
            className="flex-1"
            label="Processing"
            loading={statsLoading}
            value={count(sum(books, "processing"))}
          />
          <Stat
            className="flex-1"
            label="Failed"
            loading={statsLoading}
            value={count(failed)}
            note={
              failed > 0 ? "Open a page to see why and re-run it" : undefined
            }
          />
        </div>

        {deadMessages && deadMessages.count > 0 && (
          <GaveUp count={deadMessages.count} recent={deadMessages.recent} />
        )}

        {!recentQuery.isLoading && (
          <Card title="Recently scanned">
            <TableHead second="Book" />
            {recent.map((r) => (
              <Row
                key={r.file_id}
                lead={r.page_number != null ? count(r.page_number) : "—"}
                primary={<BookTitle>{r.book_title}</BookTitle>}
                status={
                  <StatusPill tone={statusTone[r.state]}>
                    {statusLabel[r.state]}
                  </StatusPill>
                }
                when={when(r.updated_at)}
                onOpen={() => navigate(`/reader/${r.book_id}/${r.file_id}`)}
              />
            ))}
          </Card>
        )}
      </div>
    </>
  );
};
