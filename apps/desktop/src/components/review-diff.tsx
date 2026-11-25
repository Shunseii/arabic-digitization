import {
  type PageReviewStatus,
  REVIEW_CATEGORY_LABELS,
  type ReviewedEdit,
} from "@qiraa/shared";
import { ChevronsUpDown } from "lucide-react";
import { useState } from "react";
import { cx, Tag, type Tone } from "@/components/ui";
import { count, plural } from "@/lib/format";
import {
  type ChangeKind,
  type DiffSegment,
  isMarkup,
  tokenize,
} from "@/lib/word-diff";

export const REVIEW_STATUS: Record<
  PageReviewStatus,
  { label: string; tone: Tone }
> = {
  applied: { label: "Changed", tone: "accent" },
  no_changes: { label: "No changes", tone: "ok" },
  skipped_hand_edited: { label: "Skipped: hand-edited", tone: "neutral" },
  stale: { label: "Skipped: text changed", tone: "neutral" },
  conflict: { label: "Skipped: conflict", tone: "warn" },
  page_gone: { label: "Page deleted", tone: "neutral" },
  invalid_output: { label: "Unreadable output", tone: "danger" },
  refused: { label: "Refused", tone: "danger" },
  errored: { label: "Errored, retried", tone: "warn" },
  expired: { label: "Expired, retried", tone: "warn" },
  canceled: { label: "Canceled, retried", tone: "warn" },
  failed: { label: "Failed", tone: "danger" },
};

const CHANGE_STYLE: Record<ChangeKind, string> = {
  same: "",
  added: "rounded-sm bg-ok-soft text-ok",
  removed: "me-1 rounded-sm bg-danger-soft text-danger line-through",
};

/** Tags (the ruby glosses' <ruby>/<rt>) are shown small, muted and LTR. */
const Tokens = ({ text }: { text: string }) =>
  tokenize(text).map((token, index) =>
    isMarkup(token) ? (
      <bdi key={index} dir="ltr" className="font-body text-label text-ink-3">
        {token}
      </bdi>
    ) : (
      token
    ),
  );

const FoldedLines = ({ segment }: { segment: DiffSegment }) => {
  const [open, setOpen] = useState(false);
  if (open) return <Tokens text={segment.text} />;
  return (
    <button
      type="button"
      dir="ltr"
      onClick={() => setOpen(true)}
      className="my-2 flex w-full items-center justify-center gap-2 rounded-sm bg-surface-2 py-1.5 font-body text-small font-medium text-ink-2 hover:text-ink"
    >
      <ChevronsUpDown size={14} />
      {segment.kind === "folded" &&
        plural({
          n: segment.lines,
          one: "unchanged line",
          many: "unchanged lines",
        })}
    </button>
  );
};

/** The before and after texts as one RTL text: deletions struck, insertions marked. */
export const DiffText = ({ segments }: { segments: DiffSegment[] }) => (
  <div
    dir="rtl"
    className="whitespace-pre-wrap text-right font-ar text-section leading-[2.1] text-ink"
  >
    {segments.map((segment, index) =>
      segment.kind === "folded" ? (
        <FoldedLines key={index} segment={segment} />
      ) : (
        <span key={index} className={CHANGE_STYLE[segment.kind]}>
          <Tokens text={segment.text} />
        </span>
      ),
    )}
  </div>
);

export const DiffLegend = ({
  wordsAdded,
  wordsRemoved,
}: {
  wordsAdded: number;
  wordsRemoved: number;
}) => (
  <div className="flex items-center gap-4 text-small text-ink-2">
    <span className="flex items-center gap-2">
      <span className="size-2.5 rounded-sm bg-danger-soft ring-1 ring-danger/40" />
      {count(wordsRemoved)} removed
    </span>
    <span className="flex items-center gap-2">
      <span className="size-2.5 rounded-sm bg-ok-soft ring-1 ring-ok/40" />
      {count(wordsAdded)} added
    </span>
  </div>
);

const Quoted = ({ text, kind }: { text: string; kind: ChangeKind }) =>
  text === "" ? (
    <span className="font-body text-small italic text-ink-3">(nothing)</span>
  ) : (
    <span
      dir="rtl"
      className={cx(
        "whitespace-pre-wrap px-1 font-ar text-body leading-[1.8]",
        CHANGE_STYLE[kind],
      )}
    >
      <Tokens text={text} />
    </span>
  );

/** Each edit Opus proposed, in the order it was applied, and whether it took. */
export const EditList = ({ edits }: { edits: ReviewedEdit[] }) => (
  <ol className="flex flex-col">
    {edits.map((edit, index) => (
      <li
        key={index}
        className={cx(
          "flex flex-col gap-2 border-b border-line py-3 last:border-b-0",
          !edit.applied && "opacity-80",
        )}
      >
        <div className="flex items-center gap-2">
          <span className="w-6 text-small tabular-nums text-ink-3">
            {index + 1}
          </span>
          <Tag>{REVIEW_CATEGORY_LABELS[edit.category] ?? edit.category}</Tag>
          <span
            className={cx(
              "ml-auto text-small font-medium",
              edit.applied ? "text-ok" : "text-warn",
            )}
          >
            {edit.applied ? "Applied" : "Not applied"}
          </span>
        </div>
        <div
          dir="rtl"
          className="flex flex-wrap items-baseline gap-x-2 gap-y-1"
        >
          <Quoted text={edit.find} kind={edit.applied ? "removed" : "same"} />
          <span className="font-body text-small text-ink-3">←</span>
          <Quoted text={edit.replace} kind={edit.applied ? "added" : "same"} />
        </div>
      </li>
    ))}
  </ol>
);
