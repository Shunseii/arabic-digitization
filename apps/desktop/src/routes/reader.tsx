import type { FileState } from "@qiraa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CloudOff,
  File,
  GitCompare,
  Hourglass,
  RefreshCw,
  RotateCw,
} from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ReviewIcon,
  ReviewPageDialog,
  reviewBlockedReason,
  useNotice,
} from "@/components/page-review";
import {
  Badge,
  Button,
  cx,
  EmptyState,
  IconButton,
  Notice,
  Segmented,
  Skeleton,
} from "@/components/ui";
import { ZoomableImage } from "@/components/zoomable-image";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { count } from "@/lib/format";
import { Markdown } from "@/lib/markdown";
import { loadStatus, recentKey, statusKey } from "@/lib/status";
import { type ReviewRouteState, reviewPath } from "@/routes/review";
import { statusLabel, statusTone } from "@/theme";

const READABLE: FileState[] = ["done", "approved", "needs_review"];

type View = "text" | "scan" | "both";

const TextSkeleton = () => (
  <div className="flex flex-col gap-4">
    <Skeleton className="h-4 w-24 self-center rounded-sm" />
    <Skeleton className="h-px w-full" />
    <Skeleton className="h-6 w-56 self-center rounded-sm" />
    {[100, 94, 97, 90, 60, 98, 92, 75].map((w, i) => (
      <Skeleton
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        key={i}
        className="h-4 self-end rounded-sm"
        // Ragged line ends, like a real paragraph.
        style={{ width: `${w}%` }}
      />
    ))}
  </div>
);

export const ReaderScreen = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { bookId = "", fileId = "" } = useParams<{
    bookId: string;
    fileId: string;
  }>();
  const [view, setView] = useState<View>("both");

  const bookQuery = useQuery({
    queryKey: ["book", bookId],
    queryFn: () => api.getBook(bookId),
  });
  const statusQuery = useQuery({
    queryKey: statusKey(bookId),
    queryFn: () => loadStatus(bookId),
  });

  const files = statusQuery.data ?? [];
  const index = files.findIndex((f) => f.file_id === fileId);
  const file = index >= 0 ? files[index] : undefined;
  const readable = file ? READABLE.includes(file.state) : false;
  const prev = index > 0 ? files[index - 1] : undefined;
  const next = index >= 0 ? files[index + 1] : undefined;

  const textQuery = useQuery({
    queryKey: ["text", bookId, fileId],
    queryFn: () => api.fileText({ bookId, fileId }),
    enabled: readable,
  });

  const rerun = useMutation({
    mutationFn: () => api.rerunOcr({ bookId, fileId }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: statusKey(bookId) });
      queryClient.invalidateQueries({ queryKey: ["text", bookId, fileId] });
      queryClient.invalidateQueries({ queryKey: recentKey });
    },
  });

  const reviewsQuery = useQuery({
    queryKey: ["page-reviews", bookId, fileId],
    queryFn: () => api.pageReviews({ bookId, fileId }),
    enabled: file?.review_cost_usd != null,
  });
  const lastChange = reviewsQuery.data?.reviews.find(
    (r) => r.revision_id !== null,
  );
  const openLastChange = () => {
    if (!lastChange) return;
    const state: ReviewRouteState = {
      pageNumber: file?.page_number,
      bookTitle: bookQuery.data?.title,
    };
    navigate(reviewPath({ bookId, fileId, batchId: lastChange.batch_id }), {
      state,
    });
  };

  const [reviewing, setReviewing] = useState(false);
  const notice = useNotice();
  const reviewBlocked = file ? reviewBlockedReason(file) : null;

  const goTo = (target: string) => navigate(`/reader/${bookId}/${target}`);
  const pageNumber =
    file?.page_number != null ? count(file.page_number) : count(index + 1);

  let text: React.ReactNode;
  if (statusQuery.isLoading || (readable && textQuery.isLoading)) {
    text = <TextSkeleton />;
  } else if (file && file.state === "failed") {
    text = (
      <EmptyState
        icon={CircleAlert}
        tone="danger"
        title="Transcription failed"
        body={file.error ?? "OCR gave up on this page."}
      >
        <Button
          icon={RotateCw}
          onClick={() => rerun.mutate()}
          loading={rerun.isPending}
        >
          Re-run OCR
        </Button>
      </EmptyState>
    );
  } else if (file && !readable) {
    text = (
      <EmptyState
        icon={Hourglass}
        title="Not transcribed yet"
        body="This page is waiting in the queue. Refresh the book to check on it."
      />
    );
  } else if (textQuery.isError) {
    text = (
      <EmptyState
        icon={CloudOff}
        tone="danger"
        title="Couldn't load the text"
        body={errorMessage(textQuery.error)}
      >
        <Button icon={RefreshCw} onClick={() => textQuery.refetch()}>
          Try again
        </Button>
      </EmptyState>
    );
  } else if (!textQuery.data?.trim()) {
    text = (
      <EmptyState
        icon={File}
        title="Blank page"
        body="The model found no text on this page. If that's wrong, re-run OCR."
      >
        <Button
          variant="secondary"
          icon={RotateCw}
          onClick={() => rerun.mutate()}
          loading={rerun.isPending}
        >
          Re-run OCR
        </Button>
      </EmptyState>
    );
  } else {
    text = <Markdown source={textQuery.data} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-4 border-b border-line bg-surface px-6 py-4">
        <IconButton
          icon={ChevronLeft}
          label="Back to book"
          variant="tonal"
          onClick={() => navigate(`/book/${bookId}`)}
        />
        <div className="flex flex-col">
          <span
            dir="rtl"
            className="font-ar text-body font-bold leading-[1.6] text-ink"
          >
            {bookQuery.data?.title ?? "…"}
          </span>
          {file && (
            <span className="text-small font-medium text-ink-3">
              Page {pageNumber} of {count(files.length)}
            </span>
          )}
        </div>
        {file && (
          <Badge tone={statusTone[file.state]}>{statusLabel[file.state]}</Badge>
        )}
        {lastChange && (
          <Button
            size="sm"
            variant="ghost"
            icon={GitCompare}
            className="ml-auto"
            title="What the last Opus review changed on this page"
            onClick={openLastChange}
          >
            Review changes
          </Button>
        )}
        {file && (
          <Button
            size="sm"
            variant="secondary"
            icon={ReviewIcon}
            className={cx(!lastChange && "ml-auto")}
            disabled={reviewBlocked !== null}
            title={reviewBlocked ?? "Have Opus proofread this page again"}
            onClick={() => setReviewing(true)}
          >
            Re-run review
          </Button>
        )}
        <Segmented
          className={cx("w-60", !file && "ml-auto")}
          value={view}
          onChange={setView}
          options={[
            { value: "text", label: "Text" },
            { value: "scan", label: "Scan" },
            { value: "both", label: "Both" },
          ]}
        />
        <IconButton
          icon={ChevronLeft}
          label="Previous page"
          variant="tonal"
          disabled={!prev}
          onClick={() => prev && goTo(prev.file_id)}
        />
        <IconButton
          icon={ChevronRight}
          label="Next page"
          variant="tonal"
          disabled={!next}
          onClick={() => next && goTo(next.file_id)}
        />
      </header>

      <div className="flex min-h-0 flex-1">
        <section
          className="split-pane flex min-w-0 basis-0 justify-center overflow-y-auto border-r border-line"
          style={{ flexGrow: view === "scan" ? 0 : 1 }}
        >
          <div className="flex min-h-full w-[560px] shrink-0 flex-col py-8">
            {text}
          </div>
        </section>
        <section
          className="split-pane flex min-w-0 basis-0 flex-col overflow-hidden bg-surface-2"
          style={{
            flexGrow: view === "text" ? 0 : 1,
            opacity: view === "text" ? 0 : 1,
          }}
        >
          <ZoomableImage bookId={bookId} fileId={fileId} />
        </section>
      </div>
      <ReviewPageDialog
        bookId={bookId}
        file={reviewing && file ? file : null}
        pageLabel={pageNumber}
        onClose={() => setReviewing(false)}
        onQueued={notice.show}
      />
      <Notice text={notice.notice} />
    </div>
  );
};
