import type { LucideIcon } from "lucide-react";
import {
  Check,
  ChevronDown,
  CircleX,
  LoaderCircle,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  useEffect,
  useRef,
} from "react";

const cx = (...parts: (string | false | null | undefined)[]) =>
  parts.filter(Boolean).join(" ");

export { cx };

// --- Buttons ---------------------------------------------------------------

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-on-accent",
  secondary: "bg-surface-2 text-ink",
  ghost: "bg-transparent text-accent",
  danger: "bg-danger-soft text-danger",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "md" | "sm";
  icon?: LucideIcon;
  loading?: boolean;
}

export const Button = ({
  variant = "primary",
  size = "md",
  icon: Icon,
  loading = false,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) => {
  const iconSize = size === "sm" ? 16 : 18;
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={cx(
        "press inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-md font-semibold disabled:cursor-default disabled:opacity-40",
        size === "sm"
          ? "h-9 gap-1.5 px-3.5 text-small"
          : "h-12 gap-2 px-5 text-body",
        buttonVariants[variant],
        loading && "disabled:opacity-100",
        className,
      )}
      {...rest}
    >
      {loading ? (
        <LoaderCircle
          size={iconSize}
          className="animate-[spin_900ms_linear_infinite]"
        />
      ) : (
        Icon && <Icon size={iconSize} />
      )}
      {children}
    </button>
  );
};

type IconButtonVariant = "plain" | "tonal" | "filled";

const iconButtonVariants: Record<IconButtonVariant, string> = {
  plain: "text-ink hover:bg-surface-2",
  tonal: "bg-surface-2 text-ink",
  filled: "bg-accent text-on-accent",
};

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  label: string;
  variant?: IconButtonVariant;
  iconSize?: number;
}

export const IconButton = ({
  icon: Icon,
  label,
  variant = "plain",
  iconSize = 18,
  className,
  type = "button",
  ...rest
}: IconButtonProps) => (
  <button
    type={type}
    aria-label={label}
    title={label}
    className={cx(
      "press inline-flex size-10 shrink-0 items-center justify-center rounded-full disabled:cursor-default disabled:opacity-40",
      iconButtonVariants[variant],
      className,
    )}
    {...rest}
  >
    <Icon size={iconSize} />
  </button>
);

// --- Refresh ---------------------------------------------------------------

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

/**
 * Server data refreshes only on demand (polling burns D1 reads), so every
 * screen showing it carries this: the as-of time and a refresh button whose
 * icon spins while the fetch is in flight.
 */
export const RefreshControl = ({
  onRefresh,
  refreshing,
  updatedAt,
  failed = false,
}: {
  onRefresh: () => void;
  refreshing: boolean;
  updatedAt: number;
  failed?: boolean;
}) => {
  const asOf = refreshing
    ? "Refreshing…"
    : updatedAt > 0
      ? `${failed ? "Last updated" : "Updated"} ${clock(updatedAt)}`
      : null;
  return (
    <div className="flex items-center gap-3">
      {asOf && (
        <span key={asOf} className="fade-in text-small text-ink-3">
          {asOf}
        </span>
      )}
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        aria-label="Refresh"
        title="Refresh"
        data-state={refreshing ? "loading" : undefined}
        className="press inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-2 text-ink disabled:cursor-default disabled:text-ink-3"
      >
        <RefreshCw size={18} className="refresh-icon" />
      </button>
    </div>
  );
};

// --- Page frame ------------------------------------------------------------

/** Screen header: title (+ optional sub line), with actions on the right. */
export const PageHeader = ({
  title,
  sub,
  above,
  actions,
  children,
}: {
  title: ReactNode;
  sub?: ReactNode;
  above?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) => (
  <header className="flex shrink-0 flex-col gap-5 px-10 pb-6 pt-8">
    {above}
    <div className="flex items-center gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="font-display text-title font-semibold text-ink">
          {title}
        </h1>
        {sub != null && <p className="text-small text-ink-2">{sub}</p>}
      </div>
      {actions && (
        <div className="ml-auto flex items-center gap-4">{actions}</div>
      )}
    </div>
    {children}
  </header>
);

/** A centred message for empty, error and not-connected states. */
export const EmptyState = ({
  icon: Icon,
  tone = "neutral",
  title,
  body,
  children,
}: {
  icon: LucideIcon;
  tone?: "neutral" | "danger";
  title: ReactNode;
  body?: ReactNode;
  children?: ReactNode;
}) => (
  <div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
    <div className="flex size-14 items-center justify-center rounded-full bg-surface-2">
      <Icon
        size={24}
        className={tone === "danger" ? "text-danger" : "text-ink-3"}
      />
    </div>
    <h2 className="font-display text-number font-semibold tracking-tight text-ink">
      {title}
    </h2>
    {body && <p className="max-w-md text-body text-ink-2">{body}</p>}
    {children && <div className="mt-2 flex items-center gap-3">{children}</div>}
  </div>
);

export const Skeleton = ({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) => <div className={cx("shrink-0 bg-surface-2", className)} style={style} />;

// --- Inputs ----------------------------------------------------------------

export const SearchField = ({
  value,
  onChange,
  placeholder,
  className,
  busy = false,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  className?: string;
  /** Shows a spinner in place of the clear button while results load. */
  busy?: boolean;
}) => (
  <label
    className={cx(
      "flex h-[46px] items-center gap-2.5 rounded-md bg-surface-2 px-3.5 focus-within:bg-surface focus-within:shadow-[inset_0_0_0_1.5px_var(--accent)]",
      className,
    )}
  >
    <Search size={18} className="shrink-0 text-ink-3" />
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-ink-3"
    />
    {busy ? (
      <LoaderCircle size={18} className="shrink-0 animate-spin text-ink-3" />
    ) : (
      value && (
        <button
          type="button"
          aria-label="Clear"
          onClick={() => onChange("")}
          className="shrink-0 text-ink-3"
        >
          <CircleX size={18} />
        </button>
      )
    )}
  </label>
);

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  helper?: ReactNode;
  error?: boolean;
  rtl?: boolean;
}

export const FieldLabel = ({ children }: { children: ReactNode }) => (
  <span className="text-label font-semibold uppercase tracking-[0.08em] text-ink-3">
    {children}
  </span>
);

export const TextField = ({
  label,
  helper,
  error = false,
  rtl = false,
  className,
  ...rest
}: TextFieldProps) => (
  <label className={cx("flex flex-col gap-2", className)}>
    <FieldLabel>{label}</FieldLabel>
    <input
      dir={rtl ? "rtl" : undefined}
      className={cx(
        "h-[50px] rounded-md border bg-surface px-3.5 text-ink outline-none placeholder:text-ink-3 focus:border-accent focus:shadow-[inset_0_0_0_0.5px_var(--accent)] disabled:opacity-40",
        error ? "border-danger" : "border-line",
        rtl ? "font-ar text-section" : "text-body",
      )}
      {...rest}
    />
    {helper && (
      <span className={cx("text-xs", error ? "text-danger" : "text-ink-3")}>
        {helper}
      </span>
    )}
  </label>
);

// --- Selection -------------------------------------------------------------

export const Segmented = <T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) => (
  <div
    role="tablist"
    className={cx("flex gap-0.5 rounded-md bg-surface-2 p-[3px]", className)}
  >
    {options.map((o) => {
      const active = o.value === value;
      return (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={active}
          onClick={() => onChange(o.value)}
          className={cx(
            "press flex h-8 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-sm px-3 text-small font-medium",
            active ? "bg-surface text-ink shadow-sm" : "text-ink-2",
          )}
        >
          {o.label}
        </button>
      );
    })}
  </div>
);

export const DropdownTrigger = ({
  label,
  active = false,
  onClick,
}: {
  label: ReactNode;
  active?: boolean;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    aria-haspopup="listbox"
    className={cx(
      "press flex h-9 items-center gap-2 rounded-sm border px-3 text-small font-medium",
      active
        ? "border-transparent bg-accent-soft text-accent"
        : "border-line bg-surface text-ink",
    )}
  >
    {label}
    <ChevronDown size={16} className={active ? "text-accent" : "text-ink-3"} />
  </button>
);

export const Chip = ({
  children,
  selected = false,
  onClick,
  onRemove,
}: {
  children: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  onRemove?: () => void;
}) => {
  const className = cx(
    "inline-flex h-[34px] shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-small font-medium",
    selected
      ? "border-transparent bg-accent-soft text-accent"
      : "border-line bg-surface text-ink-2",
  );
  if (onRemove)
    return (
      <span className={className}>
        {children}
        <button
          type="button"
          aria-label="Remove"
          onClick={onRemove}
          className="press -mr-1 text-ink-3"
        >
          <X size={14} />
        </button>
      </span>
    );
  if (onClick)
    return (
      <button
        type="button"
        onClick={onClick}
        className={cx("press", className)}
      >
        {children}
      </button>
    );
  return <span className={className}>{children}</span>;
};

// --- Status ----------------------------------------------------------------

export type Tone = "ok" | "warn" | "danger" | "accent" | "neutral";

const pillTones: Record<Tone, string> = {
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
  accent: "bg-accent-soft text-accent",
  neutral: "bg-surface-2 text-ink-2",
};

export const StatusPill = ({
  tone,
  children,
}: {
  tone: Tone;
  children: ReactNode;
}) => (
  <span
    className={cx(
      "inline-flex items-center gap-2 whitespace-nowrap rounded-full px-2 py-1 text-small font-medium",
      pillTones[tone],
    )}
  >
    <span className="size-1.5 rounded-full bg-current" />
    {children}
  </span>
);

/** Compact status (the mobile Badge): 12px, used in dense headers. */
export const Badge = ({
  tone,
  children,
}: {
  tone: Tone;
  children: ReactNode;
}) => (
  <span
    className={cx(
      "inline-flex h-[22px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-xs font-medium",
      pillTones[tone],
    )}
  >
    <span className="size-1.5 rounded-full bg-current" />
    {children}
  </span>
);

export const Tag = ({ children }: { children: ReactNode }) => (
  <span className="whitespace-nowrap rounded-full bg-surface-2 px-2 py-1 text-small font-medium text-ink-2">
    {children}
  </span>
);

// --- Overlays --------------------------------------------------------------

/**
 * A modal dialog. Stays mounted so the CSS exit transition can play; `open`
 * flips data-state, and .scrim/.dialog in index.css do the rest.
 */
export const Dialog = ({
  open,
  onClose,
  title,
  children,
  width = "w-[440px]",
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  width?: string;
}) => {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    // Children stay mounted between openings, so autoFocus can't do this.
    panel.current?.querySelector<HTMLElement>("input, textarea")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  return (
    <div
      data-state={open ? "open" : "closed"}
      className="scrim fixed inset-0 z-40 flex items-center justify-center bg-scrim"
    >
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        className={cx(
          "dialog relative flex flex-col gap-4 rounded-lg bg-surface p-6 shadow-lg",
          width,
        )}
      >
        <h2 className="font-display text-number font-semibold tracking-tight text-ink">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
};

/** Popover panel: grows from its trigger's corner (origin set by caller). */
export const Popover = ({
  open,
  onClose,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) => (
  <>
    {open && (
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        className="fixed inset-0 z-20 cursor-default"
        onClick={onClose}
      />
    )}
    <div
      data-state={open ? "open" : "closed"}
      className={cx(
        "popover absolute z-30 flex flex-col gap-0.5 rounded-md border border-line bg-surface p-2 shadow-md",
        className,
      )}
    >
      {children}
    </div>
  </>
);

/** A checkbox row in a filter popover, with a trailing count. */
export const CheckOption = ({
  checked,
  onToggle,
  label,
  count,
  disabled = false,
  className,
}: {
  checked: boolean;
  onToggle: () => void;
  label: ReactNode;
  count?: ReactNode;
  disabled?: boolean;
  className?: string;
}) => (
  <label
    className={cx(
      "flex cursor-pointer items-center gap-3 rounded-sm px-3 py-2 hover:bg-surface-2",
      disabled && "cursor-default opacity-40",
      className,
    )}
  >
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={onToggle}
      className="sr-only"
    />
    <span
      className={cx(
        "flex size-4 shrink-0 items-center justify-center rounded border-[1.5px]",
        checked ? "border-accent bg-accent" : "border-line",
      )}
    >
      {checked && <Check size={12} className="text-on-accent" />}
    </span>
    <span className="min-w-0 flex-1 truncate text-small text-ink">{label}</span>
    {count != null && (
      <span className="text-small font-medium text-ink-3">{count}</span>
    )}
  </label>
);

export const MenuItem = ({
  icon: Icon,
  tone = "default",
  onClick,
  disabled,
  children,
}: {
  icon: LucideIcon;
  tone?: "default" | "danger";
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={cx(
      "flex h-10 w-full items-center gap-3 rounded-sm px-3 text-left text-body hover:bg-surface-2 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent",
      tone === "danger" ? "text-danger" : "text-ink",
    )}
  >
    <Icon size={18} className={tone === "danger" ? "" : "text-ink-2"} />
    {children}
  </button>
);

// TEMP(migration): old-theme helpers still used by routes not yet redesigned.
export const Centered = ({ children }: { children: ReactNode }) => (
  <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
    {children}
  </div>
);
export const Loading = () => (
  <div className="flex flex-1 items-center justify-center py-16">
    <LoaderCircle className="animate-spin text-accent" size={22} />
  </div>
);
export const RefreshButton = ({
  onRefresh,
  refreshing,
}: {
  onRefresh: () => void;
  refreshing: boolean;
}) => (
  <RefreshControl onRefresh={onRefresh} refreshing={refreshing} updatedAt={0} />
);
export const StatusBadge = ({ state }: { state: string }) => (
  <StatusPill tone="neutral">{state}</StatusPill>
);
export const StatusDot = (_: { state: string; size?: number }) => (
  <span className="inline-block size-2 rounded-full bg-ink-3" />
);
