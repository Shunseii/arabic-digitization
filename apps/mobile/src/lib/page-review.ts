import {
  DEFAULT_REVIEW_COST_PER_PAGE_USD,
  type FileStatus,
  pageReviewBlockedReason,
  pageReviewNotice,
} from "@qiraa/shared";
import { useMutation } from "@tanstack/react-query";
import { Alert } from "react-native";
import { api } from "@/lib/api";

export { pageReviewBlockedReason };

// What one page's review costs: the average so far, or a default before any
// review has run. Always an estimate.
export const estimatePageReview = async (): Promise<string> => {
  const perPage = await api
    .reviewSummary()
    .then((s) => s.cost_per_page_usd ?? DEFAULT_REVIEW_COST_PER_PAGE_USD)
    .catch(() => DEFAULT_REVIEW_COST_PER_PAGE_USD);
  return `$${perPage.toFixed(2)}`;
};

/**
 * Re-run one page's Opus review: one confirm with the estimated cost, then a
 * short notice saying whether the review started or waits for the next run.
 */
export const usePageReview = (bookId: string) => {
  const review = useMutation({
    mutationFn: (fileId: string) => api.reviewPage({ bookId, fileId }),
    onSuccess: (res) => Alert.alert(pageReviewNotice(res)),
    onError: (err) => Alert.alert("Could not queue the review", String(err)),
  });

  const ask = async ({ file, label }: { file: FileStatus; label: string }) => {
    const blocked = pageReviewBlockedReason(file);
    if (blocked) {
      Alert.alert("Can't review this page", blocked);
      return;
    }
    const estimate = await estimatePageReview();
    Alert.alert(
      `Re-run the review of page ${label}?`,
      `Opus proofreads the page against its scan again. About ${estimate} (estimate). Hand-edited pages can't be reviewed.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Re-run review", onPress: () => review.mutate(file.file_id) },
      ],
    );
  };

  return { ask, pending: review.isPending };
};
