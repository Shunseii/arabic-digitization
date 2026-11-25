import type { BookWithStatus } from "@qiraa/shared";
import { Check } from "lucide-react";
import { cx } from "./ui";

const doneShare = (b: BookWithStatus): number => {
  const done = (b.counts.done ?? 0) + (b.counts.approved ?? 0);
  return b.files_total > 0 ? done / b.files_total : 0;
};

/**
 * A book's transcription progress: accent while in progress, danger once a
 * page failed, a green check when every page is done.
 */
export const ProgressRing = ({
  book,
  size = "md",
}: {
  book: BookWithStatus;
  size?: "md" | "sm";
}) => {
  const failed = (book.counts.failed ?? 0) > 0;
  const pct = Math.floor(doneShare(book) * 100);
  const complete = !failed && book.files_total > 0 && pct === 100;
  const color = failed
    ? "var(--danger)"
    : complete
      ? "var(--ok)"
      : "var(--accent)";
  return (
    <div
      className={cx(
        "flex shrink-0 items-center justify-center rounded-full",
        size === "md" ? "size-11" : "size-9",
      )}
      style={{
        background: `conic-gradient(${color} 0 ${pct}%, var(--surface-2) ${pct}% 100%)`,
      }}
    >
      <div
        className={cx(
          "flex items-center justify-center rounded-full bg-surface",
          size === "md" ? "size-9" : "size-7",
        )}
      >
        {complete ? (
          <Check size={16} className="text-ok" />
        ) : (
          <span
            className={cx(
              "font-semibold tabular-nums text-ink",
              size === "md" ? "text-small" : "text-label",
            )}
          >
            {pct}%
          </span>
        )}
      </div>
    </div>
  );
};
