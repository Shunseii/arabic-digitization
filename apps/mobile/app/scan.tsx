import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import DocumentScanner, {
  ResponseType,
  ScanDocumentResponseStatus,
} from "react-native-document-scanner-plugin";
import Animated, { Keyframe, LinearTransition } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PageViewer } from "@/components/page-viewer";
import {
  ActionBar,
  Button,
  IconButton,
  type IconName,
  PagePlaceholder,
  ProgressBar,
  T,
} from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { DURATION, EASE_OUT } from "@/lib/motion";
import { rotateImage, uprightPage } from "@/lib/orientation";
import { useColors } from "@/theme";

// Removing a page reflows the ones after it (and renumbers them), so let the
// tiles slide to their new spots instead of snapping.
const TILE_LAYOUT = LinearTransition.duration(DURATION.layout).easing(EASE_OUT);
const TILE_ENTER = new Keyframe({
  0: { opacity: 0, transform: [{ scale: 0.95 }] },
  100: { opacity: 1, transform: [{ scale: 1 }], easing: EASE_OUT },
}).duration(DURATION.layout);
const TILE_EXIT = new Keyframe({
  0: { opacity: 1, transform: [{ scale: 1 }] },
  100: { opacity: 0, transform: [{ scale: 0.95 }], easing: EASE_OUT },
}).duration(DURATION.fast);

interface Captured {
  id: string;
  uri: string;
  page: string; // editable; blank = upload without a page number
  /** Orientation check still running; upload waits for it. */
  checking: boolean;
  /** Turned upright automatically (clockwise degrees), for the badge. */
  autoRotated: number;
}

let nextCaptureId = 0;

const SCREEN_PADDING = 24;
const GRID_GAP = 20;

const TIPS: { icon: IconName; text: string }[] = [
  { icon: "maximize", text: "Edges are detected and each page is flattened." },
  { icon: "layers", text: "Capture one or many pages in a row." },
  { icon: "hash", text: "Set each page's number before you upload." },
];

/** Continue from the last typed number, else from the book's next page. */
const nextPageNumber = ({
  pages,
  startPage,
}: {
  pages: Captured[];
  startPage: number;
}) => {
  const last = pages[pages.length - 1];
  const lastNum = last?.page ? Number.parseInt(last.page, 10) : null;
  return lastNum !== null ? lastNum + 1 : startPage + pages.length;
};

export default function ScanScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const c = useColors();
  const { width } = useWindowDimensions();
  const params = useLocalSearchParams<{
    bookId: string;
    title?: string;
    startPage?: string;
  }>();
  const bookId = params.bookId;
  const startPage = params.startPage
    ? Number.parseInt(params.startPage, 10)
    : 1;

  const [pages, setPages] = useState<Captured[]>([]);
  const [busy, setBusy] = useState(false);
  const [uploadIndex, setUploadIndex] = useState<number | null>(null);
  const [failedIndexes, setFailedIndexes] = useState<number[]>([]);
  const [viewingId, setViewingId] = useState<string | null>(null);

  const runScan = async () => {
    try {
      // Native edge detection + perspective flatten (iOS VisionKit / Android ML Kit).
      const { scannedImages, status } = await DocumentScanner.scanDocument({
        responseType: ResponseType.ImageFilePath,
      });
      if (
        status === ScanDocumentResponseStatus.Cancel ||
        !scannedImages?.length
      )
        return;
      const captured: Captured[] = scannedImages.map((uri) => ({
        id: String(nextCaptureId++),
        uri,
        page: "",
        checking: true,
        autoRotated: 0,
      }));
      setPages((prev) => {
        const base = nextPageNumber({ pages: prev, startPage });
        return [
          ...prev,
          ...captured.map((p, i) => ({ ...p, page: String(base + i) })),
        ];
      });
      // ML Kit often picks the wrong "up"; turn each page upright in turn.
      for (const p of captured) {
        const { uri, rotated } = await uprightPage(p.uri);
        updatePage({
          id: p.id,
          patch: { uri, autoRotated: rotated, checking: false },
        });
      }
    } catch (err) {
      Alert.alert("Scan failed", String(err));
    }
  };

  const updatePage = ({
    id,
    patch,
  }: {
    id: string;
    patch: Partial<Captured>;
  }) =>
    setPages((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  const rotatePage = async (p: Captured) => {
    updatePage({ id: p.id, patch: { checking: true } });
    try {
      const uri = await rotateImage({ uri: p.uri, degrees: 90 });
      updatePage({ id: p.id, patch: { uri, checking: false, autoRotated: 0 } });
    } catch (err) {
      updatePage({ id: p.id, patch: { checking: false } });
      Alert.alert("Could not rotate", String(err));
    }
  };

  const checking = pages.some((p) => p.checking);
  const viewing = pages.find((p) => p.id === viewingId);

  const setPageAt = ({ index, value }: { index: number; value: string }) =>
    setPages((prev) =>
      prev.map((p, i) =>
        i === index ? { ...p, page: value.replace(/[^0-9]/g, "") } : p,
      ),
    );

  const removeAt = (index: number) =>
    setPages((prev) => prev.filter((_, i) => i !== index));

  const upload = async () => {
    setBusy(true);
    setFailedIndexes([]);
    let failed = 0;
    try {
      for (let i = 0; i < pages.length; i++) {
        const p = pages[i] as Captured;
        setUploadIndex(i);
        const page = p.page ? Number.parseInt(p.page, 10) : undefined;
        try {
          await api.uploadPage({
            bookId,
            uri: p.uri,
            page,
            mime: "image/jpeg",
          });
        } catch (err) {
          failed += 1;
          setFailedIndexes((prev) => [...prev, i]);
          if (err instanceof ApiError && err.status === 401) {
            Alert.alert("Unauthorized", "Check your API key in Settings.");
            break;
          }
        }
      }
      await queryClient.invalidateQueries({ queryKey: ["books"] });
      await queryClient.invalidateQueries({ queryKey: ["status", bookId] });
      await queryClient.invalidateQueries({ queryKey: ["recent"] });
      if (failed > 0)
        Alert.alert(
          "Some uploads failed",
          `${failed} of ${pages.length} did not upload.`,
        );
      router.back();
    } finally {
      setBusy(false);
      setUploadIndex(null);
    }
  };

  const tileWidth = (width - SCREEN_PADDING * 2 - GRID_GAP) / 2;
  const uploading = busy && uploadIndex !== null;

  const tileBadge = (index: number) => {
    if (!busy) {
      return (
        <Pressable
          onPress={() => removeAt(index)}
          hitSlop={8}
          className="h-7 w-7 items-center justify-center rounded-full bg-ink-3 active:opacity-70"
        >
          <Feather name="x" size={14} color={c.surface} />
        </Pressable>
      );
    }
    if (failedIndexes.includes(index)) {
      return (
        <View className="h-7 w-7 items-center justify-center rounded-full bg-danger">
          <Feather name="alert-circle" size={14} color={c.onAccent} />
        </View>
      );
    }
    if (uploadIndex !== null && index < uploadIndex) {
      return (
        <View className="h-7 w-7 items-center justify-center rounded-full bg-ok">
          <Feather name="check" size={14} color={c.onAccent} />
        </View>
      );
    }
    if (index === uploadIndex) {
      return (
        <View className="h-7 w-7 items-center justify-center rounded-full border border-line bg-surface">
          <ActivityIndicator size="small" color={c.accent} />
        </View>
      );
    }
    return null;
  };

  return (
    <View className="flex-1 bg-bg" style={{ paddingTop: insets.top }}>
      <View className="flex-row items-center gap-3 px-5 pb-2.5 pt-1.5">
        <IconButton icon="x" onPress={() => router.back()} />
        <View className="flex-1 items-center">
          <T variant="bodyStrong" numberOfLines={1}>
            Scan pages
          </T>
          {params.title ? (
            <T
              variant="caption"
              className="font-ar text-ink-3"
              style={{ writingDirection: "rtl" }}
              numberOfLines={1}
            >
              {params.title}
            </T>
          ) : null}
        </View>
        <View className="w-10" />
      </View>

      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingHorizontal: SCREEN_PADDING,
          paddingTop: 12,
          paddingBottom: 24,
        }}
      >
        {pages.length === 0 ? (
          <View className="gap-6">
            <View className="items-center justify-center rounded-3xl bg-surface-2 py-6">
              <View className="rounded-2xl border-2 border-accent p-3">
                <PagePlaceholder width={170} height={226} lines={12} />
              </View>
            </View>
            <View className="gap-3">
              {TIPS.map((tip) => (
                <View key={tip.icon} className="flex-row items-center gap-3">
                  <Feather name={tip.icon} size={16} color={c.accent} />
                  <T variant="small" className="flex-1 text-ink-2">
                    {tip.text}
                  </T>
                </View>
              ))}
            </View>
          </View>
        ) : (
          <View className="gap-4">
            {uploading ? (
              <View className="gap-3">
                <T variant="title">
                  Uploading {(uploadIndex ?? 0) + 1} of {pages.length}
                </T>
                <ProgressBar value={(uploadIndex ?? 0) / pages.length} />
              </View>
            ) : (
              <View className="flex-row items-baseline justify-between">
                <T variant="title">
                  {pages.length} {pages.length === 1 ? "page" : "pages"}
                </T>
                <T variant="caption" className="font-body text-ink-3">
                  Next number: {nextPageNumber({ pages, startPage })}
                </T>
              </View>
            )}

            <View
              className="flex-row flex-wrap"
              style={{ columnGap: GRID_GAP, rowGap: GRID_GAP }}
            >
              {pages.map((p, i) => (
                <Animated.View
                  key={p.id}
                  layout={TILE_LAYOUT}
                  entering={TILE_ENTER}
                  exiting={TILE_EXIT}
                  style={{ width: tileWidth, gap: 8 }}
                >
                  <View>
                    <Pressable
                      onPress={() => setViewingId(p.id)}
                      accessibilityRole="imagebutton"
                      accessibilityLabel="View page full screen"
                      className="active:opacity-80"
                    >
                      <Image
                        source={{ uri: p.uri }}
                        className="rounded-xl bg-surface-2"
                        style={{ width: tileWidth, aspectRatio: 3 / 4 }}
                        resizeMode="cover"
                      />
                    </Pressable>
                    <View className="absolute right-2 top-2">
                      {tileBadge(i)}
                    </View>
                    <View className="absolute bottom-2 left-2">
                      {p.checking ? (
                        <View className="h-9 flex-row items-center gap-1.5 rounded-full bg-surface px-3">
                          <ActivityIndicator size="small" color={c.accent} />
                          <T variant="caption" className="font-body text-ink-2">
                            Checking
                          </T>
                        </View>
                      ) : (
                        <View className="flex-row items-center gap-1.5">
                          {busy ? null : (
                            <Pressable
                              onPress={() => rotatePage(p)}
                              hitSlop={6}
                              accessibilityRole="button"
                              accessibilityLabel="Rotate page 90 degrees"
                              className="size-9 items-center justify-center rounded-full bg-surface active:opacity-70"
                            >
                              <Feather
                                name="rotate-cw"
                                size={16}
                                color={c.ink}
                              />
                            </Pressable>
                          )}
                          {p.autoRotated ? (
                            <View className="h-7 justify-center rounded-full bg-surface px-2.5">
                              <T
                                variant="caption"
                                className="font-body text-accent"
                              >
                                Turned upright
                              </T>
                            </View>
                          ) : null}
                        </View>
                      )}
                    </View>
                  </View>
                  <View className="flex-row items-center gap-2">
                    <T variant="small" className="text-ink-3">
                      Page
                    </T>
                    <TextInput
                      value={p.page}
                      onChangeText={(value) => setPageAt({ index: i, value })}
                      editable={!busy}
                      keyboardType="number-pad"
                      placeholder="—"
                      placeholderTextColor={c.ink3}
                      style={{ textAlignVertical: "center" }}
                      className="h-10 flex-1 rounded-lg border border-line bg-surface px-3 py-0 font-body-semibold text-base text-ink"
                    />
                  </View>
                </Animated.View>
              ))}
            </View>
          </View>
        )}
      </ScrollView>

      <ActionBar>
        {pages.length === 0 ? (
          <Button label="Open scanner" icon="camera" onPress={runScan} />
        ) : busy ? (
          <Button label="Uploading…" loading />
        ) : (
          <View className="flex-row gap-3">
            <Button
              label="Scan more"
              icon="camera"
              variant="secondary"
              onPress={runScan}
              className="flex-1"
            />
            <Button
              label={checking ? "Checking…" : `Upload ${pages.length}`}
              icon={checking ? undefined : "arrow-up"}
              onPress={upload}
              disabled={checking}
              className="flex-1"
            />
          </View>
        )}
      </ActionBar>

      <PageViewer
        uri={viewing?.uri ?? null}
        title={viewing?.page ? `Page ${viewing.page}` : undefined}
        onClose={() => setViewingId(null)}
      />
    </View>
  );
}
