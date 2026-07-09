import type { HighlightResponse } from "@qiraa/shared";
import { Loader2, Search as SearchIcon, X } from "lucide-react";
import {
  type ComponentProps,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  InstantSearch,
  useInfiniteHits,
  useInstantSearch,
  useRefinementList,
  useSearchBox,
} from "react-instantsearch";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { useConfigState } from "@/lib/config-context";
import { Markdown } from "@/lib/markdown";
import {
  cleanSnippet,
  getLastQuery,
  makeSearchClient,
  SEARCH_FUTURE,
  SEARCH_INDEX,
  type SearchHit,
  setLastQuery,
} from "@/lib/search";

const SearchBar = () => {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stable across renders — react-instantsearch re-runs effects on a changing
  // queryHook identity, which can loop.
  const queryHook = useCallback(
    (q: string, search: (value: string) => void) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => search(q), 250);
    },
    [],
  );
  const { query, refine } = useSearchBox({ queryHook });
  const { status } = useInstantSearch();
  const busy = status === "loading" || status === "stalled";
  const [value, setValue] = useState(query);
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-border bg-surface px-4 py-3">
      <SearchIcon size={18} className="shrink-0 text-text-muted" />
      <input
        // biome-ignore lint/a11y/noAutofocus: search-first screen
        autoFocus
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          refine(e.target.value);
        }}
        placeholder="Search the library…"
        className="flex-1 bg-transparent text-base text-ink outline-none placeholder:text-text-muted"
      />
      {busy ? (
        <Loader2 size={18} className="shrink-0 animate-spin text-text-muted" />
      ) : value.length > 0 ? (
        <button
          type="button"
          onClick={() => {
            setValue("");
            refine("");
          }}
          className="text-text-muted hover:text-ink"
        >
          <X size={18} />
        </button>
      ) : null}
    </div>
  );
};

// Multi-select book facet. Meili facets `book_title` (a filterable attribute);
// checking books scopes results to any of them (OR). A button shows the count
// and opens a checkbox popover. Hidden until more than one book has matches,
// since a lone book is nothing to filter.
const BookFilter = () => {
  const { items, refine } = useRefinementList({
    attribute: "book_title",
    limit: 100,
  });
  const [open, setOpen] = useState(false);
  if (items.length <= 1) return null;
  const selectedCount = items.filter((i) => i.isRefined).length;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="h-full rounded-xl border border-border bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-alt"
      >
        {selectedCount > 0
          ? `${selectedCount} book${selectedCount > 1 ? "s" : ""}`
          : "All books"}
      </button>
      {open && (
        <>
          {/* Click-away backdrop closes the popover. */}
          <button
            type="button"
            aria-label="Close book filter"
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 z-20 mt-1 max-h-80 w-64 overflow-y-auto rounded-xl border border-border bg-surface p-2 shadow-lg">
            {items.map((i) => (
              <label
                key={i.value}
                className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-alt"
              >
                <input
                  type="checkbox"
                  checked={i.isRefined}
                  onChange={() => refine(i.value)}
                  className="accent-accent"
                />
                <span className="flex-1 truncate text-sm text-ink">
                  {i.label}
                </span>
                <span className="text-xs text-text-muted">{i.count}</span>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

// Clear the selected preview whenever the search query changes, so the reader
// pane never shows a page from a stale query.
const ResetPreviewOnQueryChange = ({ onReset }: { onReset: () => void }) => {
  const { query } = useSearchBox();
  const q = query.trim();
  // biome-ignore lint/correctness/useExhaustiveDependencies: q is the trigger
  useEffect(() => {
    onReset();
  }, [q]);
  return null;
};

const HitCard = ({
  hit,
  selected,
  onSelect,
}: {
  hit: SearchHit;
  selected: boolean;
  onSelect: (hit: SearchHit) => void;
}) => (
  <button
    type="button"
    onClick={() => onSelect(hit)}
    className={`w-full rounded-xl border p-3.5 text-left transition-colors ${
      selected
        ? "border-accent bg-accent-soft"
        : "border-border bg-surface hover:bg-surface-alt"
    }`}
  >
    <div className="flex items-center justify-between">
      <span className="text-sm font-semibold text-accent">
        {hit.book_title}
      </span>
      {hit.page_number != null && (
        <span className="text-xs text-text-muted">ص {hit.page_number}</span>
      )}
    </div>
    <p
      dir="rtl"
      className="mt-1.5 line-clamp-2 text-sm leading-7 text-text-secondary"
    >
      {cleanSnippet(hit._formatted?.text ?? hit.text ?? "")}
    </p>
  </button>
);

const Results = ({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (hit: SearchHit) => void;
}) => {
  const { items, isLastPage, showMore } = useInfiniteHits<SearchHit>();
  const { query } = useSearchBox();
  if (items.length === 0)
    return (
      <p className="mt-10 text-center text-sm text-text-muted">
        {query.trim() ? `No results for “${query}”.` : "Type to search."}
      </p>
    );
  return (
    <div className="flex flex-col gap-2.5">
      {items.map((hit) => (
        <HitCard
          key={hit.id}
          hit={hit}
          selected={hit.id === selectedId}
          onSelect={onSelect}
        />
      ))}
      {!isLastPage && (
        <button
          type="button"
          onClick={showMore}
          className="mt-1 self-center rounded-lg border border-border px-4 py-2 text-sm font-semibold text-text-secondary hover:bg-surface-alt"
        >
          Load more
        </button>
      )}
    </div>
  );
};

// (query, fileId) → highlight response, so reselecting a result or retyping the
// same query doesn't re-hit the API. Session-lived; clears on reload.
const highlightCache = new Map<string, HighlightResponse>();

const Preview = ({ hit }: { hit: SearchHit | null }) => {
  const { query } = useSearchBox();
  const q = query.trim();
  const [hl, setHl] = useState<HighlightResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  // The page id (not the chunk id) — highlight and reader both address pages.
  const hitId = hit?.file_id;
  const bookId = hit?.book_id;
  // Highlighting is an explicit action now, so drop any existing highlight when
  // the selected result or query changes — the button re-fetches on demand.
  // hitId/q are triggers here, not values the effect reads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are reset triggers
  useEffect(() => {
    setHl(null);
    setLoading(false);
    setFailed(false);
  }, [hitId, q]);

  const runHighlight = useCallback(() => {
    if (!hitId || !bookId || !q) return;
    const key = `${hitId}|${q}`;
    const cached = highlightCache.get(key);
    if (cached) {
      setHl(cached);
      return;
    }
    setLoading(true);
    setFailed(false);
    api
      .highlight({ bookId, fileId: hitId, query: q })
      .then((res) => {
        highlightCache.set(key, res);
        setHl(res);
      })
      // Surface the failure instead of silently reverting to the button, which
      // looks like nothing happened.
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }, [hitId, bookId, q]);

  if (!hit)
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-text-muted">
          Select a result to preview the page.
        </p>
      </div>
    );

  // Each relevant span, split per-line so a passage spanning a line break still
  // matches against the per-line markdown the renderer produces.
  const highlight = hl?.spans.flatMap((s) =>
    s.text
      .split(/\n+/)
      .map((t) => t.trim())
      .filter(Boolean),
  );

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-accent">{hit.book_title}</p>
          {hit.page_number != null && (
            <p className="text-xs text-text-muted">صفحة {hit.page_number}</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          {q.length > 0 &&
            (loading ? (
              <span className="flex items-center gap-1.5 text-xs text-text-muted">
                <Loader2 size={14} className="animate-spin" />
                Finding…
              </span>
            ) : failed ? (
              <button
                type="button"
                onClick={runHighlight}
                className="text-xs font-semibold text-st-fail hover:underline"
              >
                Couldn't highlight — retry
              </button>
            ) : hl ? (
              highlight && highlight.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setHl(null)}
                  className="text-xs font-semibold text-text-muted hover:text-ink"
                >
                  Clear highlight
                </button>
              ) : (
                <span className="text-xs text-text-muted">
                  No matching passage
                </span>
              )
            ) : (
              <button
                type="button"
                onClick={runHighlight}
                className="rounded-lg border border-accent/40 px-2.5 py-1 text-xs font-semibold text-accent hover:bg-accent-soft"
              >
                Highlight matches
              </button>
            ))}
          <Link
            to={`/reader/${hit.book_id}/${hit.file_id}`}
            className="text-xs font-semibold text-accent hover:underline"
          >
            Open in reader →
          </Link>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto rounded-xl border border-border bg-surface p-5">
        <Markdown
          source={hit.page_text ?? hit.text ?? ""}
          highlight={highlight}
        />
      </div>
    </div>
  );
};

export const SearchScreen = () => {
  const { config, ready } = useConfigState();
  const [selected, setSelected] = useState<SearchHit | null>(null);
  const searchClient = useMemo(
    () =>
      config?.meiliUrl && config.meiliKey
        ? makeSearchClient({ url: config.meiliUrl, key: config.meiliKey })
        : null,
    [config?.meiliUrl, config?.meiliKey],
  );
  // Restore the last query on mount; remember it as it changes.
  const initialUiState = useMemo(
    () => ({ [SEARCH_INDEX]: { query: getLastQuery() } }),
    [],
  );
  const onStateChange = useCallback<
    NonNullable<ComponentProps<typeof InstantSearch>["onStateChange"]>
  >(({ uiState, setUiState }) => {
    setLastQuery((uiState[SEARCH_INDEX] as { query?: string })?.query ?? "");
    setUiState(uiState);
  }, []);
  const clearSelected = useCallback(() => setSelected(null), []);

  if (!ready) return null;

  if (!searchClient)
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-lg font-semibold text-ink">Search isn't set up</p>
        <p className="text-sm text-text-secondary">
          Add your Meilisearch URL and read-only key in Settings.
        </p>
        <Link to="/settings" className="mt-1 font-semibold text-accent">
          Open Settings →
        </Link>
      </div>
    );

  return (
    <div className="flex flex-1 flex-col overflow-hidden px-8 pt-10">
      <h1 className="mb-5 text-3xl font-semibold text-ink">Search</h1>
      <InstantSearch
        searchClient={searchClient}
        indexName={SEARCH_INDEX}
        future={SEARCH_FUTURE}
        initialUiState={initialUiState}
        onStateChange={onStateChange}
      >
        <ResetPreviewOnQueryChange onReset={clearSelected} />
        <div className="mb-5 flex items-stretch gap-2.5">
          <div className="flex-1">
            <SearchBar />
          </div>
          <BookFilter />
        </div>
        <div className="flex flex-1 gap-6 overflow-hidden pb-8">
          <div className="w-[420px] shrink-0 overflow-y-auto pr-1">
            <Results selectedId={selected?.id ?? null} onSelect={setSelected} />
          </div>
          <div className="flex-1 overflow-hidden border-l border-hairline pl-6">
            <Preview hit={selected} />
          </div>
        </div>
      </InstantSearch>
    </div>
  );
};
