import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useMemo } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  BookRows,
  inFlightCount,
  transcribedCount,
} from "@/components/book-row";
import {
  ActionBar,
  Badge,
  Button,
  Card,
  EmptyState,
  Header,
  IconButton,
  ListCard,
  Loading,
  T,
} from "@/components/ui";
import { api } from "@/lib/api";

const Stat = ({ value, label }: { value: string; label: string }) => (
  <View className="flex-1 gap-0.5">
    <T variant="title">{value}</T>
    <T variant="small" className="text-ink-3">
      {label}
    </T>
  </View>
);

export default function WorkDetailScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const workId = id ?? "";

  const workQuery = useQuery({
    queryKey: ["work", workId],
    queryFn: () => api.getWork(workId),
    enabled: !!workId,
  });
  const booksQuery = useQuery({
    queryKey: ["books"],
    queryFn: api.listBooks,
    refetchInterval: (q) =>
      q.state.data?.some((b) => inFlightCount(b) > 0) ? 5000 : false,
  });

  const copies = useMemo(
    () => (booksQuery.data ?? []).filter((b) => b.work_id === workId),
    [booksQuery.data, workId],
  );

  const goToEdit = () => router.push(`/work/edit/${workId}`);

  const header = (
    <View style={{ paddingTop: insets.top }}>
      <Header
        onLeft={() => router.back()}
        right={
          workQuery.data ? (
            <IconButton icon="edit-2" onPress={goToEdit} />
          ) : undefined
        }
      />
    </View>
  );

  if (workQuery.isLoading) {
    return (
      <View className="flex-1 bg-bg">
        {header}
        <Loading />
      </View>
    );
  }

  const work = workQuery.data;
  if (workQuery.isError || !work) {
    return (
      <View className="flex-1 bg-bg">
        {header}
        <View className="flex-1 justify-center pb-24">
          <EmptyState
            icon="alert-circle"
            title="Couldn't load this work"
            body="Check your connection, then go back and try again."
            action={
              <Button
                label="Go back"
                variant="secondary"
                onPress={() => router.back()}
              />
            }
          />
        </View>
      </View>
    );
  }

  const totalPages = copies.reduce((n, b) => n + b.files_total, 0);
  const transcribed = copies.reduce((n, b) => n + transcribedCount(b), 0);
  const percent =
    totalPages > 0 ? Math.round((transcribed / totalPages) * 100) : 0;

  return (
    <View className="flex-1 bg-bg">
      {header}
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 24 }}
      >
        <View className="mt-2 gap-1.5">
          <T variant="overline" className="text-ink-3">
            Work
          </T>
          <T
            variant="arTitle"
            className="text-4xl leading-[52px]"
            style={{ textAlign: "left" }}
          >
            {work.name}
          </T>
          {work.author ? (
            <T
              variant="arSmall"
              className="font-ar text-ink-2"
              style={{ textAlign: "left" }}
            >
              {work.author}
            </T>
          ) : null}
          {work.tags.length > 0 ? (
            <View className="mt-1 flex-row flex-wrap gap-1.5">
              {work.tags.map((tag) => (
                <Badge key={tag} label={tag} tone="accent" dot={false} />
              ))}
            </View>
          ) : null}
        </View>

        <Card className="mt-6 flex-row px-4 py-3.5">
          <Stat
            value={copies.length.toLocaleString()}
            label={copies.length === 1 ? "copy" : "copies"}
          />
          <Stat
            value={totalPages.toLocaleString()}
            label={totalPages === 1 ? "page" : "pages"}
          />
          <Stat value={`${percent}%`} label="transcribed" />
        </Card>

        <T variant="overline" className="mb-2 mt-7 text-ink-3">
          Copies
        </T>
        {booksQuery.isLoading ? (
          <View className="py-6">
            <Loading />
          </View>
        ) : copies.length > 0 ? (
          <ListCard>
            <BookRows books={copies} />
          </ListCard>
        ) : (
          <T variant="small" className="text-ink-3">
            No copies yet.
          </T>
        )}
      </ScrollView>
      <ActionBar>
        <Button
          label="Add a copy"
          icon="plus"
          variant="secondary"
          onPress={() =>
            router.push({ pathname: "/new-book", params: { workId } })
          }
        />
      </ActionBar>
    </View>
  );
}
