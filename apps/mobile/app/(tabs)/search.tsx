import { Feather } from "@expo/vector-icons";
import type { HighlightResponse } from "@qiraa/shared";
import { Link, useRouter } from "expo-router";
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

// Render `text` with the given char ranges emphasized via nested <Text>.
// Ranges are sorted; any overlapping an already-emphasized region is skipped.
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
    if (start < pos) continue;
    if (start > pos) parts.push(text.slice(pos, start));
    parts.push(
      <Text
        key={start}
        style={{ backgroundColor: colors.accentSoft, color: colors.accent }}
      >
        {text.slice(start, end)}
      </Text>,
    );
    pos = end;
  }
  parts.push(text.slice(pos));
  return (
    <Text
      className="text-base leading-7 text-ink"
      style={{ writingDirection: "rtl", textAlign: "right" }}
    >
      {parts}
    </Text>
  );
};

// Full-page rendered preview, opened by tapping a result. When there's an
// active query, shows the LLM-picked passages highlighted; otherwise the plain
// markdown page.
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

  const ranges = hl?.spans.flatMap((s) => s.ranges) ?? [];
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
                router.push(`/reader/${hit.book_id}/${hit.id}`);
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
          {loading ? (
            <View className="flex-row items-center gap-2">
              <ActivityIndicator size="small" color={colors.textMuted} />
              <Text className="text-sm text-text-muted">
                Finding the relevant passage…
              </Text>
            </View>
          ) : hl && ranges.length > 0 ? (
            <HighlightedText text={hl.text} ranges={ranges} />
          ) : (
            <Markdown source={hit?.text ?? ""} />
          )}
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
