import { UPLOAD_CONTENT_TYPES, type UploadContentType } from "@qiraa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  CircleCheck,
  ImagePlus,
  RotateCw,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Badge,
  Button,
  EmptyState,
  ErrorBanner,
  FieldLabel,
  IconButton,
  Skeleton,
} from "@/components/ui";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { count, plural } from "@/lib/format";
import { loadStatus, recentKey, statusKey } from "@/lib/status";

type ItemState = "pending" | "uploading" | "done" | "error";
interface QueueItem {
  id: string;
  file: File;
  preview: string;
  state: ItemState;
  error?: string;
}

const isUploadable = (file: File): boolean =>
  (UPLOAD_CONTENT_TYPES as readonly string[]).includes(file.type);

const mimeFor = (file: File): UploadContentType =>
  isUploadable(file) ? (file.type as UploadContentType) : "image/jpeg";

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const FileRow = ({
  item,
  page,
  trailing,
}: {
  item: QueueItem;
  page: number;
  trailing: React.ReactNode;
}) => (
  <div className="flex items-center gap-4 border-b border-line py-3 last:border-b-0">
    <img
      src={item.preview}
      alt=""
      className="h-12 w-9 shrink-0 rounded-[3px] bg-paper object-cover shadow-sm"
    />
    <span className="w-16 shrink-0 font-display text-section font-semibold leading-[1.2] tabular-nums tracking-[-0.01em] text-ink">
      {page}
    </span>
    <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-small">
      <span className="truncate text-ink">{item.file.name}</span>
      {item.state === "error" ? (
        <span className="truncate text-danger">{item.error}</span>
      ) : (
        <span className="text-ink-3">{megabytes(item.file.size)}</span>
      )}
    </div>
    {trailing}
  </div>
);

export const UploadScreen = () => {
  const navigate = useNavigate();
  const { bookId = "" } = useParams<{ bookId: string }>();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);

  const [items, setItems] = useState<QueueItem[]>([]);
  const [startPage, setStartPage] = useState("");

  // Revoke thumbnail URLs when the screen goes away.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(
    () => () => {
      for (const it of itemsRef.current) URL.revokeObjectURL(it.preview);
    },
    [],
  );

  const bookQuery = useQuery({
    queryKey: ["book", bookId],
    queryFn: () => api.getBook(bookId),
  });
  const statusQuery = useQuery({
    queryKey: statusKey(bookId),
    queryFn: () => loadStatus(bookId),
  });

  const nextPage = useMemo(() => {
    const max = (statusQuery.data ?? []).reduce(
      (m, f) => Math.max(m, f.page_number ?? 0),
      0,
    );
    return max > 0 ? max + 1 : 1;
  }, [statusQuery.data]);

  const effectiveStart = startPage.trim()
    ? Number.parseInt(startPage, 10)
    : nextPage;

  const addFiles = (fileList: FileList | null) => {
    if (!fileList) return;
    // Dropped files skip the input's `accept` filter, so a PDF could get in.
    const next = Array.from(fileList)
      .filter(isUploadable)
      .map<QueueItem>((file) => ({
        id: crypto.randomUUID(),
        file,
        preview: URL.createObjectURL(file),
        state: "pending",
      }));
    setItems((prev) => [...prev, ...next]);
  };
  const remove = (id: string) =>
    setItems((prev) =>
      prev.filter((it) => {
        if (it.id === id) URL.revokeObjectURL(it.preview);
        return it.id !== id;
      }),
    );
  const reset = () => {
    for (const it of items) URL.revokeObjectURL(it.preview);
    setItems([]);
    setStartPage("");
    upload.reset();
  };

  const setItem = (index: number, patch: Partial<QueueItem>) =>
    setItems((prev) =>
      prev.map((it, j) => (j === index ? { ...it, ...patch } : it)),
    );

  const upload = useMutation({
    mutationFn: async (only?: number) => {
      for (let i = 0; i < items.length; i += 1) {
        if (items[i].state === "done") continue;
        if (only !== undefined && i !== only) continue;
        setItem(i, { state: "uploading", error: undefined });
        try {
          await api.uploadPage({
            bookId,
            blob: items[i].file,
            page: effectiveStart + i,
            mime: mimeFor(items[i].file),
          });
          setItem(i, { state: "done" });
        } catch (err) {
          setItem(i, {
            state: "error",
            error: `${errorMessage(err)} Retry this page.`,
          });
        }
      }
    },
    // Pin the start page: the refetch after upload moves "next page" on.
    onMutate: () => setStartPage(String(effectiveStart)),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: statusKey(bookId) });
      queryClient.invalidateQueries({ queryKey: ["books"] });
      queryClient.invalidateQueries({ queryKey: recentKey });
    },
  });

  const uploaded = items.filter((it) => it.state === "done").length;
  const failed = items.filter((it) => it.state === "error").length;
  const working = upload.isPending;
  const allDone = items.length > 0 && uploaded === items.length;
  const started = items.some((it) => it.state !== "pending");

  const header = (
    <header className="flex shrink-0 items-center gap-4 px-10 pb-6 pt-8">
      <IconButton
        icon={ChevronLeft}
        label="Back to book"
        variant="tonal"
        onClick={() => navigate(`/book/${bookId}`)}
      />
      <div className="flex items-baseline gap-4">
        <h1 className="font-display text-title font-semibold text-ink">
          Upload pages
        </h1>
        <span
          dir="rtl"
          className="font-ar text-body font-bold leading-[1.6] text-ink-2"
        >
          {bookQuery.data?.title}
        </span>
      </div>
    </header>
  );

  if (allDone && !working)
    return (
      <>
        {header}
        <EmptyState
          icon={CircleCheck}
          tone="ok"
          title={`${plural({ n: uploaded, one: "page", many: "pages" })} uploaded`}
          body={`${
            uploaded === 1
              ? `Page ${count(effectiveStart)} is`
              : `Pages ${count(effectiveStart)}–${count(effectiveStart + uploaded - 1)} are`
          } queued for OCR. Refresh the book to see them land.`}
        >
          <Button onClick={() => navigate(`/book/${bookId}`)}>
            Back to book
          </Button>
          <Button variant="secondary" onClick={reset}>
            Upload more
          </Button>
        </EmptyState>
      </>
    );

  const trailingFor = (it: QueueItem, i: number) => {
    if (it.state === "done") return <Badge tone="ok">uploaded</Badge>;
    if (it.state === "uploading") return <Badge tone="accent">uploading</Badge>;
    if (it.state === "error")
      return (
        <Button
          size="sm"
          variant="secondary"
          icon={RotateCw}
          disabled={working}
          onClick={() => upload.mutate(i)}
        >
          Retry
        </Button>
      );
    if (working)
      return <span className="text-small font-medium text-ink-3">waiting</span>;
    return (
      <IconButton
        icon={X}
        label="Remove"
        className="size-8 text-ink-3"
        onClick={() => remove(it.id)}
      />
    );
  };

  return (
    <>
      {header}
      <div className="flex min-h-0 flex-1 justify-center overflow-y-auto">
        <div className="flex w-[760px] flex-col gap-5 pb-10">
          {failed > 0 && !working && (
            <ErrorBanner title="Some uploads failed">
              {count(failed)} of {count(items.length)} pages didn't upload.
              {uploaded > 0 && " The others are queued for OCR."}
            </ErrorBanner>
          )}
          {!started && (
            <>
              <div className="flex items-end gap-4">
                <div className="flex w-40 flex-col gap-2">
                  <FieldLabel>Start at page</FieldLabel>
                  {statusQuery.isLoading ? (
                    <Skeleton className="h-[50px] rounded-md" />
                  ) : (
                    <input
                      aria-label="Start at page"
                      value={startPage}
                      inputMode="numeric"
                      onChange={(e) =>
                        setStartPage(e.target.value.replace(/[^0-9]/g, ""))
                      }
                      placeholder={String(nextPage)}
                      className="h-[50px] rounded-md border border-line bg-surface px-3.5 text-body text-ink outline-none placeholder:text-ink focus:border-accent"
                    />
                  )}
                </div>
                <p className="pb-4 text-small text-ink-2">
                  Pages are numbered from here in the order shown.
                </p>
              </div>
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  addFiles(e.dataTransfer.files);
                }}
                className="flex flex-col items-center gap-2 rounded-lg border-[1.5px] border-dashed border-line bg-surface py-14 hover:border-accent"
              >
                <span className="flex size-12 items-center justify-center rounded-full bg-accent-soft">
                  <ImagePlus size={22} className="text-accent" />
                </span>
                <span className="text-body font-semibold text-ink">
                  Drop scans here, or click to choose
                </span>
                <span className="text-small text-ink-3">JPEG, PNG or WebP</span>
              </button>
              <input
                ref={inputRef}
                type="file"
                multiple
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(e) => {
                  addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </>
          )}
          {items.length > 0 && (
            <div className="flex flex-col rounded-lg border border-line bg-surface px-5 py-1">
              {items.map((it, i) => (
                <FileRow
                  key={it.id}
                  item={it}
                  page={effectiveStart + i}
                  trailing={trailingFor(it, i)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      <footer className="flex shrink-0 items-center gap-4 border-t border-line bg-surface px-10 py-4">
        {working && (
          <span className="flex-1 text-small text-ink-2">
            Keep Qiraa open until uploads finish.
          </span>
        )}
        {failed > 0 && !working ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={() => navigate(`/book/${bookId}`)}
            >
              Back to book
            </Button>
            <Button
              className="w-[280px]"
              icon={Upload}
              onClick={() => upload.mutate(undefined)}
            >
              Retry {plural({ n: failed, one: "page", many: "pages" })}
            </Button>
          </>
        ) : (
          <Button
            className="ml-auto w-[280px]"
            icon={working ? undefined : Upload}
            disabled={items.length === 0}
            loading={working}
            onClick={() => upload.mutate(undefined)}
          >
            {working
              ? `Uploading… ${count(Math.min(uploaded + failed + 1, items.length))} of ${count(items.length)}`
              : items.length === 0
                ? "Upload pages"
                : `Upload ${plural({ n: items.length, one: "page", many: "pages" })}`}
          </Button>
        )}
      </footer>
    </>
  );
};
