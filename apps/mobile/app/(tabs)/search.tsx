import { Feather } from "@expo/vector-icons";
import type { HighlightResponse } from "@qiraa/shared";
import { useRouter } from "expo-router";
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
} from "react-instantsearch-core";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ActionBar,
  Button,
  Chip,
  EmptyState,
  IconButton,
  SearchField,
  Sheet,
  T,
} from "@/components/ui";
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
import { useColors } from "@/theme";

// Debounce queries so we don't hit Meili on every keystroke.
const useDebouncedSearchBox = () => {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stable across renders — a changing queryHook identity re-runs
  // react-instantsearch effects and can loop.
  const queryHook = useCallback(
    (query: string, refine: (value: string) => void) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => refine(query), 250);
    },
    [],
  );
  return useSearchBox({ queryHook });
};

const SearchBar = () => {
  const { query, refine } = useDebouncedSearchBox();
  const [value, setValue] = useState(query);
  return (
    <SearchField
      value={value}
      onChangeText={(text) => {
        setValue(text);
        refine(text);
      }}
      placeholder="Search inside every page…"
      autoFocus
    />
  );
};

// The three facets together give the search filter set: Works (`work_name`) for
// filtering by book, Titles (`book_title`) to drill into a specific copy, and
// Tags (`tags`). Multi-select: OR within an attribute, Meili ANDs across them.
// A facet is hidden until it has more than `minItems` values in the current
// result set, so trivial filters don't take up space.
const FACETS = [
  { attribute: "work_name", label: "Works", minItems: 1, rtl: true },
  { attribute: "book_title", label: "Titles", minItems: 1, rtl: true },
  { attribute: "tags", label: "Tags", minItems: 0, rtl: false },
] as const;

type Facet = (typeof FACETS)[number] & {
  list: ReturnType<typeof useRefinementList>;
};

// Refinement-list widgets must stay mounted for their refinements to apply, so
// they live here rather than inside the (unmounting) filter sheet.
const useFacets = (): Facet[] => {
  const works = useRefinementList({ attribute: "work_name", limit: 200 });
  const titles = useRefinementList({ attribute: "book_title", limit: 200 });
  const tags = useRefinementList({ attribute: "tags", limit: 200 });
  const lists = [works, titles, tags];
  return FACETS.map((facet, i) => ({ ...facet, list: lists[i] }));
};

const FilterBar = ({
  facets,
  onOpenFilters,
}: {
  facets: Facet[];
  onOpenFilters: () => void;
}) => {
  const c = useColors();
  const { status } = useInstantSearch();
  const busy = status === "loading" || status === "stalled";
  const active = facets.flatMap((f) =>
    f.list.items
      .filter((item) => item.isRefined)
      .map((item) => ({ facet: f, item })),
  );
  const hasFacets = facets.some((f) => f.list.items.length > f.minItems);
  if (!hasFacets && active.length === 0 && !busy) return null;
  return (
    <View className="flex-row items-center gap-2">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8, alignItems: "center" }}
        className="flex-1"
      >
        {hasFacets || active.length > 0 ? (
          <Button
            label={active.length > 0 ? `Filters · ${active.length}` : "Filters"}
            icon="sliders"
            variant="secondary"
            size="sm"
            onPress={onOpenFilters}
          />
        ) : null}
        {active.map(({ facet, item }) => (
          <Chip
            key={`${facet.attribute}:${item.value}`}
            label={item.label}
            rtl={facet.rtl}
            removable
            onPress={() => facet.list.refine(item.value)}
          />
        ))}
      </ScrollView>
      {busy ? <ActivityIndicator size="small" color={c.ink3} /> : null}
    </View>
  );
};

const FilterSheet = ({
  facets,
  visible,
  onClose,
}: {
  facets: Facet[];
  visible: boolean;
  onClose: () => void;
}) => (
  <Sheet visible={visible} onClose={onClose} title="Filter results">
    <ScrollView
      className="max-h-[420px]"
      contentContainerStyle={{ paddingHorizontal: 20, gap: 16 }}
    >
      {facets
        .filter((f) => f.list.items.length > f.minItems)
        .map((f) => (
          <View key={f.attribute} className="gap-2">
            <T variant="overline" className="text-ink-3">
              {f.label}
            </T>
            <View className="flex-row flex-wrap gap-2">
              {f.list.items.map((item) => (
                <Chip
                  key={item.value}
                  label={`${item.label} · ${item.count}`}
                  rtl={f.rtl}
                  selected={item.isRefined}
                  onPress={() => f.list.refine(item.value)}
                />
              ))}
            </View>
          </View>
        ))}
    </ScrollView>
    <View className="px-5 pt-5">
      <Button label="Done" onPress={onClose} />
    </View>
  </Sheet>
);

const HitRow = ({
  hit,
  first,
  last,
  onSelect,
}: {
  hit: SearchHit;
  first: boolean;
  last: boolean;
  onSelect: (hit: SearchHit) => void;
}) => (
  <View
    className={`border-x border-line bg-surface px-4 ${first ? "rounded-t-2xl border-t" : ""} ${last ? "rounded-b-2xl border-b" : ""}`}
  >
    <Pressable
      onPress={() => onSelect(hit)}
      className={`gap-1.5 py-3.5 active:opacity-70 ${first ? "" : "border-t border-line"}`}
    >
      <View className="flex-row items-center gap-1.5">
        <T
          variant="caption"
          className="shrink font-ar-bold text-accent"
          numberOfLines={1}
        >
          {hit.book_title}
        </T>
        {hit.page_number != null ? (
          <T variant="caption" className="font-body text-ink-3">
            · page {hit.page_number}
          </T>
        ) : null}
      </View>
      <T
        variant="arSmall"
        className="font-ar leading-7"
        numberOfLines={3}
        style={{ textAlign: "right" }}
      >
        {cleanSnippet(hit._formatted?.text ?? hit.text ?? "")}
      </T>
    </Pressable>
  </View>
);

const Results = ({ onSelect }: { onSelect: (hit: SearchHit) => void }) => {
  const { items, isLastPage, showMore } = useInfiniteHits<SearchHit>();
  const { query } = useSearchBox();
  const insets = useSafeAreaInsets();
  return (
    <FlatList
      data={items}
      keyExtractor={(h) => h.id}
      renderItem={({ item, index }) => (
        <HitRow
          hit={item}
          first={index === 0}
          last={index === items.length - 1}
          onSelect={onSelect}
        />
      )}
      contentContainerStyle={{
        flexGrow: 1,
        paddingHorizontal: 24,
        paddingBottom: insets.bottom + 90,
      }}
      keyboardShouldPersistTaps="handled"
      onEndReached={() => {
        if (!isLastPage) showMore();
      }}
      onEndReachedThreshold={0.5}
      ListEmptyComponent={
        <View className="flex-1 justify-center pb-24">
          {query.trim() ? (
            <EmptyState
              icon="search"
              title="No results"
              body="Try fewer words, or search without tashkeel."
            />
          ) : (
            <EmptyState
              icon="file-text"
              title="Search your library"
              body="Type a word or phrase in Arabic. Results come from every transcribed page."
            />
          )}
        </View>
      }
    />
  );
};

const SearchContent = ({
  onSelect,
}: {
  onSelect: (hit: SearchHit) => void;
}) => {
  const facets = useFacets();
  const [filtersOpen, setFiltersOpen] = useState(false);
  return (
    <>
      <View className="gap-3 px-6 pb-4">
        <SearchBar />
        <FilterBar facets={facets} onOpenFilters={() => setFiltersOpen(true)} />
      </View>
      <Results onSelect={onSelect} />
      <FilterSheet
        facets={facets}
        visible={filtersOpen}
        onClose={() => setFiltersOpen(false)}
      />
    </>
  );
};

// (query, fileId) → highlight response, so reopening a result or retyping the
// same query doesn't re-hit the API. Session-lived; clears on reload.
const highlightCache = new Map<string, HighlightResponse>();

const HighlightAction = ({
  loading,
  hasResult,
  hasMatches,
  onHighlight,
  onClear,
}: {
  loading: boolean;
  hasResult: boolean;
  hasMatches: boolean;
  onHighlight: () => void;
  onClear: () => void;
}) => {
  if (loading)
    return <Button label="Finding…" icon="edit-3" loading onPress={() => {}} />;
  if (hasResult && hasMatches)
    return (
      <Button
        label="Clear highlight"
        icon="x"
        variant="secondary"
        onPress={onClear}
      />
    );
  if (hasResult)
    return (
      <View className="h-12 items-center justify-center">
        <T variant="small" className="text-ink-3">
          No matching passage
        </T>
      </View>
    );
  return (
    <Button label="Highlight matches" icon="edit-3" onPress={onHighlight} />
  );
};

// Full-page rendered preview, opened by tapping a result. Renders the page with
// the same Markdown component as the reader; tapping "Highlight matches" fetches
// the LLM-picked passages and emphasizes them in place.
const PreviewModal = ({
  hit,
  query,
  onClose,
}: {
  hit: SearchHit | null;
  query: string;
  onClose: () => void;
}) => {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const c = useColors();
  const q = query.trim();
  const [hl, setHl] = useState<HighlightResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  // The page id (not the chunk id) — highlight and reader both address pages.
  const hitId = hit?.file_id;
  const bookId = hit?.book_id;
  // Highlighting is an explicit action, so drop any existing highlight when the
  // opened result or query changes — the button re-fetches on demand.
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
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }, [hitId, bookId, q]);

  // Each relevant span, split per-line so a passage spanning a line break still
  // matches against the per-line markdown the renderer produces.
  const highlight = hl?.spans.flatMap((s) =>
    s.text
      .split(/\n+/)
      .map((t) => t.trim())
      .filter(Boolean),
  );
  const canHighlight = q.length > 0;

  return (
    <Modal
      visible={hit != null}
      animationType="slide"
      onRequestClose={onClose}
      transparent={false}
    >
      <View className="flex-1 bg-bg" style={{ paddingTop: insets.top }}>
        <View className="flex-row items-center gap-3 px-5 pb-2.5 pt-1.5">
          <IconButton icon="x" onPress={onClose} />
          <View className="flex-1 items-center">
            <T
              variant="caption"
              className="font-ar-bold text-ink"
              numberOfLines={1}
            >
              {hit?.book_title}
            </T>
            {hit?.page_number != null ? (
              <T variant="caption" className="font-body text-ink-3">
                Page {hit.page_number}
              </T>
            ) : null}
          </View>
          <IconButton
            icon="book-open"
            disabled={!hit}
            onPress={() => {
              if (!hit) return;
              onClose();
              router.push(`/reader/${hit.book_id}/${hit.file_id}`);
            }}
          />
        </View>
        <ScrollView
          className="flex-1"
          contentContainerStyle={{
            paddingHorizontal: 24,
            paddingTop: 8,
            paddingBottom: canHighlight ? 24 : insets.bottom + 24,
          }}
        >
          {canHighlight && failed ? (
            <View className="mb-4 flex-row items-center gap-2.5 rounded-xl bg-danger-soft px-3.5 py-3">
              <Feather name="alert-circle" size={16} color={c.danger} />
              <T variant="small" className="flex-1 text-danger">
                Couldn't highlight this page.
              </T>
              <Pressable onPress={runHighlight} hitSlop={8}>
                <T variant="small" className="font-body-bold text-danger">
                  Retry
                </T>
              </Pressable>
            </View>
          ) : null}
          <Markdown
            source={hit?.page_text ?? hit?.text ?? ""}
            highlight={highlight}
          />
        </ScrollView>
        {canHighlight ? (
          <ActionBar>
            <HighlightAction
              loading={loading}
              hasResult={hl != null}
              hasMatches={(highlight?.length ?? 0) > 0}
              onHighlight={runHighlight}
              onClear={() => setHl(null)}
            />
          </ActionBar>
        ) : null}
      </View>
    </Modal>
  );
};

const ScreenTitle = () => {
  const insets = useSafeAreaInsets();
  return (
    <T
      variant="display"
      className="px-6 pb-4"
      style={{ paddingTop: insets.top + 16 }}
    >
      Search
    </T>
  );
};

export default function SearchScreen() {
  const router = useRouter();
  const { config, ready } = useConfigState();
  const [selected, setSelected] = useState<SearchHit | null>(null);
  // Mirrored from InstantSearch so PreviewModal (rendered outside the provider)
  // knows the active query to request highlights for.
  const [query, setQuery] = useState(getLastQuery());
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
    const q = (uiState[SEARCH_INDEX] as { query?: string })?.query ?? "";
    setLastQuery(q);
    setQuery(q);
    setUiState(uiState);
  }, []);
  // Close the preview whenever the query changes — never show a page from a
  // stale query.
  // biome-ignore lint/correctness/useExhaustiveDependencies: query is the trigger
  useEffect(() => {
    setSelected(null);
  }, [query]);

  if (!ready) return null;

  if (!searchClient) {
    return (
      <View className="flex-1 bg-bg">
        <ScreenTitle />
        <View className="flex-1 justify-center pb-24">
          <EmptyState
            icon="search"
            title="Search isn't set up"
            body="Add your Meilisearch URL and read-only key in Settings to search inside every page."
            action={
              <Button
                label="Open Settings"
                variant="secondary"
                onPress={() => router.navigate("/settings")}
              />
            }
          />
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-bg">
      <ScreenTitle />
      <InstantSearch
        searchClient={searchClient}
        indexName={SEARCH_INDEX}
        future={SEARCH_FUTURE}
        initialUiState={initialUiState}
        onStateChange={onStateChange}
      >
        <SearchContent onSelect={setSelected} />
      </InstantSearch>
      <PreviewModal
        hit={selected}
        query={query}
        onClose={() => setSelected(null)}
      />
    </View>
  );
}
