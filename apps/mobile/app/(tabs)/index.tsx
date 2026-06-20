import type { BookWithStatus } from "@qiraa/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouter } from "expo-router";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
    <Link href={`/book/${book.id}`} asChild>
      <Pressable className="flex-1 rounded-2xl border border-border bg-surface p-2.5">
        <View className="h-36 overflow-hidden rounded-xl bg-accent-soft">
          <View className="absolute left-0 top-0 h-full w-1 bg-accent" />
          <View className="flex-1 items-center justify-center">
            <Text className="text-4xl text-accent">
              {book.title.trim().charAt(0)}
            </Text>
          </View>
        </View>
        <Text className="mt-2.5 text-base text-ink" numberOfLines={1}>
          {book.title}
        </Text>
        <View className="mt-2 flex-row items-center justify-between">
          <Text className="text-xs font-medium text-text-muted">
            {book.files_total} pp
          </Text>
          <Text className="text-xs font-semibold" style={{ color: metaColor }}>
            {meta}
          </Text>
        </View>
        <View className="mt-2 h-1 overflow-hidden rounded-full bg-surface-alt">
          <View
            className="h-full rounded-full bg-accent"
            style={{ width: `${pct}%` }}
          />
        </View>
      </Pressable>
    </Link>
  );
};

export default function LibraryScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
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

  if (!configured) {
    return (
      <Centered>
        <Text className="text-center text-lg font-semibold text-ink">
          Connect to your API
        </Text>
        <Text className="text-center text-sm text-text-secondary">
          Add your worker endpoint and key in Settings to start scanning.
        </Text>
        <Link href="/settings" className="mt-2 font-semibold text-accent">
          Open Settings →
        </Link>
      </Centered>
    );
  }

  const books = booksQuery.data ?? [];
  const totalPages = books.reduce((n, b) => n + b.files_total, 0);

  return (
    <ScrollView
      className="flex-1 bg-bg"
      contentContainerStyle={{
        paddingTop: insets.top + 8,
        paddingHorizontal: 20,
        paddingBottom: insets.bottom + 90,
      }}
      refreshControl={
        <RefreshControl
          refreshing={booksQuery.isRefetching}
          onRefresh={() => booksQuery.refetch()}
          tintColor={colors.accent}
        />
      }
    >
      <View className="flex-row items-center justify-between">
        <View className="gap-1">
          <Text className="text-base font-bold text-accent">رقمنة</Text>
          <Text className="text-[34px] font-semibold text-ink">Library</Text>
        </View>
        <View className="flex-row items-center gap-1.5 rounded-full bg-[#16271E] px-3 py-1.5">
          <View className="h-1.5 w-1.5 rounded-full bg-st-done" />
          <Text className="text-xs font-semibold text-st-done">Online</Text>
        </View>
      </View>

      {booksQuery.isLoading ? (
        <View className="mt-16">
          <Loading />
        </View>
      ) : (
        <>
          <Text className="mt-1 text-sm text-text-muted">
            {books.length} {books.length === 1 ? "book" : "books"} ·{" "}
            {totalPages} pages
          </Text>
          <View className="mt-5 flex-row flex-wrap gap-3.5">
            {books.map((book) => (
              <View key={book.id} className="w-[47%] grow">
                <BookCard book={book} />
              </View>
            ))}
            <Pressable
              onPress={() => router.push("/new-book")}
              className="w-[47%] grow items-center justify-center gap-2.5 rounded-2xl border border-border py-8"
            >
              <View className="h-11 w-11 items-center justify-center rounded-full bg-accent-soft">
                <Text className="text-2xl text-accent">+</Text>
              </View>
              <Text className="text-sm font-semibold text-text-secondary">
                New book
              </Text>
            </Pressable>
          </View>
        </>
      )}
    </ScrollView>
  );
}
