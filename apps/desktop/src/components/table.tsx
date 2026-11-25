import type { ReactNode } from "react";
import { cx, Skeleton } from "./ui";

/** Column heading for data tables (designs: TableHeader). */
export const HeaderCell = ({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) => (
  <div
    className={cx(
      "flex h-9 shrink-0 items-center px-3 text-label font-semibold uppercase tracking-[0.08em] text-ink-3",
      className,
    )}
  >
    {children}
  </div>
);

/** The page-number cell that leads Book and Activity rows. */
export const LeadCell = ({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) => (
  <span
    className={cx(
      "shrink-0 px-3 font-display text-section font-semibold leading-[1.2] tabular-nums tracking-[-0.01em] text-ink",
      className,
    )}
  >
    {children}
  </span>
);

/** A headline number with a label and an optional note (designs: Stat). */
export const Stat = ({
  label,
  value,
  note,
  loading = false,
  className,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  loading?: boolean;
  className?: string;
}) => (
  <div
    className={cx(
      "flex flex-col gap-2 rounded-lg border border-line bg-surface p-5",
      className,
    )}
  >
    <span className="text-label font-semibold uppercase tracking-[0.08em] text-ink-3">
      {label}
    </span>
    {loading ? (
      <Skeleton className="h-[29px] w-[120px] rounded-sm" />
    ) : (
      <span className="font-display text-number font-semibold tabular-nums tracking-[-0.01em] text-ink">
        {value}
      </span>
    )}
    {note && !loading && <span className="text-small text-ink-2">{note}</span>}
  </div>
);
