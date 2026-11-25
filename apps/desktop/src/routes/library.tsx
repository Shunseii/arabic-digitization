import type { BookWithStatus, WorkWithCounts } from "@qiraa/shared";
import { useQuery } from "@tanstack/react-query";
import {
  BookOpen,
  CloudOff,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ProgressRing } from "@/components/progress-ring";
import {
  Button,
  CheckOption,
  Chip,
  cx,
  DropdownTrigger,
  EmptyState,
  PageHeader,
  Popover,
  RefreshControl,
  SearchField,
  Segmented,
  Skeleton,
} from "@/components/ui";
import { api } from "@/lib/api";
import { useConfigState } from "@/lib/config-context";
import { errorMessage } from "@/lib/errors";
import { count, plural } from "@/lib/format";

const inQueue = (b: BookWithStatus): number =>
  (b.counts.queued ?? 0) +
  (b.counts.processing ?? 0) +
  (b.counts.rate_limited ?? 0);

const BookCard = ({ book }: { book: BookWithStatus }) => {
  const failed = book.counts.failed ?? 0;
  const queued = inQueue(book);
  const status =
    failed > 0 ? (
      <span className="font-semibold text-danger">{count(failed)} failed</span>
    ) : book.paused ? (
      <span className="text-ink-2">paused</span>
    ) : queued > 0 ? (
      <span className="font-semibold text-accent">
        {count(queued)} in queue
      </span>
    ) : null;
  return (
    <Link
      to={`/book/${book.id}`}
      className="flex w-[270px] flex-col gap-3 rounded-lg border border-line bg-surface p-4 hover:bg-surface-2"
    >
      <ProgressRing book={book} />
      <span
        dir="rtl"
        className="truncate font-ar text-section font-bold leading-normal text-ink"
      >
        {book.title}
      </span>
      <span className="flex items-center gap-2 text-small">
        <span className="text-ink-2">
          {plural({ n: book.files_total, one: "page", many: "pages" })}
        </span>
        {status && (
          <>
            <span className="text-ink-3">·</span>
            {status}
          </>
        )}
      </span>
    </Link>
  );
};

const SkeletonCard = () => (
  <div className="flex w-[270px] flex-col gap-4 rounded-lg border border-line bg-surface p-4">
    <Skeleton className="size-11 rounded-full" />
    <Skeleton className="h-[18px] w-40 rounded-sm" />
    <Skeleton className="h-3 w-[110px] rounded-sm" />
  </div>
);

const Grid = ({ children }: { children: React.ReactNode }) => (
  <div className="flex flex-wrap items-start gap-4">{children}</div>
);

const WorkGroup = ({
  work,
  books,
}: {
  work: WorkWithCounts | null;
  books: BookWithStatus[];
}) => (
  <section className="flex flex-col gap-3">
    <div className="flex items-center gap-3">
      {work ? (
        <span
          dir="rtl"
          className="font-ar text-section font-bold leading-normal text-ink"
        >
          {work.name}
        </span>
      ) : (
        <span className="font-display text-section font-semibold tracking-tight text-ink">
          Ungrouped
        </span>
      )}
      {work?.author && (
        <span className="text-small text-ink-2">{work.author}</span>
      )}
      <span className="text-small font-medium text-ink-3">
        {plural({ n: books.length, one: "copy", many: "copies" })}
      </span>
      {work && (
        <Link
          to={`/work/${work.id}`}
          className="flex items-center gap-1 text-small font-medium text-accent"
        >
          <Pencil size={14} />
          Edit work
        </Link>
      )}
      {work && work.tags.length > 0 && (
        <div className="ml-auto flex gap-3">
          {work.tags.map((t) => (
            <Chip key={t}>{t}</Chip>
          ))}
        </div>
      )}
    </div>
    <Grid>
      {books.map((b) => (
        <BookCard key={b.id} book={b} />
      ))}
    </Grid>
  </section>
);

const TagFilter = ({
  options,
  selected,
  onToggle,
}: {
  options: { name: string; books: number }[];
  selected: Set<string>;
  onToggle: (name: string) => void;
}) => {
  const [open, setOpen] = useState(false);
  const label =
    selected.size === 0
      ? "All tags"
      : `Tags: ${[...selected].sort().join(", ")}`;
  return (
    <div className="relative">
      <DropdownTrigger
        label={label}
        active={selected.size > 0}
        onClick={() => setOpen((o) => !o)}
      />
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        className="left-0 top-[calc(100%+8px)] w-60 origin-top-left"
      >
        {options.map((o) => (
          <CheckOption
            key={o.name}
            checked={selected.has(o.name)}
            onToggle={() => onToggle(o.name)}
            label={o.name}
            count={o.books}
          />
        ))}
      </Popover>
    </div>
  );
};

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
  const { configured } = useConfigState();

  const booksQuery = useQuery({
    queryKey: ["books"],
    queryFn: api.listBooks,
    enabled: configured,
  });
  const worksQuery = useQuery({
    queryKey: ["works"],
    queryFn: api.listWorks,
    enabled: configured,
  });

  const [view, setView] = useState<"all" | "work">("all");
  const [filter, setFilter] = useState("");
  const [selectedTags, toggleTag] = useToggleSet();

  const works = useMemo(() => worksQuery.data ?? [], [worksQuery.data]);
  const worksById = useMemo(
    () => new Map(works.map((w) => [w.id, w])),
    [works],
  );
  const books = useMemo(() => booksQuery.data ?? [], [booksQuery.data]);

  const tagOptions = useMemo(() => {
    const names = new Set<string>();
    for (const w of works) for (const t of w.tags) names.add(t);
    return [...names].sort().map((name) => ({
      name,
      books: books.filter((b) =>
        b.work_id ? worksById.get(b.work_id)?.tags.includes(name) : false,
      ).length,
    }));
  }, [works, books, worksById]);

  // Tags are OR'd; a book matches through its work, so standalone books drop
  // out once a tag is selected. The text filter matches title, work or author.
  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return books.filter((b) => {
      const work = b.work_id ? worksById.get(b.work_id) : undefined;
      if (selectedTags.size > 0 && !work?.tags.some((t) => selectedTags.has(t)))
        return false;
      if (!needle) return true;
      return [b.title, work?.name, work?.author].some((s) =>
        s?.toLowerCase().includes(needle),
      );
    });
  }, [books, filter, selectedTags, worksById]);

  const refreshing = booksQuery.isFetching || worksQuery.isFetching;
  const refresh = () => {
    booksQuery.refetch();
    worksQuery.refetch();
  };
  const refreshControl = (
    <RefreshControl
      onRefresh={refresh}
      refreshing={refreshing}
      updatedAt={booksQuery.dataUpdatedAt}
      failed={booksQuery.isError}
    />
  );
  const newBook = (
    <Button size="sm" icon={Plus} onClick={() => navigate("/new-book")}>
      New book
    </Button>
  );

  if (!configured)
    return (
      <>
        <PageHeader title="Library" />
        <EmptyState
          icon={Plug}
          title="Connect to your API"
          body="Add your worker endpoint and key in Settings to start scanning."
        >
          <Button onClick={() => navigate("/settings")}>Open Settings</Button>
        </EmptyState>
      </>
    );

  if (booksQuery.isError && !booksQuery.data)
    return (
      <>
        <PageHeader title="Library" actions={refreshControl} />
        <EmptyState
          icon={CloudOff}
          tone="danger"
          title="Couldn't load your books"
          body={errorMessage(booksQuery.error)}
        >
          <Button icon={RefreshCw} onClick={refresh} loading={refreshing}>
            Try again
          </Button>
          <Button variant="secondary" onClick={() => navigate("/settings")}>
            Open Settings
          </Button>
        </EmptyState>
      </>
    );

  if (booksQuery.isSuccess && books.length === 0)
    return (
      <>
        <PageHeader title="Library" actions={refreshControl} />
        <EmptyState
          icon={BookOpen}
          title="Start your library"
          body="Create a book, then upload its scanned pages. Each page is transcribed in the cloud and shows up here."
        >
          <Button icon={Plus} onClick={() => navigate("/new-book")}>
            New book
          </Button>
        </EmptyState>
      </>
    );

  const loading = booksQuery.isLoading;
  const totalPages = filtered.reduce((n, b) => n + b.files_total, 0);

  const grouped = (() => {
    const byWork = new Map<string, BookWithStatus[]>();
    const ungrouped: BookWithStatus[] = [];
    for (const b of filtered) {
      if (b.work_id && worksById.has(b.work_id)) {
        byWork.set(b.work_id, [...(byWork.get(b.work_id) ?? []), b]);
      } else {
        ungrouped.push(b);
      }
    }
    return {
      ordered: works
        .filter((w) => byWork.has(w.id))
        .map((w) => ({ work: w, books: byWork.get(w.id) ?? [] })),
      ungrouped,
    };
  })();

  return (
    <>
      <PageHeader
        title="Library"
        sub={
          loading
            ? "Loading books…"
            : `${plural({ n: filtered.length, one: "book", many: "books" })} · ${plural({ n: totalPages, one: "page", many: "pages" })}`
        }
        actions={
          <>
            {refreshControl}
            {newBook}
          </>
        }
      />
      <div
        className={cx(
          "flex min-h-0 flex-1 flex-col overflow-y-auto px-10 pb-10",
          view === "work" ? "gap-8" : "gap-6",
        )}
      >
        <div className="flex items-center gap-3">
          <SearchField
            value={filter}
            onChange={setFilter}
            placeholder="Filter by title or author"
            className="w-[360px]"
          />
          <Segmented
            className="w-[220px]"
            value={view}
            onChange={setView}
            options={[
              { value: "all", label: "All books" },
              { value: "work", label: "By work" },
            ]}
          />
          {tagOptions.length > 0 && (
            <TagFilter
              options={tagOptions}
              selected={selectedTags}
              onToggle={toggleTag}
            />
          )}
        </div>

        {loading ? (
          <Grid>
            {Array.from({ length: 6 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
              <SkeletonCard key={i} />
            ))}
          </Grid>
        ) : view === "work" ? (
          <>
            {grouped.ordered.map(({ work, books: copies }) => (
              <WorkGroup key={work.id} work={work} books={copies} />
            ))}
            {grouped.ungrouped.length > 0 && (
              <WorkGroup work={null} books={grouped.ungrouped} />
            )}
          </>
        ) : (
          <Grid>
            {filtered.map((b) => (
              <BookCard key={b.id} book={b} />
            ))}
          </Grid>
        )}
      </div>
    </>
  );
};
