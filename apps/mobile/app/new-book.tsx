import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ActionBar, Button, Header, T, TextField } from "@/components/ui";
import {
  TagEditor,
  type WorkChoice,
  WorkPicker,
} from "@/components/work-fields";
import { ApiError, api } from "@/lib/api";
import { useConfigState } from "@/lib/config-context";

export default function NewBookScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const params = useLocalSearchParams<{ workId?: string }>();

  const { configured } = useConfigState();
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [work, setWork] = useState<WorkChoice>(
    params.workId ? { kind: "existing", id: params.workId } : { kind: "new" },
  );
  // Tags for the auto-created work; only sent when a new work is created.
  const [tags, setTags] = useState<string[]>([]);

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
        work_id: work.kind === "existing" ? work.id : undefined,
        tags: work.kind === "new" && tags.length > 0 ? tags : undefined,
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

        <View className="mt-6">
          <WorkPicker works={works} value={work} onChange={setWork} />
        </View>

        {work.kind === "new" ? (
          <View className="mt-5">
            <TagEditor tags={tags} onChange={setTags} />
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
