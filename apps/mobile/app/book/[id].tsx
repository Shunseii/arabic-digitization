import { Feather } from "@expo/vector-icons";
import {
  type BookUpdateBody,
  type BookWithStatus,
  DEFAULT_REVIEW_COST_PER_PAGE_USD,
  type FileState,
  type FileStatus,
} from "@qiraa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Button,
  Card,
  Chip,
  Dialog,
  Dot,
  FieldLabel,
  Header,
  IconButton,
  ListRow,
  Loading,
  Segmented,
  Sheet,
  StatusLine,
  T,
  TextField,
} from "@/components/ui";
import {
  TagEditor,
  type WorkChoice,
  WorkPicker,
} from "@/components/work-fields";
import { api } from "@/lib/api";
import { useGoBack } from "@/lib/navigation";
import { pageReviewBlockedReason, usePageReview } from "@/lib/page-review";
import { loadStatus } from "@/lib/status";
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

// A page's total cost (its OCR plus its reviews), or nothing if unknown.
const pageCostLabel = (f: FileStatus): string | undefined => {
  const ocr = f.ocr_cost_usd ?? f.cost_usd;
  if (ocr == null && f.review_cost_usd == null) return undefined;
  return `$${((ocr ?? 0) + (f.review_cost_usd ?? 0)).toFixed(4)}`;
};

const capitalize = (s: string): string =>
  s.charAt(0).toUpperCase() + s.slice(1);
// Where a jumped-to row lands: a little below the top of the list.
const JUMP_VIEW_POSITION = 0.2;

export default function BookScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const c = useColors();
  const { id } = useLocalSearchParams<{ id: string }>();
  const queryClient = useQueryClient();
  const goBack = useGoBack("/");

  const [menuPage, setMenuPage] = useState<PageSelection | null>(null);
  const [errorPage, setErrorPage] = useState<PageSelection | null>(null);
  const [editing, setEditing] = useState<FileStatus | null>(null);
  const [filter, setFilter] = useState<ReadonlySet<ProgressGroup>>(new Set());
  const [jumpOpen, setJumpOpen] = useState(false);
  const [jumpInput, setJumpInput] = useState("");
  const [jumpTarget, setJumpTarget] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const listRef = useRef<FlatList<FileStatus>>(null);
  const [pageInput, setPageInput] = useState("");
  const [editBook, setEditBook] = useState(false);
  const [bookTitle, setBookTitle] = useState("");
  const [bookInstructions, setBookInstructions] = useState("");
  const [bookWork, setBookWork] = useState<WorkChoice>({ kind: "none" });
  const [bookTags, setBookTags] = useState<string[]>([]);

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
    queryFn: () => loadStatus(id),
  });
  const refreshing = statusQuery.isRefetching || bookQuery.isRefetching;
  const refresh = () => {
    statusQuery.refetch();
    bookQuery.refetch();
  };

  const invalidateBook = () => {
    invalidate();
    queryClient.invalidateQueries({ queryKey: ["book", id] });
  };
  const pause = useMutation({
    mutationFn: () => api.pauseBook(id),
    onSettled: invalidateBook,
  });
  const resume = useMutation({
    mutationFn: () => api.resumeBook(id),
    onSettled: invalidateBook,
  });

  // What reviewing `pages` pages would cost: the average so far, or a
  // default before any review has run. Always an estimate.
  const estimateReview = async (pages: number): Promise<string> => {
    const perPage = await api
      .reviewSummary()
      .then((s) => s.cost_per_page_usd ?? DEFAULT_REVIEW_COST_PER_PAGE_USD)
      .catch(() => DEFAULT_REVIEW_COST_PER_PAGE_USD);
    return `$${(pages * perPage).toFixed(2)}`;
  };

  const queueExisting = useMutation({
    mutationFn: () => api.queueReview({ bookId: id }),
    onSuccess: ({ queued }) =>
      Alert.alert(
        "Queued for review",
        `${queued} ${queued === 1 ? "page" : "pages"} will be reviewed in the next batch.`,
      ),
    onError: (err) => Alert.alert("Could not queue pages", String(err)),
  });

  const pageReview = usePageReview(id);

  const offerExistingPages = async (pages: number) => {
    const estimate = await estimateReview(pages);
    Alert.alert(
      "Review the pages already done?",
      `${pages} ${pages === 1 ? "page" : "pages"}, about ${estimate} (estimate). Pages that finish OCR from now on are reviewed either way. Hand-edited pages are skipped.`,
      [
        { text: "Only new pages", style: "cancel" },
        {
          text: `Review ${pages}`,
          onPress: () => queueExisting.mutate(),
        },
      ],
    );
  };

  // Optimistic: the switch moves at once and moves back if the save fails.
  const setReview = useMutation({
    mutationFn: (on: boolean) =>
      api.updateBook({ id, body: { review_enabled: on } }),
    onMutate: async (on) => {
      await queryClient.cancelQueries({ queryKey: ["book", id] });
      const before = queryClient.getQueryData<BookWithStatus>(["book", id]);
      if (before) {
        queryClient.setQueryData(["book", id], {
          ...before,
          review_enabled: on,
        });
      }
      return { before };
    },
    onError: (err, _on, context) => {
      if (context?.before)
        queryClient.setQueryData(["book", id], context.before);
      Alert.alert("Could not change review", String(err));
    },
    onSuccess: (_book, on) => {
      const done = bookQuery.data?.counts.done ?? 0;
      if (on && done > 0) offerExistingPages(done);
    },
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
  const worksQuery = useQuery({ queryKey: ["works"], queryFn: api.listWorks });
  const works = worksQuery.data ?? [];
  const tagsOf = (choice: WorkChoice): string[] =>
    choice.kind === "existing"
      ? (works.find((w) => w.id === choice.id)?.tags ?? [])
      : [];
  const chooseWork = (choice: WorkChoice) => {
    setBookWork(choice);
    setBookTags(tagsOf(choice));
  };

  const resolveWorkId = async (): Promise<string | null> => {
    const title = bookTitle.trim();
    if (bookWork.kind === "none") return null;
    if (bookWork.kind === "new")
      return (await api.createWork({ name: title, tags: bookTags })).id;
    const before = tagsOf(bookWork);
    const tagsChanged =
      before.length !== bookTags.length ||
      before.some((t) => !bookTags.includes(t));
    if (tagsChanged)
      await api.updateWork({ id: bookWork.id, body: { tags: bookTags } });
    return bookWork.id;
  };

  const saveBook = useMutation({
    mutationFn: async () => {
      const title = bookTitle.trim();
      const instructions = bookInstructions.trim() || null;
      const workId = await resolveWorkId();
      const body: BookUpdateBody = {
        ...(title !== book?.title && { title }),
        ...(instructions !== (book?.ocr_instructions ?? null) && {
          ocr_instructions: instructions,
        }),
        ...(workId !== (book?.work_id ?? null) && { work_id: workId }),
      };
      if (Object.keys(body).length > 0) await api.updateBook({ id, body });
    },
    onSuccess: () => {
      for (const key of ["book", "books", "works", "work"])
        queryClient.invalidateQueries({ queryKey: [key] });
      setEditBook(false);
    },
    onError: (err) => Alert.alert("Could not save book", String(err)),
  });

  // Sorting keeps each file object as react-query returned it; structural
  // sharing keeps unchanged pages' objects identical across polls, so their
  // memoised rows skip re-rendering.
  const files = useMemo(
    () =>
      (statusQuery.data ?? [])
        .slice()
        .sort(
          (a, b) =>
            (a.page_number ?? Number.MAX_SAFE_INTEGER) -
            (b.page_number ?? Number.MAX_SAFE_INTEGER),
        ),
    [statusQuery.data],
  );
  // Filters for groups the book no longer has are ignored, not applied.
  const shownFiles = useMemo(() => {
    const active = GROUPS.map((g) => g.key).filter(
      (g) => filter.has(g) && files.some((f) => GROUP_OF[f.state] === g),
    );
    return active.length === 0
      ? files
      : files.filter((f) => active.includes(GROUP_OF[f.state]));
  }, [files, filter]);
  const filtering = shownFiles !== files;
  // Labels for unnumbered pages use their position in the whole book.
  const indexOf = useMemo(
    () => new Map(files.map((f, i) => [f.file_id, i])),
    [files],
  );
  const toggleGroup = (g: ProgressGroup) =>
    setFilter((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });

  const numbered = files.filter((f) => f.page_number != null);
  const firstPage = numbered[0]?.page_number ?? null;
  const lastPage = numbered[numbered.length - 1]?.page_number ?? null;
  const openJump = () => {
    setJumpInput("");
    setJumpOpen(true);
  };
  // The page itself, or the next one after it when that number is missing.
  const goToPage = () => {
    const n = Number(jumpInput);
    if (!jumpInput || !Number.isFinite(n)) return;
    const target =
      numbered.find((f) => (f.page_number ?? 0) >= n) ??
      numbered[numbered.length - 1];
    setJumpOpen(false);
    if (!target) return;
    if (!shownFiles.includes(target)) setFilter(new Set());
    setJumpTarget(target.file_id);
  };
  // Runs once the (possibly unfiltered) list holds the target.
  useEffect(() => {
    if (!jumpTarget) return;
    const index = shownFiles.findIndex((f) => f.file_id === jumpTarget);
    if (index < 0) return;
    listRef.current?.scrollToIndex({
      index,
      viewPosition: JUMP_VIEW_POSITION,
      animated: true,
    });
    setHighlightId(jumpTarget);
    setJumpTarget(null);
  }, [jumpTarget, shownFiles]);
  useEffect(() => {
    if (!highlightId) return;
    const timer = setTimeout(() => setHighlightId(null), 1600);
    return () => clearTimeout(timer);
  }, [highlightId]);

  const openPage = useCallback(
    (f: FileStatus, label: string) => {
      if (READABLE.includes(f.state)) router.push(`/reader/${id}/${f.file_id}`);
      else if (f.error) setErrorPage({ file: f, label });
      else router.push(`/reader/${id}/${f.file_id}?pane=scan`);
    },
    [id, router],
  );
  const openMenu = useCallback(
    (f: FileStatus, label: string) => setMenuPage({ file: f, label }),
    [],
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
  const book = bookQuery.data;
  const paused = book?.paused === true;
  const visibleGroups = GROUPS.filter((g) => groupCounts[g.key] > 0).map((g) =>
    paused && g.key === "queue"
      ? { ...g, label: "paused", color: "ink3" as const }
      : g,
  );
  // Everything billed for the book (re-runs included), split by kind; an
  // older API without the split reports the OCR of the current text only.
  const ocrCost = book?.usage?.ocr?.cost_usd ?? book?.usage?.cost_usd;
  const reviewCost = book?.usage?.review?.cost_usd ?? 0;
  const summary =
    files.length === 0
      ? "No pages yet"
      : [
          `${files.length} pages`,
          ocrCost != null ? `$${ocrCost.toFixed(2)} OCR` : null,
          reviewCost > 0 ? `$${reviewCost.toFixed(2)} review` : null,
        ]
          .filter((part) => part !== null)
          .join(" · ");

  const openScan = () =>
    router.push(
      `/scan?bookId=${id}&title=${encodeURIComponent(book?.title ?? "")}&startPage=${nextPage}`,
    );

  const openBookEdit = () => {
    setBookTitle(book?.title ?? "");
    setBookInstructions(book?.ocr_instructions ?? "");
    chooseWork(
      book?.work_id ? { kind: "existing", id: book.work_id } : { kind: "none" },
    );
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
        onLeft={goBack}
        right={<IconButton icon="edit-2" onPress={openBookEdit} />}
      />

      {statusQuery.isLoading ? (
        <Loading />
      ) : (
        <FlatList
          ref={listRef}
          data={shownFiles}
          keyExtractor={(f) => f.file_id}
          onScrollToIndexFailed={({ index, averageItemLength }) => {
            // Rows far down aren't measured yet: get close, then retry.
            listRef.current?.scrollToOffset({
              offset: averageItemLength * index,
              animated: false,
            });
            setTimeout(
              () =>
                listRef.current?.scrollToIndex({
                  index,
                  viewPosition: JUMP_VIEW_POSITION,
                  animated: true,
                }),
              100,
            );
          }}
          renderItem={({ item, index }) => (
            <PageRow
              file={item}
              label={pageLabel(item, indexOf.get(item.file_id) ?? index)}
              first={index === 0}
              last={index === shownFiles.length - 1}
              highlighted={item.file_id === highlightId}
              removing={del.isPending && del.variables === item.file_id}
              paused={paused && isPending(item)}
              onOpen={openPage}
              onMenu={openMenu}
            />
          )}
          ListHeaderComponent={
            <>
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
                        <View
                          key={g.key}
                          className="flex-row items-center gap-1.5"
                        >
                          <Dot color={c[g.color]} size={7} />
                          <T variant="small" className="text-ink-2">
                            {groupCounts[g.key]} {g.label}
                          </T>
                        </View>
                      ))}
                    </View>
                  </View>

                  {pendingCount > 0 && paused ? (
                    <View className="mt-5 flex-row items-center gap-3 rounded-xl bg-surface-2 py-3 pr-3 pl-4">
                      <Feather name="pause-circle" size={18} color={c.ink2} />
                      <T variant="bodyStrong" className="flex-1">
                        {pendingCount} {pendingCount === 1 ? "page" : "pages"}{" "}
                        paused
                      </T>
                      <Button
                        label="Resume"
                        icon="play"
                        size="sm"
                        loading={resume.isPending}
                        onPress={() => resume.mutate()}
                      />
                    </View>
                  ) : pendingCount > 0 ? (
                    <View className="mt-5 flex-row items-center gap-3 rounded-xl bg-accent-soft py-3 pr-3 pl-4">
                      <ActivityIndicator size="small" color={c.accent} />
                      <T variant="bodyStrong" className="flex-1">
                        Transcribing {pendingCount}{" "}
                        {pendingCount === 1 ? "page" : "pages"}
                      </T>
                      <Button
                        label="Pause"
                        icon="pause"
                        size="sm"
                        variant="secondary"
                        loading={pause.isPending}
                        onPress={() => pause.mutate()}
                      />
                    </View>
                  ) : null}
                  <View className="mt-6 gap-2.5 pb-2.5">
                    <View className="h-8 flex-row items-center justify-between">
                      <FieldLabel>
                        {filtering
                          ? `Pages · ${shownFiles.length} of ${files.length}`
                          : "Pages"}
                      </FieldLabel>
                      <View className="-mr-3">
                        <Button
                          label="Go to page"
                          icon="hash"
                          variant="ghost"
                          size="sm"
                          onPress={openJump}
                        />
                      </View>
                    </View>
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      className="-mx-6"
                      contentContainerStyle={{ gap: 8, paddingHorizontal: 24 }}
                    >
                      {visibleGroups.map((g) => (
                        <Chip
                          key={g.key}
                          label={`${capitalize(g.label)} ${groupCounts[g.key]}`}
                          selected={filter.has(g.key)}
                          onPress={() => toggleGroup(g.key)}
                        />
                      ))}
                    </ScrollView>
                  </View>
                </>
              )}
            </>
          }
          contentContainerStyle={{
            paddingHorizontal: 24,
            paddingBottom: insets.bottom + 96,
          }}
          initialNumToRender={12}
          windowSize={11}
          removeClippedSubviews
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={refresh}
              tintColor={c.accent}
            />
          }
        />
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
              icon="eye"
              title="Re-run review"
              subtitle={
                pageReviewBlockedReason(menuPage.file) ??
                "Opus proofreads it against the scan again"
              }
              disabled={pageReviewBlockedReason(menuPage.file) !== null}
              onPress={() => {
                setMenuPage(null);
                pageReview.ask(menuPage);
              }}
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
              label="View scan"
              icon="image"
              variant="secondary"
              onPress={() => {
                const fileId = errorPage.file.file_id;
                setErrorPage(null);
                router.push(`/reader/${id}/${fileId}?pane=scan`);
              }}
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
        visible={jumpOpen}
        onClose={() => setJumpOpen(false)}
        title="Go to page"
        message={
          firstPage != null && lastPage != null
            ? `Pages ${firstPage}–${lastPage}`
            : undefined
        }
      >
        <TextField
          value={jumpInput}
          onChangeText={(v) => setJumpInput(v.replace(/[^0-9]/g, ""))}
          keyboardType="number-pad"
          autoFocus
          placeholder="—"
          onSubmitEditing={goToPage}
        />
        <View className="flex-row gap-2.5">
          <Button
            label="Cancel"
            variant="secondary"
            className="flex-1"
            onPress={() => setJumpOpen(false)}
          />
          <Button label="Go" className="flex-1" onPress={goToPage} />
        </View>
      </Dialog>

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
        scrollable
      >
        <View className="gap-5 px-5 pt-1">
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
          <WorkPicker
            works={works}
            value={bookWork}
            onChange={chooseWork}
            allowNone
          />
          {bookWork.kind !== "none" ? (
            <TagEditor
              tags={bookTags}
              onChange={setBookTags}
              label="Tags"
              helper="Tags belong to the work, so every copy shares them."
            />
          ) : null}
        </View>
        <View className="px-5 pt-5">
          <Button
            label={saveBook.isPending ? "Saving…" : "Save"}
            loading={saveBook.isPending}
            disabled={!bookTitle.trim()}
            onPress={() => saveBook.mutate()}
          />
        </View>
        <View className="gap-2 px-5 pt-6">
          <FieldLabel>Opus review</FieldLabel>
          <Segmented
            options={[
              { value: "off", label: "Off" },
              { value: "on", label: "On" },
            ]}
            value={book?.review_enabled ? "on" : "off"}
            onChange={(value) => setReview.mutate(value === "on")}
          />
          <T variant="small" className="text-ink-3">
            {book?.review_enabled
              ? "Pages that finish OCR are proofread against the scan. Applies now; costs money."
              : "Off. Pages already sent for review still finish."}
          </T>
        </View>
      </Sheet>
    </View>
  );
}

/**
 * One page in the list. Rows are slices of a single card (rounded top on the
 * first, rounded bottom on the last) so the list can be virtualised; memo
 * means a poll only re-renders the pages whose status changed.
 */
const PageRow = memo(
  ({
    file,
    label,
    first,
    last,
    removing,
    paused,
    highlighted,
    onOpen,
    onMenu,
  }: {
    file: FileStatus;
    label: string;
    first: boolean;
    last: boolean;
    removing: boolean;
    paused: boolean;
    highlighted: boolean;
    onOpen: (f: FileStatus, label: string) => void;
    onMenu: (f: FileStatus, label: string) => void;
  }) => {
    const c = useColors();
    // A jumped-to row lights up, then fades out.
    const glow = useSharedValue(0);
    useEffect(() => {
      glow.value = highlighted ? 1 : withTiming(0, { duration: 600 });
    }, [highlighted, glow]);
    const glowStyle = useAnimatedStyle(() => ({ opacity: glow.value }));
    return (
      <View
        className={`border-x border-line bg-surface px-4 ${first ? "rounded-t-2xl border-t" : ""} ${last ? "rounded-b-2xl border-b" : ""}`}
        // Rows sit at fractional pixel offsets; overlapping each by 1px hides
        // the hairline gap that would otherwise show between card slices.
        style={first ? undefined : { marginTop: -1 }}
      >
        <Animated.View
          pointerEvents="none"
          className={`absolute inset-0 bg-accent-soft ${first ? "rounded-t-2xl" : ""} ${last ? "rounded-b-2xl" : ""}`}
          style={glowStyle}
        />
        <View
          className={`flex-row items-center gap-2 py-3 ${first ? "" : "border-t border-line"}`}
          style={removing ? { opacity: 0.4 } : null}
        >
          <Pressable
            onPress={() => onOpen(file, label)}
            className="flex-1 flex-row items-center gap-3 active:opacity-70"
          >
            <View className="w-12 items-center">
              <T
                variant="title"
                style={{ fontSize: label.length > 3 ? 15 : 18, lineHeight: 24 }}
                numberOfLines={1}
              >
                {label}
              </T>
              <T variant="caption" className="font-body text-ink-3">
                {file.page_number != null ? "page" : "unset"}
              </T>
            </View>
            <View className="flex-1 gap-1">
              <PagePreview file={file} label={label} paused={paused} />
              <StatusLine
                state={file.state}
                paused={paused}
                trailing={pageCostLabel(file)}
              />
            </View>
          </Pressable>
          <IconButton
            icon="more-vertical"
            variant="plain"
            color={c.ink3}
            onPress={() => onMenu(file, label)}
          />
        </View>
      </View>
    );
  },
);

const PagePreview = ({
  file,
  label,
  paused,
}: {
  file: FileStatus;
  label: string;
  paused: boolean;
}) => {
  if (file.error)
    return (
      <T variant="small" className="text-danger" numberOfLines={1}>
        {file.error}
      </T>
    );
  if (file.preview === "" && READABLE.includes(file.state))
    return (
      <T variant="small" className="italic text-ink-3" numberOfLines={1}>
        Blank page
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
      {paused ? "Paused" : (PENDING_SENTENCE[file.state] ?? `Page ${label}`)}
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
