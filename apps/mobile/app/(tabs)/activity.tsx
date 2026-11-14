import { Feather } from "@expo/vector-icons";
import type { BookWithStatus, FileStatus } from "@qiraa/shared";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import type { ReactNode } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Button,
  EmptyState,
  IconButton,
  ListCard,
  Loading,
  StatusLine,
  T,
} from "@/components/ui";
import { api } from "@/lib/api";
import { useConfigState } from "@/lib/config-context";
import { useColors } from "@/theme";

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

const timeAgo = (raw: number): string => {
  const rel = relativeTime(raw);
  return rel === "now" ? "just now" : `${rel} ago`;
};

const STAT_TONES = {
  ok: { bg: "bg-ok-soft", fg: "text-ok" },
  accent: { bg: "bg-accent-soft", fg: "text-accent" },
  danger: { bg: "bg-danger-soft", fg: "text-danger" },
} as const;

const StatTile = ({
  value,
  label,
  tone,
}: {
  value: number;
  label: string;
  tone: keyof typeof STAT_TONES;
}) => {
  const { bg, fg } = STAT_TONES[tone];
  return (
    <View className={`flex-1 gap-0.5 rounded-2xl px-3.5 py-3 ${bg}`}>
      <T variant="title" className={fg}>
        {value}
      </T>
      <T variant="caption" className={`font-body ${fg}`}>
        {label}
      </T>
    </View>
  );
};

const Screen = ({
  children,
  right,
}: {
  children: ReactNode;
  right?: ReactNode;
}) => {
  const insets = useSafeAreaInsets();
  return (
    <View className="flex-1 bg-bg" style={{ paddingTop: insets.top + 16 }}>
      <View className="flex-row items-center justify-between px-6 pb-4">
        <T variant="display">Activity</T>
        {right}
      </View>
      {children}
    </View>
  );
};

export default function ActivityScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const c = useColors();
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
      <Screen>
        <View className="flex-1 justify-center pb-24">
          <EmptyState
            icon="power"
            title="Not connected"
            body="Connect your API in Settings to see recent scans."
            action={
              <Button
                label="Open Settings"
                variant="secondary"
                onPress={() => router.navigate("/settings")}
              />
            }
          />
        </View>
      </Screen>
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
    <Screen right={<IconButton icon="refresh-cw" onPress={refetchAll} />}>
      <ScrollView
        className="flex-1"
        contentContainerStyle={{
          flexGrow: 1,
          paddingHorizontal: 24,
          paddingBottom: insets.bottom + 90,
        }}
        refreshControl={
          <RefreshControl
            refreshing={booksQuery.isRefetching || recentQuery.isRefetching}
            onRefresh={refetchAll}
            tintColor={c.accent}
          />
        }
      >
        <View className="flex-row gap-2.5">
          <StatTile value={done} label="done" tone="ok" />
          <StatTile value={queued} label="in queue" tone="accent" />
          <StatTile value={failed} label="failed" tone="danger" />
        </View>

        {recentQuery.isLoading ? (
          <View className="mt-10">
            <Loading />
          </View>
        ) : recent.length === 0 ? (
          <View className="flex-1 justify-center pb-16">
            <EmptyState
              icon="maximize"
              title="Nothing scanned yet"
              body="Open a book and tap Scan pages. Each page appears here as it transcribes."
            />
          </View>
        ) : (
          <View className="mt-6 gap-2.5">
            <T variant="overline" className="text-ink-3">
              Recently scanned
            </T>
            <ListCard>
              {recent.map((r, i) => {
                const readable = READABLE.includes(r.file.state);
                return (
                  <Pressable
                    key={r.file.file_id}
                    disabled={!readable}
                    onPress={() =>
                      router.push(`/reader/${r.book_id}/${r.file.file_id}`)
                    }
                    className={`flex-row items-center gap-3.5 py-3.5 active:opacity-70 ${i > 0 ? "border-t border-line" : ""}`}
                  >
                    <View className="w-10 items-center">
                      <T variant="title" className="leading-7">
                        {r.file.page_number ?? "—"}
                      </T>
                      <T variant="caption" className="font-body text-ink-3">
                        page
                      </T>
                    </View>
                    <View className="flex-1 items-start gap-0.5">
                      <T
                        variant="arSmall"
                        numberOfLines={1}
                        className="font-ar-bold"
                      >
                        {r.title}
                      </T>
                      <StatusLine
                        state={r.file.state}
                        trailing={`· ${timeAgo(r.file.updated_at)}`}
                      />
                    </View>
                    <Feather
                      name="chevron-right"
                      size={18}
                      color={readable ? c.ink3 : c.line}
                    />
                  </Pressable>
                );
              })}
            </ListCard>
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}
