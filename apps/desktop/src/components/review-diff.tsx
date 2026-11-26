// biome-ignore-all lint/suspicious/noArrayIndexKey: diff pieces and edits are derived lists that never reorder
import {
  INVALID_OUTPUT_REASONS,
  type PageReview,
  type PageReviewStatus,
  type RecentPageReview,
  type ReviewedEdit,
} from "@qiraa/shared";
import { ChevronsUpDown } from "lucide-react";
import { useState } from "react";
import { cx, type Tone } from "@/components/ui";
import { count, plural } from "@/lib/format";
import {
  type ChangeKind,
  type DiffNode,
  type DiffPiece,
  type DiffSegment,
  isMarkup,
  toDiffNodes,
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

/** The status label, naming the guard or cut-off for an answer that wasn't applied. */
export const reviewStatusLabel = ({
  status,
  error_type,
}: Pick<PageReview, "status" | "error_type">): string =>
  (status === "invalid_output" && error_type
    ? INVALID_OUTPUT_REASONS[error_type]
    : undefined) ?? REVIEW_STATUS[status].label;

type ReviewChange = Pick<
  RecentPageReview,
  "format" | "words_added" | "words_removed" | "edits_applied" | "edits_failed"
>;

/** How much a review changed, in the measure its format has. */
export const ReviewChangeSummary = ({ review }: { review: ReviewChange }) => {
  if (review.format === "edits") {
    return (
      <>
        <span className="text-ink">{count(review.edits_applied)} applied</span>
        {review.edits_failed > 0 && (
          <span className="text-warn">
            {count(review.edits_failed)} not applied
          </span>
        )}
      </>
    );
  }
  if (review.words_added === null || review.words_removed === null) {
    return <span className="text-ink-3">—</span>;
  }
  return (
    <>
      <span className="text-ok">+{count(review.words_added)}</span>
      <span className="text-danger">−{count(review.words_removed)}</span>
      <span className="text-ink-3">words</span>
    </>
  );
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

/** Running text with glosses drawn the way the reader shows them: base (gloss). */
const DiffNodes = ({ pieces }: { pieces: DiffPiece[] }) =>
  toDiffNodes(pieces).map((node: DiffNode, index) =>
    node.type === "text" ? (
      <span key={index} className={CHANGE_STYLE[node.kind]}>
        {node.text}
      </span>
    ) : (
      <span key={index}>
        {node.base.map((piece, pieceIndex) => (
          <span key={pieceIndex} className={CHANGE_STYLE[piece.kind]}>
            {piece.text}
          </span>
        ))}
        <span className="whitespace-pre-line font-body text-small text-accent">
          {" ("}
          {node.gloss.map((piece, pieceIndex) => (
            <span key={pieceIndex} className={CHANGE_STYLE[piece.kind]}>
              {piece.text}
            </span>
          ))}
          {")"}
        </span>
      </span>
    ),
  );

const FoldedLines = ({ text, lines }: { text: string; lines: number }) => {
  const [open, setOpen] = useState(false);
  if (open) return <DiffNodes pieces={[{ kind: "same", text }]} />;
  return (
    <button
      type="button"
      dir="ltr"
      onClick={() => setOpen(true)}
      className="my-2 flex w-full items-center justify-center gap-2 rounded-sm bg-surface-2 py-1.5 font-body text-small font-medium text-ink-2 hover:text-ink"
    >
      <ChevronsUpDown size={14} />
      {plural({ n: lines, one: "unchanged line", many: "unchanged lines" })}
    </button>
  );
};

type DiffBlock =
  | { type: "pieces"; pieces: DiffPiece[] }
  | { type: "folded"; text: string; lines: number };

const toBlocks = (segments: DiffSegment[]) =>
  segments.reduce<DiffBlock[]>((blocks, segment) => {
    if (segment.kind === "folded") {
      blocks.push({ type: "folded", text: segment.text, lines: segment.lines });
      return blocks;
    }
    const last = blocks.at(-1);
    if (last?.type === "pieces") last.pieces.push(segment);
    else blocks.push({ type: "pieces", pieces: [segment] });
    return blocks;
  }, []);

/** The before and after texts as one RTL text: deletions struck, insertions marked. */
export const DiffText = ({ segments }: { segments: DiffSegment[] }) => (
  <div
    dir="rtl"
    className="whitespace-pre-wrap text-right font-ar text-section leading-[2.1] text-ink"
  >
    {toBlocks(segments).map((block, index) =>
      block.type === "folded" ? (
        <FoldedLines key={index} text={block.text} lines={block.lines} />
      ) : (
        <DiffNodes key={index} pieces={block.pieces} />
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
