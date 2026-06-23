import { Feather } from "@expo/vector-icons";
import { Link, useRouter } from "expo-router";
import { useMemo, useRef, useState } from "react";
import {
  InstantSearch,
  useInfiniteHits,
  useSearchBox,
} from "react-instantsearch-core";
import { FlatList, Pressable, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Centered } from "@/components/ui";
import { useConfigState } from "@/lib/config-context";
import { makeSearchClient, SEARCH_INDEX, type SearchHit } from "@/lib/search";
import { colors } from "@/theme";

// Debounce queries so we don't hit Meili on every keystroke.
const useDebouncedSearchBox = () => {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const box = useSearchBox({
    queryHook: (query, refine) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => refine(query), 250);
    },
  });
  return box;
};

const SearchBar = () => {
  const { query, refine } = useDebouncedSearchBox();
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
      {value.length > 0 && (
        <Pressable
          onPress={() => {
            setValue("");
            refine("");
          }}
        >
          <Feather name="x" size={18} color={colors.textMuted} />
        </Pressable>
      )}
    </View>
  );
};

const Hit = ({ hit }: { hit: SearchHit }) => {
  const router = useRouter();
  const snippet = (hit._formatted?.text ?? hit.text ?? "")
    .replace(/<\/?(ais-highlight|em)>|__\/?ais-highlight__/g, "")
    .trim();
  return (
    <Pressable
      onPress={() => router.push(`/reader/${hit.book_id}/${hit.id}`)}
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
        {snippet}
      </Text>
    </Pressable>
  );
};

const Results = () => {
  const { items, isLastPage, showMore } = useInfiniteHits<SearchHit>();
  const insets = useSafeAreaInsets();
  return (
    <FlatList
      data={items}
      keyExtractor={(h) => h.id}
      renderItem={({ item }) => <Hit hit={item} />}
      ItemSeparatorComponent={() => <View className="h-2.5" />}
      contentContainerStyle={{ paddingBottom: insets.bottom + 90 }}
      keyboardShouldPersistTaps="handled"
      onEndReached={() => {
        if (!isLastPage) showMore();
      }}
      onEndReachedThreshold={0.5}
      ListEmptyComponent={
        <Text className="mt-10 text-center text-sm text-text-muted">
          No results yet — type to search.
        </Text>
      }
    />
  );
};

export default function SearchScreen() {
  const insets = useSafeAreaInsets();
  const { config, ready } = useConfigState();
  const searchClient = useMemo(
    () =>
      config?.meiliUrl && config.meiliKey
        ? makeSearchClient({ url: config.meiliUrl, key: config.meiliKey })
        : null,
    [config?.meiliUrl, config?.meiliKey],
  );

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
      <InstantSearch searchClient={searchClient} indexName={SEARCH_INDEX}>
        <View className="mb-3">
          <SearchBar />
        </View>
        <Results />
      </InstantSearch>
    </View>
  );
}
