import type { WorkWithCounts } from "@qiraa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ActionBar,
  Button,
  Chip,
  FieldLabel,
  Header,
  T,
  TextField,
} from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { useConfigState } from "@/lib/config-context";
import { useColors } from "@/theme";

const describeWork = (work: WorkWithCounts): string => {
  const copies = `${work.copies_total} ${work.copies_total === 1 ? "copy" : "copies"}`;
  return work.tags.length > 0 ? `${copies} · ${work.tags.join(", ")}` : copies;
};

export default function NewBookScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const c = useColors();
  const queryClient = useQueryClient();
  const params = useLocalSearchParams<{ workId?: string }>();

  const { configured } = useConfigState();
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  // null = auto-create a new work from the title; otherwise attach to this work.
  const [workId, setWorkId] = useState<string | null>(params.workId ?? null);
  // Tags for the auto-created work; only meaningful when workId is null.
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const addTag = (raw: string) => {
    const t = raw.trim();
    if (t && !tags.includes(t)) setTags((prev) => [...prev, t]);
    setTagInput("");
  };

  const worksQuery = useQuery({
    queryKey: ["works"],
    queryFn: api.listWorks,
    enabled: configured,
  });
  const works = worksQuery.data ?? [];

  const mutation = useMutation({
    mutationFn: () =>
      api.createBook({
        title: title.trim(),
        ocr_instructions: instructions.trim() || undefined,
        work_id: workId ?? undefined,
        tags: workId === null && tags.length > 0 ? tags : undefined,
      }),
    onSuccess: async (book) => {
      await queryClient.invalidateQueries({ queryKey: ["books"] });
      await queryClient.invalidateQueries({ queryKey: ["works"] });
      router.replace(`/book/${book.id}`);
    },
    onError: (err) => {
      const msg =
        err instanceof ApiError ? `${err.status}: ${err.message}` : String(err);
      Alert.alert("Could not create book", msg);
    },
  });

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-bg"
      style={{ paddingTop: insets.top }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <Header title="New book" left="x" onLeft={() => router.back()} />

      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 24 }}
        keyboardShouldPersistTaps="handled"
      >
        <TextField
          label="Title"
          value={title}
          onChangeText={setTitle}
          placeholder="نور الإيضاح"
          rtl
          className="mt-2"
        />

        <View className="mt-6 gap-1">
          <FieldLabel>Work</FieldLabel>
          <T variant="caption" className="font-body text-ink-3">
            Copies of the same text share a work, so they group together.
          </T>
          <View className="mt-1">
            <WorkOption
              selected={workId === null}
              title="New work"
              subtitle="Created from the title"
              onPress={() => setWorkId(null)}
            />
            {works.map((w) => (
              <WorkOption
                key={w.id}
                selected={workId === w.id}
                title={w.name}
                subtitle={describeWork(w)}
                arabic
                onPress={() => setWorkId(w.id)}
              />
            ))}
          </View>
        </View>

        {workId === null ? (
          <View className="mt-5 gap-2.5">
            <FieldLabel>Tags · optional</FieldLabel>
            <View className="flex-row flex-wrap gap-2">
              {tags.map((t) => (
                <Chip
                  key={t}
                  label={t}
                  removable
                  onPress={() => setTags((prev) => prev.filter((x) => x !== t))}
                />
              ))}
              <TextInput
                value={tagInput}
                onChangeText={setTagInput}
                onSubmitEditing={() => addTag(tagInput)}
                onBlur={() => tagInput.trim() && addTag(tagInput)}
                placeholder="+ Add tag"
                placeholderTextColor={c.ink}
                returnKeyType="done"
                className="h-[34px] min-w-24 rounded-full border border-line bg-surface px-3.5 font-body-medium text-[13px] text-ink"
              />
            </View>
          </View>
        ) : null}

        <TextField
          label="OCR instructions · optional"
          value={instructions}
          onChangeText={setInstructions}
          placeholder="Preserve tashkeel. Keep footnotes at the bottom of the page."
          multiline
          className="mt-5"
        />
      </ScrollView>

      <ActionBar>
        <T variant="caption" className="text-center font-body text-ink-3">
          Pages you scan into this book transcribe automatically.
        </T>
        <Button
          label={mutation.isPending ? "Creating…" : "Create book"}
          loading={mutation.isPending}
          disabled={!title.trim()}
          onPress={() => mutation.mutate()}
        />
      </ActionBar>
    </KeyboardAvoidingView>
  );
}

const WorkOption = ({
  selected,
  title,
  subtitle,
  arabic = false,
  onPress,
}: {
  selected: boolean;
  title: string;
  subtitle: string;
  arabic?: boolean;
  onPress: () => void;
}) => (
  <Pressable
    onPress={onPress}
    accessibilityRole="radio"
    accessibilityState={{ selected }}
    className="flex-row items-center gap-3 py-2.5 active:opacity-70"
  >
    <View
      className={`h-5 w-5 items-center justify-center rounded-full border-2 ${selected ? "border-accent" : "border-ink-3"}`}
    >
      {selected ? (
        <View className="h-2.5 w-2.5 rounded-full bg-accent" />
      ) : null}
    </View>
    <View className="flex-1">
      <T
        variant={arabic ? "arSmall" : "bodyStrong"}
        className={arabic ? "text-left" : ""}
        style={arabic ? { writingDirection: "auto" } : undefined}
        numberOfLines={1}
      >
        {title}
      </T>
      <T variant="caption" className="font-body text-ink-3" numberOfLines={1}>
        {subtitle}
      </T>
    </View>
  </Pressable>
);
