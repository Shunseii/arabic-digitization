import { Feather } from "@expo/vector-icons";
import type { BookWithStatus, WorkWithCounts } from "@qiraa/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouter } from "expo-router";
import { useMemo, useState } from "react";
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

// A grid of book cards, 2-up with wrapping — shared by flat and grouped views.
const BookGrid = ({
  books,
  footer,
}: {
  books: BookWithStatus[];
  footer?: React.ReactNode;
}) => (
  <View className="flex-row flex-wrap gap-3.5">
    {books.map((book) => (
      <View key={book.id} className="w-[47%] grow">
        <BookCard book={book} />
      </View>
    ))}
    {footer}
  </View>
);

const WorkGroup = ({
  work,
  books,
}: {
  work: WorkWithCounts | null;
  books: BookWithStatus[];
}) => (
  <View className="mt-6">
    <View className="flex-row flex-wrap items-baseline gap-x-2.5 gap-y-1">
      <Text className="text-lg font-semibold text-ink">
        {work ? work.name : "Ungrouped"}
      </Text>
      {work?.author ? (
        <Text className="text-sm text-text-muted">{work.author}</Text>
      ) : null}
      <Text className="text-xs text-text-muted">
        {books.length} {books.length === 1 ? "copy" : "copies"}
      </Text>
      {work ? (
        <Link href={`/work/${work.id}`} asChild>
          <Pressable className="flex-row items-center gap-1" hitSlop={8}>
            <Feather name="edit-2" size={11} color={colors.textMuted} />
            <Text className="text-xs font-medium text-text-muted">Edit</Text>
          </Pressable>
        </Link>
      ) : null}
    </View>
    {work && work.tags.length > 0 ? (
      <View className="mt-1.5 flex-row flex-wrap gap-1.5">
        {work.tags.map((t) => (
          <View key={t} className="rounded-full bg-accent-soft px-2 py-0.5">
            <Text className="text-xs text-accent">{t}</Text>
          </View>
        ))}
      </View>
    ) : null}
    <View className="mt-3">
      <BookGrid books={books} />
    </View>
  </View>
);

// Toggleable pill — used for the flat/group toggle and the tag chips.
const Chip = ({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) => (
  <Pressable
    onPress={onPress}
    className={`rounded-full border px-3 py-1.5 ${
      active ? "border-accent bg-accent-soft" : "border-border bg-surface"
    }`}
  >
    <Text
      className={`text-sm font-medium ${active ? "text-accent" : "text-text-muted"}`}
    >
      {label}
    </Text>
  </Pressable>
);

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
  const worksQuery = useQuery({
    queryKey: ["works"],
    queryFn: api.listWorks,
    enabled: configured,
  });

  const [grouped, setGrouped] = useState(false);
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const toggleTag = (name: string) =>
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const works = useMemo(() => worksQuery.data ?? [], [worksQuery.data]);
  const worksById = useMemo(
    () => new Map(works.map((w) => [w.id, w])),
    [works],
  );
  const tagOptions = useMemo(() => {
    const names = new Set<string>();
    for (const w of works) for (const t of w.tags) names.add(t);
    return [...names].sort();
  }, [works]);

  const books = useMemo(() => booksQuery.data ?? [], [booksQuery.data]);

  // Work + tag filtering (tags OR). Standalone books drop out under a tag filter.
  const filtered = useMemo(
    () =>
      books.filter((b) => {
        if (selectedTags.size === 0) return true;
        const work = b.work_id ? worksById.get(b.work_id) : undefined;
        return !!work && work.tags.some((t) => selectedTags.has(t));
      }),
    [books, selectedTags, worksById],
  );

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

  const totalPages = filtered.reduce((n, b) => n + b.files_total, 0);

  // Grouped buckets: works newest-first (query order), standalone trailing.
  const byWork = new Map<string, BookWithStatus[]>();
  const ungrouped: BookWithStatus[] = [];
  for (const b of filtered) {
    if (b.work_id && worksById.has(b.work_id)) {
      const list = byWork.get(b.work_id) ?? [];
      list.push(b);
      byWork.set(b.work_id, list);
    } else {
      ungrouped.push(b);
    }
  }
  const orderedGroups = works
    .filter((w) => byWork.has(w.id))
    .map((w) => ({ work: w, books: byWork.get(w.id) ?? [] }));

  const newBookButton = (
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
  );

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
            {filtered.length} {filtered.length === 1 ? "book" : "books"} ·{" "}
            {totalPages} pages
          </Text>

          <View className="mt-4 flex-row gap-2">
            <Chip
              label="Flat"
              active={!grouped}
              onPress={() => setGrouped(false)}
            />
            <Chip
              label="Group by work"
              active={grouped}
              onPress={() => setGrouped(true)}
            />
          </View>

          {tagOptions.length > 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              className="mt-3"
              contentContainerStyle={{ gap: 8 }}
            >
              {tagOptions.map((t) => (
                <Chip
                  key={t}
                  label={t}
                  active={selectedTags.has(t)}
                  onPress={() => toggleTag(t)}
                />
              ))}
            </ScrollView>
          ) : null}

          {grouped ? (
            <>
              {orderedGroups.map(({ work, books: groupBooks }) => (
                <WorkGroup key={work.id} work={work} books={groupBooks} />
              ))}
              {ungrouped.length > 0 ? (
                <WorkGroup work={null} books={ungrouped} />
              ) : null}
              <View className="mt-6">
                <BookGrid books={[]} footer={newBookButton} />
              </View>
            </>
          ) : (
            <View className="mt-5">
              <BookGrid books={filtered} footer={newBookButton} />
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}
