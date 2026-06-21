import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Zap } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, api } from "@/lib/api";
import { colors } from "@/theme";

export const NewBookScreen = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      api.createBook({
        title: title.trim(),
        ocr_instructions: instructions.trim() || undefined,
      }),
    onSuccess: async (book) => {
      await queryClient.invalidateQueries({ queryKey: ["books"] });
      navigate(`/book/${book.id}`, { replace: true });
    },
    onError: (err) => {
      setError(
        err instanceof ApiError ? `${err.status}: ${err.message}` : String(err),
      );
    },
  });

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
          <h1 className="text-[26px] font-semibold text-ink">New book</h1>
        </div>

        <span className="mt-6 mb-2 block text-xs font-bold tracking-wide text-text-muted">
          TITLE
        </span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="نور الإيضاح"
          dir="rtl"
          className="w-full rounded-xl border border-accent bg-surface px-4 py-3.5 text-lg text-ink outline-none placeholder:text-text-muted"
        />

        <span className="mt-5 mb-2 block text-xs font-bold tracking-wide text-text-muted">
          OCR INSTRUCTIONS · OPTIONAL
        </span>
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="Preserve tashkeel. Keep footnotes at the bottom of the page."
          className="min-h-[110px] w-full resize-y rounded-xl border border-border bg-surface px-4 py-3.5 text-base text-text-secondary outline-none placeholder:text-text-muted focus:border-accent"
        />

        <div className="mt-5 flex flex-row items-center gap-2 rounded-xl bg-accent-soft px-3 py-2.5">
          <Zap size={15} color={colors.accent} />
          <span className="flex-1 text-xs text-accent">
            Pages you upload into this book transcribe automatically.
          </span>
        </div>

        {error && <p className="mt-4 text-sm text-st-fail">{error}</p>}

        <div className="flex-1" />

        <button
          type="button"
          onClick={() => mutation.mutate()}
          disabled={!title.trim() || mutation.isPending}
          className="mt-6 flex items-center justify-center rounded-xl bg-accent py-4 disabled:opacity-50"
        >
          <span className="text-base font-bold text-accent-ink">
            {mutation.isPending ? "Creating…" : "Create book"}
          </span>
        </button>
      </div>
    </div>
  );
};
