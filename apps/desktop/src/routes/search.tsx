import { Search as SearchIcon, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import {
  InstantSearch,
  useInfiniteHits,
  useSearchBox,
} from "react-instantsearch";
import { Link, useNavigate } from "react-router-dom";
import { useConfigState } from "@/lib/config-context";
import { makeSearchClient, SEARCH_INDEX, type SearchHit } from "@/lib/search";

const SearchBar = () => {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { query, refine } = useSearchBox({
    queryHook: (q, search) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => search(q), 250);
    },
  });
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
      {value.length > 0 && (
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
      )}
    </div>
  );
};

const Hit = ({ hit }: { hit: SearchHit }) => {
  const navigate = useNavigate();
  const snippet = (hit._formatted?.text ?? hit.text ?? "")
    .replace(/<\/?(ais-highlight|em)>|__\/?ais-highlight__/g, "")
    .trim();
  return (
    <button
      type="button"
      onClick={() => navigate(`/reader/${hit.book_id}/${hit.id}`)}
      className="w-full rounded-xl border border-border bg-surface p-4 text-left transition-colors hover:bg-surface-alt"
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
        className="mt-1.5 line-clamp-3 text-sm leading-7 text-text-secondary"
      >
        {snippet}
      </p>
    </button>
  );
};

const Results = () => {
  const { items, isLastPage, showMore } = useInfiniteHits<SearchHit>();
  if (items.length === 0)
    return (
      <p className="mt-10 text-center text-sm text-text-muted">
        Type to search the corpus.
      </p>
    );
  return (
    <div className="flex flex-col gap-2.5">
      {items.map((hit) => (
        <Hit key={hit.id} hit={hit} />
      ))}
      {!isLastPage && (
        <button
          type="button"
          onClick={showMore}
          className="mt-2 self-center rounded-lg border border-border px-4 py-2 text-sm font-semibold text-text-secondary hover:bg-surface-alt"
        >
          Load more
        </button>
      )}
    </div>
  );
};

export const SearchScreen = () => {
  const { config, ready } = useConfigState();
  const searchClient = useMemo(
    () =>
      config?.meiliUrl && config.meiliKey
        ? makeSearchClient({ url: config.meiliUrl, key: config.meiliKey })
        : null,
    [config?.meiliUrl, config?.meiliKey],
  );

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
    <div className="flex flex-1 flex-col overflow-hidden px-8 pt-7">
      <h1 className="mb-4 text-3xl font-semibold text-ink">Search</h1>
      <InstantSearch searchClient={searchClient} indexName={SEARCH_INDEX}>
        <div className="mb-4 max-w-2xl">
          <SearchBar />
        </div>
        <div className="max-w-2xl flex-1 overflow-y-auto pb-8">
          <Results />
        </div>
      </InstantSearch>
    </div>
  );
};
