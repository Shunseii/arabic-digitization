import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import DocumentScanner, {
  ResponseType,
  ScanDocumentResponseStatus,
} from "react-native-document-scanner-plugin";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ApiError, api } from "@/lib/api";
import { colors } from "@/theme";

interface UploadResult {
  page?: number;
  ok: boolean;
  error?: string;
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
    : undefined;

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [results, setResults] = useState<UploadResult[]>([]);

  const runScan = async () => {
    setResults([]);
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

      setBusy(true);
      const uploaded: UploadResult[] = [];
      for (let i = 0; i < scannedImages.length; i++) {
        const page = startPage != null ? startPage + i : undefined;
        setProgress(`Uploading ${i + 1} of ${scannedImages.length}…`);
        try {
          await api.uploadPage({
            bookId,
            uri: scannedImages[i] as string,
            page,
            mime: "image/jpeg",
          });
          uploaded.push({ page, ok: true });
        } catch (err) {
          uploaded.push({
            page,
            ok: false,
            error: err instanceof ApiError ? err.message : String(err),
          });
        }
        setResults([...uploaded]);
      }
      await queryClient.invalidateQueries({ queryKey: ["books"] });
      await queryClient.invalidateQueries({ queryKey: ["status", bookId] });
    } catch (err) {
      Alert.alert("Scan failed", String(err));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const failed = results.filter((r) => !r.ok).length;
  const done = results.filter((r) => r.ok).length;

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
          flexGrow: 1,
        }}
      >
        <View className="flex-1 items-center justify-center gap-4">
          <View className="h-24 w-24 items-center justify-center rounded-full bg-accent-soft">
            <Feather name="camera" size={36} color={colors.accent} />
          </View>
          <Text className="text-center text-sm text-text-secondary">
            The camera detects page edges and flattens each scan automatically.
            Capture one or many pages — they upload and transcribe on their own.
          </Text>
          {startPage != null && (
            <Text className="text-xs text-text-muted">
              Numbering starts at page {startPage}.
            </Text>
          )}
          {progress && (
            <Text className="text-sm font-semibold text-accent">
              {progress}
            </Text>
          )}

          {results.length > 0 && !busy && (
            <View className="w-full gap-1 rounded-xl border border-border bg-surface p-4">
              <Text className="text-sm font-semibold text-ink">
                Uploaded {done} {done === 1 ? "page" : "pages"}
                {failed > 0 ? ` · ${failed} failed` : ""}
              </Text>
              {failed > 0 && (
                <Text className="text-xs text-st-fail">
                  Retry failed pages from the book screen.
                </Text>
              )}
            </View>
          )}
        </View>

        <Pressable
          onPress={runScan}
          disabled={busy}
          className="mt-4 flex-row items-center justify-center gap-2 rounded-xl bg-accent py-4"
          style={{ opacity: busy ? 0.6 : 1 }}
        >
          <Feather name="camera" size={18} color={colors.accentInk} />
          <Text className="text-base font-bold text-accent-ink">
            {busy ? "Uploading…" : "Open scanner"}
          </Text>
        </Pressable>

        {results.length > 0 && !busy && (
          <Pressable
            onPress={() => router.back()}
            className="mt-3 items-center justify-center rounded-xl border border-border py-3.5"
          >
            <Text className="text-sm font-semibold text-text-secondary">
              Done
            </Text>
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}
