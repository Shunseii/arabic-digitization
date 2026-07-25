import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Loading } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { colors } from "@/theme";

export const WorkScreen = () => {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const workQuery = useQuery({
    queryKey: ["work", id],
    queryFn: () => api.getWork(id),
    enabled: !!id,
  });

  const [name, setName] = useState("");
  const [author, setAuthor] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Seed the form once the work loads.
  useEffect(() => {
    const w = workQuery.data;
    if (!w) return;
    setName(w.name);
    setAuthor(w.author ?? "");
    setTags(w.tags);
  }, [workQuery.data]);

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["works"] }),
      queryClient.invalidateQueries({ queryKey: ["work", id] }),
      queryClient.invalidateQueries({ queryKey: ["work-title-tree"] }),
      queryClient.invalidateQueries({ queryKey: ["books"] }),
    ]);
  };

  const save = useMutation({
    mutationFn: () =>
      api.updateWork({
        id,
        body: {
          name: name.trim(),
          author: author.trim() || null,
          tags,
        },
      }),
    onSuccess: async () => {
      await invalidate();
      navigate(-1);
    },
    onError: (err) =>
      setError(
        err instanceof ApiError ? `${err.status}: ${err.message}` : String(err),
      ),
  });

  const remove = useMutation({
    mutationFn: (mode: "unlink" | "delete") => api.deleteWork({ id, mode }),
    onSuccess: async () => {
      await invalidate();
      navigate("/", { replace: true });
    },
    onError: (err) =>
      setError(
        err instanceof ApiError ? `${err.status}: ${err.message}` : String(err),
      ),
  });

  const addTag = (raw: string) => {
    const t = raw.trim();
    if (t && !tags.includes(t)) setTags((prev) => [...prev, t]);
    setTagInput("");
  };

  if (workQuery.isLoading) return <Loading />;
  if (workQuery.isError || !workQuery.data)
    return (
      <div className="flex-1 p-10">
        <p className="text-sm text-st-fail">Couldn't load this work.</p>
      </div>
    );

  const busy = save.isPending || remove.isPending;

  return (
    <div className="flex-1 overflow-y-auto px-10 py-8">
      <div className="mx-auto flex min-h-full max-w-xl flex-col">
        <div className="flex flex-row items-center gap-3">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-surface"
          >
            <ChevronLeft size={18} color={colors.textSecondary} />
          </button>
          <h1 className="text-[26px] font-semibold text-ink">Edit work</h1>
        </div>

        <span className="mt-6 mb-2 block text-xs font-bold tracking-wide text-text-muted">
          NAME
        </span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          dir="rtl"
          className="w-full rounded-xl border border-accent bg-surface px-4 py-3.5 text-lg text-ink outline-none placeholder:text-text-muted"
        />

        <span className="mt-5 mb-2 block text-xs font-bold tracking-wide text-text-muted">
          AUTHOR · OPTIONAL
        </span>
        <input
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
          placeholder="ابن قدامة"
          dir="rtl"
          className="w-full rounded-xl border border-border bg-surface px-4 py-3.5 text-base text-ink outline-none placeholder:text-text-muted focus:border-accent"
        />

        <span className="mt-5 mb-2 block text-xs font-bold tracking-wide text-text-muted">
          TAGS · OPTIONAL
        </span>
        {tags.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <span
                key={t}
                className="flex items-center gap-1 rounded-full bg-accent-soft px-2.5 py-1 text-xs text-accent"
              >
                {t}
                <button
                  type="button"
                  onClick={() => setTags((prev) => prev.filter((x) => x !== t))}
                  aria-label={`Remove ${t}`}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        <input
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              addTag(tagInput);
            }
          }}
          onBlur={() => tagInput.trim() && addTag(tagInput)}
          placeholder="Add a tag, then Enter"
          className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-base text-ink outline-none placeholder:text-text-muted focus:border-accent"
        />

        {error && <p className="mt-4 text-sm text-st-fail">{error}</p>}

        <div className="flex-1" />

        <button
          type="button"
          onClick={() => save.mutate()}
          disabled={!name.trim() || busy}
          className="mt-6 flex items-center justify-center rounded-xl bg-accent py-4 disabled:opacity-50"
        >
          <span className="text-base font-bold text-accent-ink">
            {save.isPending ? "Saving…" : "Save changes"}
          </span>
        </button>

        {/* Delete: two modes. First tap reveals the choice so a stray click can't
            cascade-delete copies. */}
        {confirmingDelete ? (
          <div className="mt-3 rounded-xl border border-st-fail/40 bg-surface p-3">
            <p className="mb-3 text-sm text-text-secondary">
              Delete this work. Keep its copies (they become ungrouped), or
              delete them too?
            </p>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => remove.mutate("unlink")}
                disabled={busy}
                className="rounded-lg border border-border py-2.5 text-sm font-semibold text-ink hover:bg-surface-alt disabled:opacity-50"
              >
                Delete work · keep copies
              </button>
              <button
                type="button"
                onClick={() => remove.mutate("delete")}
                disabled={busy}
                className="rounded-lg bg-st-fail py-2.5 text-sm font-semibold text-white disabled:opacity-50"
              >
                Delete work · delete all copies
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                disabled={busy}
                className="py-1.5 text-sm text-text-muted hover:text-ink"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            disabled={busy}
            className="mt-3 py-2 text-sm font-semibold text-st-fail hover:underline disabled:opacity-50"
          >
            Delete work…
          </button>
        )}
      </div>
    </div>
  );
};
