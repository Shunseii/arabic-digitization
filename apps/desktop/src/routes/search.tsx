import type { HighlightResponse } from "@qiraa/shared";
import { useQuery } from "@tanstack/react-query";
import {
  BookOpen,
  ChevronRight,
  Highlighter,
  Search as SearchIcon,
  SearchX,
} from "lucide-react";
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
  useClearRefinements,
  useInfiniteHits,
  useInstantSearch,
  useRefinementList,
  useSearchBox,
} from "react-instantsearch";
import { useNavigate } from "react-router-dom";
import {
  Button,
  CheckOption,
  cx,
  DropdownTrigger,
  EmptyState,
  PageHeader,
  Popover,
  SearchField,
} from "@/components/ui";
import { api } from "@/lib/api";
import { useConfigState } from "@/lib/config-context";
import { count } from "@/lib/format";
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
  const [value, setValue] = useState(query);
  return (
    <SearchField
      className="w-[640px]"
      value={value}
      busy={status === "loading" || status === "stalled"}
      onChange={(v) => {
        setValue(v);
        refine(v);
      }}
      placeholder="Search the text of every page…"
    />
  );
};

const FilterPopover = ({
  label,
  active,
  children,
}: {
  label: ReactNode;
  active: boolean;
  children: ReactNode;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <DropdownTrigger
        label={label}
        active={active}
        onClick={() => setOpen((o) => !o)}
      />
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        className="left-0 top-[calc(100%+8px)] max-h-80 w-72 origin-top-left overflow-y-auto"
      >
        {children}
      </Popover>
    </div>
  );
};

// Work → title nested filter. Top level is the work (Meili facet `work_name`);
// expanding a work reveals its individual copies (facet `book_title`). Checking a
// work scopes to all its copies; checking a title scopes to that one copy. Meili
// ANDs across the two attributes and ORs within each. The parent/child structure
// isn't in the facet data, so we build it from the works + books APIs and read
// counts / refinement state off the two refinement lists. Copies whose work is
// unknown (legacy, work_id NULL) are listed flat under "Ungrouped".
const BookFilter = () => {
  const work = useRefinementList({ attribute: "work_name", limit: 500 });
  const title = useRefinementList({ attribute: "book_title", limit: 1000 });
  const { configured } = useConfigState();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Static work → titles structure (independent of the query).
  const { data: tree } = useQuery({
    queryKey: ["work-title-tree"],
    enabled: configured,
    queryFn: async () => {
      const [works, books] = await Promise.all([
        api.listWorks(),
        api.listBooks(),
      ]);
      const nameById = new Map(works.map((w) => [w.id, w.name]));
      const grouped = new Map<string, Set<string>>();
      const ungrouped = new Set<string>();
      for (const b of books) {
        const wn = b.work_id ? nameById.get(b.work_id) : undefined;
        if (wn) {
          const set = grouped.get(wn) ?? new Set<string>();
          set.add(b.title);
          grouped.set(wn, set);
        } else {
          ungrouped.add(b.title);
        }
      }
      return { grouped, ungrouped };
    },
  });

  const titleItem = useMemo(
    () => new Map(title.items.map((i) => [i.value, i])),
    [title.items],
  );
  const workItem = useMemo(
    () => new Map(work.items.map((i) => [i.value, i])),
    [work.items],
  );

  if (!tree) return null;
  const refined = [
    ...work.items.filter((i) => i.isRefined),
    ...title.items.filter((i) => i.isRefined),
  ];
  const label =
    refined.length === 0 ? (
      "All books"
    ) : refined.length === 1 ? (
      <span dir="rtl" className="font-ar">
        {refined[0]?.value}
      </span>
    ) : (
      `${refined.length} books`
    );

  const toggleExpand = (name: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const arabic = (t: string) => (
    <span dir="rtl" className="font-ar text-body">
      {t}
    </span>
  );
  const titleRow = (t: string) => {
    const item = titleItem.get(t);
    if (!item) return null; // no matches for the current query
    return (
      <CheckOption
        key={t}
        className="pl-9"
        checked={item.isRefined}
        onToggle={() => title.refine(t)}
        label={arabic(t)}
        count={item.count}
      />
    );
  };

  return (
    <FilterPopover label={label} active={refined.length > 0}>
      {[...tree.grouped.entries()].map(([name, titles]) => {
        const wItem = workItem.get(name);
        const isOpen = expanded.has(name);
        return (
          <div key={name}>
            <div className="flex items-center">
              <button
                type="button"
                aria-label={isOpen ? "Collapse" : "Expand"}
                onClick={() => toggleExpand(name)}
                className="p-1 text-ink-3"
              >
                <ChevronRight size={14} className={isOpen ? "rotate-90" : ""} />
              </button>
              <CheckOption
                className="flex-1 pl-1"
                checked={wItem?.isRefined ?? false}
                disabled={!wItem}
                onToggle={() => work.refine(name)}
                label={arabic(name)}
                count={wItem?.count}
              />
            </div>
            {isOpen && [...titles].map(titleRow)}
          </div>
        );
      })}
      {tree.ungrouped.size > 0 && (
        <div className="mt-1 border-t border-line pt-1">
          <p className="px-3 pb-1 pt-2 text-label font-semibold uppercase tracking-[0.08em] text-ink-3">
            Ungrouped
          </p>
          {[...tree.ungrouped].map(titleRow)}
        </div>
      )}
    </FilterPopover>
  );
};

// Tag facet (Meili array attribute `tags`). Multi-select is OR within the facet,
// natively. Hidden until at least one tag exists in the current result set.
const TagFilter = () => {
  const { items, refine } = useRefinementList({
    attribute: "tags",
    limit: 200,
  });
  if (items.length === 0) return null;
  const refined = items.filter((i) => i.isRefined);
  return (
    <FilterPopover
      active={refined.length > 0}
      label={
        refined.length === 0
          ? "All tags"
          : `Tags: ${refined.map((i) => i.label).join(", ")}`
      }
    >
      {items.map((i) => (
        <CheckOption
          key={i.value}
          checked={i.isRefined}
          onToggle={() => refine(i.value)}
          label={i.label}
          count={i.count}
        />
      ))}
    </FilterPopover>
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

// InstantSearch escapes the snippet and turns Meili's __ais-highlight__
// markers into <mark> tags; keep those through the clean-up as control
// characters, then split into plain and matched runs.
const OPEN = "\u0001";
const CLOSE = "\u0002";
const snippetParts = (raw: string): { text: string; match: boolean }[] =>
  cleanSnippet(
    raw
      .replace(/<mark>|__ais-highlight__/g, OPEN)
      .replace(/<\/mark>|__\/ais-highlight__/g, CLOSE)
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&"),
  )
    .split(new RegExp(`(${OPEN}[^${CLOSE}]*${CLOSE})`))
    .filter(Boolean)
    .map((part) =>
      part.startsWith(OPEN)
        ? { text: part.slice(1, -1), match: true }
        : { text: part, match: false },
    );

const pageLabel = (hit: SearchHit) =>
  hit.page_number != null ? `Page ${count(hit.page_number)}` : null;

const HitRow = ({
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
    className={cx(
      "flex w-full flex-col gap-1 rounded-md px-4 py-3 text-left",
      selected ? "bg-accent-soft" : "hover:bg-surface-2",
    )}
  >
    <span className="flex items-center gap-2">
      <span
        dir="rtl"
        className="font-ar text-body font-bold leading-[1.6] text-ink"
      >
        {hit.book_title}
      </span>
      {pageLabel(hit) && (
        <span className="text-small font-medium text-ink-3">
          {pageLabel(hit)}
        </span>
      )}
    </span>
    <span
      dir="rtl"
      className="block truncate text-right font-ar text-body font-medium leading-[1.6] text-ink-2"
    >
      {snippetParts(hit._snippetResult?.text?.value ?? hit.text ?? "").map(
        (p, i) =>
          p.match ? (
            <mark
              // biome-ignore lint/suspicious/noArrayIndexKey: parts never reorder
              key={i}
              className="rounded bg-warn-soft px-1 font-bold text-ink"
            >
              {p.text}
            </mark>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: parts never reorder
            <span key={i}>{p.text}</span>
          ),
      )}
    </span>
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
  return (
    <div className="flex w-[520px] shrink-0 flex-col gap-1 overflow-y-auto">
      {items.map((hit) => (
        <HitRow
          key={hit.id}
          hit={hit}
          selected={hit.id === selectedId}
          onSelect={onSelect}
        />
      ))}
      {!isLastPage && (
        <Button
          size="sm"
          variant="secondary"
          className="mt-2 self-center"
          onClick={showMore}
        >
          Load more
        </Button>
      )}
    </div>
  );
};

// (query, fileId) → highlight response, so reselecting a result or retyping the
// same query doesn't re-hit the API. Session-lived; clears on reload.
const highlightCache = new Map<string, HighlightResponse>();

const Preview = ({ hit }: { hit: SearchHit | null }) => {
  const navigate = useNavigate();
  const { query } = useSearchBox();
  const q = query.trim();
  const [hl, setHl] = useState<HighlightResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  // The page id (not the chunk id) — highlight and reader both address pages.
  const hitId = hit?.file_id;
  const bookId = hit?.book_id;
  // Highlighting is an explicit action, so drop any existing highlight when
  // the selected result or query changes — the button re-fetches on demand.
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

  if (!hit) return <div className="flex-1" />;

  // Each relevant span, split per-line so a passage spanning a line break still
  // matches against the per-line markdown the renderer produces.
  const highlight = hl?.spans.flatMap((s) =>
    s.text
      .split(/\n+/)
      .map((t) => t.trim())
      .filter(Boolean),
  );

  let highlightAction: ReactNode = null;
  if (q.length > 0) {
    if (hl && highlight?.length === 0)
      highlightAction = (
        <span className="text-small text-ink-3">No matching passage</span>
      );
    else if (hl)
      highlightAction = (
        <Button size="sm" variant="ghost" onClick={() => setHl(null)}>
          Clear highlight
        </Button>
      );
    else
      highlightAction = (
        <Button
          size="sm"
          variant="ghost"
          icon={Highlighter}
          loading={loading}
          onClick={runHighlight}
          className={failed ? "text-danger" : undefined}
        >
          {failed ? "Couldn't highlight. Retry" : "Highlight matches"}
        </Button>
      );
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col gap-4 overflow-hidden rounded-lg border border-line bg-surface p-6">
      <div className="flex items-center gap-3">
        <div className="flex flex-col">
          <span
            dir="rtl"
            className="font-ar text-body font-bold leading-[1.6] text-ink"
          >
            {hit.book_title}
          </span>
          {pageLabel(hit) && (
            <span className="text-small font-medium text-ink-3">
              {pageLabel(hit)}
            </span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {highlightAction}
          <Button
            size="sm"
            variant="secondary"
            icon={BookOpen}
            onClick={() => navigate(`/reader/${hit.book_id}/${hit.file_id}`)}
          >
            Open in reader
          </Button>
        </div>
      </div>
      <div className="h-px shrink-0 bg-line" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Markdown
          source={hit.page_text ?? hit.text ?? ""}
          highlight={highlight}
        />
      </div>
    </section>
  );
};

const Body = () => {
  const [selected, setSelected] = useState<SearchHit | null>(null);
  const clearSelected = useCallback(() => setSelected(null), []);
  const { results, status } = useInstantSearch();
  const { query } = useSearchBox();
  const { refine: clearFilters, canRefine: filtered } = useClearRefinements();
  const q = query.trim();
  const hits = q ? (results?.nbHits ?? 0) : 0;
  const settled = status === "idle";

  let content: ReactNode;
  if (!q)
    content = (
      <EmptyState
        icon={SearchIcon}
        title="Search the Arabic text"
        body="Type a word or phrase. Diacritics are optional; results match with or without tashkeel."
      />
    );
  else if (settled && hits === 0)
    content = (
      <EmptyState
        icon={SearchX}
        title="No matching pages"
        body={
          filtered
            ? "Nothing in the selected books matches. Try all books, or a shorter word."
            : "Nothing matches. Try a shorter word, or fewer words."
        }
      >
        {filtered && (
          <Button variant="secondary" onClick={clearFilters}>
            Search all books
          </Button>
        )}
      </EmptyState>
    );
  else
    content = (
      <div className="flex min-h-0 flex-1 items-stretch gap-6 px-10 pb-10">
        <Results selectedId={selected?.id ?? null} onSelect={setSelected} />
        <Preview hit={selected} />
      </div>
    );

  return (
    <>
      <ResetPreviewOnQueryChange onReset={clearSelected} />
      <PageHeader
        title="Search"
        sub={
          q && settled
            ? `${count(hits)} ${hits === 1 ? "match" : "matches"}`
            : undefined
        }
      >
        <div className="flex items-center gap-3">
          <SearchBar />
          <BookFilter />
          <TagFilter />
        </div>
      </PageHeader>
      {content}
    </>
  );
};

export const SearchScreen = () => {
  const navigate = useNavigate();
  const { config, ready } = useConfigState();
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
      <>
        <PageHeader title="Search" />
        <EmptyState
          icon={SearchIcon}
          title="Search isn't set up"
          body="Add your Meilisearch URL and a read-only search key in Settings."
        >
          <Button onClick={() => navigate("/settings")}>Open Settings</Button>
        </EmptyState>
      </>
    );

  return (
    <InstantSearch
      searchClient={searchClient}
      indexName={SEARCH_INDEX}
      future={SEARCH_FUTURE}
      initialUiState={initialUiState}
      onStateChange={onStateChange}
    >
      <Body />
    </InstantSearch>
  );
};
