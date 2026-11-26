import type { PageReview, TextRevision } from "@qiraa/shared";
import { useQuery } from "@tanstack/react-query";
import {
  BookOpen,
  ChevronLeft,
  CircleAlert,
  CloudOff,
  FileSearch,
  Info,
  RefreshCw,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import {
  DiffLegend,
  DiffText,
  EditList,
  REVIEW_STATUS,
  reviewStatusLabel,
} from "@/components/review-diff";
import {
  Badge,
  Button,
  cx,
  EmptyState,
  IconButton,
  Segmented,
  Skeleton,
} from "@/components/ui";
import { ZoomableImage } from "@/components/zoomable-image";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { count, plural, usd } from "@/lib/format";
import { wordDiff } from "@/lib/word-diff";

type View = "changes" | "both";

/** What the Usage list already knows, passed along so the header fills at once. */
export interface ReviewRouteState {
  pageNumber?: number | null;
  bookTitle?: string | null;
}

export const reviewPath = ({
  bookId,
  fileId,
  batchId,
}: {
  bookId: string;
  fileId: string;
  batchId: string;
}) => `/usage/reviews/${bookId}/${fileId}/${batchId}`;

const CHANGE_NAME: Record<TextRevision["change"], string> = {
  edit: "edited by hand",
  ocr: "re-transcribed",
  review: "reviewed again",
};

export const reviewedAt = (ms: number) =>
  new Date(ms).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

const Section = ({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) => (
  <section className="flex flex-col gap-3">
    <div className="flex items-center gap-4 border-b border-line pb-2">
      <h2 className="font-display text-section font-semibold text-ink">
        {title}
      </h2>
      {aside && <div className="ml-auto">{aside}</div>}
    </div>
    {children}
  </section>
);

const Callout = ({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "warn";
  children: ReactNode;
}) => (
  <div
    className={cx(
      "flex items-start gap-3 rounded-md px-4 py-3 text-small",
      tone === "warn" ? "bg-warn-soft text-ink" : "bg-surface-2 text-ink-2",
    )}
  >
    <Info
      size={16}
      className={cx(
        "mt-0.5 shrink-0",
        tone === "warn" ? "text-warn" : "text-ink-3",
      )}
    />
    <p>{children}</p>
  </div>
);

const DiffSkeleton = () => (
  <div className="flex flex-col gap-4">
    {[100, 92, 97, 88, 64, 95].map((width, index) => (
      <Skeleton
        key={index}
        className="h-4 self-end rounded-sm"
        style={{ width: `${width}%` }}
      />
    ))}
  </div>
);

/**
 * The texts on either side of an applied review: the history entry it wrote
 * holds the text before it, and the next newer entry (or the current text, if
 * nothing changed the page since) holds the text it produced.
 */
const useReviewTexts = ({
  bookId,
  fileId,
  review,
}: {
  bookId: string;
  fileId: string;
  review: PageReview | undefined;
}) => {
  const revisionId = review?.revision_id ?? null;
  const history = useQuery({
    queryKey: ["text-history", bookId, fileId],
    queryFn: () => api.textHistory({ bookId, fileId }),
    enabled: revisionId !== null,
  });
  const revisions = history.data?.revisions ?? [];
  const position = revisions.findIndex((r) => r.id === revisionId);
  const newer = position > 0 ? revisions[position - 1] : undefined;
  const historyReady = history.isSuccess;

  const before = useQuery({
    queryKey: ["text", bookId, fileId, revisionId],
    queryFn: () =>
      api.fileText({ bookId, fileId, rev: revisionId ?? undefined }),
    enabled: revisionId !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const after = useQuery({
    queryKey: newer
      ? ["text", bookId, fileId, newer.id]
      : ["text", bookId, fileId],
    queryFn: () => api.fileText({ bookId, fileId, rev: newer?.id }),
    enabled: revisionId !== null && historyReady,
  });
  return { history, before, after, newer };
};

export const ReviewScreen = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const routeState = (location.state ?? {}) as ReviewRouteState;
  const {
    bookId = "",
    fileId = "",
    batchId = "",
  } = useParams<{ bookId: string; fileId: string; batchId: string }>();
  const [view, setView] = useState<View>("both");

  const bookQuery = useQuery({
    queryKey: ["book", bookId],
    queryFn: () => api.getBook(bookId),
    enabled: !routeState.bookTitle,
  });
  const reviewsQuery = useQuery({
    queryKey: ["page-reviews", bookId, fileId],
    queryFn: () => api.pageReviews({ bookId, fileId }),
  });
  const review = reviewsQuery.data?.reviews.find((r) => r.batch_id === batchId);
  const { history, before, after, newer } = useReviewTexts({
    bookId,
    fileId,
    review,
  });

  const diff = useMemo(
    () =>
      before.data !== undefined && after.data !== undefined
        ? wordDiff({ before: before.data, after: after.data })
        : null,
    [before.data, after.data],
  );

  const title = routeState.bookTitle ?? bookQuery.data?.title ?? "…";
  const pageLabel =
    routeState.pageNumber != null
      ? `Page ${count(routeState.pageNumber)}`
      : "Page";
  const textsError = history.error ?? before.error ?? after.error;
  const notApplied = review?.edits.filter((e) => !e.applied).length ?? 0;

  let changes: ReactNode;
  if (reviewsQuery.isLoading) {
    changes = <DiffSkeleton />;
  } else if (reviewsQuery.isError) {
    changes = (
      <EmptyState
        icon={CloudOff}
        tone="danger"
        title="Couldn't load the review"
        body={errorMessage(reviewsQuery.error)}
      >
        <Button icon={RefreshCw} onClick={() => reviewsQuery.refetch()}>
          Try again
        </Button>
      </EmptyState>
    );
  } else if (!review) {
    changes = (
      <EmptyState
        icon={FileSearch}
        title="Review not found"
        body="This page has no review from that batch. The page may have been deleted."
      />
    );
  } else if (review.revision_id === null) {
    changes = (
      <Callout>
        {review.status === "no_changes"
          ? "Opus found nothing to change on this page, so the text was left as it was."
          : `${reviewStatusLabel(review)}. This review didn't change the page's text.${review.error ? ` ${review.error}` : ""}`}
      </Callout>
    );
  } else if (textsError) {
    changes = (
      <EmptyState
        icon={CircleAlert}
        tone="danger"
        title="Couldn't load the page text"
        body={errorMessage(textsError)}
      >
        <Button
          icon={RefreshCw}
          onClick={() => {
            history.refetch();
            before.refetch();
            after.refetch();
          }}
        >
          Try again
        </Button>
      </EmptyState>
    );
  } else if (!diff) {
    changes = <DiffSkeleton />;
  } else if (diff.wordsAdded === 0 && diff.wordsRemoved === 0) {
    changes = (
      <Callout>
        The text before and after this review is the same apart from spacing.
      </Callout>
    );
  } else {
    changes = <DiffText segments={diff.segments} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-4 border-b border-line bg-surface px-6 py-4">
        <IconButton
          icon={ChevronLeft}
          label="Back"
          variant="tonal"
          onClick={() => navigate(-1)}
        />
        <div className="flex min-w-0 flex-col">
          <span
            dir="rtl"
            className="truncate font-ar text-body font-bold leading-[1.6] text-ink"
          >
            {title}
          </span>
          <span className="text-small font-medium text-ink-3">
            {pageLabel}
            {review && ` · reviewed ${reviewedAt(review.created_at)}`}
          </span>
        </div>
        {review && (
          <Badge tone={REVIEW_STATUS[review.status].tone}>
            {reviewStatusLabel(review)}
          </Badge>
        )}
        <Button
          size="sm"
          variant="secondary"
          icon={BookOpen}
          className="ml-auto"
          onClick={() => navigate(`/reader/${bookId}/${fileId}`)}
        >
          Open in reader
        </Button>
        <Segmented
          className="w-60"
          value={view}
          onChange={setView}
          options={[
            { value: "changes", label: "Changes" },
            { value: "both", label: "With scan" },
          ]}
        />
      </header>

      <div className="flex min-h-0 flex-1">
        <section className="flex min-w-0 flex-1 basis-0 justify-center overflow-y-auto border-r border-line">
          <div className="flex w-full max-w-2xl flex-col gap-8 px-8 py-8">
            {review && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-small text-ink-2">
                {review.format === "edits" ? (
                  <>
                    <span>
                      {plural({
                        n: review.edits_proposed,
                        one: "edit proposed",
                        many: "edits proposed",
                      })}
                    </span>
                    <span className="text-ok">
                      {count(review.edits_applied)} applied
                    </span>
                    {review.edits_failed > 0 && (
                      <span className="text-warn">
                        {count(review.edits_failed)} not applied
                      </span>
                    )}
                  </>
                ) : (
                  review.format === "full_page" && (
                    <span>Opus returned the corrected page</span>
                  )
                )}
                <span className="ml-auto tabular-nums text-ink-3">
                  {review.model} · {review.effort} effort ·{" "}
                  {usd(review.cost_usd)}
                </span>
              </div>
            )}

            {newer && (
              <Callout tone="warn">
                This page was {CHANGE_NAME[newer.change]} after the review (
                {reviewedAt(newer.created_at)}). "After" here is the text this
                review produced, not the page's current text.
              </Callout>
            )}

            <Section
              title="What the review changed"
              aside={
                diff &&
                review?.revision_id !== null && (
                  <DiffLegend
                    wordsAdded={diff.wordsAdded}
                    wordsRemoved={diff.wordsRemoved}
                  />
                )
              }
            >
              {changes}
            </Section>

            {review && review.edits.length > 0 && (
              <Section title="Edits Opus proposed">
                {notApplied > 0 && (
                  <Callout>
                    An edit is "not applied" when the passage Opus quoted didn't
                    match the page's text exactly once (it wasn't there word for
                    word, or it appeared more than once). Those edits were
                    skipped and the text there was left as it was.
                  </Callout>
                )}
                <EditList edits={review.edits} />
              </Section>
            )}
          </div>
        </section>
        <section
          className="split-pane flex min-w-0 basis-0 flex-col overflow-hidden bg-surface-2"
          style={{
            flexGrow: view === "changes" ? 0 : 1,
            opacity: view === "changes" ? 0 : 1,
          }}
        >
          <ZoomableImage bookId={bookId} fileId={fileId} />
        </section>
      </div>
    </div>
  );
};
