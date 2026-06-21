import type { BookWithStatus } from "@qiraa/shared";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
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

  const books = booksQuery.data ?? [];
  const totalPages = books.reduce((n, b) => n + b.files_total, 0);

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
              {books.length} {books.length === 1 ? "book" : "books"} ·{" "}
              {totalPages} pages
            </p>
            <div className="mt-5 grid grid-cols-2 gap-3.5 sm:grid-cols-3 lg:grid-cols-4">
              {books.map((book) => (
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
          </>
        )}
      </div>
    </div>
  );
};
