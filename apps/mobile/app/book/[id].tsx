import type { FileState, FileStatus } from "@qiraa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Button,
  Card,
  Dialog,
  Dot,
  FieldLabel,
  Header,
  IconButton,
  ListCard,
  ListRow,
  Loading,
  Sheet,
  StatusLine,
  T,
  TextField,
} from "@/components/ui";
import { api } from "@/lib/api";
import { type Palette, useColors } from "@/theme";

const READABLE: FileState[] = ["done", "approved", "needs_review"];
const isPending = (f: FileStatus): boolean =>
  f.state === "queued" ||
  f.state === "processing" ||
  f.state === "rate_limited";
const pageLabel = (f: FileStatus, index: number): string =>
  f.page_number != null ? String(f.page_number) : `#${index + 1}`;

const PENDING_SENTENCE: Partial<Record<FileState, string>> = {
  processing: "Transcribing now…",
  rate_limited: "Rate limited, retrying shortly",
  queued: "Waiting in queue",
  captured: "Waiting in queue",
};

type ProgressGroup = "done" | "review" | "failed" | "queue";

const GROUP_OF: Record<FileState, ProgressGroup> = {
  done: "done",
  approved: "done",
  needs_review: "review",
  failed: "failed",
  queued: "queue",
  processing: "queue",
  rate_limited: "queue",
  captured: "queue",
};

const GROUPS: { key: ProgressGroup; label: string; color: keyof Palette }[] = [
  { key: "done", label: "done", color: "ok" },
  { key: "review", label: "review", color: "warn" },
  { key: "failed", label: "failed", color: "danger" },
  { key: "queue", label: "in queue", color: "accent" },
];

type PageSelection = { file: FileStatus; label: string };

export default function BookScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const c = useColors();
  const { id } = useLocalSearchParams<{ id: string }>();
  const queryClient = useQueryClient();

  const [menuPage, setMenuPage] = useState<PageSelection | null>(null);
  const [errorPage, setErrorPage] = useState<PageSelection | null>(null);
  const [editing, setEditing] = useState<FileStatus | null>(null);
  const [pageInput, setPageInput] = useState("");
  const [editBook, setEditBook] = useState(false);
  const [bookTitle, setBookTitle] = useState("");
  const [bookInstructions, setBookInstructions] = useState("");

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
  const saveBook = useMutation({
    mutationFn: () =>
      api.updateBook({
        id,
        body: {
          title: bookTitle.trim(),
          ocr_instructions: bookInstructions.trim() || null,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["book", id] });
      queryClient.invalidateQueries({ queryKey: ["books"] });
      setEditBook(false);
    },
    onError: (err) => Alert.alert("Could not save book", String(err)),
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
  const pendingCount = files.filter(isPending).length;
  const groupCounts = files.reduce<Record<ProgressGroup, number>>(
    (counts, f) => {
      counts[GROUP_OF[f.state]] += 1;
      return counts;
    },
    { done: 0, review: 0, failed: 0, queue: 0 },
  );
  const visibleGroups = GROUPS.filter((g) => groupCounts[g.key] > 0);

  const book = bookQuery.data;
  const costUsd = book?.usage?.cost_usd;
  const summary =
    files.length === 0
      ? "No pages yet"
      : `${files.length} pages${costUsd != null ? ` · $${costUsd.toFixed(2)} OCR` : ""}`;

  const openScan = () =>
    router.push(
      `/scan?bookId=${id}&title=${encodeURIComponent(book?.title ?? "")}&startPage=${nextPage}`,
    );

  const openBookEdit = () => {
    setBookTitle(book?.title ?? "");
    setBookInstructions(book?.ocr_instructions ?? "");
    setEditBook(true);
  };
  const startEdit = (f: FileStatus) => {
    setMenuPage(null);
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
  const rerun = (f: FileStatus) => {
    setMenuPage(null);
    setErrorPage(null);
    retry.mutate(f.file_id);
  };
  const confirmDelete = (f: FileStatus) => {
    setMenuPage(null);
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
      <Header
        onLeft={() => router.replace("/")}
        right={<IconButton icon="edit-2" onPress={openBookEdit} />}
      />

      {statusQuery.isLoading ? (
        <Loading />
      ) : (
        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: 24,
            paddingBottom: insets.bottom + 96,
          }}
          refreshControl={
            <RefreshControl
              refreshing={statusQuery.isRefetching}
              onRefresh={() => statusQuery.refetch()}
              tintColor={c.accent}
            />
          }
        >
          <View className="gap-1 pt-2">
            <T
              variant="arTitle"
              style={{ fontSize: 32, lineHeight: 52 }}
              numberOfLines={2}
            >
              {book?.title ?? "…"}
            </T>
            <T variant="small" className="text-ink-3">
              {summary}
            </T>
          </View>

          {files.length === 0 ? (
            <EmptyPages />
          ) : (
            <>
              <View className="mt-6 gap-2.5">
                <View className="h-2 flex-row gap-0.5 overflow-hidden rounded-full">
                  {visibleGroups.map((g) => (
                    <View
                      key={g.key}
                      style={{
                        flex: groupCounts[g.key],
                        backgroundColor: c[g.color],
                      }}
                    />
                  ))}
                </View>
                <View className="flex-row flex-wrap gap-x-3.5 gap-y-1">
                  {visibleGroups.map((g) => (
                    <View key={g.key} className="flex-row items-center gap-1.5">
                      <Dot color={c[g.color]} size={7} />
                      <T variant="small" className="text-ink-2">
                        {groupCounts[g.key]} {g.label}
                      </T>
                    </View>
                  ))}
                </View>
              </View>

              {pendingCount > 0 ? (
                <View className="mt-5 flex-row items-center gap-3 rounded-xl bg-accent-soft px-4 py-3.5">
                  <ActivityIndicator size="small" color={c.accent} />
                  <T variant="bodyStrong" className="flex-1">
                    Transcribing {pendingCount}{" "}
                    {pendingCount === 1 ? "page" : "pages"}
                  </T>
                  <T variant="small" className="text-ink-3">
                    auto-refreshing
                  </T>
                </View>
              ) : null}

              <View className="mt-6 gap-2.5">
                <FieldLabel>Pages</FieldLabel>
                <ListCard>
                  {files.map((f, i) => {
                    const label = pageLabel(f, i);
                    const readable = READABLE.includes(f.state);
                    const removing =
                      del.isPending && del.variables === f.file_id;
                    return (
                      <View
                        key={f.file_id}
                        className={`flex-row items-center gap-2 py-3 ${i > 0 ? "border-t border-line" : ""}`}
                        style={removing ? { opacity: 0.4 } : null}
                      >
                        <Pressable
                          disabled={
                            !readable && !(f.state === "failed" && !!f.error)
                          }
                          onPress={() => {
                            if (readable)
                              router.push(`/reader/${id}/${f.file_id}`);
                            else if (f.error) setErrorPage({ file: f, label });
                          }}
                          className="flex-1 flex-row items-center gap-3 active:opacity-70"
                        >
                          <View className="w-11 items-center">
                            <T variant="title" numberOfLines={1}>
                              {label}
                            </T>
                            <T
                              variant="caption"
                              className="font-body text-ink-3"
                            >
                              {f.page_number != null ? "page" : "unset"}
                            </T>
                          </View>
                          <View className="flex-1 gap-1">
                            <PagePreview file={f} label={label} />
                            <StatusLine
                              state={f.state}
                              trailing={
                                f.cost_usd != null
                                  ? `$${f.cost_usd.toFixed(4)}`
                                  : undefined
                              }
                            />
                          </View>
                        </Pressable>
                        <IconButton
                          icon="more-vertical"
                          variant="plain"
                          color={c.ink3}
                          onPress={() => setMenuPage({ file: f, label })}
                        />
                      </View>
                    );
                  })}
                </ListCard>
              </View>
            </>
          )}
        </ScrollView>
      )}

      <View
        className="absolute inset-x-0 bottom-0 px-6"
        style={{ paddingBottom: insets.bottom + 12 }}
        pointerEvents="box-none"
      >
        <View
          style={{
            shadowColor: c.accent,
            shadowOpacity: 0.25,
            shadowRadius: 16,
            shadowOffset: { width: 0, height: 8 },
            elevation: 6,
            borderRadius: 999,
          }}
        >
          <Button label="Scan pages" icon="camera" pill onPress={openScan} />
        </View>
      </View>

      <Sheet
        visible={menuPage != null}
        onClose={() => setMenuPage(null)}
        title={menuPage ? `Page ${menuPage.label}` : ""}
      >
        {menuPage ? (
          <View className="pb-2">
            <ListRow
              icon="hash"
              title="Change page number"
              value={menuPage.file.page_number?.toString() ?? "unset"}
              onPress={() => startEdit(menuPage.file)}
            />
            <ListRow
              icon="rotate-cw"
              title="Re-run OCR"
              subtitle="Uses this book's OCR instructions"
              onPress={() => rerun(menuPage.file)}
            />
            <ListRow
              icon="trash-2"
              title="Delete page"
              subtitle="Removes the scan and its transcription"
              danger
              onPress={() => confirmDelete(menuPage.file)}
            />
          </View>
        ) : null}
      </Sheet>

      <Sheet
        visible={errorPage != null}
        onClose={() => setErrorPage(null)}
        title={errorPage ? `Page ${errorPage.label} failed` : "OCR error"}
      >
        {errorPage ? (
          <View className="gap-3 px-5 pt-1">
            <ScrollView className="max-h-80 rounded-xl bg-danger-soft">
              <T
                variant="small"
                selectable
                className="px-3.5 py-3 text-center text-danger"
                style={{ writingDirection: "ltr" }}
              >
                {errorPage.file.error}
              </T>
            </ScrollView>
            <Button
              label="Re-run OCR"
              icon="rotate-cw"
              onPress={() => rerun(errorPage.file)}
            />
            <Button
              label="Close"
              variant="ghost"
              onPress={() => setErrorPage(null)}
            />
          </View>
        ) : null}
      </Sheet>

      <Dialog
        visible={editing != null}
        onClose={() => setEditing(null)}
        title="Change page number"
        message="Leave it blank to unset. Pages re-sort by number."
      >
        <TextField
          value={pageInput}
          onChangeText={(v) => setPageInput(v.replace(/[^0-9]/g, ""))}
          keyboardType="number-pad"
          autoFocus
          placeholder="—"
          onSubmitEditing={saveEdit}
        />
        <View className="flex-row gap-2.5">
          <Button
            label="Cancel"
            variant="secondary"
            className="flex-1"
            onPress={() => setEditing(null)}
          />
          <Button label="Save" className="flex-1" onPress={saveEdit} />
        </View>
      </Dialog>

      <Sheet
        visible={editBook}
        onClose={() => setEditBook(false)}
        title="Edit book"
      >
        <View className="gap-4 px-5 pt-1">
          <TextField
            label="Title"
            value={bookTitle}
            onChangeText={setBookTitle}
            placeholder="نور الإيضاح"
            rtl
          />
          <TextField
            label="OCR instructions · optional"
            helper="Sent with every page of this book."
            value={bookInstructions}
            onChangeText={setBookInstructions}
            placeholder="Preserve tashkeel. Keep footnotes at the bottom of the page."
            multiline
          />
          <Button
            label={saveBook.isPending ? "Saving…" : "Save"}
            loading={saveBook.isPending}
            disabled={!bookTitle.trim()}
            onPress={() => saveBook.mutate()}
          />
        </View>
      </Sheet>
    </View>
  );
}

const PagePreview = ({ file, label }: { file: FileStatus; label: string }) => {
  if (file.error)
    return (
      <T variant="small" className="text-danger" numberOfLines={1}>
        {file.error}
      </T>
    );
  if (file.preview)
    return (
      <T variant="arSmall" numberOfLines={1}>
        {file.preview}
      </T>
    );
  return (
    <T variant="small" className="text-ink-3" numberOfLines={1}>
      {PENDING_SENTENCE[file.state] ?? `Page ${label}`}
    </T>
  );
};

const EmptyPages = () => (
  <Card className="mt-6 items-center gap-2 px-6 py-6">
    <View className="mb-3 flex-row gap-2.5">
      {[1, 0.6, 0.35].map((opacity) => (
        <View
          key={opacity}
          className="h-[86px] w-16 rounded-md border border-dashed border-ink-3"
          style={{ opacity }}
        />
      ))}
    </View>
    <T variant="heading" className="text-center">
      Scan your first pages
    </T>
    <T variant="small" className="text-center text-ink-2">
      Capture one or many pages, set their numbers, then upload. Transcription
      starts automatically.
    </T>
  </Card>
);
