import { Feather } from "@expo/vector-icons";
import type { BookWithStatus } from "@qiraa/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "expo-router";
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

const sum = (
  books: BookWithStatus[],
  key: keyof BookWithStatus["counts"],
): number => books.reduce((n, b) => n + (b.counts[key] ?? 0), 0);

const Stat = ({
  value,
  label,
  color,
}: {
  value: number;
  label: string;
  color: string;
}) => (
  <View className="items-center gap-1">
    <Text className="text-[22px] font-semibold" style={{ color }}>
      {value}
    </Text>
    <Text className="text-xs text-text-muted">{label}</Text>
  </View>
);

export default function ActivityScreen() {
  const insets = useSafeAreaInsets();
  const { configured, ready } = useConfigState();
  const booksQuery = useQuery({
    queryKey: ["books"],
    queryFn: api.listBooks,
    enabled: configured,
  });

  if (!ready) return <Loading />;
  if (!configured) {
    return (
      <Centered>
        <Text className="text-center text-sm text-text-secondary">
          Configure the API in Settings to see activity.
        </Text>
      </Centered>
    );
  }

  const books = booksQuery.data ?? [];
  const queued = sum(books, "queued") + sum(books, "processing");
  const done = sum(books, "done") + sum(books, "approved");
  const failed = sum(books, "failed");
  const active = books
    .filter(
      (b) =>
        (b.counts.queued ?? 0) +
          (b.counts.processing ?? 0) +
          (b.counts.failed ?? 0) >
        0,
    )
    .sort((a, b) => (b.counts.failed ?? 0) - (a.counts.failed ?? 0));

  return (
    <ScrollView
      className="flex-1 bg-bg"
      contentContainerStyle={{
        paddingTop: insets.top + 8,
        paddingHorizontal: 20,
        paddingBottom: 24,
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
        <Text className="text-[30px] font-semibold text-ink">Activity</Text>
        <Pressable
          onPress={() => booksQuery.refetch()}
          className="h-10 w-10 items-center justify-center rounded-full border border-border bg-surface"
        >
          <Feather name="refresh-cw" size={17} color={colors.textSecondary} />
        </Pressable>
      </View>

      {booksQuery.isLoading ? (
        <View className="mt-16">
          <Loading />
        </View>
      ) : (
        <>
          <View className="mt-4 flex-row items-center justify-around rounded-2xl border border-border bg-surface px-2 py-3.5">
            <Stat value={done} label="done" color="#46B97D" />
            <View className="h-8 w-px bg-hairline" />
            <Stat value={queued} label="queued" color="#5C8DF0" />
            <View className="h-8 w-px bg-hairline" />
            <Stat value={failed} label="failed" color="#EE6A4D" />
          </View>

          <Text className="mt-5 text-xs font-bold tracking-wide text-text-muted">
            NEEDS ATTENTION
          </Text>
          {active.length === 0 ? (
            <Text className="mt-3 text-sm text-text-secondary">
              Everything is transcribed. Nothing in flight.
            </Text>
          ) : (
            <View className="mt-2">
              {active.map((b, i) => (
                <Link key={b.id} href={`/book/${b.id}`} asChild>
                  <Pressable
                    className="flex-row items-center gap-3 py-3"
                    style={
                      i > 0
                        ? { borderTopWidth: 1, borderTopColor: colors.hairline }
                        : undefined
                    }
                  >
                    <View className="flex-1 gap-0.5">
                      <Text className="text-base text-ink" numberOfLines={1}>
                        {b.title}
                      </Text>
                      <Text className="text-xs text-text-muted">
                        {(b.counts.queued ?? 0) + (b.counts.processing ?? 0)} in
                        queue
                        {b.counts.failed ? ` · ${b.counts.failed} failed` : ""}
                      </Text>
                    </View>
                    <Feather
                      name="chevron-right"
                      size={18}
                      color={colors.textMuted}
                    />
                  </Pressable>
                </Link>
              ))}
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}
