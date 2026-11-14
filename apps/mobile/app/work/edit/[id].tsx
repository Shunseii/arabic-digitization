import { Feather } from "@expo/vector-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Centered, Loading } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { colors } from "@/theme";

export default function WorkScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { id } = useLocalSearchParams<{ id: string }>();
  const workId = id ?? "";

  const workQuery = useQuery({
    queryKey: ["work", workId],
    queryFn: () => api.getWork(workId),
    enabled: !!workId,
  });

  const [name, setName] = useState("");
  const [author, setAuthor] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");

  useEffect(() => {
    const w = workQuery.data;
    if (!w) return;
    setName(w.name);
    setAuthor(w.author ?? "");
    setTags(w.tags);
  }, [workQuery.data]);

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["works"] }),
      queryClient.invalidateQueries({ queryKey: ["work", workId] }),
      queryClient.invalidateQueries({ queryKey: ["books"] }),
    ]);
  };

  const save = useMutation({
    mutationFn: () =>
      api.updateWork({
        id: workId,
        body: { name: name.trim(), author: author.trim() || null, tags },
      }),
    onSuccess: async () => {
      await invalidate();
      router.back();
    },
    onError: (err) =>
      Alert.alert(
        "Could not save",
        err instanceof ApiError ? `${err.status}: ${err.message}` : String(err),
      ),
  });

  const remove = useMutation({
    mutationFn: (mode: "unlink" | "delete") =>
      api.deleteWork({ id: workId, mode }),
    onSuccess: async () => {
      await invalidate();
      router.replace("/");
    },
    onError: (err) =>
      Alert.alert(
        "Could not delete",
        err instanceof ApiError ? `${err.status}: ${err.message}` : String(err),
      ),
  });

  const confirmDelete = () =>
    Alert.alert(
      "Delete work",
      "Keep its copies (they become ungrouped), or delete them too?",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Keep copies", onPress: () => remove.mutate("unlink") },
        {
          text: "Delete all copies",
          style: "destructive",
          onPress: () => remove.mutate("delete"),
        },
      ],
    );

  const addTag = (raw: string) => {
    const t = raw.trim();
    if (t && !tags.includes(t)) setTags((prev) => [...prev, t]);
    setTagInput("");
  };

  if (workQuery.isLoading) return <Loading />;
  if (workQuery.isError || !workQuery.data)
    return (
      <Centered>
        <Text className="text-sm text-st-fail">Couldn't load this work.</Text>
      </Centered>
    );

  const busy = save.isPending || remove.isPending;

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
        <Text className="text-[26px] font-semibold text-ink">Edit work</Text>
      </View>

      <Text className="mt-6 mb-2 text-xs font-bold tracking-wide text-text-muted">
        NAME
      </Text>
      <TextInput
        value={name}
        onChangeText={setName}
        className="rounded-xl border border-accent bg-surface px-4 py-3.5 text-lg text-ink"
        style={{ writingDirection: "rtl" }}
      />

      <Text className="mt-5 mb-2 text-xs font-bold tracking-wide text-text-muted">
        AUTHOR · OPTIONAL
      </Text>
      <TextInput
        value={author}
        onChangeText={setAuthor}
        placeholder="ابن قدامة"
        placeholderTextColor={colors.textMuted}
        className="rounded-xl border border-border bg-surface px-4 py-3.5 text-base text-ink"
        style={{ writingDirection: "rtl" }}
      />

      <Text className="mt-5 mb-2 text-xs font-bold tracking-wide text-text-muted">
        TAGS · OPTIONAL
      </Text>
      {tags.length > 0 ? (
        <View className="mb-2 flex-row flex-wrap gap-1.5">
          {tags.map((t) => (
            <Pressable
              key={t}
              onPress={() => setTags((prev) => prev.filter((x) => x !== t))}
              className="flex-row items-center gap-1 rounded-full bg-accent-soft px-2.5 py-1"
            >
              <Text className="text-xs text-accent">{t}</Text>
              <Feather name="x" size={12} color={colors.accent} />
            </Pressable>
          ))}
        </View>
      ) : null}
      <TextInput
        value={tagInput}
        onChangeText={setTagInput}
        onSubmitEditing={() => addTag(tagInput)}
        onBlur={() => tagInput.trim() && addTag(tagInput)}
        placeholder="Add a tag, then return"
        placeholderTextColor={colors.textMuted}
        returnKeyType="done"
        className="rounded-xl border border-border bg-surface px-4 py-3 text-base text-ink"
      />

      <View className="flex-1" />

      <Pressable
        onPress={() => save.mutate()}
        disabled={!name.trim() || busy}
        className="mt-6 items-center justify-center rounded-xl bg-accent py-4"
        style={{ opacity: !name.trim() || busy ? 0.5 : 1 }}
      >
        <Text className="text-base font-bold text-accent-ink">
          {save.isPending ? "Saving…" : "Save changes"}
        </Text>
      </Pressable>

      <Pressable
        onPress={confirmDelete}
        disabled={busy}
        className="mt-3 items-center py-2"
        style={{ opacity: busy ? 0.5 : 1 }}
      >
        <Text className="text-sm font-semibold text-st-fail">Delete work…</Text>
      </Pressable>
    </ScrollView>
  );
}
