import { Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as SecureStore from "expo-secure-store";
import { useEffect, useState } from "react";
import {
  Image,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Centered, Loading } from "@/components/ui";
import { api } from "@/lib/api";
import { Markdown } from "@/lib/markdown";
import { colors } from "@/theme";

export default function ReaderScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const { bookId, fileId } = useLocalSearchParams<{
    bookId: string;
    fileId: string;
  }>();
  const [index, setIndex] = useState(0);
  const [showHint, setShowHint] = useState(false);

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

  const onScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) =>
    setIndex(Math.round(e.nativeEvent.contentOffset.x / width));

  return (
    <View className="flex-1 bg-bg" style={{ paddingTop: insets.top }}>
      <View className="flex-row items-center justify-between px-4 py-3">
        <Pressable
          onPress={() => router.back()}
          className="h-10 w-10 items-center justify-center rounded-full border border-border bg-surface"
        >
          <Feather name="chevron-left" size={18} color={colors.textSecondary} />
        </Pressable>
        <View className="flex-row items-center gap-2">
          <Text className="text-sm font-semibold text-text-secondary">
            {index === 0 ? "Transcription" : "Scan"}
          </Text>
          <View className="flex-row items-center gap-1.5">
            <View
              className="h-1.5 w-1.5 rounded-full"
              style={{
                backgroundColor: index === 0 ? colors.accent : colors.border,
              }}
            />
            <View
              className="h-1.5 w-1.5 rounded-full"
              style={{
                backgroundColor: index === 1 ? colors.accent : colors.border,
              }}
            />
          </View>
        </View>
        <View className="h-10 w-10" />
      </View>

      <ScrollView
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onScrollEnd}
      >
        {/* Pane 1: transcription */}
        <View style={{ width }}>
          {textQuery.isLoading ? (
            <Loading />
          ) : textQuery.isError ? (
            <Centered>
              <Text className="text-center text-sm text-text-secondary">
                No transcription yet for this page. Swipe → to see the scan.
              </Text>
            </Centered>
          ) : (
            <ScrollView
              contentContainerStyle={{
                paddingHorizontal: 26,
                paddingBottom: insets.bottom + 32,
                paddingTop: 4,
              }}
            >
              <Markdown source={textQuery.data ?? ""} />
            </ScrollView>
          )}
        </View>

        {/* Pane 2: original scan */}
        <View style={{ width }} className="items-center justify-center px-4">
          <Image
            source={api.imageSource({ bookId, fileId })}
            resizeMode="contain"
            style={{ width: width - 32, height: "85%" }}
            // biome-ignore lint/suspicious/noEmptyBlockStatements: placeholder while loading
            onError={() => {}}
          />
        </View>
      </ScrollView>

      <Modal
        visible={showHint}
        transparent
        animationType="fade"
        onRequestClose={dismissHint}
      >
        <Pressable
          onPress={dismissHint}
          className="flex-1 items-center justify-center px-10"
          style={{ backgroundColor: "#000000B3" }}
        >
          <View className="w-full items-center gap-3 rounded-2xl border border-border bg-surface p-6">
            <Feather name="chevrons-left" size={28} color={colors.accent} />
            <Text className="text-center text-base font-semibold text-ink">
              Swipe to switch views
            </Text>
            <Text className="text-center text-sm text-text-secondary">
              Swipe left for the scanned page, right for the transcription.
            </Text>
            <Pressable
              onPress={dismissHint}
              className="mt-1 rounded-lg bg-accent px-5 py-2"
            >
              <Text className="text-sm font-bold text-accent-ink">Got it</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}
