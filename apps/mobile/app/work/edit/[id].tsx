import type { WorkWithCounts } from "@qiraa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ActionBar,
  Button,
  Dialog,
  Divider,
  EmptyState,
  Header,
  Loading,
  T,
  TextField,
} from "@/components/ui";
import { TagEditor } from "@/components/work-fields";
import { ApiError, api } from "@/lib/api";

type DeleteMode = "unlink" | "delete";

const errorMessage = (err: unknown): string =>
  err instanceof ApiError ? `${err.status}: ${err.message}` : String(err);

export default function EditWorkScreen() {
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
  const [confirmingDelete, setConfirmingDelete] = useState(false);

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
    onError: (err) => Alert.alert("Could not save", errorMessage(err)),
  });

  const remove = useMutation({
    mutationFn: (mode: DeleteMode) => api.deleteWork({ id: workId, mode }),
    onSuccess: async () => {
      await invalidate();
      router.dismissTo("/");
    },
    onError: (err) => Alert.alert("Could not delete", errorMessage(err)),
  });

  const deleteWith = (mode: DeleteMode) => {
    setConfirmingDelete(false);
    remove.mutate(mode);
  };

  const header = (
    <View style={{ paddingTop: insets.top }}>
      <Header left="x" onLeft={() => router.back()} title="Edit work" />
    </View>
  );

  if (workQuery.isLoading) {
    return (
      <View className="flex-1 bg-bg">
        {header}
        <Loading />
      </View>
    );
  }

  if (workQuery.isError || !workQuery.data) {
    return (
      <View className="flex-1 bg-bg">
        {header}
        <View className="flex-1 justify-center pb-24">
          <EmptyState
            icon="alert-circle"
            title="Couldn't load this work"
            body="Check your connection, then go back and try again."
            action={
              <Button
                label="Go back"
                variant="secondary"
                onPress={() => router.back()}
              />
            }
          />
        </View>
      </View>
    );
  }

  const busy = save.isPending || remove.isPending;
  const copiesTotal = queryClient
    .getQueryData<WorkWithCounts[]>(["works"])
    ?.find((w) => w.id === workId)?.copies_total;
  const copiesPhrase =
    copiesTotal === undefined
      ? "its copies"
      : copiesTotal === 1
        ? "its copy"
        : `its ${copiesTotal} copies`;

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-bg"
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {header}
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 24 }}
        keyboardShouldPersistTaps="handled"
      >
        <View className="mt-2 gap-5">
          <TextField label="Name" value={name} onChangeText={setName} rtl />
          <TextField
            label="Author · optional"
            value={author}
            onChangeText={setAuthor}
            placeholder="ابن قدامة"
            rtl
          />
          <TagEditor tags={tags} onChange={setTags} label="Tags" />
        </View>

        <View className="mt-7">
          <Divider />
        </View>
        <View className="mt-6 items-start gap-2">
          <T variant="bodyStrong">Delete this work</T>
          <T variant="small" className="text-ink-2">
            Choose whether to keep {copiesPhrase} as ungrouped books or delete
            them too.
          </T>
          <Button
            label="Delete work…"
            variant="danger"
            size="sm"
            loading={remove.isPending}
            disabled={busy}
            onPress={() => setConfirmingDelete(true)}
            className="mt-1"
          />
        </View>
      </ScrollView>

      <ActionBar>
        <Button
          label={save.isPending ? "Saving…" : "Save changes"}
          loading={save.isPending}
          disabled={!name.trim() || busy}
          onPress={() => save.mutate()}
        />
      </ActionBar>

      <Dialog
        visible={confirmingDelete}
        onClose={() => setConfirmingDelete(false)}
        title="Delete work"
        message="Keep its copies (they become ungrouped), or delete them too?"
      >
        <View className="gap-2">
          <Button
            label="Keep copies"
            variant="secondary"
            onPress={() => deleteWith("unlink")}
          />
          <Button
            label="Delete all copies"
            variant="danger"
            onPress={() => deleteWith("delete")}
          />
          <Button
            label="Cancel"
            variant="ghost"
            onPress={() => setConfirmingDelete(false)}
          />
        </View>
      </Dialog>
    </KeyboardAvoidingView>
  );
}
