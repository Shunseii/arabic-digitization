import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, CloudOff, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ProgressRing } from "@/components/progress-ring";
import {
  Button,
  Chip,
  Dialog,
  EmptyState,
  ErrorBanner,
  FieldLabel,
  IconButton,
  PageHeader,
  Skeleton,
  TextField,
} from "@/components/ui";
import { api } from "@/lib/api";
import { useConfigState } from "@/lib/config-context";
import { errorMessage } from "@/lib/errors";
import { plural } from "@/lib/format";

export const WorkScreen = () => {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { configured } = useConfigState();

  const workQuery = useQuery({
    queryKey: ["work", id],
    queryFn: () => api.getWork(id),
    enabled: !!id,
  });
  // The copies come from the book list the Library and sidebar already hold.
  const booksQuery = useQuery({
    queryKey: ["books"],
    queryFn: api.listBooks,
    enabled: configured,
  });
  const copies = (booksQuery.data ?? []).filter((b) => b.work_id === id);

  const [name, setName] = useState("");
  const [author, setAuthor] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [deleting, setDeleting] = useState(false);

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
  });

  const remove = useMutation({
    mutationFn: (mode: "unlink" | "delete") => api.deleteWork({ id, mode }),
    onSuccess: async () => {
      await invalidate();
      navigate("/", { replace: true });
    },
  });

  const addTag = (raw: string) => {
    const t = raw.trim();
    if (t && !tags.includes(t)) setTags((prev) => [...prev, t]);
    setTagInput("");
  };

  const back = (
    <IconButton
      icon={ChevronLeft}
      label="Back"
      variant="tonal"
      onClick={() => navigate(-1)}
    />
  );
  const header = (
    <header className="flex shrink-0 items-center gap-4 px-10 pb-6 pt-8">
      {back}
      <div className="flex flex-col gap-1">
        <h1 className="font-display text-title font-semibold text-ink">
          Edit work
        </h1>
        {workQuery.data && (
          <p className="text-small text-ink-2">Changes apply to every copy</p>
        )}
      </div>
    </header>
  );

  if (workQuery.isError)
    return (
      <>
        <PageHeader
          title={
            <span className="flex items-center gap-4">{back}Edit work</span>
          }
        />
        <EmptyState
          icon={CloudOff}
          tone="danger"
          title="Couldn't load this work"
          body="It may have been deleted on another device."
        >
          <Button onClick={() => navigate("/")}>Back to Library</Button>
        </EmptyState>
      </>
    );

  const busy = save.isPending || remove.isPending;
  const error = save.error ?? remove.error;

  return (
    <>
      {header}
      <div className="flex min-h-0 flex-1 justify-center overflow-y-auto">
        {workQuery.isLoading ? (
          <div className="flex w-[560px] flex-col gap-5">
            <Skeleton className="h-[72px] rounded-md" />
            <Skeleton className="h-[72px] rounded-md" />
            <Skeleton className="h-40 rounded-lg" />
          </div>
        ) : (
          <form
            className="flex w-[560px] flex-col gap-5 pb-10"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) save.mutate();
            }}
          >
            <TextField
              label="Name"
              rtl
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <TextField
              label="Author"
              rtl
              value={author}
              placeholder="ابن قدامة"
              onChange={(e) => setAuthor(e.target.value)}
            />
            <div className="flex flex-col gap-2">
              <FieldLabel>Tags</FieldLabel>
              {tags.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {tags.map((t) => (
                    <Chip
                      key={t}
                      onRemove={() =>
                        setTags((prev) => prev.filter((x) => x !== t))
                      }
                    >
                      {t}
                    </Chip>
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
                className="h-[50px] rounded-md border border-line bg-surface px-3.5 text-body text-ink outline-none placeholder:text-ink-3 focus:border-accent"
              />
            </div>

            {copies.length > 0 && (
              <section className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-6">
                <div className="flex flex-col gap-0.5">
                  <h2 className="font-display text-section font-semibold leading-[1.2] tracking-[-0.01em] text-ink">
                    Copies in this work
                  </h2>
                  <p className="text-small text-ink-2">
                    Books scanned from this work
                  </p>
                </div>
                {copies.map((b) => (
                  <Link
                    key={b.id}
                    to={`/book/${b.id}`}
                    className="flex items-center gap-3 border-t border-line py-2 hover:bg-surface-2"
                  >
                    <ProgressRing book={b} size="sm" />
                    <span
                      dir="rtl"
                      className="font-ar text-body font-bold leading-[1.6] text-ink"
                    >
                      {b.title}
                    </span>
                    <span className="text-small text-ink-2">
                      {plural({ n: b.files_total, one: "page", many: "pages" })}
                    </span>
                    <ChevronRight size={16} className="ml-auto text-ink-3" />
                  </Link>
                ))}
              </section>
            )}

            {error && (
              <ErrorBanner title="Couldn't save the work">
                {errorMessage(error)}
              </ErrorBanner>
            )}

            <div className="flex items-center gap-3">
              <Button
                size="sm"
                variant="ghost"
                icon={Trash2}
                disabled={busy}
                onClick={() => setDeleting(true)}
              >
                Delete work
              </Button>
              <Button
                type="submit"
                className="ml-auto"
                disabled={!name.trim() || remove.isPending}
                loading={save.isPending}
              >
                Save changes
              </Button>
            </div>
          </form>
        )}
      </div>

      {/* Two modes: keep the copies (they become ungrouped) or delete them too. */}
      <Dialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title="Delete this work?"
        width="w-[440px]"
      >
        <p className="text-body text-ink-2">
          Keep its copies (they become ungrouped), or delete them too. Deleting
          copies removes their scans and transcriptions and can't be undone.
        </p>
        <div className="mt-2 flex flex-col gap-2">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => remove.mutate("unlink")}
          >
            Delete work · keep copies
          </Button>
          <Button
            variant="danger"
            icon={Trash2}
            disabled={busy}
            onClick={() => remove.mutate("delete")}
          >
            Delete work and all copies
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setDeleting(false)}>
            Cancel
          </Button>
        </div>
      </Dialog>
    </>
  );
};
