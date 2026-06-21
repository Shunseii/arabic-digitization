import { UPLOAD_CONTENT_TYPES, type UploadContentType } from "@qiraa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronLeft, FileImage, Upload, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Loading } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { colors } from "@/theme";

type ItemState = "pending" | "uploading" | "done" | "error";
interface QueueItem {
  id: string;
  file: File;
  state: ItemState;
  error?: string;
}

const mimeFor = (file: File): UploadContentType => {
  const t = file.type as UploadContentType;
  return UPLOAD_CONTENT_TYPES.includes(t) ? t : "image/jpeg";
};

export const UploadScreen = () => {
  const navigate = useNavigate();
  const { bookId = "" } = useParams<{ bookId: string }>();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);

  const [items, setItems] = useState<QueueItem[]>([]);
  const [startPage, setStartPage] = useState("");

  const bookQuery = useQuery({
    queryKey: ["book", bookId],
    queryFn: () => api.getBook(bookId),
  });
  const statusQuery = useQuery({
    queryKey: ["status", bookId],
    queryFn: () => api.status(bookId),
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
    const next = Array.from(fileList).map<QueueItem>((file) => ({
      id: crypto.randomUUID(),
      file,
      state: "pending",
    }));
    setItems((prev) => [...prev, ...next]);
  };

  const upload = useMutation({
    mutationFn: async () => {
      let page = effectiveStart;
      for (let i = 0; i < items.length; i += 1) {
        if (items[i].state === "done") {
          page += 1;
          continue;
        }
        setItems((prev) =>
          prev.map((it, j) =>
            j === i ? { ...it, state: "uploading", error: undefined } : it,
          ),
        );
        try {
          await api.uploadPage({
            bookId,
            blob: items[i].file,
            page,
            mime: mimeFor(items[i].file),
          });
          setItems((prev) =>
            prev.map((it, j) => (j === i ? { ...it, state: "done" } : it)),
          );
          page += 1;
        } catch (err) {
          const msg =
            err instanceof ApiError
              ? `${err.status}: ${err.message}`
              : String(err);
          setItems((prev) =>
            prev.map((it, j) =>
              j === i ? { ...it, state: "error", error: msg } : it,
            ),
          );
        }
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["status", bookId] });
      queryClient.invalidateQueries({ queryKey: ["books"] });
      queryClient.invalidateQueries({ queryKey: ["recent"] });
    },
  });

  if (statusQuery.isLoading) return <Loading />;

  const allDone = items.length > 0 && items.every((it) => it.state === "done");

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-row items-center gap-3 px-8 py-4">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-surface"
        >
          <ChevronLeft size={18} color={colors.textSecondary} />
        </button>
        <div className="flex flex-1 flex-col overflow-hidden">
          <h1 className="text-xl text-ink">Upload pages</h1>
          <span className="truncate text-xs text-text-muted" dir="rtl">
            {bookQuery.data?.title ?? "…"}
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-8 pb-28">
        <div className="mx-auto max-w-2xl">
          <div className="flex flex-row items-end gap-4">
            <div className="flex flex-col">
              <span className="mb-2 block text-xs font-bold tracking-wide text-text-muted">
                STARTING PAGE
              </span>
              <input
                value={startPage}
                onChange={(e) =>
                  setStartPage(e.target.value.replace(/[^0-9]/g, ""))
                }
                placeholder={String(nextPage)}
                className="w-28 rounded-xl border border-border bg-surface px-4 py-3 text-base text-ink outline-none placeholder:text-text-muted focus:border-accent"
              />
            </div>
            <p className="pb-3 text-xs text-text-secondary">
              Pages number up from {effectiveStart} in the order listed below.
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
            className="mt-5 flex w-full cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border bg-surface py-12 transition-colors hover:border-accent/50"
          >
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft">
              <FileImage size={22} color={colors.accent} />
            </span>
            <span className="text-sm font-semibold text-ink">
              Drop scans here or click to choose
            </span>
            <span className="text-xs text-text-muted">
              JPEG, PNG, WebP, or PDF · added in selection order
            </span>
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp,application/pdf"
            className="hidden"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />

          {items.length > 0 && (
            <div className="mt-6">
              {items.map((it, i) => (
                <div
                  key={it.id}
                  className="flex flex-row items-center gap-3 py-3"
                  style={{
                    borderTop:
                      i > 0 ? `1px solid ${colors.hairline}` : undefined,
                  }}
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-alt">
                    <span className="text-sm font-semibold text-ink">
                      {effectiveStart + i}
                    </span>
                  </span>
                  <div className="flex flex-1 flex-col overflow-hidden">
                    <span className="truncate text-sm text-ink">
                      {it.file.name}
                    </span>
                    {it.error && (
                      <span className="truncate text-xs text-st-fail">
                        {it.error}
                      </span>
                    )}
                  </div>
                  <ItemStatus state={it.state} />
                  {it.state === "pending" && !upload.isPending && (
                    <button
                      type="button"
                      onClick={() =>
                        setItems((prev) => prev.filter((_, j) => j !== i))
                      }
                      className="flex h-7 w-7 items-center justify-center rounded-full hover:bg-surface-alt"
                    >
                      <X size={15} color={colors.textMuted} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div
        className="absolute bottom-0 left-0 right-0 border-t border-hairline bg-surface px-8 py-4"
        style={{ marginLeft: 0 }}
      >
        <div className="mx-auto flex max-w-2xl flex-row gap-3">
          {allDone ? (
            <button
              type="button"
              onClick={() => navigate(`/book/${bookId}`)}
              className="flex flex-1 items-center justify-center rounded-xl bg-accent py-4"
            >
              <span className="text-base font-bold text-accent-ink">
                Done · back to book
              </span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => upload.mutate()}
              disabled={items.length === 0 || upload.isPending}
              className="flex flex-1 flex-row items-center justify-center gap-2 rounded-xl bg-accent py-4 disabled:opacity-50"
            >
              <Upload size={18} color={colors.accentInk} />
              <span className="text-base font-bold text-accent-ink">
                {upload.isPending
                  ? "Uploading…"
                  : `Upload ${items.length || ""} ${items.length === 1 ? "page" : "pages"}`}
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

const ItemStatus = ({ state }: { state: ItemState }) => {
  if (state === "done") return <Check size={18} color="#46B97D" />;
  if (state === "error") return <X size={18} color="#EE6A4D" />;
  if (state === "uploading")
    return (
      <span className="text-xs font-semibold" style={{ color: colors.accent }}>
        …
      </span>
    );
  return <span className="text-xs text-text-muted">queued</span>;
};
