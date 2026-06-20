import { Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Centered, Loading } from "@/components/ui";
import { api } from "@/lib/api";
import { Markdown } from "@/lib/markdown";
import { colors } from "@/theme";

export default function ReaderScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { bookId, fileId } = useLocalSearchParams<{
    bookId: string;
    fileId: string;
  }>();

  const textQuery = useQuery({
    queryKey: ["text", bookId, fileId],
    queryFn: () => api.fileText({ bookId, fileId }),
  });

  return (
    <View className="flex-1 bg-bg" style={{ paddingTop: insets.top }}>
      <View className="flex-row items-center justify-between px-4 py-3">
        <Pressable
          onPress={() => router.back()}
          className="h-10 w-10 items-center justify-center rounded-full border border-border bg-surface"
        >
          <Feather name="chevron-left" size={18} color={colors.textSecondary} />
        </Pressable>
        <Text className="text-sm font-semibold text-text-secondary">
          Transcription
        </Text>
        <View className="h-10 w-10" />
      </View>

      {textQuery.isLoading ? (
        <Loading />
      ) : textQuery.isError ? (
        <Centered>
          <Text className="text-center text-sm text-text-secondary">
            No transcription yet for this page, or it failed to load.
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
  );
}
