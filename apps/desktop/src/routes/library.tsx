import type { BookWithStatus, WorkWithCounts } from "@qiraa/shared";
import { useQuery } from "@tanstack/react-query";
import { Pencil, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Centered, Loading } from "@/components/ui";
import { api } from "@/lib/api";
import { useConfigState } from "@/lib/config-context";
import { colors } from "@/theme";

const inFlight = (b: BookWithStatus): number =>
  (b.counts.queued ?? 0) + (b.counts.processing ?? 0);
const progress = (b: BookWithStatus): number => {
  const done = (b.counts.done ?? 0) + (b.counts.approved ?? 0);
  return b.files_total > 0 ? done / b.files_total : 0;
};

const BookCard = ({ book }: { book: BookWithStatus }) => {
  const pct = Math.round(progress(book) * 100);
  const failed = book.counts.failed ?? 0;
  const meta =
    failed > 0
      ? `${failed} failed`
      : inFlight(book) > 0
        ? `${inFlight(book)} in queue`
        : `${pct}%`;
  const metaColor = failed > 0 ? "#EE6A4D" : colors.accent;
  return (
    <Link
      to={`/book/${book.id}`}
      className="flex flex-col rounded-2xl border border-border bg-surface p-2.5 transition-colors hover:border-accent/40"
    >
      <div className="relative h-36 overflow-hidden rounded-xl bg-accent-soft">
        <div className="absolute left-0 top-0 h-full w-1 bg-accent" />
        <div className="flex h-full items-center justify-center">
          <span className="text-4xl text-accent">
            {book.title.trim().charAt(0)}
          </span>
        </div>
      </div>
      <span className="mt-2.5 truncate text-base text-ink">{book.title}</span>
      <div className="mt-2 flex flex-row items-center justify-between">
        <span className="text-xs font-medium text-text-muted">
          {book.files_total} pp
        </span>
        <span className="text-xs font-semibold" style={{ color: metaColor }}>
          {meta}
        </span>
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-alt">
        <div
          className="h-full rounded-full bg-accent"
          style={{ width: `${pct}%` }}
        />
      </div>
    </Link>
  );
};

// Generic multi-select popover: a button showing the active count, opening a
// checkbox list. Empty selection reads as "All". Mirrors the search BookFilter.
const MultiSelect = ({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: { value: string; label: string; count?: number }[];
  selected: Set<string>;
  onToggle: (value: string) => void;
}) => {
  const [open, setOpen] = useState(false);
  if (options.length === 0) return null;
  const count = selected.size;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="h-full rounded-xl border border-border bg-surface px-4 py-2 text-sm font-medium text-ink hover:bg-surface-alt"
      >
        {count > 0 ? `${label}: ${count}` : `All ${label.toLowerCase()}`}
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-label={`Close ${label} filter`}
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute left-0 z-20 mt-1 max-h-80 w-64 overflow-y-auto rounded-xl border border-border bg-surface p-2 shadow-lg">
            {options.map((o) => (
              <label
                key={o.value}
                className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-alt"
              >
                <input
                  type="checkbox"
                  checked={selected.has(o.value)}
                  onChange={() => onToggle(o.value)}
                  className="accent-accent"
                />
                <span className="flex-1 truncate text-sm text-ink">
                  {o.label}
                </span>
                {o.count != null && (
                  <span className="text-xs text-text-muted">{o.count}</span>
                )}
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

// A work header + its copies (grouped view). Also used for the "Ungrouped"
// pseudo-section (work is null).
const WorkGroup = ({
  work,
  books,
}: {
  work: WorkWithCounts | null;
  books: BookWithStatus[];
}) => (
  <div className="mt-6">
    <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
      <h2 className="text-lg font-semibold text-ink">
        {work ? work.name : "Ungrouped"}
      </h2>
      {work?.author && (
        <span className="text-sm text-text-muted">{work.author}</span>
      )}
      <span className="text-xs text-text-muted">
        {books.length} {books.length === 1 ? "copy" : "copies"}
      </span>
      {work && (
        <Link
          to={`/work/${work.id}`}
          className="ml-1 flex items-center gap-1 text-xs font-medium text-text-muted hover:text-accent"
        >
          <Pencil size={12} />
          Edit
        </Link>
      )}
    </div>
    {work && work.tags.length > 0 && (
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {work.tags.map((t) => (
          <span
            key={t}
            className="rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent"
          >
            {t}
          </span>
        ))}
      </div>
    )}
    <div className="mt-3 grid grid-cols-2 gap-3.5 sm:grid-cols-3 lg:grid-cols-4">
      {books.map((book) => (
        <BookCard key={book.id} book={book} />
      ))}
    </div>
  </div>
);

const useToggleSet = () => {
  const [set, setSet] = useState<Set<string>>(new Set());
  const toggle = (value: string) =>
    setSet((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  return [set, toggle] as const;
};

export const LibraryScreen = () => {
  const navigate = useNavigate();
  const { configured, ready } = useConfigState();

  const booksQuery = useQuery({
    queryKey: ["books"],
    queryFn: api.listBooks,
    enabled: configured,
    refetchInterval: (q) =>
      q.state.data?.some(
        (b) => (b.counts.queued ?? 0) + (b.counts.processing ?? 0) > 0,
      )
        ? 5000
        : false,
  });
  const worksQuery = useQuery({
    queryKey: ["works"],
    queryFn: api.listWorks,
    enabled: configured,
  });

  const [grouped, setGrouped] = useState(false);
  const [selectedWorks, toggleWork] = useToggleSet();
  const [selectedTags, toggleTag] = useToggleSet();

  const works = useMemo(() => worksQuery.data ?? [], [worksQuery.data]);
  const worksById = useMemo(
    () => new Map(works.map((w) => [w.id, w])),
    [works],
  );

  // Distinct tag names across works, for the tag filter options.
  const tagOptions = useMemo(() => {
    const names = new Set<string>();
    for (const w of works) for (const t of w.tags) names.add(t);
    return [...names].sort().map((name) => ({ value: name, label: name }));
  }, [works]);

  const books = useMemo(() => booksQuery.data ?? [], [booksQuery.data]);

  // Apply the work + tag filters. Tag filter is OR within tags; a book matches
  // if its work carries any selected tag. Standalone books (no work) can't match
  // a tag filter, so they drop out once tags are selected.
  const filtered = useMemo(() => {
    return books.filter((b) => {
      if (
        selectedWorks.size > 0 &&
        !(b.work_id && selectedWorks.has(b.work_id))
      )
        return false;
      if (selectedTags.size > 0) {
        const work = b.work_id ? worksById.get(b.work_id) : undefined;
        if (!work || !work.tags.some((t) => selectedTags.has(t))) return false;
      }
      return true;
    });
  }, [books, selectedWorks, selectedTags, worksById]);

  if (!ready) return <Loading />;

  if (!configured)
    return (
      <Centered>
        <p className="text-lg font-semibold text-ink">Connect to your API</p>
        <p className="max-w-sm text-sm text-text-secondary">
          Add your worker endpoint and key in Settings to start scanning.
        </p>
        <Link to="/settings" className="mt-2 font-semibold text-accent">
          Open Settings →
        </Link>
      </Centered>
    );

  const totalPages = filtered.reduce((n, b) => n + b.files_total, 0);
  const workOptions = works.map((w) => ({
    value: w.id,
    label: w.name,
    count: w.copies_total,
  }));

  // Grouped view: bucket the filtered books by work, works newest-first (works
  // query is ordered), standalone books collected into a trailing group.
  const grouping = (() => {
    const byWork = new Map<string, BookWithStatus[]>();
    const ungrouped: BookWithStatus[] = [];
    for (const b of filtered) {
      if (b.work_id && worksById.has(b.work_id)) {
        const list = byWork.get(b.work_id) ?? [];
        list.push(b);
        byWork.set(b.work_id, list);
      } else {
        ungrouped.push(b);
      }
    }
    const ordered = works
      .filter((w) => byWork.has(w.id))
      .map((w) => ({ work: w, books: byWork.get(w.id) ?? [] }));
    return { ordered, ungrouped };
  })();

  return (
    <div className="flex-1 overflow-y-auto px-10 py-8">
      <div className="mx-auto max-w-5xl">
        <div className="flex flex-row items-center justify-between">
          <div className="flex flex-col gap-1">
            <span className="text-base font-bold text-accent" dir="rtl">
              رقمنة
            </span>
            <h1 className="text-[34px] font-semibold text-ink">Library</h1>
          </div>
          <div className="flex flex-row items-center gap-1.5 rounded-full bg-[#16271E] px-3 py-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-st-done" />
            <span className="text-xs font-semibold text-st-done">Online</span>
          </div>
        </div>

        {booksQuery.isLoading ? (
          <div className="mt-16">
            <Loading />
          </div>
        ) : (
          <>
            <p className="mt-1 text-sm text-text-muted">
              {filtered.length} {filtered.length === 1 ? "book" : "books"} ·{" "}
              {totalPages} pages
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-2.5">
              {/* Flat / Grouped segmented toggle. */}
              <div className="flex rounded-xl border border-border bg-surface p-0.5">
                {(["flat", "grouped"] as const).map((mode) => {
                  const active = (mode === "grouped") === grouped;
                  return (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setGrouped(mode === "grouped")}
                      className={`rounded-lg px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
                        active
                          ? "bg-accent-soft text-accent"
                          : "text-text-muted hover:text-ink"
                      }`}
                    >
                      {mode === "grouped" ? "Group by work" : "Flat"}
                    </button>
                  );
                })}
              </div>
              <MultiSelect
                label="Works"
                options={workOptions}
                selected={selectedWorks}
                onToggle={toggleWork}
              />
              <MultiSelect
                label="Tags"
                options={tagOptions}
                selected={selectedTags}
                onToggle={toggleTag}
              />
            </div>

            {grouped ? (
              <>
                {grouping.ordered.map(({ work, books: groupBooks }) => (
                  <WorkGroup key={work.id} work={work} books={groupBooks} />
                ))}
                {grouping.ungrouped.length > 0 && (
                  <WorkGroup work={null} books={grouping.ungrouped} />
                )}
                <div className="mt-6">
                  <button
                    type="button"
                    onClick={() => navigate("/new-book")}
                    className="flex w-full flex-col items-center justify-center gap-2.5 rounded-2xl border border-border bg-transparent py-8 transition-colors hover:border-accent/40 sm:w-64"
                  >
                    <span className="flex h-11 w-11 items-center justify-center rounded-full bg-accent-soft">
                      <Plus size={22} color={colors.accent} />
                    </span>
                    <span className="text-sm font-semibold text-text-secondary">
                      New book
                    </span>
                  </button>
                </div>
              </>
            ) : (
              <div className="mt-5 grid grid-cols-2 gap-3.5 sm:grid-cols-3 lg:grid-cols-4">
                {filtered.map((book) => (
                  <BookCard key={book.id} book={book} />
                ))}
                <button
                  type="button"
                  onClick={() => navigate("/new-book")}
                  className="flex flex-col items-center justify-center gap-2.5 rounded-2xl border border-border bg-transparent py-8 transition-colors hover:border-accent/40"
                >
                  <span className="flex h-11 w-11 items-center justify-center rounded-full bg-accent-soft">
                    <Plus size={22} color={colors.accent} />
                  </span>
                  <span className="text-sm font-semibold text-text-secondary">
                    New book
                  </span>
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
