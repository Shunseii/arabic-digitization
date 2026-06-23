import { Feather } from "@expo/vector-icons";
import { Link, useRouter } from "expo-router";
import {
  type ComponentProps,
  useCallback,
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

// Full-page rendered preview, opened by tapping a result.
const PreviewModal = ({
  hit,
  onClose,
}: {
  hit: SearchHit | null;
  onClose: () => void;
}) => {
  const insets = useSafeAreaInsets();
  const router = useRouter();
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
          <Markdown source={hit?.text ?? ""} />
        </ScrollView>
      </View>
    </Modal>
  );
};

export default function SearchScreen() {
  const insets = useSafeAreaInsets();
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
      <PreviewModal hit={selected} onClose={() => setSelected(null)} />
    </View>
  );
}
