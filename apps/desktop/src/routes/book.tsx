import type { FileStatus } from "@qiraa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  Hash,
  type LucideIcon,
  MoreVertical,
  Pencil,
  RefreshCw,
  RotateCw,
  Trash2,
  Upload,
} from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Loading, StatusBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { colors } from "@/theme";

const READABLE: FileStatus["state"][] = ["done", "approved", "needs_review"];
const isPending = (f: FileStatus): boolean =>
  f.state === "queued" || f.state === "processing";
const pageLabel = (f: FileStatus, index: number): string =>
  f.page_number != null ? String(f.page_number) : `#${index + 1}`;

export const BookScreen = () => {
  const navigate = useNavigate();
  const { id = "" } = useParams<{ id: string }>();
  const queryClient = useQueryClient();

  const [menuFile, setMenuFile] = useState<FileStatus | null>(null);
  const [errorFile, setErrorFile] = useState<FileStatus | null>(null);
  const [editing, setEditing] = useState<FileStatus | null>(null);
  const [pageInput, setPageInput] = useState("");
  const [editBook, setEditBook] = useState(false);
  const [bookTitle, setBookTitle] = useState("");
  const [bookInstructions, setBookInstructions] = useState("");

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["status", id] });
    queryClient.invalidateQueries({ queryKey: ["books"] });
    queryClient.invalidateQueries({ queryKey: ["recent"] });
  };

  const bookQuery = useQuery({
    queryKey: ["book", id],
    queryFn: () => api.getBook(id),
  });
  const statusQuery = useQuery({
    queryKey: ["status", id],
    queryFn: () => api.status(id),
    refetchInterval: (query) =>
      query.state.data?.some(isPending) ? 4000 : false,
  });

  const retry = useMutation({
    mutationFn: (fileId: string) => api.rerunOcr({ bookId: id, fileId }),
    onSettled: invalidate,
  });
  const del = useMutation({
    mutationFn: (fileId: string) => api.deleteFile({ bookId: id, fileId }),
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

  const files = (statusQuery.data ?? [])
    .slice()
    .sort(
      (a, b) =>
        (a.page_number ?? Number.MAX_SAFE_INTEGER) -
        (b.page_number ?? Number.MAX_SAFE_INTEGER),
    );

  const openBookEdit = () => {
    const b = bookQuery.data;
    setBookTitle(b?.title ?? "");
    setBookInstructions(b?.ocr_instructions ?? "");
    setEditBook(true);
  };
  const startEdit = (f: FileStatus) => {
    setMenuFile(null);
    setPageInput(f.page_number != null ? String(f.page_number) : "");
    setEditing(f);
  };
  const saveEdit = () => {
    if (!editing) return;
    const v = pageInput.trim();
    patch.mutate({
      fileId: editing.file_id,
      page: v ? Number.parseInt(v, 10) : null,
    });
    setEditing(null);
  };
  const confirmDelete = (f: FileStatus) => {
    setMenuFile(null);
    if (
      window.confirm(
        "Delete page? Removes the scan and its transcription. Cannot be undone.",
      )
    )
      del.mutate(f.file_id);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-row items-center gap-3 px-8 py-4">
        <button
          type="button"
          onClick={() => navigate("/")}
          className="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-surface"
        >
          <ChevronLeft size={18} color={colors.textSecondary} />
        </button>
        <div className="flex flex-1 flex-col overflow-hidden">
          <span className="truncate text-xl text-ink" dir="rtl">
            {bookQuery.data?.title ?? "…"}
          </span>
          <span className="text-xs text-text-muted">{files.length} pages</span>
        </div>
        <button
          type="button"
          onClick={openBookEdit}
          className="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-surface"
        >
          <Pencil size={16} color={colors.textSecondary} />
        </button>
        <button
          type="button"
          onClick={() => statusQuery.refetch()}
          className="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-surface"
        >
          <RefreshCw size={16} color={colors.textSecondary} />
        </button>
        <button
          type="button"
          onClick={() => navigate(`/upload/${id}`)}
          className="flex flex-row items-center gap-2 rounded-xl bg-accent px-4 py-2.5"
        >
          <Upload size={16} color={colors.accentInk} />
          <span className="text-sm font-bold text-accent-ink">
            Upload pages
          </span>
        </button>
      </div>

      {statusQuery.isLoading ? (
        <Loading />
      ) : (
        <div className="flex-1 overflow-y-auto px-8 pb-10">
          <div className="mx-auto max-w-3xl">
            {files.length === 0 ? (
              <p className="mt-12 text-center text-sm text-text-secondary">
                No pages yet. Click “Upload pages” to add some.
              </p>
            ) : (
              files.map((f, i) => {
                const readable = READABLE.includes(f.state);
                const removing = del.isPending && del.variables === f.file_id;
                return (
                  <div
                    key={f.file_id}
                    className="flex flex-row items-center gap-2 py-3"
                    style={{
                      borderTop:
                        i > 0 ? `1px solid ${colors.hairline}` : undefined,
                      opacity: removing ? 0.4 : 1,
                    }}
                  >
                    <button
                      type="button"
                      disabled={
                        !readable && !(f.state === "failed" && !!f.error)
                      }
                      onClick={() => {
                        if (readable) navigate(`/reader/${id}/${f.file_id}`);
                        else if (f.error) setErrorFile(f);
                      }}
                      className="flex flex-1 flex-row items-center gap-3 overflow-hidden text-left disabled:cursor-default"
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-alt">
                        <span className="text-sm font-semibold text-ink">
                          {pageLabel(f, i)}
                        </span>
                      </span>
                      <span className="flex flex-1 flex-col gap-0.5 overflow-hidden">
                        {f.preview ? (
                          <span className="truncate text-sm text-ink" dir="rtl">
                            {f.preview}
                          </span>
                        ) : (
                          <span className="text-sm text-text-muted">
                            Page {pageLabel(f, i)}
                          </span>
                        )}
                        {f.error ? (
                          <span className="truncate text-xs text-st-fail">
                            {f.error}
                          </span>
                        ) : null}
                      </span>
                    </button>
                    <StatusBadge state={f.state} />
                    <button
                      type="button"
                      onClick={() => setMenuFile(f)}
                      className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-surface-alt"
                    >
                      <MoreVertical size={18} color={colors.textMuted} />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {menuFile && (
        <Overlay onClose={() => setMenuFile(null)}>
          <div className="w-72 rounded-2xl border border-border bg-surface p-2">
            <p className="px-3 py-2 text-xs font-bold tracking-wide text-text-muted">
              PAGE {menuFile.page_number ?? "—"}
            </p>
            <MenuItem
              icon={Hash}
              label="Change page number"
              onClick={() => startEdit(menuFile)}
            />
            <MenuItem
              icon={RotateCw}
              label="Re-run OCR"
              onClick={() => {
                const f = menuFile;
                setMenuFile(null);
                retry.mutate(f.file_id);
              }}
            />
            <MenuItem
              icon={Trash2}
              label="Delete page"
              destructive
              onClick={() => confirmDelete(menuFile)}
            />
          </div>
        </Overlay>
      )}

      {errorFile && (
        <Overlay onClose={() => setErrorFile(null)}>
          <div className="flex max-h-[70vh] w-[34rem] max-w-[90vw] flex-col gap-3 rounded-2xl border border-border bg-surface p-5">
            <p className="text-xs font-bold tracking-wide text-st-fail">
              OCR ERROR · PAGE {errorFile.page_number ?? "—"}
            </p>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-bg p-3 text-xs leading-6 text-ink">
              {errorFile.error}
            </pre>
            <div className="flex flex-row items-center justify-end gap-4">
              <button
                type="button"
                onClick={() =>
                  navigator.clipboard.writeText(errorFile.error ?? "")
                }
              >
                <span className="text-sm font-semibold text-text-secondary">
                  Copy
                </span>
              </button>
              <button
                type="button"
                onClick={() => setErrorFile(null)}
                className="rounded-lg bg-accent px-4 py-2"
              >
                <span className="text-sm font-bold text-accent-ink">Close</span>
              </button>
            </div>
          </div>
        </Overlay>
      )}

      {editing && (
        <Overlay onClose={() => setEditing(null)}>
          <div className="flex w-80 flex-col gap-4 rounded-2xl border border-border bg-surface p-5">
            <p className="text-lg font-semibold text-ink">Page number</p>
            <input
              value={pageInput}
              onChange={(e) =>
                setPageInput(e.target.value.replace(/[^0-9]/g, ""))
              }
              // biome-ignore lint/a11y/noAutofocus: focusing the sole field in a just-opened dialog
              autoFocus
              placeholder="—"
              onKeyDown={(e) => e.key === "Enter" && saveEdit()}
              className="rounded-lg border border-border bg-bg px-3 py-2.5 text-base text-ink outline-none placeholder:text-text-muted focus:border-accent"
            />
            <div className="flex flex-row items-center justify-end gap-4">
              <button type="button" onClick={() => setEditing(null)}>
                <span className="text-sm font-semibold text-text-secondary">
                  Cancel
                </span>
              </button>
              <button
                type="button"
                onClick={saveEdit}
                className="rounded-lg bg-accent px-4 py-2"
              >
                <span className="text-sm font-bold text-accent-ink">Save</span>
              </button>
            </div>
          </div>
        </Overlay>
      )}

      {editBook && (
        <Overlay onClose={() => setEditBook(false)}>
          <div className="flex w-[28rem] flex-col gap-4 rounded-2xl border border-border bg-surface p-5">
            <p className="text-lg font-semibold text-ink">Edit book</p>
            <div className="flex flex-col">
              <span className="mb-2 block text-xs font-bold tracking-wide text-text-muted">
                TITLE
              </span>
              <input
                value={bookTitle}
                onChange={(e) => setBookTitle(e.target.value)}
                placeholder="نور الإيضاح"
                dir="rtl"
                className="w-full rounded-xl border border-accent bg-bg px-4 py-3 text-lg text-ink outline-none placeholder:text-text-muted"
              />
            </div>
            <div className="flex flex-col">
              <span className="mb-2 block text-xs font-bold tracking-wide text-text-muted">
                OCR INSTRUCTIONS · OPTIONAL
              </span>
              <textarea
                value={bookInstructions}
                onChange={(e) => setBookInstructions(e.target.value)}
                placeholder="Preserve tashkeel. Keep footnotes at the bottom of the page."
                className="min-h-[110px] w-full resize-y rounded-xl border border-border bg-bg px-4 py-3 text-base text-text-secondary outline-none placeholder:text-text-muted focus:border-accent"
              />
            </div>
            {saveBook.error && (
              <p className="text-sm text-st-fail">{String(saveBook.error)}</p>
            )}
            <div className="flex flex-row items-center justify-end gap-4">
              <button type="button" onClick={() => setEditBook(false)}>
                <span className="text-sm font-semibold text-text-secondary">
                  Cancel
                </span>
              </button>
              <button
                type="button"
                onClick={() => saveBook.mutate()}
                disabled={!bookTitle.trim() || saveBook.isPending}
                className="rounded-lg bg-accent px-4 py-2 disabled:opacity-50"
              >
                <span className="text-sm font-bold text-accent-ink">
                  {saveBook.isPending ? "Saving…" : "Save"}
                </span>
              </button>
            </div>
          </div>
        </Overlay>
      )}
    </div>
  );
};

const Overlay = ({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) => (
  <button
    type="button"
    aria-label="Close"
    onClick={onClose}
    className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
  >
    <button
      type="button"
      onClick={(e) => e.stopPropagation()}
      className="cursor-default"
    >
      {children}
    </button>
  </button>
);

const MenuItem = ({
  icon: Icon,
  label,
  destructive,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  destructive?: boolean;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    className="flex w-full flex-row items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-surface-alt"
  >
    <Icon size={18} color={destructive ? "#EE6A4D" : colors.textSecondary} />
    <span
      className="text-base"
      style={{ color: destructive ? "#EE6A4D" : colors.ink }}
    >
      {label}
    </span>
  </button>
);
