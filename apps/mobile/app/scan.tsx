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
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
import { useColors } from "@/theme";

interface Captured {
  uri: string;
  page: string; // editable; blank = upload without a page number
}

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
      setPages((prev) => {
        const base = nextPageNumber({ pages: prev, startPage });
        return [
          ...prev,
          ...scannedImages.map((uri, i) => ({ uri, page: String(base + i) })),
        ];
      });
    } catch (err) {
      Alert.alert("Scan failed", String(err));
    }
  };

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
                <View
                  key={p.uri}
                  className="gap-2"
                  style={{ width: tileWidth }}
                >
                  <View>
                    <Image
                      source={{ uri: p.uri }}
                      className="rounded-xl bg-surface-2"
                      style={{ width: tileWidth, aspectRatio: 3 / 4 }}
                      resizeMode="cover"
                    />
                    <View className="absolute right-2 top-2">
                      {tileBadge(i)}
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
                      className="h-10 flex-1 rounded-lg border border-line bg-surface px-3 font-body-semibold text-base text-ink"
                    />
                  </View>
                </View>
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
              label={`Upload ${pages.length}`}
              icon="arrow-up"
              onPress={upload}
              className="flex-1"
            />
          </View>
        )}
      </ActionBar>
    </View>
  );
}
