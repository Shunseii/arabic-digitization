import {
  DEFAULT_REVIEW_COST_PER_PAGE_USD,
  type FileStatus,
  pageReviewNotice,
} from "@qiraa/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, Dialog } from "@/components/ui";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { usd } from "@/lib/format";

export const ReviewIcon = Sparkles;

export { pageReviewBlockedReason as reviewBlockedReason } from "@qiraa/shared";

/** One confirm for re-running a page's Opus review, with its estimated cost. */
export const ReviewPageDialog = ({
  bookId,
  file,
  pageLabel,
  onClose,
  onQueued,
}: {
  bookId: string;
  file: FileStatus | null;
  pageLabel: string;
  onClose: () => void;
  onQueued: (notice: string) => void;
}) => {
  const summary = useQuery({
    queryKey: ["review-summary", 90],
    queryFn: () => api.reviewSummary({ days: 90 }),
    enabled: file !== null,
    staleTime: 5 * 60_000,
  });
  const review = useMutation({
    mutationFn: (fileId: string) => api.reviewPage({ bookId, fileId }),
    onSuccess: (res) => {
      onClose();
      onQueued(pageReviewNotice(res));
    },
  });
  const { reset } = review;
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear an old error when another page opens
  useEffect(() => reset(), [file?.file_id, reset]);

  const estimate = usd(
    summary.data?.cost_per_page_usd ?? DEFAULT_REVIEW_COST_PER_PAGE_USD,
  );
  return (
    <Dialog
      open={file !== null}
      onClose={onClose}
      title={`Re-run the review of page ${pageLabel}?`}
      width="w-[420px]"
    >
      <p className="text-body text-ink-2">
        Opus proofreads the page against its scan again. About {estimate}{" "}
        (estimate). Hand-edited pages can't be reviewed.
      </p>
      {review.isError && (
        <p className="text-small text-danger">
          Couldn't queue the review. {errorMessage(review.error)}
        </p>
      )}
      <div className="mt-2 flex items-center gap-3">
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          icon={ReviewIcon}
          loading={review.isPending}
          onClick={() => file && review.mutate(file.file_id)}
        >
          Re-run review
        </Button>
      </div>
    </Dialog>
  );
};

const NOTICE_MS = 4000;

/** A short notice that hides itself after a few seconds. */
export const useNotice = () => {
  const [notice, setNotice] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = (text: string) => {
    clearTimeout(timer.current);
    setNotice(text);
    timer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  };
  return { notice, show };
};
