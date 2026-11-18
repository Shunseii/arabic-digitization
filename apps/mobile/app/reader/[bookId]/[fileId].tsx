import { Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as SecureStore from "expo-secure-store";
import { useEffect, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  useWindowDimensions,
  View,
} from "react-native";
import Animated, {
  runOnJS,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useSharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Button,
  EmptyState,
  FLOAT_SHADOW,
  IconButton,
  type IconName,
  Loading,
  Segmented,
  T,
} from "@/components/ui";
import { ZoomableImage } from "@/components/zoomable-image";
import { api } from "@/lib/api";
import { Markdown } from "@/lib/markdown";
import { useGoBack } from "@/lib/navigation";
import { loadStatus } from "@/lib/status";
import { useColors } from "@/theme";

type Pane = "text" | "scan";

const PANES: Pane[] = ["text", "scan"];
const PANE_OPTIONS: { value: Pane; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "scan", label: "Scan" },
];
const TOOLBAR_HEIGHT = 56;
const TOOLBAR_GAP = 12;

export default function ReaderScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const c = useColors();
  const { width } = useWindowDimensions();
  const { bookId, fileId } = useLocalSearchParams<{
    bookId: string;
    fileId: string;
  }>();
  const goBack = useGoBack(`/book/${bookId}`);
  const [index, setIndex] = useState(0);
  const [showHint, setShowHint] = useState(false);
  const [scanZoomed, setScanZoomed] = useState(false);

  useEffect(() => {
    SecureStore.getItemAsync("qiraa.hint.readerSwipe").then((v) => {
      if (!v) setShowHint(true);
    });
  }, []);
  const dismissHint = () => {
    setShowHint(false);
    SecureStore.setItemAsync("qiraa.hint.readerSwipe", "1");
  };

  const textQuery = useQuery({
    queryKey: ["text", bookId, fileId],
    queryFn: () => api.fileText({ bookId, fileId }),
  });

  const statusQuery = useQuery({
    queryKey: ["status", bookId],
    queryFn: () => loadStatus(bookId),
  });

  // Same key as the book screen, so this is usually served from cache.
  const bookQuery = useQuery({
    queryKey: ["book", bookId],
    queryFn: () => api.getBook(bookId),
  });

  const files = (statusQuery.data ?? [])
    .slice()
    .sort(
      (a, b) =>
        (a.page_number ?? Number.MAX_SAFE_INTEGER) -
        (b.page_number ?? Number.MAX_SAFE_INTEGER),
    );
  const currentIndex = files.findIndex((f) => f.file_id === fileId);
  const currentFile = currentIndex >= 0 ? files[currentIndex] : null;
  const prevFile = currentIndex > 0 ? files[currentIndex - 1] : null;
  const nextFile =
    currentIndex >= 0 && currentIndex < files.length - 1
      ? files[currentIndex + 1]
      : null;
  // Swap the page in place: no slide animation, and back still returns to
  // whichever screen opened the reader.
  const goToFile = (target: string) => {
    setScanZoomed(false);
    router.setParams({ fileId: target });
  };

  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  // 0 on Text, 1 on Scan, fractional mid-swipe; the pane switch follows it.
  const paneProgress = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler({
    onScroll: (e) => {
      paneProgress.value = width > 0 ? e.contentOffset.x / width : 0;
    },
    onMomentumEnd: (e) => {
      runOnJS(setIndex)(Math.round(e.contentOffset.x / width));
    },
  });

  // Jump to a pane programmatically. Works even while the scan is zoomed
  // (which disables swipe gestures); leaving the scan resets its zoom.
  const showPane = (pane: Pane) => {
    const target = PANES.indexOf(pane);
    if (pane !== "scan") setScanZoomed(false);
    scrollRef.current?.scrollTo({ x: width * target, animated: true });
    setIndex(target);
  };

  const pageLabel =
    currentFile?.page_number != null ? `Page ${currentFile.page_number}` : null;
  const bottomClearance =
    insets.bottom + TOOLBAR_GAP + TOOLBAR_HEIGHT + TOOLBAR_GAP;

  return (
    <View className="flex-1 bg-bg" style={{ paddingTop: insets.top }}>
      <View className="flex-row items-center gap-3 px-5 pb-2.5 pt-1.5">
        <IconButton icon="chevron-left" onPress={goBack} />
        <View className="flex-1 items-center">
          {bookQuery.data?.title ? (
            <T variant="arSmall" className="font-ar-bold" numberOfLines={1}>
              {bookQuery.data.title}
            </T>
          ) : null}
          {pageLabel ? (
            <T variant="caption" className="font-body text-ink-3">
              {pageLabel}
            </T>
          ) : null}
        </View>
        <View className="w-10" />
      </View>

      <Animated.ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        scrollEnabled={!scanZoomed}
        showsHorizontalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={16}
      >
        <View style={{ width }}>
          {textQuery.isLoading ? (
            <Loading />
          ) : textQuery.isError ? (
            <View
              className="flex-1 justify-center"
              style={{ paddingBottom: bottomClearance }}
            >
              <EmptyState
                icon="file-text"
                title="Not transcribed yet"
                body="This page has no transcription yet. Switch to Scan to see the page meanwhile."
              />
            </View>
          ) : (
            <ScrollView
              contentContainerStyle={{
                paddingHorizontal: 28,
                paddingTop: 8,
                paddingBottom: bottomClearance + 16,
              }}
            >
              <Markdown source={textQuery.data ?? ""} />
            </ScrollView>
          )}
        </View>

        <View
          style={{ width, paddingBottom: bottomClearance }}
          className="items-center justify-center px-4 pt-2"
        >
          <ZoomableImage
            key={fileId}
            source={api.imageSource({ bookId, fileId })}
            resizeMode="contain"
            style={{ width: width - 32, flex: 1 }}
            zoomed={scanZoomed}
            onZoomChange={setScanZoomed}
          />
        </View>
      </Animated.ScrollView>

      <View
        className="absolute left-5 right-5 flex-row items-center gap-3"
        style={{ bottom: insets.bottom + TOOLBAR_GAP, height: TOOLBAR_HEIGHT }}
      >
        <PageStepButton
          icon="chevron-left"
          disabled={!prevFile}
          onPress={() => prevFile && goToFile(prevFile.file_id)}
        />
        <View className="flex-1">
          <Segmented
            pill
            floating
            progress={paneProgress}
            options={PANE_OPTIONS}
            value={PANES[index] ?? "text"}
            onChange={showPane}
          />
        </View>
        <PageStepButton
          icon="chevron-right"
          disabled={!nextFile}
          onPress={() => nextFile && goToFile(nextFile.file_id)}
        />
      </View>

      <Modal
        visible={showHint}
        transparent
        animationType="fade"
        onRequestClose={dismissHint}
      >
        <Pressable
          onPress={dismissHint}
          className="flex-1 items-center justify-center px-10"
          style={{ backgroundColor: c.scrim }}
        >
          <View className="w-full items-center gap-3 rounded-3xl bg-surface p-6">
            <View className="flex-row">
              <Feather name="arrow-left" size={22} color={c.accent} />
              <Feather name="arrow-right" size={22} color={c.accent} />
            </View>
            <T variant="heading" className="text-center">
              Swipe to switch views
            </T>
            <T variant="small" className="text-center text-ink-2">
              Swipe left for the scanned page, right for the transcription.
            </T>
            <Button
              label="Got it"
              size="sm"
              onPress={dismissHint}
              className="mt-1"
            />
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const PageStepButton = ({
  icon,
  disabled,
  onPress,
}: {
  icon: IconName;
  disabled: boolean;
  onPress: () => void;
}) => {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={
        icon === "chevron-left" ? "Previous page" : "Next page"
      }
      className="size-12 items-center justify-center rounded-full border border-line bg-surface active:opacity-70"
      style={[FLOAT_SHADOW, { opacity: disabled ? 0.4 : 1 }]}
    >
      <Feather name={icon} size={22} color={c.ink} />
    </Pressable>
  );
};
