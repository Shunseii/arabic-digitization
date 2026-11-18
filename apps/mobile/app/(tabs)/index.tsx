import { Feather } from "@expo/vector-icons";
import type { BookWithStatus, WorkWithCounts } from "@qiraa/shared";
import { useQuery } from "@tanstack/react-query";
import { Redirect, useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BookRows } from "@/components/book-row";
import {
  Badge,
  Button,
  Card,
  Chip,
  Divider,
  Dot,
  IconButton,
  ListCard,
  Loading,
  PagePlaceholder,
  SearchField,
  Segmented,
  T,
} from "@/components/ui";
import { api } from "@/lib/api";
import { useConfigState } from "@/lib/config-context";
import { matchesSearch } from "@/lib/text";
import { useColors } from "@/theme";

type LibraryView = "flat" | "grouped";

const VIEW_OPTIONS: { value: LibraryView; label: string }[] = [
  { value: "flat", label: "All books" },
  { value: "grouped", label: "By work" },
];

const plural = ({
  count,
  one,
  many,
}: {
  count: number;
  one: string;
  many: string;
}): string => `${count.toLocaleString()} ${count === 1 ? one : many}`;

const WorkCard = ({
  work,
  books,
}: {
  work: WorkWithCounts;
  books: BookWithStatus[];
}) => {
  const c = useColors();
  const router = useRouter();
  return (
    <Card className="px-4">
      <Pressable
        onPress={() => router.push(`/work/${work.id}`)}
        className="flex-row items-center gap-3 py-4 active:opacity-70"
      >
        <View className="flex-1 gap-1">
          <T
            variant="arTitle"
            className="text-xl"
            style={{ textAlign: "left" }}
            numberOfLines={1}
          >
            {work.name}
          </T>
          <View className="flex-row flex-wrap items-center gap-1.5">
            {work.author ? (
              <>
                <T variant="arSmall" className="font-ar text-sm text-ink-3">
                  {work.author}
                </T>
                <T variant="small" className="text-ink-3">
                  ·
                </T>
              </>
            ) : null}
            <T variant="small" className="text-ink-3">
              {plural({ count: books.length, one: "copy", many: "copies" })}
            </T>
          </View>
          {work.tags.length > 0 ? (
            <View className="mt-1.5 flex-row flex-wrap gap-1.5">
              {work.tags.map((tag) => (
                <Badge key={tag} label={tag} tone="accent" dot={false} />
              ))}
            </View>
          ) : null}
        </View>
        <Feather name="chevron-right" size={18} color={c.ink3} />
      </Pressable>
      <Divider />
      <BookRows books={books} compact />
    </Card>
  );
};

const UngroupedCard = ({ books }: { books: BookWithStatus[] }) => (
  <Card className="px-4">
    <View className="gap-1 py-4">
      <T variant="heading">Ungrouped</T>
      <T variant="small" className="text-ink-3">
        {plural({ count: books.length, one: "book", many: "books" })}
      </T>
    </View>
    <Divider />
    <BookRows books={books} compact />
  </Card>
);

const LoadingSkeleton = () => (
  <View className="mt-5 gap-5">
    <View className="h-10 rounded-xl bg-surface-2" />
    <ListCard>
      {[0, 1, 2, 3, 4].map((row) => (
        <View key={row} className="flex-row items-center gap-3.5 py-3.5">
          <View className="size-12 rounded-full bg-surface-2" />
          <View className="flex-1 gap-2">
            <View className="h-4 w-3/5 rounded-md bg-surface-2" />
            <View className="h-2.5 w-2/5 rounded-md bg-surface-2" />
          </View>
        </View>
      ))}
    </ListCard>
  </View>
);

const EmptyShelf = ({ onAdd }: { onAdd: () => void }) => (
  <View className="mt-24 items-center gap-2.5 px-2">
    <View className="mb-5 h-32 w-44">
      <View
        className="absolute left-0 top-2"
        style={{ transform: [{ rotate: "-6deg" }] }}
      >
        <PagePlaceholder width={92} height={120} lines={7} />
      </View>
      <View
        className="absolute right-0 top-0"
        style={{ transform: [{ rotate: "5deg" }] }}
      >
        <PagePlaceholder width={92} height={120} lines={7} />
      </View>
    </View>
    <T variant="title" className="text-center">
      Your shelf is empty
    </T>
    <T className="text-center text-ink-2">
      Add a book, then scan its pages. Each page is transcribed as soon as it
      uploads.
    </T>
    <View className="mt-3">
      <Button label="Add a book" icon="plus" onPress={onAdd} />
    </View>
  </View>
);

export default function LibraryScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const c = useColors();
  const { configured, ready } = useConfigState();

  const booksQuery = useQuery({
    queryKey: ["books"],
    queryFn: api.listBooks,
    enabled: configured,
  });
  const worksQuery = useQuery({
    queryKey: ["works"],
    queryFn: api.listWorks,
    enabled: configured,
  });

  const [view, setView] = useState<LibraryView>("flat");
  const [query, setQuery] = useState("");
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

  // Text matches title, work name, author or tag. Tags are OR-ed; standalone
  // books drop out under a tag filter.
  const filtered = useMemo(() => {
    return books.filter((b) => {
      const work = b.work_id ? worksById.get(b.work_id) : undefined;
      if (selectedTags.size > 0 && !work?.tags.some((t) => selectedTags.has(t)))
        return false;
      return matchesSearch({
        query,
        fields: [b.title, work?.name, work?.author, ...(work?.tags ?? [])],
      });
    });
  }, [books, selectedTags, worksById, query]);

  if (!ready) return <Loading />;
  if (!configured) return <Redirect href="/onboarding" />;

  const goToNewBook = () => router.push("/new-book");
  const grouped = view === "grouped";
  const filtering = selectedTags.size > 0 || query.trim().length > 0;
  const totalPages = filtered.reduce((n, b) => n + b.files_total, 0);

  // Works newest-first (query order), standalone trailing.
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

  const bookCount = plural({
    count: filtered.length,
    one: "book",
    many: "books",
  });
  const countsLine = filtering
    ? `${filtered.length.toLocaleString()} of ${plural({ count: books.length, one: "book", many: "books" })}`
    : grouped
      ? `${plural({ count: orderedGroups.length, one: "work", many: "works" })} · ${bookCount}`
      : `${bookCount} · ${plural({ count: totalPages, one: "page", many: "pages" })}`;

  const isEmpty = !booksQuery.isLoading && books.length === 0;

  return (
    <ScrollView
      className="flex-1 bg-bg"
      contentContainerStyle={{
        paddingTop: insets.top + 12,
        paddingHorizontal: 24,
        paddingBottom: insets.bottom + 90,
      }}
      refreshControl={
        <RefreshControl
          refreshing={booksQuery.isRefetching}
          onRefresh={() => booksQuery.refetch()}
          tintColor={c.accent}
        />
      }
    >
      <View className="flex-row items-end justify-between">
        <View className="gap-0.5">
          <T variant="arSmall" className="font-ar-bold text-accent">
            رقمنة
          </T>
          <T variant="display">Library</T>
        </View>
        <IconButton icon="plus" variant="filled" onPress={goToNewBook} />
      </View>

      {booksQuery.isLoading ? (
        <LoadingSkeleton />
      ) : (
        <>
          <View className="mt-2 flex-row items-center justify-between">
            <T variant="small" className="text-ink-3">
              {countsLine}
            </T>
            <View className="flex-row items-center gap-1.5">
              <Dot color={c.ok} size={6} />
              <T variant="caption" className="font-body-semibold text-ok">
                Online
              </T>
            </View>
          </View>

          {isEmpty ? (
            <EmptyShelf onAdd={goToNewBook} />
          ) : (
            <>
              <View className="mt-5">
                <SearchField
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Search books, works, authors"
                />
              </View>
              <View className="mt-3">
                <Segmented
                  options={VIEW_OPTIONS}
                  value={view}
                  onChange={setView}
                />
              </View>

              {tagOptions.length > 0 ? (
                <View className="-mr-6 mt-4 flex-row items-center gap-2">
                  <Feather name="tag" size={16} color={c.ink3} />
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={{ gap: 8, paddingRight: 24 }}
                  >
                    {tagOptions.map((t) => (
                      <Chip
                        key={t}
                        label={t}
                        selected={selectedTags.has(t)}
                        onPress={() => toggleTag(t)}
                      />
                    ))}
                  </ScrollView>
                </View>
              ) : null}

              <View className="mt-4 gap-4">
                {filtered.length === 0 ? (
                  <T variant="small" className="mt-4 text-center text-ink-3">
                    No books match.
                  </T>
                ) : grouped ? (
                  <>
                    {orderedGroups.map(({ work, books: groupBooks }) => (
                      <WorkCard key={work.id} work={work} books={groupBooks} />
                    ))}
                    {ungrouped.length > 0 ? (
                      <UngroupedCard books={ungrouped} />
                    ) : null}
                  </>
                ) : (
                  <ListCard>
                    <BookRows books={filtered} />
                  </ListCard>
                )}
                {selectedTags.size > 0 && filtered.length > 0 ? (
                  <T
                    variant="caption"
                    className="font-body text-center text-ink-3"
                  >
                    Showing books whose work is tagged{" "}
                    {[...selectedTags].join(" or ")}.
                  </T>
                ) : null}
              </View>
            </>
          )}
        </>
      )}
    </ScrollView>
  );
}
