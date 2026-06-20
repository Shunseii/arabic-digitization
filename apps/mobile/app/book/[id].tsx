import { Feather } from "@expo/vector-icons";
import type { FileStatus } from "@qiraa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import {
  Alert,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
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

  const [menuFile, setMenuFile] = useState<FileStatus | null>(null);
  const [editing, setEditing] = useState<FileStatus | null>(null);
  const [pageInput, setPageInput] = useState("");

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["status", id] });
    queryClient.invalidateQueries({ queryKey: ["books"] });
    queryClient.invalidateQueries({ queryKey: ["recent"] });
  };

  const bookQuery = useQuery({
    queryKey: ["book", id],
    queryFn: () => api.getBook(id),
  });
  const statusQuery = useQuery({
    queryKey: ["status", id],
    queryFn: () => api.status(id),
    refetchInterval: (query) =>
      query.state.data?.some(isPending) ? 4000 : false,
  });

  const retry = useMutation({
    mutationFn: (fileId: string) => api.rerunOcr({ bookId: id, fileId }),
    onSettled: invalidate,
  });
  const del = useMutation({
    mutationFn: (fileId: string) => api.deleteFile({ bookId: id, fileId }),
    onSettled: invalidate,
  });
  const patch = useMutation({
    mutationFn: ({ fileId, page }: { fileId: string; page: number | null }) =>
      api.updatePageNumber({ bookId: id, fileId, page }),
    onSettled: invalidate,
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

  const startEdit = (f: FileStatus) => {
    setMenuFile(null);
    setPageInput(f.page_number != null ? String(f.page_number) : "");
    setEditing(f);
  };
  const saveEdit = () => {
    if (!editing) return;
    const v = pageInput.trim();
    patch.mutate({
      fileId: editing.file_id,
      page: v ? Number.parseInt(v, 10) : null,
    });
    setEditing(null);
  };
  const confirmDelete = (f: FileStatus) => {
    setMenuFile(null);
    Alert.alert(
      "Delete page?",
      "Removes the scan and its transcription. Cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => del.mutate(f.file_id),
        },
      ],
    );
  };

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
              const removing = del.isPending && del.variables === f.file_id;
              return (
                <View
                  key={f.file_id}
                  className="flex-row items-center gap-2 py-3"
                  style={[
                    i > 0
                      ? { borderTopWidth: 1, borderTopColor: colors.hairline }
                      : null,
                    removing ? { opacity: 0.4 } : null,
                  ]}
                >
                  <Pressable
                    disabled={!readable}
                    onPress={() => router.push(`/reader/${id}/${f.file_id}`)}
                    className="flex-1 flex-row items-center gap-3"
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
                        <Text
                          className="text-xs text-st-fail"
                          numberOfLines={1}
                        >
                          {f.error}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                  <StatusBadge state={f.state} />
                  <Pressable
                    onPress={() => setMenuFile(f)}
                    hitSlop={8}
                    className="h-8 w-8 items-center justify-center rounded-full"
                  >
                    <Feather
                      name="more-vertical"
                      size={18}
                      color={colors.textMuted}
                    />
                  </Pressable>
                </View>
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

      {/* Row action sheet — closes on Android back (onRequestClose) and tap-out. */}
      <Modal
        visible={menuFile != null}
        transparent
        animationType="slide"
        onRequestClose={() => setMenuFile(null)}
      >
        <Pressable
          onPress={() => setMenuFile(null)}
          className="flex-1 justify-end"
          style={{ backgroundColor: "#00000099" }}
        >
          <Pressable
            onPress={() => {}}
            className="rounded-t-3xl border-t border-border bg-surface px-5 pt-3"
            style={{ paddingBottom: insets.bottom + 12 }}
          >
            <View className="mb-2 items-center">
              <View className="h-1 w-10 rounded-full bg-border" />
            </View>
            <Text className="mb-1 px-1 py-2 text-xs font-bold tracking-wide text-text-muted">
              {menuFile ? `PAGE ${menuFile.page_number ?? "—"}` : ""}
            </Text>
            {menuFile && (
              <>
                <SheetItem
                  icon="hash"
                  label="Change page number"
                  onPress={() => startEdit(menuFile)}
                />
                <SheetItem
                  icon="rotate-cw"
                  label="Re-run OCR"
                  onPress={() => {
                    const f = menuFile;
                    setMenuFile(null);
                    retry.mutate(f.file_id);
                  }}
                />
                <SheetItem
                  icon="trash-2"
                  label="Delete page"
                  destructive
                  onPress={() => confirmDelete(menuFile)}
                />
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Page-number editor. */}
      <Modal
        visible={editing != null}
        transparent
        animationType="fade"
        onRequestClose={() => setEditing(null)}
      >
        <Pressable
          onPress={() => setEditing(null)}
          className="flex-1 items-center justify-center px-8"
          style={{ backgroundColor: "#00000099" }}
        >
          <Pressable
            onPress={() => {}}
            className="w-full gap-4 rounded-2xl border border-border bg-surface p-5"
          >
            <Text className="text-lg font-semibold text-ink">Page number</Text>
            <TextInput
              value={pageInput}
              onChangeText={(v) => setPageInput(v.replace(/[^0-9]/g, ""))}
              keyboardType="number-pad"
              autoFocus
              placeholder="—"
              placeholderTextColor={colors.textMuted}
              className="rounded-lg border border-border bg-bg px-3 py-2.5 text-base text-ink"
            />
            <View className="flex-row items-center justify-end gap-4">
              <Pressable onPress={() => setEditing(null)}>
                <Text className="text-sm font-semibold text-text-secondary">
                  Cancel
                </Text>
              </Pressable>
              <Pressable
                onPress={saveEdit}
                className="rounded-lg bg-accent px-4 py-2"
              >
                <Text className="text-sm font-bold text-accent-ink">Save</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const SheetItem = ({
  icon,
  label,
  destructive,
  onPress,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  destructive?: boolean;
  onPress: () => void;
}) => (
  <Pressable onPress={onPress} className="flex-row items-center gap-3 py-3.5">
    <Feather
      name={icon}
      size={18}
      color={destructive ? "#EE6A4D" : colors.textSecondary}
    />
    <Text
      className="text-base"
      style={{ color: destructive ? "#EE6A4D" : colors.ink }}
    >
      {label}
    </Text>
  </Pressable>
);
