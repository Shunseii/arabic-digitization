import { Feather } from "@expo/vector-icons";
import type { HighlightResponse } from "@qiraa/shared";
import { Link, useRouter } from "expo-router";
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
  useMenu,
  useSearchBox,
} from "react-instantsearch-core";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Centered } from "@/components/ui";
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
import { colors } from "@/theme";

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
  const { status } = useInstantSearch();
  const busy = status === "loading" || status === "stalled";
  const [value, setValue] = useState(query);
  return (
    <View className="flex-row items-center gap-2 rounded-2xl border border-border bg-surface px-3.5 py-2.5">
      <Feather name="search" size={18} color={colors.textMuted} />
      <TextInput
        value={value}
        onChangeText={(t) => {
          setValue(t);
          refine(t);
        }}
        placeholder="Search the library…"
        placeholderTextColor={colors.textMuted}
        autoFocus
        autoCorrect={false}
        className="flex-1 text-base text-ink"
        style={{ writingDirection: "rtl" }}
      />
      {busy ? (
        <ActivityIndicator size="small" color={colors.textMuted} />
      ) : value.length > 0 ? (
        <Pressable
          onPress={() => {
            setValue("");
            refine("");
          }}
        >
          <Feather name="x" size={18} color={colors.textMuted} />
        </Pressable>
      ) : null}
    </View>
  );
};

// Single-select book facet as a horizontal chip row. Meili facets `book_title`;
// tapping a chip scopes results to that book, tapping it again clears. Hidden
// until more than one book has matches.
const BookFilter = () => {
  const { items, refine } = useMenu({ attribute: "book_title", limit: 100 });
  if (items.length <= 1) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 8, paddingRight: 8 }}
    >
      {items.map((i) => (
        <Pressable
          key={i.value}
          onPress={() => refine(i.value)}
          className={`rounded-full border px-3 py-1.5 ${
            i.isRefined
              ? "border-accent bg-accent-soft"
              : "border-border bg-surface"
          }`}
        >
          <Text
            className={`text-xs font-semibold ${
              i.isRefined ? "text-accent" : "text-text-secondary"
            }`}
            numberOfLines={1}
          >
            {i.label} ({i.count})
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
};

const Hit = ({
  hit,
  onSelect,
}: {
  hit: SearchHit;
  onSelect: (hit: SearchHit) => void;
}) => (
  <Pressable
    onPress={() => onSelect(hit)}
    className="rounded-2xl border border-border bg-surface p-3.5"
  >
    <View className="flex-row items-center justify-between">
      <Text className="text-sm font-semibold text-accent" numberOfLines={1}>
        {hit.book_title}
      </Text>
      {hit.page_number != null && (
        <Text className="text-xs text-text-muted">ص {hit.page_number}</Text>
      )}
    </View>
    <Text
      className="mt-1.5 text-sm leading-6 text-text-secondary"
      numberOfLines={3}
      style={{ writingDirection: "rtl", textAlign: "right" }}
    >
      {cleanSnippet(hit._formatted?.text ?? hit.text ?? "")}
    </Text>
  </Pressable>
);

const Results = ({ onSelect }: { onSelect: (hit: SearchHit) => void }) => {
  const { items, isLastPage, showMore } = useInfiniteHits<SearchHit>();
  const { query } = useSearchBox();
  const insets = useSafeAreaInsets();
  return (
    <FlatList
      data={items}
      keyExtractor={(h) => h.id}
      renderItem={({ item }) => <Hit hit={item} onSelect={onSelect} />}
      ItemSeparatorComponent={() => <View className="h-2.5" />}
      contentContainerStyle={{ paddingBottom: insets.bottom + 90 }}
      keyboardShouldPersistTaps="handled"
      onEndReached={() => {
        if (!isLastPage) showMore();
      }}
      onEndReachedThreshold={0.5}
      ListEmptyComponent={
        <Text className="mt-10 text-center text-sm text-text-muted">
          {query.trim() ? "No results." : "Type to search the library."}
        </Text>
      }
    />
  );
};

// (query, fileId) → highlight response, so reopening a result or retyping the
// same query doesn't re-hit the API. Session-lived; clears on reload.
const highlightCache = new Map<string, HighlightResponse>();

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
  const q = query.trim();
  const [hl, setHl] = useState<HighlightResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  // The page id (not the chunk id) — highlight and reader both address pages.
  const hitId = hit?.file_id;
  const bookId = hit?.book_id;
  // Highlighting is an explicit action now, so drop any existing highlight when
  // the opened result or query changes — the button re-fetches on demand.
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
      // Surface the failure instead of silently doing nothing.
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
        <View className="flex-row items-center justify-between border-b border-hairline px-5 py-3">
          <Pressable onPress={onClose} hitSlop={8}>
            <Feather name="x" size={22} color={colors.ink} />
          </Pressable>
          <View className="flex-1 px-3">
            <Text
              className="text-sm font-semibold text-accent"
              numberOfLines={1}
            >
              {hit?.book_title}
            </Text>
            {hit?.page_number != null && (
              <Text className="text-xs text-text-muted">
                صفحة {hit.page_number}
              </Text>
            )}
          </View>
          {hit && (
            <Pressable
              onPress={() => {
                onClose();
                router.push(`/reader/${hit.book_id}/${hit.file_id}`);
              }}
              hitSlop={8}
            >
              <Feather name="book-open" size={20} color={colors.accent} />
            </Pressable>
          )}
        </View>
        <ScrollView
          className="flex-1 px-5"
          contentContainerStyle={{
            paddingVertical: 20,
            paddingBottom: insets.bottom + 24,
          }}
        >
          {canHighlight && (
            <View className="mb-3">
              {loading ? (
                <View className="flex-row items-center gap-2">
                  <ActivityIndicator size="small" color={colors.textMuted} />
                  <Text className="text-sm text-text-muted">Finding…</Text>
                </View>
              ) : failed ? (
                <Pressable onPress={runHighlight} hitSlop={8}>
                  <Text className="text-sm font-semibold text-st-fail">
                    Couldn't highlight — retry
                  </Text>
                </Pressable>
              ) : hl ? (
                highlight && highlight.length > 0 ? (
                  <Pressable onPress={() => setHl(null)} hitSlop={8}>
                    <Text className="text-sm font-semibold text-text-muted">
                      Clear highlight
                    </Text>
                  </Pressable>
                ) : (
                  <Text className="text-sm text-text-muted">
                    No matching passage
                  </Text>
                )
              ) : (
                <Pressable
                  onPress={runHighlight}
                  className="self-start rounded-lg border border-accent px-3 py-1.5"
                >
                  <Text className="text-sm font-semibold text-accent">
                    Highlight matches
                  </Text>
                </Pressable>
              )}
            </View>
          )}
          <Markdown
            source={hit?.page_text ?? hit?.text ?? ""}
            highlight={highlight}
          />
        </ScrollView>
      </View>
    </Modal>
  );
};

export default function SearchScreen() {
  const insets = useSafeAreaInsets();
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

  if (!ready) return null;

  if (!searchClient) {
    return (
      <Centered>
        <Text className="text-center text-lg font-semibold text-ink">
          Search isn't set up
        </Text>
        <Text className="text-center text-sm text-text-secondary">
          Add your Meilisearch URL and read-only key in Settings.
        </Text>
        <Link href="/settings" className="mt-2 font-semibold text-accent">
          Open Settings →
        </Link>
      </Centered>
    );
  }

  return (
    <View className="flex-1 bg-bg px-5" style={{ paddingTop: insets.top + 8 }}>
      <Text className="mb-3 text-[34px] font-semibold text-ink">Search</Text>
      <InstantSearch
        searchClient={searchClient}
        indexName={SEARCH_INDEX}
        future={SEARCH_FUTURE}
        initialUiState={initialUiState}
        onStateChange={onStateChange}
      >
        <View className="mb-3">
          <SearchBar />
        </View>
        <View className="mb-3">
          <BookFilter />
        </View>
        <Results onSelect={setSelected} />
      </InstantSearch>
      <PreviewModal
        hit={selected}
        query={query}
        onClose={() => setSelected(null)}
      />
    </View>
  );
}
