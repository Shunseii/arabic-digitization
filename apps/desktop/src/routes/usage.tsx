import type { RecentPageReview, SpendKind, SpendResponse } from "@qiraa/shared";
import { useQuery } from "@tanstack/react-query";
import {
  ChartColumn,
  ChevronRight,
  CloudOff,
  Copy,
  Plug,
  RefreshCw,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { REVIEW_STATUS } from "@/components/review-diff";
import { HeaderCell, LeadCell, Stat } from "@/components/table";
import {
  Badge,
  Button,
  CheckOption,
  cx,
  DropdownTrigger,
  EmptyState,
  PageHeader,
  Popover,
  RefreshControl,
  Segmented,
  Skeleton,
  Tag,
} from "@/components/ui";
import { api } from "@/lib/api";
import { useConfigState } from "@/lib/config-context";
import { errorMessage } from "@/lib/errors";
import { ago, count } from "@/lib/format";
import { type ReviewRouteState, reviewPath } from "@/routes/review";

// Usage is built on GET /api/spend (totals by kind and model, a daily series
// by kind, the costliest books per kind). The design's per-run views (fallback
// reasons, latency percentiles, outliers, instruction versions, run detail)
// need run-level data no endpoint serves, so they aren't shown.

type Tab = "scorecard" | "trends";
type Range = "7" | "30" | "90";

const money = (n: number, digits = 2) => `$${n.toFixed(digits)}`;
const perPage = (cost: number, pages: number) =>
  pages > 0 ? money(cost / pages, 4) : "—";

const KIND_LABEL: Record<SpendKind, string> = { ocr: "OCR", review: "Review" };

// Series order is fixed everywhere (designs: Chart colors): OCR is the
// primary series (accent), review the second (mark).
const SERIES: Record<SpendKind, string> = {
  ocr: "bg-accent",
  review: "bg-mark",
};

const Card = ({
  title,
  sub,
  aside,
  children,
}: {
  title: string;
  sub?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) => (
  <section className="flex flex-col gap-2 rounded-lg border border-line bg-surface px-8 pb-6 pt-8">
    <div className="flex items-start gap-4">
      <div className="flex flex-col gap-0.5">
        <h2 className="font-display text-section font-semibold leading-[1.2] tracking-[-0.01em] text-ink">
          {title}
        </h2>
        {sub && <p className="text-small text-ink-2">{sub}</p>}
      </div>
      {aside && <div className="ml-auto">{aside}</div>}
    </div>
    {children}
  </section>
);

const Legend = () => (
  <div className="flex items-center gap-4">
    {(["ocr", "review"] as const).map((k) => (
      <span key={k} className="flex items-center gap-2 text-small text-ink-2">
        <span className={cx("size-2.5 rounded-[2px]", SERIES[k])} />
        {KIND_LABEL[k]}
      </span>
    ))}
  </div>
);

const Scorecard = ({
  data,
  onOpenBook,
}: {
  data: SpendResponse;
  onOpenBook: (id: string) => void;
}) => {
  const sum = (kind: SpendKind, key: "cost_usd" | "pages" | "calls") =>
    data.by_model
      .filter((m) => m.kind === kind)
      .reduce((n, m) => n + m[key], 0);
  const models = [...data.by_model].sort(
    (a, b) =>
      (a.kind === b.kind ? 0 : a.kind === "ocr" ? -1 : 1) ||
      b.cost_usd - a.cost_usd,
  );
  const books = [...data.top_books].sort(
    (a, b) =>
      (a.kind === b.kind ? 0 : a.kind === "ocr" ? -1 : 1) ||
      b.cost_usd - a.cost_usd,
  );
  return (
    <>
      <div className="flex items-stretch gap-4">
        <Stat
          className="flex-1"
          label="Pages transcribed"
          value={count(sum("ocr", "pages"))}
          note={`${count(sum("ocr", "calls"))} calls, retries included`}
        />
        <Stat
          className="flex-1"
          label="OCR spend"
          value={money(sum("ocr", "cost_usd"))}
        />
        <Stat
          className="flex-1"
          label="Review spend"
          value={money(sum("review", "cost_usd"))}
          note={`${count(sum("review", "pages"))} pages reviewed`}
        />
      </div>

      <Card
        title="By model"
        sub="Every billed call, OCR re-runs and fallbacks included."
      >
        <div className="flex flex-col">
          <div className="flex items-center border-b border-line">
            <HeaderCell className="flex-1">Model</HeaderCell>
            <HeaderCell className="w-28 justify-end">Calls</HeaderCell>
            <HeaderCell className="w-28 justify-end">Pages</HeaderCell>
            <HeaderCell className="w-32 justify-end">Cost / page</HeaderCell>
            <HeaderCell className="w-28 justify-end">Cost</HeaderCell>
          </div>
          {models.map((m) => (
            <div
              key={`${m.kind}-${m.model}`}
              className="flex items-center border-b border-line py-3 last:border-b-0"
            >
              <div className="flex flex-1 items-center gap-3 px-3">
                <span
                  className={cx(
                    "size-2.5 shrink-0 rounded-[2px]",
                    SERIES[m.kind],
                  )}
                />
                <div className="flex flex-col">
                  <span className="text-body font-semibold text-ink">
                    {m.model}
                  </span>
                  <span className="text-small text-ink-3">
                    {KIND_LABEL[m.kind]}
                  </span>
                </div>
              </div>
              <span className="w-28 px-3 text-right text-small tabular-nums text-ink">
                {count(m.calls)}
              </span>
              <span className="w-28 px-3 text-right text-small tabular-nums text-ink">
                {count(m.pages)}
              </span>
              <span className="w-32 px-3 text-right text-small tabular-nums text-ink">
                {perPage(m.cost_usd, m.pages)}
              </span>
              <span className="w-28 px-3 text-right text-body font-semibold tabular-nums text-ink">
                {money(m.cost_usd)}
              </span>
            </div>
          ))}
        </div>
      </Card>

      {books.length > 0 && (
        <Card title="By book" sub="The costliest books for each kind of spend.">
          <div className="flex flex-col">
            <div className="flex items-center border-b border-line">
              <HeaderCell className="flex-1">Book</HeaderCell>
              <HeaderCell className="w-28">Kind</HeaderCell>
              <HeaderCell className="w-28 justify-end">Pages</HeaderCell>
              <HeaderCell className="w-32 justify-end">Cost / page</HeaderCell>
              <HeaderCell className="w-28 justify-end">Cost</HeaderCell>
              <HeaderCell className="w-12" />
            </div>
            {books.map((b) => (
              <button
                type="button"
                key={`${b.kind}-${b.book_id}`}
                onClick={() => onOpenBook(b.book_id)}
                className="flex w-full items-center border-b border-line py-3 text-left last:border-b-0 hover:bg-surface-2"
              >
                <span
                  dir="rtl"
                  className="flex-1 px-3 text-left font-ar text-body font-medium leading-[1.6] text-ink"
                >
                  {b.title ?? b.book_id}
                </span>
                <span className="w-28 px-3">
                  <Tag>{KIND_LABEL[b.kind]}</Tag>
                </span>
                <span className="w-28 px-3 text-right text-small tabular-nums text-ink">
                  {count(b.pages)}
                </span>
                <span className="w-32 px-3 text-right text-small tabular-nums text-ink">
                  {perPage(b.cost_usd, b.pages)}
                </span>
                <span className="w-28 px-3 text-right text-small tabular-nums text-ink">
                  {money(b.cost_usd)}
                </span>
                <span className="flex w-12 justify-end px-3 text-ink-3">
                  <ChevronRight size={16} />
                </span>
              </button>
            ))}
          </div>
        </Card>
      )}
    </>
  );
};

const REVIEW_LIST_LIMIT = 50;

const ReviewedPages = ({
  reviews,
  failed,
  onOpen,
}: {
  reviews: RecentPageReview[] | undefined;
  failed: boolean;
  onOpen: (review: RecentPageReview) => void;
}) => (
  <Card
    title="Reviewed pages"
    sub={`The ${REVIEW_LIST_LIMIT} newest Opus reviews in this window. Open one to see what it changed in the OCR text.`}
  >
    <div className="flex flex-col">
      <div className="flex items-center border-b border-line">
        <HeaderCell className="w-20">Page</HeaderCell>
        <HeaderCell className="flex-1">Book</HeaderCell>
        <HeaderCell className="w-44">Result</HeaderCell>
        <HeaderCell className="w-52">Edits</HeaderCell>
        <HeaderCell className="w-24 justify-end">Cost</HeaderCell>
        <HeaderCell className="w-20 justify-end">When</HeaderCell>
        <HeaderCell className="w-12" />
      </div>
      {!reviews && failed && (
        <p className="py-6 text-center text-small text-danger">
          Couldn't load the reviewed pages. Refresh to try again.
        </p>
      )}
      {!reviews &&
        !failed &&
        [0, 1, 2].map((row) => (
          <div
            key={row}
            className="flex items-center gap-6 border-b border-line px-3 py-4 last:border-b-0"
          >
            <Skeleton className="h-5 w-10 rounded-sm" />
            <Skeleton className="h-4 flex-1 rounded-sm" />
            <Skeleton className="h-4 w-32 rounded-sm" />
          </div>
        ))}
      {reviews?.length === 0 && (
        <p className="py-6 text-center text-small text-ink-2">
          No pages were reviewed in this window.
        </p>
      )}
      {reviews?.map((review) => (
        <button
          type="button"
          key={`${review.file_id}-${review.batch_id}`}
          onClick={() => onOpen(review)}
          className="flex w-full items-center border-b border-line py-3 text-left last:border-b-0 hover:bg-surface-2"
        >
          <LeadCell className="w-20">
            {review.page_number != null ? count(review.page_number) : "—"}
          </LeadCell>
          <span
            dir="rtl"
            className="min-w-0 flex-1 truncate px-3 text-left font-ar text-body font-medium leading-[1.6] text-ink"
          >
            {review.book_title ?? review.book_id}
          </span>
          <span className="w-44 px-3">
            <Badge tone={REVIEW_STATUS[review.status].tone}>
              {REVIEW_STATUS[review.status].label}
            </Badge>
          </span>
          <span className="flex w-52 items-baseline gap-2 px-3 text-small tabular-nums">
            <span className="text-ink">
              {count(review.edits_applied)} applied
            </span>
            {review.edits_failed > 0 && (
              <span className="text-warn">
                {count(review.edits_failed)} not applied
              </span>
            )}
          </span>
          <span className="w-24 px-3 text-right text-small tabular-nums text-ink">
            {money(review.cost_usd, 3)}
          </span>
          <span
            className="w-20 px-3 text-right text-small tabular-nums text-ink-2"
            title={new Date(review.created_at).toLocaleString()}
          >
            {ago(review.created_at)}
          </span>
          <span className="flex w-12 justify-end px-3 text-ink-3">
            <ChevronRight size={16} />
          </span>
        </button>
      ))}
    </div>
  </Card>
);

const dayLabel = (day: string, opts: Intl.DateTimeFormatOptions) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    ...opts,
  });

// A round tick step that gives at most six gridlines.
const niceMax = (max: number): { top: number; step: number } => {
  if (max <= 0) return { top: 0.04, step: 0.01 };
  const raw = max / 5;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  return { top: step * Math.ceil(max / step), step };
};

const SpendChart = ({ data }: { data: SpendResponse }) => {
  const [hover, setHover] = useState<number | null>(null);

  // The API lists only days with spend; fill the window so gaps show as gaps.
  const days = useMemo(() => {
    const byDay = new Map(data.daily.map((d) => [d.day, d]));
    const out: { day: string; ocr: number; review: number }[] = [];
    const start = Date.parse(`${data.since_day}T00:00:00Z`);
    const today = new Date().toISOString().slice(0, 10);
    for (let t = start; ; t += 86_400_000) {
      const day = new Date(t).toISOString().slice(0, 10);
      const d = byDay.get(day);
      out.push({
        day,
        ocr: d?.ocr_cost_usd ?? 0,
        review: d?.review_cost_usd ?? 0,
      });
      if (day >= today || out.length > 100) break;
    }
    return out;
  }, [data]);

  const { top, step } = niceMax(Math.max(...days.map((d) => d.ocr + d.review)));
  const ticks = Array.from(
    { length: Math.round(top / step) + 1 },
    (_, i) => i * step,
  );
  const digits = step < 0.01 ? 3 : 2;
  const labelEvery = days.length > 40 ? 15 : 5;
  const hovered = hover === null ? null : days[hover];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-end gap-3 pt-8">
        <div className="relative h-[200px] w-11 shrink-0">
          {ticks.map((v) => (
            <span
              key={v}
              className="absolute right-0 -translate-y-1/2 text-label tabular-nums text-ink-3"
              style={{ top: `${100 - (v / top) * 100}%` }}
            >
              {money(v, digits)}
            </span>
          ))}
        </div>
        <figure
          aria-label="Spend per day"
          className="relative h-[200px] flex-1"
          onMouseLeave={() => setHover(null)}
        >
          {ticks.map((v) => (
            <div
              key={v}
              className="absolute inset-x-0 h-px bg-line"
              style={{ top: `${100 - (v / top) * 100}%` }}
            />
          ))}
          {hover !== null && (
            <div
              className="absolute inset-y-0 rounded bg-surface-2"
              style={{
                left: `${(hover / days.length) * 100}%`,
                width: `${100 / days.length}%`,
              }}
            />
          )}
          <div className="absolute inset-0 flex items-end gap-1">
            {days.map((d, i) => {
              const total = d.ocr + d.review;
              return (
                <div
                  key={d.day}
                  role="img"
                  aria-label={`${dayLabel(d.day, { day: "numeric", month: "short" })}: ${money(total)}`}
                  className="relative flex h-full flex-1 flex-col-reverse gap-0.5"
                  onMouseEnter={() => setHover(i)}
                >
                  {total > 0 && (
                    <div
                      className="flex flex-col-reverse gap-0.5"
                      style={{ height: `${(total / top) * 100}%` }}
                    >
                      {(["ocr", "review"] as const)
                        .filter((k) => d[k] > 0)
                        .map((k, j, shown) => (
                          <div
                            key={k}
                            className={cx(
                              "min-h-0.5",
                              SERIES[k],
                              j === shown.length - 1 && "rounded-t",
                            )}
                            // Shares of the day, so the flex-grows sum to 1 and fill the column.
                            style={{ flex: d[k] / total }}
                          />
                        ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {hovered && hover !== null && (
            <div
              className="pointer-events-none absolute top-8 z-10 flex w-56 flex-col gap-2 rounded-sm border border-line bg-surface p-3 shadow-md"
              style={
                hover < days.length / 2
                  ? {
                      left: `${((hover + 1) / days.length) * 100}%`,
                      marginLeft: 8,
                    }
                  : {
                      right: `${(1 - hover / days.length) * 100}%`,
                      marginRight: 8,
                    }
              }
            >
              <span className="text-small font-medium text-ink">
                {dayLabel(hovered.day, {
                  weekday: "short",
                  day: "numeric",
                  month: "short",
                })}
                {" · "}
                {money(hovered.ocr + hovered.review)}
              </span>
              {(["ocr", "review"] as const).map((k) => (
                <span
                  key={k}
                  className="flex items-center gap-2 text-small text-ink-2"
                >
                  <span className={cx("size-2 rounded-[2px]", SERIES[k])} />
                  {KIND_LABEL[k]} · {money(hovered[k])}
                </span>
              ))}
            </div>
          )}
        </figure>
      </div>
      <div className="flex gap-3">
        <div className="w-11 shrink-0" />
        <div className="relative h-4 flex-1">
          {days.map((d, i) =>
            i % labelEvery === 0 ? (
              <span
                key={d.day}
                className="absolute text-label text-ink-3"
                style={{ left: `${(i / days.length) * 100}%` }}
              >
                {dayLabel(d.day, { day: "numeric", month: "short" })}
              </span>
            ) : null,
          )}
        </div>
      </div>
    </div>
  );
};

const BookFilter = ({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
}) => {
  const { configured } = useConfigState();
  const [open, setOpen] = useState(false);
  // The Library's book list, shared through the query cache.
  const books = useQuery({
    queryKey: ["books"],
    queryFn: api.listBooks,
    enabled: configured,
  }).data;
  const selected = books?.find((b) => b.id === value);
  const pick = (id: string | null) => {
    onChange(id);
    setOpen(false);
  };
  return (
    <div className="relative">
      <DropdownTrigger
        active={value !== null}
        onClick={() => setOpen((o) => !o)}
        label={
          selected ? (
            <span dir="rtl" className="font-ar">
              {selected.title}
            </span>
          ) : (
            "All books"
          )
        }
      />
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        className="right-0 top-[calc(100%+8px)] max-h-80 w-64 origin-top-right overflow-y-auto"
      >
        <CheckOption
          checked={value === null}
          onToggle={() => pick(null)}
          label="All books"
        />
        {books?.map((b) => (
          <CheckOption
            key={b.id}
            checked={value === b.id}
            onToggle={() => pick(b.id)}
            label={
              <span dir="rtl" className="font-ar text-body">
                {b.title}
              </span>
            }
          />
        ))}
      </Popover>
    </div>
  );
};

export const UsageScreen = () => {
  const navigate = useNavigate();
  const { configured } = useConfigState();
  const [tab, setTab] = useState<Tab>("scorecard");
  const [range, setRange] = useState<Range>("30");
  const [bookId, setBookId] = useState<string | null>(null);

  const spendQuery = useQuery({
    queryKey: ["spend", range, bookId],
    queryFn: () =>
      api.spend({ days: Number(range), bookId: bookId ?? undefined }),
    enabled: configured,
  });
  const reviewsQuery = useQuery({
    queryKey: ["recent-reviews", range, bookId],
    queryFn: () =>
      api.recentReviews({
        days: Number(range),
        bookId: bookId ?? undefined,
        limit: REVIEW_LIST_LIMIT,
      }),
    enabled: configured && tab === "scorecard",
  });
  const openReview = (review: RecentPageReview) => {
    const state: ReviewRouteState = {
      pageNumber: review.page_number,
      bookTitle: review.book_title,
    };
    navigate(
      reviewPath({
        bookId: review.book_id,
        fileId: review.file_id,
        batchId: review.batch_id,
      }),
      { state },
    );
  };

  if (!configured)
    return (
      <>
        <PageHeader title="Usage" />
        <EmptyState
          icon={Plug}
          title="Connect to your API"
          body="Add your worker endpoint and key in Settings to see what OCR and review cost."
        >
          <Button onClick={() => navigate("/settings")}>Open Settings</Button>
        </EmptyState>
      </>
    );

  const data = spendQuery.data;
  const header = (
    <PageHeader
      title="Usage"
      actions={
        <RefreshControl
          label="Data as of"
          onRefresh={() => {
            spendQuery.refetch();
            if (tab === "scorecard") reviewsQuery.refetch();
          }}
          refreshing={spendQuery.isFetching}
          updatedAt={spendQuery.dataUpdatedAt}
          failed={spendQuery.isError}
        />
      }
    >
      <div className="flex items-center gap-3">
        <Segmented
          className="w-[330px]"
          value={tab}
          onChange={setTab}
          options={[
            { value: "scorecard", label: "Scorecard" },
            { value: "trends", label: "Trends" },
          ]}
        />
        <Segmented
          className="ml-auto w-[260px]"
          value={range}
          onChange={setRange}
          options={[
            { value: "7", label: "7 days" },
            { value: "30", label: "30 days" },
            { value: "90", label: "90 days" },
          ]}
        />
        <BookFilter value={bookId} onChange={setBookId} />
      </div>
    </PageHeader>
  );

  if (spendQuery.isError && !data)
    return (
      <>
        {header}
        <EmptyState
          icon={CloudOff}
          tone="danger"
          title="Couldn't load usage"
          body={`${errorMessage(spendQuery.error)} Nothing was lost.`}
        >
          <Button icon={RefreshCw} onClick={() => spendQuery.refetch()}>
            Try again
          </Button>
          <Button
            variant="secondary"
            icon={Copy}
            onClick={() =>
              navigator.clipboard.writeText(String(spendQuery.error))
            }
          >
            Copy error
          </Button>
        </EmptyState>
      </>
    );

  if (data && data.by_model.length === 0)
    return (
      <>
        {header}
        <EmptyState
          icon={ChartColumn}
          title="No spend yet"
          body={
            bookId
              ? "Nothing was billed for this book in this window."
              : "Spend is recorded from the moment a page finishes OCR. Upload pages to a book and come back after a few have been transcribed."
          }
        >
          {!bookId && (
            <Button onClick={() => navigate("/")}>Go to Library</Button>
          )}
        </EmptyState>
      </>
    );

  return (
    <>
      {header}
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-10 pb-10">
        {!data ? (
          <div className="flex items-stretch gap-4">
            <Stat
              className="flex-1"
              label="Pages transcribed"
              value=""
              loading
            />
            <Stat className="flex-1" label="OCR spend" value="" loading />
            <Stat className="flex-1" label="Review spend" value="" loading />
          </div>
        ) : tab === "scorecard" ? (
          <>
            <Scorecard
              data={data}
              onOpenBook={(id) => navigate(`/book/${id}`)}
            />
            <ReviewedPages
              reviews={reviewsQuery.data?.reviews}
              failed={reviewsQuery.isError}
              onOpen={openReview}
            />
          </>
        ) : (
          <Card
            title="Spend per day, by kind"
            sub={`${money(data.total_cost_usd)} in ${range} days`}
            aside={<Legend />}
          >
            <SpendChart data={data} />
          </Card>
        )}
      </div>
    </>
  );
};
