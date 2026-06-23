import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import {
  Alert,
  Image,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import DocumentScanner, {
  ResponseType,
  ScanDocumentResponseStatus,
} from "react-native-document-scanner-plugin";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ApiError, api } from "@/lib/api";
import { colors } from "@/theme";

interface Captured {
  uri: string;
  page: string; // editable; blank = upload without a page number
}

export default function ScanScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
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
  const [progress, setProgress] = useState<string | null>(null);

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
      // Prefill new pages continuing from the last typed number, else the book's next page.
      setPages((prev) => {
        const last = prev[prev.length - 1];
        const lastNum = last?.page ? Number.parseInt(last.page, 10) : null;
        const base = lastNum !== null ? lastNum + 1 : startPage + prev.length;
        return [
          ...prev,
          ...scannedImages.map((uri, i) => ({ uri, page: String(base + i) })),
        ];
      });
    } catch (err) {
      Alert.alert("Scan failed", String(err));
    }
  };

  const setPageAt = (index: number, value: string) =>
    setPages((prev) =>
      prev.map((p, i) =>
        i === index ? { ...p, page: value.replace(/[^0-9]/g, "") } : p,
      ),
    );

  const removeAt = (index: number) =>
    setPages((prev) => prev.filter((_, i) => i !== index));

  const upload = async () => {
    setBusy(true);
    let failed = 0;
    try {
      for (let i = 0; i < pages.length; i++) {
        const p = pages[i] as Captured;
        setProgress(`Uploading ${i + 1} of ${pages.length}…`);
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
      setProgress(null);
    }
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
          <Text className="text-xl font-semibold text-ink" numberOfLines={1}>
            Scan pages
          </Text>
          {params.title ? (
            <Text
              className="text-xs text-text-muted"
              numberOfLines={1}
              style={{ writingDirection: "rtl" }}
            >
              {params.title}
            </Text>
          ) : null}
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{
          padding: 20,
          paddingBottom: insets.bottom + 24,
        }}
      >
        {pages.length === 0 ? (
          <View className="items-center justify-center gap-4 pt-16">
            <View className="h-24 w-24 items-center justify-center rounded-full bg-accent-soft">
              <Feather name="camera" size={36} color={colors.accent} />
            </View>
            <Text className="text-center text-sm text-text-secondary">
              The camera detects page edges and flattens each scan. Capture one
              or many pages — set the page number for each, then upload.
            </Text>
          </View>
        ) : (
          <View className="gap-3">
            <Text className="text-xs font-bold tracking-wide text-text-muted">
              {pages.length} {pages.length === 1 ? "PAGE" : "PAGES"} — SET
              NUMBERS
            </Text>
            {pages.map((p, i) => (
              <View
                key={p.uri}
                className="flex-row items-center gap-3 rounded-2xl border border-border bg-surface p-3"
              >
                <Image
                  source={{ uri: p.uri }}
                  className="h-16 w-12 rounded-md bg-surface-alt"
                  resizeMode="cover"
                />
                <View className="flex-1">
                  <Text className="mb-1 text-xs text-text-muted">
                    Page number
                  </Text>
                  <TextInput
                    value={p.page}
                    onChangeText={(v) => setPageAt(i, v)}
                    keyboardType="number-pad"
                    placeholder="—"
                    placeholderTextColor={colors.textMuted}
                    className="rounded-lg border border-border bg-bg px-3 py-2 text-base text-ink"
                  />
                </View>
                <Pressable
                  onPress={() => removeAt(i)}
                  className="h-9 w-9 items-center justify-center rounded-full bg-surface-alt"
                >
                  <Feather
                    name="trash-2"
                    size={16}
                    color={colors.textSecondary}
                  />
                </Pressable>
              </View>
            ))}
          </View>
        )}

        {progress && (
          <Text className="mt-4 text-center text-sm font-semibold text-accent">
            {progress}
          </Text>
        )}

        <Pressable
          onPress={runScan}
          disabled={busy}
          className="mt-5 flex-row items-center justify-center gap-2 rounded-xl border border-border py-3.5"
          style={{ opacity: busy ? 0.5 : 1 }}
        >
          <Feather name="camera" size={18} color={colors.accent} />
          <Text className="text-base font-semibold text-accent">
            {pages.length === 0 ? "Open scanner" : "Scan more"}
          </Text>
        </Pressable>

        {pages.length > 0 && (
          <Pressable
            onPress={upload}
            disabled={busy}
            className="mt-3 flex-row items-center justify-center gap-2 rounded-xl bg-accent py-4"
            style={{ opacity: busy ? 0.6 : 1 }}
          >
            <Feather name="arrow-up" size={18} color={colors.accentInk} />
            <Text className="text-base font-bold text-accent-ink">
              {busy
                ? "Uploading…"
                : `Upload ${pages.length} ${pages.length === 1 ? "page" : "pages"}`}
            </Text>
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}
