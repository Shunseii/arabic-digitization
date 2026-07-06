import { Feather } from "@expo/vector-icons";
import type { BookWithStatus, FileStatus } from "@qiraa/shared";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Centered, Loading, StatusBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { useConfigState } from "@/lib/config-context";
import { colors } from "@/theme";

const READABLE: FileStatus["state"][] = ["done", "approved", "needs_review"];
const isPending = (f: FileStatus): boolean =>
  f.state === "queued" ||
  f.state === "processing" ||
  f.state === "rate_limited";

const sum = (
  books: BookWithStatus[],
  key: keyof BookWithStatus["counts"],
): number => books.reduce((n, b) => n + (b.counts[key] ?? 0), 0);

const relativeTime = (raw: number): string => {
  const ms = raw < 1e12 ? raw * 1000 : raw; // tolerate seconds or ms
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

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
  const recentQuery = useQuery({
    queryKey: ["recent"],
    queryFn: () => api.recentFiles(25),
    enabled: configured,
    refetchInterval: (query) =>
      query.state.data?.some((r) => isPending(r.file)) ? 5000 : false,
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
  const queued =
    sum(books, "queued") +
    sum(books, "processing") +
    sum(books, "rate_limited");
  const done = sum(books, "done") + sum(books, "approved");
  const failed = sum(books, "failed");
  const recent = recentQuery.data ?? [];

  const refetchAll = () => {
    booksQuery.refetch();
    recentQuery.refetch();
  };

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
          refreshing={booksQuery.isRefetching || recentQuery.isRefetching}
          onRefresh={refetchAll}
          tintColor={colors.accent}
        />
      }
    >
      <View className="flex-row items-center justify-between">
        <Text className="text-[30px] font-semibold text-ink">Activity</Text>
        <Pressable
          onPress={refetchAll}
          className="h-10 w-10 items-center justify-center rounded-full border border-border bg-surface"
        >
          <Feather name="refresh-cw" size={17} color={colors.textSecondary} />
        </Pressable>
      </View>

      <View className="mt-4 flex-row items-center justify-around rounded-2xl border border-border bg-surface px-2 py-3.5">
        <Stat value={done} label="done" color="#46B97D" />
        <View className="h-8 w-px bg-hairline" />
        <Stat value={queued} label="queued" color="#5C8DF0" />
        <View className="h-8 w-px bg-hairline" />
        <Stat value={failed} label="failed" color="#EE6A4D" />
      </View>

      <Text className="mt-5 text-xs font-bold tracking-wide text-text-muted">
        RECENTLY SCANNED
      </Text>

      {recentQuery.isLoading ? (
        <View className="mt-10">
          <Loading />
        </View>
      ) : recent.length === 0 ? (
        <Text className="mt-3 text-sm text-text-secondary">
          No pages yet. Open a book and tap “Scan pages”.
        </Text>
      ) : (
        <View className="mt-2">
          {recent.map((r, i) => {
            const readable = READABLE.includes(r.file.state);
            const label =
              r.file.page_number != null ? String(r.file.page_number) : "—";
            return (
              <Pressable
                key={r.file.file_id}
                disabled={!readable}
                onPress={() =>
                  router.push(`/reader/${r.book_id}/${r.file.file_id}`)
                }
                className="flex-row items-center gap-3 py-3"
                style={
                  i > 0
                    ? { borderTopWidth: 1, borderTopColor: colors.hairline }
                    : undefined
                }
              >
                <View className="h-9 w-9 items-center justify-center rounded-full bg-surface-alt">
                  <Text className="text-sm font-semibold text-ink">
                    {label}
                  </Text>
                </View>
                <View className="flex-1 gap-0.5">
                  <Text
                    className="text-base text-ink"
                    numberOfLines={1}
                    style={{ writingDirection: "rtl" }}
                  >
                    {r.title}
                  </Text>
                  <Text className="text-xs text-text-muted">
                    {relativeTime(r.file.updated_at)} ago
                  </Text>
                </View>
                <StatusBadge state={r.file.state} />
                {readable && (
                  <Feather
                    name="chevron-right"
                    size={16}
                    color={colors.textMuted}
                  />
                )}
              </Pressable>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}
