import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Button,
  Chip,
  ErrorBanner,
  FieldLabel,
  IconButton,
  PageHeader,
} from "@/components/ui";
import { api } from "@/lib/api";
import { useConfigState } from "@/lib/config-context";
import { errorMessage } from "@/lib/errors";

// Works shown before "More…"; the selected one is always shown.
const WORKS_SHOWN = 3;

export const NewBookScreen = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { configured } = useConfigState();

  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  // null = auto-create a new work from the title; otherwise attach to this work.
  const [workId, setWorkId] = useState<string | null>(null);
  const [allWorks, setAllWorks] = useState(false);
  // Tags for the auto-created work; only meaningful when workId is null.
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const addTag = (raw: string) => {
    const t = raw.trim();
    if (t && !tags.includes(t)) setTags((prev) => [...prev, t]);
    setTagInput("");
  };

  const worksQuery = useQuery({
    queryKey: ["works"],
    queryFn: api.listWorks,
    enabled: configured,
  });
  const works = worksQuery.data ?? [];
  const shownWorks = allWorks
    ? works
    : works.filter((w, i) => i < WORKS_SHOWN || w.id === workId);

  const mutation = useMutation({
    mutationFn: () =>
      api.createBook({
        title: title.trim(),
        ocr_instructions: instructions.trim() || undefined,
        work_id: workId ?? undefined,
        tags: workId === null && tags.length > 0 ? tags : undefined,
      }),
    onSuccess: async (book) => {
      await queryClient.invalidateQueries({ queryKey: ["books"] });
      await queryClient.invalidateQueries({ queryKey: ["works"] });
      navigate(`/book/${book.id}`, { replace: true });
    },
  });

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-4">
            <IconButton
              icon={ChevronLeft}
              label="Back"
              variant="tonal"
              onClick={() => navigate(-1)}
            />
            New book
          </span>
        }
      />
      <div className="flex min-h-0 flex-1 justify-center overflow-y-auto">
        <form
          className="flex w-[560px] flex-col gap-5 pb-10"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) mutation.mutate();
          }}
        >
          <label className="flex flex-col gap-2">
            <FieldLabel>Title</FieldLabel>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="نور الإيضاح"
              dir="rtl"
              className="h-[50px] rounded-md border border-line bg-surface px-3.5 font-ar text-section text-ink outline-none placeholder:text-ink-3 focus:border-accent"
            />
          </label>

          <div className="flex flex-col gap-2">
            <FieldLabel>Work</FieldLabel>
            <div className="flex flex-wrap items-center gap-2">
              <Chip selected={workId === null} onClick={() => setWorkId(null)}>
                New work
              </Chip>
              {shownWorks.map((w) => (
                <Chip
                  key={w.id}
                  selected={workId === w.id}
                  onClick={() => setWorkId(w.id)}
                >
                  <span dir="rtl" className="font-ar">
                    {w.name}
                  </span>
                </Chip>
              ))}
              {!allWorks && works.length > shownWorks.length && (
                <Chip onClick={() => setAllWorks(true)}>More…</Chip>
              )}
            </div>
            <span className="text-small text-ink-3">
              Copies of the same work are grouped in the Library.
            </span>
          </div>

          {workId === null && (
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
          )}

          <label className="flex flex-col gap-2">
            <FieldLabel>OCR instructions · optional</FieldLabel>
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="Preserve tashkeel. Keep footnotes at the bottom of the page."
              className="min-h-[110px] resize-y rounded-md border border-line bg-surface px-4 py-3 text-body text-ink outline-none placeholder:text-ink-3 focus:border-accent"
            />
            <span className="text-small text-ink-3">
              Applied to every page of this book. Changing them starts a new
              version, so Usage can compare before and after.
            </span>
          </label>

          {mutation.isError && (
            <ErrorBanner title="Couldn't create the book">
              {errorMessage(mutation.error)} Your entries are kept.
            </ErrorBanner>
          )}

          <Button
            type="submit"
            className="w-full"
            disabled={!title.trim()}
            loading={mutation.isPending}
          >
            {mutation.isPending ? "Creating…" : "Create book"}
          </Button>
        </form>
      </div>
    </>
  );
};
