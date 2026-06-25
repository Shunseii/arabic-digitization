import type { HighlightResponse } from "@qiraa/shared";
import { Loader2, Search as SearchIcon, X } from "lucide-react";
import {
  type ComponentProps,
  type ReactNode,
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

// Render `text` with the given char ranges wrapped in <mark>. Ranges are
// sorted; any overlapping a region already wrapped is skipped.
const HighlightedText = ({
  text,
  ranges,
}: {
  text: string;
  ranges: [number, number][];
}) => {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const parts: ReactNode[] = [];
  let pos = 0;
  for (const [start, end] of sorted) {
    if (start < pos) continue; // inside an already-wrapped span
    if (start > pos) parts.push(text.slice(pos, start));
    parts.push(
      <mark
        key={start}
        className="rounded bg-accent-soft px-0.5 text-ink ring-1 ring-accent/30"
      >
        {text.slice(start, end)}
      </mark>,
    );
    pos = end;
  }
  parts.push(text.slice(pos));
  return (
    <div dir="rtl" className="whitespace-pre-wrap leading-8 text-ink">
      {parts}
    </div>
  );
};

const Preview = ({ hit }: { hit: SearchHit | null }) => {
  const { query } = useSearchBox();
  const q = query.trim();
  const [hl, setHl] = useState<HighlightResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const hitId = hit?.id;
  const bookId = hit?.book_id;
  useEffect(() => {
    if (!hitId || !bookId || !q) {
      setHl(null);
      setLoading(false);
      return;
    }
    const key = `${hitId}|${q}`;
    const cached = highlightCache.get(key);
    if (cached) {
      setHl(cached);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setHl(null);
    setLoading(true);
    api
      .highlight({ bookId, fileId: hitId, query: q })
      .then((res) => {
        if (cancelled) return;
        highlightCache.set(key, res);
        setHl(res);
      })
      // On any failure, fall through to the plain markdown view below.
      .catch(() => {
        if (!cancelled) setHl(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hitId, bookId, q]);

  if (!hit)
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-text-muted">
          Select a result to preview the page.
        </p>
      </div>
    );

  const ranges = hl?.spans.flatMap((s) => s.ranges) ?? [];
  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-accent">{hit.book_title}</p>
          {hit.page_number != null && (
            <p className="text-xs text-text-muted">صفحة {hit.page_number}</p>
          )}
        </div>
        <Link
          to={`/reader/${hit.book_id}/${hit.id}`}
          className="text-xs font-semibold text-accent hover:underline"
        >
          Open in reader →
        </Link>
      </div>
      <div className="flex-1 overflow-y-auto rounded-xl border border-border bg-surface p-5">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-text-muted">
            <Loader2 size={16} className="animate-spin" />
            Finding the relevant passage…
          </div>
        ) : hl && ranges.length > 0 ? (
          <HighlightedText text={hl.text} ranges={ranges} />
        ) : (
          <Markdown source={hit.text ?? ""} />
        )}
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
        <div className="mb-5">
          <SearchBar />
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
