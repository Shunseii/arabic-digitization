import { Feather } from "@expo/vector-icons";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ApiError, api } from "@/lib/api";
import { colors } from "@/theme";

export default function NewBookScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      api.createBook({
        title: title.trim(),
        ocr_instructions: instructions.trim() || undefined,
      }),
    onSuccess: async (book) => {
      await queryClient.invalidateQueries({ queryKey: ["books"] });
      router.replace(`/book/${book.id}`);
    },
    onError: (err) => {
      const msg =
        err instanceof ApiError ? `${err.status}: ${err.message}` : String(err);
      Alert.alert("Could not create book", msg);
    },
  });

  return (
    <ScrollView
      className="flex-1 bg-bg"
      contentContainerStyle={{
        paddingTop: insets.top + 8,
        paddingHorizontal: 20,
        paddingBottom: insets.bottom + 24,
        flexGrow: 1,
      }}
      keyboardShouldPersistTaps="handled"
    >
      <View className="flex-row items-center gap-3">
        <Pressable
          onPress={() => router.back()}
          className="h-10 w-10 items-center justify-center rounded-full border border-border bg-surface"
        >
          <Feather name="chevron-left" size={18} color={colors.textSecondary} />
        </Pressable>
        <Text className="text-[26px] font-semibold text-ink">New book</Text>
      </View>

      <Text className="mt-6 mb-2 text-xs font-bold tracking-wide text-text-muted">
        TITLE
      </Text>
      <TextInput
        value={title}
        onChangeText={setTitle}
        placeholder="نور الإيضاح"
        placeholderTextColor={colors.textMuted}
        className="rounded-xl border border-accent bg-surface px-4 py-3.5 text-lg text-ink"
        style={{ writingDirection: "rtl" }}
      />

      <Text className="mt-5 mb-2 text-xs font-bold tracking-wide text-text-muted">
        OCR INSTRUCTIONS · OPTIONAL
      </Text>
      <TextInput
        value={instructions}
        onChangeText={setInstructions}
        placeholder="Preserve tashkeel. Keep footnotes at the bottom of the page."
        placeholderTextColor={colors.textMuted}
        multiline
        className="min-h-[110px] rounded-xl border border-border bg-surface px-4 py-3.5 text-base text-text-secondary"
        textAlignVertical="top"
      />

      <View className="mt-5 flex-row items-center gap-2 rounded-xl bg-accent-soft px-3 py-2.5">
        <Feather name="zap" size={15} color={colors.accent} />
        <Text className="flex-1 text-xs text-accent">
          Pages you scan into this book transcribe automatically.
        </Text>
      </View>

      <View className="flex-1" />

      <Pressable
        onPress={() => mutation.mutate()}
        disabled={!title.trim() || mutation.isPending}
        className="items-center justify-center rounded-xl bg-accent py-4"
        style={{ opacity: !title.trim() || mutation.isPending ? 0.5 : 1 }}
      >
        <Text className="text-base font-bold text-accent-ink">
          {mutation.isPending ? "Creating…" : "Create book"}
        </Text>
      </Pressable>
    </ScrollView>
  );
}
