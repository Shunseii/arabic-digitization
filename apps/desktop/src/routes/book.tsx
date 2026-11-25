import type { FileState, FileStatus, WorkWithCounts } from "@qiraa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  CloudOff,
  Copy,
  EllipsisVertical,
  Hash,
  Pencil,
  RefreshCw,
  RotateCw,
  Trash2,
  Upload,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Button,
  cx,
  Dialog,
  EmptyState,
  FieldLabel,
  IconButton,
  MenuItem,
  Popover,
  RefreshControl,
  Skeleton,
  StatusPill,
  TextField,
} from "@/components/ui";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { ago, count, plural, usd } from "@/lib/format";
import { forgetFile, loadStatus, recentKey, statusKey } from "@/lib/status";
import { statusLabel, statusTone } from "@/theme";

const READABLE: FileState[] = ["done", "approved", "needs_review"];

type Filter = "all" | "done" | "failed" | "queue";

const filterOf = (state: FileState): Exclude<Filter, "all"> =>
  READABLE.includes(state) ? "done" : state === "failed" ? "failed" : "queue";

const FILTERS: {
  value: Exclude<Filter, "all">;
  label: string;
  dot: string;
  bar: string;
}[] = [
  { value: "done", label: "done", dot: "bg-ok", bar: "bg-ok" },
  { value: "failed", label: "failed", dot: "bg-danger", bar: "bg-danger" },
  { value: "queue", label: "in queue", dot: "bg-accent", bar: "bg-accent" },
];

const pageLabel = (f: FileStatus) =>
  f.page_number != null ? count(f.page_number) : "—";

// Column widths shared by the header and rows (designs: TableRow on Book).
const COL = {
  page: "w-20",
  status: "w-[200px]",
  updated: "w-[90px]",
  trailing: "w-14",
};

const HeaderCell = ({
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

const RowText = ({ file }: { file: FileStatus }) => {
  if (file.state === "failed")
    return (
      <span className="truncate text-small text-danger">
        {file.error ?? "OCR failed"}
      </span>
    );
  if (!READABLE.includes(file.state))
    return (
      <span className="truncate text-small text-ink-3">
        Not transcribed yet
      </span>
    );
  if (!file.preview?.trim())
    return (
      <span className="truncate text-small italic text-ink-3">Blank page</span>
    );
  return (
    <span
      dir="rtl"
      className="w-full truncate text-right font-ar text-body font-medium leading-[1.6] text-ink"
    >
      {file.preview}
    </span>
  );
};

const PageRow = ({
  file,
  selected,
  flash,
  removing,
  onOpen,
  menu,
  rowRef,
}: {
  file: FileStatus;
  selected: boolean;
  flash: number | null;
  removing: boolean;
  onOpen: (() => void) | null;
  menu: ReactNode;
  rowRef?: (el: HTMLDivElement | null) => void;
}) => (
  <div
    ref={rowRef}
    className={cx(
      "relative flex items-center border-b border-line py-3 last:border-b-0",
      selected ? "bg-accent-soft" : "hover:bg-surface-2",
      removing && "opacity-40",
    )}
  >
    {flash !== null && <span key={flash} className="row-flash" />}
    <button
      type="button"
      disabled={!onOpen}
      onClick={() => onOpen?.()}
      className="flex min-w-0 flex-1 items-center text-left disabled:cursor-default"
    >
      <span
        className={cx(
          COL.page,
          "shrink-0 px-3 font-display text-section font-semibold leading-[1.2] tabular-nums tracking-[-0.01em] text-ink",
        )}
      >
        {pageLabel(file)}
      </span>
      <span className="flex min-w-0 flex-1 px-3">
        <RowText file={file} />
      </span>
      <span className={cx(COL.status, "flex shrink-0 items-center gap-2 px-3")}>
        <StatusPill tone={statusTone[file.state]}>
          {statusLabel[file.state]}
        </StatusPill>
      </span>
      <span
        className={cx(
          COL.updated,
          "shrink-0 px-3 text-right text-small tabular-nums text-ink",
        )}
      >
        {ago(file.updated_at)}
      </span>
    </button>
    <div
      className={cx(COL.trailing, "relative flex shrink-0 justify-end px-3")}
    >
      {menu}
    </div>
  </div>
);

export const BookScreen = () => {
  const navigate = useNavigate();
  const { id = "" } = useParams<{ id: string }>();
  const queryClient = useQueryClient();

  const [filter, setFilter] = useState<Filter>("all");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  // Only the last-opened row mounts its menu (keeps 1,000-page books light);
  // it stays mounted after closing so the exit fade can play.
  const [menuMounted, setMenuMounted] = useState<string | null>(null);
  const [errorFile, setErrorFile] = useState<FileStatus | null>(null);
  const [numbering, setNumbering] = useState<FileStatus | null>(null);
  const [pageInput, setPageInput] = useState("");
  const [deleting, setDeleting] = useState<FileStatus | null>(null);
  const [editBook, setEditBook] = useState(false);
  const [bookTitle, setBookTitle] = useState("");
  const [bookInstructions, setBookInstructions] = useState("");
  const [goTo, setGoTo] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const rowEls = useRef(new Map<string, HTMLDivElement>());

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: statusKey(id) });
    queryClient.invalidateQueries({ queryKey: ["books"] });
    queryClient.invalidateQueries({ queryKey: recentKey });
  };

  const bookQuery = useQuery({
    queryKey: ["book", id],
    queryFn: () => api.getBook(id),
  });
  const statusQuery = useQuery({
    queryKey: statusKey(id),
    queryFn: () => loadStatus(id),
  });

  // Rows a refresh changed flash once, so you see what moved.
  const seen = useRef<Map<string, number> | null>(null);
  const [changed, setChanged] = useState<{ at: number; ids: Set<string> }>({
    at: 0,
    ids: new Set(),
  });
  useEffect(() => {
    const files = statusQuery.data;
    if (!files) return;
    const previous = seen.current;
    seen.current = new Map(files.map((f) => [f.file_id, f.updated_at]));
    if (!previous) return;
    const ids = new Set(
      files
        .filter((f) => previous.get(f.file_id) !== f.updated_at)
        .map((f) => f.file_id),
    );
    if (ids.size > 0) setChanged({ at: statusQuery.dataUpdatedAt, ids });
  }, [statusQuery.data, statusQuery.dataUpdatedAt]);

  const retry = useMutation({
    mutationFn: (fileId: string) => api.rerunOcr({ bookId: id, fileId }),
    onSettled: invalidate,
  });
  const del = useMutation({
    mutationFn: (fileId: string) => api.deleteFile({ bookId: id, fileId }),
    onSuccess: (_, fileId) => forgetFile({ bookId: id, fileId }),
    onSettled: invalidate,
  });
  const patch = useMutation({
    mutationFn: ({ fileId, page }: { fileId: string; page: number | null }) =>
      api.updatePageNumber({ bookId: id, fileId, page }),
    onSettled: invalidate,
  });
  const saveBook = useMutation({
    mutationFn: () =>
      api.updateBook({
        id,
        body: {
          title: bookTitle.trim(),
          ocr_instructions: bookInstructions.trim() || null,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["book", id] });
      queryClient.invalidateQueries({ queryKey: ["books"] });
      setEditBook(false);
    },
  });

  const files = statusQuery.data ?? [];
  const counts = useMemo(() => {
    const c = { done: 0, failed: 0, queue: 0 };
    for (const f of files) c[filterOf(f.state)]++;
    return c;
  }, [files]);
  const shown =
    filter === "all"
      ? files
      : files.filter((f) => filterOf(f.state) === filter);

  const book = bookQuery.data;
  // The author lives on the work; read it from the Library's cache rather
  // than spending a request on it.
  const author = book?.work_id
    ? queryClient
        .getQueryData<WorkWithCounts[]>(["works"])
        ?.find((w) => w.id === book.work_id)?.author
    : null;
  const sub = [
    plural({
      n: book?.files_total ?? files.length,
      one: "page",
      many: "pages",
    }),
    book?.usage?.cost_usd != null ? `${usd(book.usage.cost_usd)} OCR` : null,
    author,
  ]
    .filter(Boolean)
    .join(" · ");

  const refreshing = statusQuery.isFetching || bookQuery.isFetching;
  const refresh = () => {
    statusQuery.refetch();
    bookQuery.refetch();
  };

  const openBookEdit = () => {
    setBookTitle(book?.title ?? "");
    setBookInstructions(book?.ocr_instructions ?? "");
    saveBook.reset();
    setEditBook(true);
  };
  const openNumbering = (f: FileStatus) => {
    setMenuFor(null);
    setPageInput(f.page_number != null ? String(f.page_number) : "");
    setNumbering(f);
  };
  const saveNumbering = () => {
    if (!numbering) return;
    const v = pageInput.trim();
    patch.mutate({
      fileId: numbering.file_id,
      page: v ? Number.parseInt(v, 10) : null,
    });
    setNumbering(null);
  };
  const goToPage = () => {
    const n = Number.parseInt(goTo ?? "", 10);
    const target = files.find((f) => f.page_number === n);
    setGoTo(null);
    if (!target) return;
    setFilter("all");
    setSelected(target.file_id);
    requestAnimationFrame(() =>
      rowEls.current.get(target.file_id)?.scrollIntoView({ block: "center" }),
    );
  };

  const header = (
    <header className="flex shrink-0 items-center gap-4 px-10 pb-6 pt-8">
      <IconButton
        icon={ChevronLeft}
        label="Back to Library"
        variant="tonal"
        onClick={() => navigate("/")}
      />
      <div className="flex min-w-0 flex-col gap-1">
        <h1
          dir="rtl"
          className="truncate text-left font-ar text-number font-bold leading-normal text-ink"
        >
          {book?.title ?? "…"}
        </h1>
        {book && <p className="text-small text-ink-2">{sub}</p>}
      </div>
      <IconButton
        icon={Pencil}
        label="Edit book"
        variant="tonal"
        className="ml-auto"
        onClick={openBookEdit}
        disabled={!book}
      />
      <RefreshControl
        onRefresh={refresh}
        refreshing={refreshing}
        updatedAt={statusQuery.dataUpdatedAt}
        failed={statusQuery.isError}
      />
      <Button size="sm" icon={Upload} onClick={() => navigate(`/upload/${id}`)}>
        Upload pages
      </Button>
    </header>
  );

  let body: ReactNode;
  if (statusQuery.isError && !statusQuery.data) {
    body = (
      <EmptyState
        icon={CloudOff}
        tone="danger"
        title="Couldn't load pages"
        body={`${errorMessage(statusQuery.error)} Your pages are safe.`}
      >
        <Button icon={RefreshCw} onClick={refresh} loading={refreshing}>
          Try again
        </Button>
      </EmptyState>
    );
  } else if (statusQuery.isSuccess && files.length === 0) {
    body = (
      <EmptyState
        icon={Upload}
        title="No pages yet"
        body="Upload scans of this book. Pages are numbered in the order you add them."
      >
        <Button icon={Upload} onClick={() => navigate(`/upload/${id}`)}>
          Upload pages
        </Button>
      </EmptyState>
    );
  } else if (statusQuery.isLoading) {
    body = (
      <div className="flex flex-col gap-5 px-10 pb-10">
        <div className="flex flex-col gap-3">
          <Skeleton className="h-2.5 w-full rounded-sm" />
          <div className="flex gap-2">
            {Array.from({ length: 4 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
              <Skeleton key={i} className="h-8 w-[90px] rounded-full" />
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface px-5 py-2">
          {Array.from({ length: 7 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
            <div key={i} className="flex items-center gap-6 py-3">
              <Skeleton className="h-6 w-9 rounded-sm" />
              <Skeleton className="h-4 w-[520px] rounded-sm" />
              <Skeleton className="ml-auto h-[22px] w-20 rounded-sm" />
            </div>
          ))}
        </div>
      </div>
    );
  } else {
    body = (
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-10 pb-10">
        <div className="flex flex-col gap-3">
          <div className="flex w-full items-center gap-0.5">
            {FILTERS.filter((f) => counts[f.value] > 0).map((f) => (
              <div
                key={f.value}
                className={cx("h-2.5 min-w-1.5 rounded-[3px]", f.bar)}
                style={{ flex: counts[f.value] }}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            <FilterChip
              active={filter === "all"}
              onClick={() => setFilter("all")}
            >
              All {count(files.length)}
            </FilterChip>
            {FILTERS.filter((f) => counts[f.value] > 0).map((f) => (
              <FilterChip
                key={f.value}
                active={filter === f.value}
                onClick={() => setFilter(filter === f.value ? "all" : f.value)}
                dot={f.dot}
              >
                {count(counts[f.value])} {f.label}
              </FilterChip>
            ))}
            <div className="ml-auto">
              {goTo === null ? (
                <button
                  type="button"
                  onClick={() => setGoTo("")}
                  className="press flex items-center gap-2 text-small font-semibold text-accent"
                >
                  <Hash size={16} />
                  Go to page
                </button>
              ) : (
                <label className="flex items-center gap-2 text-small font-semibold text-accent">
                  <Hash size={16} />
                  <input
                    // biome-ignore lint/a11y/noAutofocus: the field the click just revealed
                    autoFocus
                    value={goTo}
                    inputMode="numeric"
                    placeholder="Page"
                    onChange={(e) =>
                      setGoTo(e.target.value.replace(/[^0-9]/g, ""))
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") goToPage();
                      if (e.key === "Escape") setGoTo(null);
                    }}
                    onBlur={() => setGoTo(null)}
                    className="h-8 w-20 rounded-sm border border-line bg-surface px-2 text-ink outline-none focus:border-accent"
                  />
                </label>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-col rounded-lg border border-line bg-surface px-2 py-1">
          <div className="flex items-center border-b border-line">
            <HeaderCell className={COL.page}>Page</HeaderCell>
            <HeaderCell className="flex-1">Text</HeaderCell>
            <HeaderCell className={COL.status}>Status</HeaderCell>
            <HeaderCell className={cx(COL.updated, "justify-end")}>
              Updated
            </HeaderCell>
            <HeaderCell className={COL.trailing} />
          </div>
          {shown.map((f) => {
            const readable = READABLE.includes(f.state);
            const open = readable
              ? () => navigate(`/reader/${id}/${f.file_id}`)
              : f.state === "failed" && f.error
                ? () => setErrorFile(f)
                : null;
            return (
              <PageRow
                key={f.file_id}
                file={f}
                selected={selected === f.file_id || menuFor === f.file_id}
                flash={changed.ids.has(f.file_id) ? changed.at : null}
                removing={del.isPending && del.variables === f.file_id}
                onOpen={open}
                rowRef={(el) => {
                  if (el) rowEls.current.set(f.file_id, el);
                  else rowEls.current.delete(f.file_id);
                }}
                menu={
                  <>
                    <IconButton
                      icon={EllipsisVertical}
                      label="Page actions"
                      className="size-6 text-ink-3"
                      onClick={() => {
                        setMenuMounted(f.file_id);
                        setMenuFor(f.file_id);
                      }}
                    />
                    {menuMounted === f.file_id && (
                      <Popover
                        open={menuFor === f.file_id}
                        onClose={() => setMenuFor(null)}
                        className="right-0 top-[calc(100%+4px)] w-[268px] origin-top-right"
                      >
                        <span className="px-3 pb-1 pt-2 text-label font-semibold uppercase tracking-[0.08em] text-ink-3">
                          Page {pageLabel(f)}
                        </span>
                        <MenuItem icon={Hash} onClick={() => openNumbering(f)}>
                          Change page number
                        </MenuItem>
                        <MenuItem
                          icon={RotateCw}
                          onClick={() => {
                            setMenuFor(null);
                            retry.mutate(f.file_id);
                          }}
                        >
                          Re-run OCR
                        </MenuItem>
                        <div className="my-1 h-px bg-line" />
                        <MenuItem
                          icon={Trash2}
                          tone="danger"
                          onClick={() => {
                            setMenuFor(null);
                            setDeleting(f);
                          }}
                        >
                          Delete page
                        </MenuItem>
                      </Popover>
                    )}
                  </>
                }
              />
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <>
      {header}
      {body}

      <Dialog
        open={numbering !== null}
        onClose={() => setNumbering(null)}
        title="Page number"
        width="w-[360px]"
      >
        <TextField
          label="Page"
          value={pageInput}
          inputMode="numeric"
          placeholder="—"
          helper="Pages after this one keep their numbers."
          onChange={(e) => setPageInput(e.target.value.replace(/[^0-9]/g, ""))}
          onKeyDown={(e) => e.key === "Enter" && saveNumbering()}
        />
        <div className="mt-2 flex items-center gap-3">
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => setNumbering(null)}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={saveNumbering}>
            Save
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`Delete page ${deleting ? pageLabel(deleting) : ""}?`}
        width="w-[420px]"
      >
        <p className="text-body text-ink-2">
          Removes the scan and its transcription. This can't be undone.
        </p>
        <div className="mt-2 flex items-center gap-3">
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => setDeleting(null)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            variant="danger"
            icon={Trash2}
            onClick={() => {
              if (deleting) del.mutate(deleting.file_id);
              setDeleting(null);
            }}
          >
            Delete page
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={editBook}
        onClose={() => setEditBook(false)}
        title="Edit book"
        width="w-[520px]"
      >
        <TextField
          label="Title"
          rtl
          value={bookTitle}
          onChange={(e) => setBookTitle(e.target.value)}
        />
        <label className="flex flex-col gap-2">
          <FieldLabel>OCR instructions · optional</FieldLabel>
          <textarea
            value={bookInstructions}
            onChange={(e) => setBookInstructions(e.target.value)}
            placeholder="Preserve tashkeel. Keep footnotes at the bottom of the page."
            className="min-h-[110px] resize-y rounded-md border-[1.5px] border-line bg-surface px-4 py-3 text-body text-ink outline-none placeholder:text-ink-3 focus:border-accent"
          />
          <span className="text-small text-ink-3">
            Applied to every page of this book. Changing them starts a new
            version, so Usage can compare before and after.
          </span>
        </label>
        {saveBook.error && (
          <p className="text-small text-danger">
            {errorMessage(saveBook.error)}
          </p>
        )}
        <div className="mt-2 flex items-center gap-3">
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => setEditBook(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => saveBook.mutate()}
            disabled={!bookTitle.trim()}
            loading={saveBook.isPending}
          >
            Save
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={errorFile !== null}
        onClose={() => setErrorFile(null)}
        title={
          <span className="flex flex-col gap-4">
            <span className="font-body text-label font-semibold uppercase tracking-[0.08em] text-danger">
              OCR error
            </span>
            Page {errorFile ? pageLabel(errorFile) : ""} failed
          </span>
        }
        width="w-[560px]"
      >
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-line bg-bg p-3 font-mono text-small text-ink">
          {errorFile?.error}
        </pre>
        <p className="text-small text-ink-2">
          Re-running queues the page again.
        </p>
        <div className="mt-2 flex items-center gap-3">
          <Button
            size="sm"
            variant="ghost"
            icon={Copy}
            className="ml-auto"
            onClick={() =>
              navigator.clipboard.writeText(errorFile?.error ?? "")
            }
          >
            Copy
          </Button>
          <Button
            size="sm"
            icon={RotateCw}
            onClick={() => {
              if (errorFile) retry.mutate(errorFile.file_id);
              setErrorFile(null);
            }}
          >
            Re-run OCR
          </Button>
        </div>
      </Dialog>
    </>
  );
};

const FilterChip = ({
  active,
  dot,
  onClick,
  children,
}: {
  active: boolean;
  dot?: string;
  onClick: () => void;
  children: ReactNode;
}) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={cx(
      "press flex h-8 items-center gap-2 rounded-full border px-3 text-small",
      active
        ? "border-accent-soft bg-accent-soft font-semibold text-accent"
        : "border-line text-ink-2",
    )}
  >
    {dot && <span className={cx("size-2 rounded-full", dot)} />}
    {children}
  </button>
);
