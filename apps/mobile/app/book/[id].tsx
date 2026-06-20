import { Feather } from "@expo/vector-icons";
import type { FileStatus } from "@qiraa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Loading, StatusBadge } from "@/components/ui";
import { api } from "@/lib/api";
import { colors } from "@/theme";

const READABLE: FileStatus["state"][] = ["done", "approved", "needs_review"];
const isPending = (f: FileStatus): boolean =>
  f.state === "queued" || f.state === "processing";

const pageLabel = (f: FileStatus, index: number): string =>
  f.page_number != null ? String(f.page_number) : `#${index + 1}`;

export default function BookScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const queryClient = useQueryClient();
  const bookQuery = useQuery({
    queryKey: ["book", id],
    queryFn: () => api.getBook(id),
  });
  const retry = useMutation({
    mutationFn: (fileId: string) => api.rerunOcr({ bookId: id, fileId }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["status", id] });
      queryClient.invalidateQueries({ queryKey: ["books"] });
    },
  });
  const statusQuery = useQuery({
    queryKey: ["status", id],
    queryFn: () => api.status(id),
    refetchInterval: (query) =>
      query.state.data?.some(isPending) ? 4000 : false,
  });

  const files = (statusQuery.data ?? [])
    .slice()
    .sort(
      (a, b) =>
        (a.page_number ?? Number.MAX_SAFE_INTEGER) -
        (b.page_number ?? Number.MAX_SAFE_INTEGER),
    );
  const maxPage = files.reduce((m, f) => Math.max(m, f.page_number ?? 0), 0);
  const nextPage = maxPage > 0 ? maxPage + 1 : 1;

  const openScan = () =>
    router.push(
      `/scan?bookId=${id}&title=${encodeURIComponent(bookQuery.data?.title ?? "")}&startPage=${nextPage}`,
    );

  return (
    <View className="flex-1 bg-bg" style={{ paddingTop: insets.top }}>
      <View className="flex-row items-center gap-3 px-5 py-3">
        <Pressable
          onPress={() => router.back()}
          className="h-10 w-10 items-center justify-center rounded-full border border-border bg-surface"
        >
          <Feather name="chevron-left" size={18} color={colors.textSecondary} />
        </Pressable>
        <View className="flex-1">
          <Text
            className="text-xl text-ink"
            numberOfLines={1}
            style={{ writingDirection: "rtl" }}
          >
            {bookQuery.data?.title ?? "…"}
          </Text>
          <Text className="text-xs text-text-muted">{files.length} pages</Text>
        </View>
      </View>

      {statusQuery.isLoading ? (
        <Loading />
      ) : (
        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: 20,
            paddingBottom: insets.bottom + 96,
          }}
          refreshControl={
            <RefreshControl
              refreshing={statusQuery.isRefetching}
              onRefresh={() => statusQuery.refetch()}
              tintColor={colors.accent}
            />
          }
        >
          {files.length === 0 ? (
            <Text className="mt-12 text-center text-sm text-text-secondary">
              No pages yet. Tap “Scan pages” to add some.
            </Text>
          ) : (
            files.map((f, i) => {
              const readable = READABLE.includes(f.state);
              return (
                <Pressable
                  key={f.file_id}
                  disabled={!readable}
                  onPress={() => router.push(`/reader/${id}/${f.file_id}`)}
                  className="flex-row items-center gap-3 py-3"
                  style={
                    i > 0
                      ? { borderTopWidth: 1, borderTopColor: colors.hairline }
                      : undefined
                  }
                >
                  <View className="h-9 w-9 items-center justify-center rounded-full bg-surface-alt">
                    <Text className="text-sm font-semibold text-ink">
                      {pageLabel(f, i)}
                    </Text>
                  </View>
                  <View className="flex-1 gap-0.5">
                    {f.preview ? (
                      <Text
                        className="text-sm text-ink"
                        numberOfLines={1}
                        style={{ writingDirection: "rtl" }}
                      >
                        {f.preview}
                      </Text>
                    ) : (
                      <Text className="text-sm text-text-muted">
                        Page {pageLabel(f, i)}
                      </Text>
                    )}
                    {f.error ? (
                      <Text className="text-xs text-st-fail" numberOfLines={1}>
                        {f.error}
                      </Text>
                    ) : null}
                  </View>
                  {f.state === "failed" ? (
                    <Pressable
                      onPress={() => retry.mutate(f.file_id)}
                      disabled={retry.isPending}
                      className="flex-row items-center gap-1.5 rounded-full px-2.5 py-1"
                      style={{ backgroundColor: "#2E1813" }}
                    >
                      {retry.isPending && retry.variables === f.file_id ? (
                        <ActivityIndicator size="small" color="#EE6A4D" />
                      ) : (
                        <Feather name="rotate-cw" size={13} color="#EE6A4D" />
                      )}
                      <Text className="text-xs font-semibold text-st-fail">
                        Retry
                      </Text>
                    </Pressable>
                  ) : (
                    <>
                      <StatusBadge state={f.state} />
                      {readable && (
                        <Feather
                          name="chevron-right"
                          size={16}
                          color={colors.textMuted}
                        />
                      )}
                    </>
                  )}
                </Pressable>
              );
            })
          )}
        </ScrollView>
      )}

      <View
        className="absolute bottom-0 left-0 right-0 border-t border-hairline bg-surface px-5 pt-3"
        style={{ paddingBottom: insets.bottom + 12 }}
      >
        <Pressable
          onPress={openScan}
          className="flex-row items-center justify-center gap-2 rounded-xl bg-accent py-4"
        >
          <Feather name="camera" size={18} color={colors.accentInk} />
          <Text className="text-base font-bold text-accent-ink">
            Scan pages
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
