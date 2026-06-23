import { useQueryClient } from "@tanstack/react-query";
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
import { useConfigState } from "@/lib/config-context";
import { colors } from "@/theme";

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { config, configured, save, clear } = useConfigState();
  const queryClient = useQueryClient();

  const [endpoint, setEndpoint] = useState(config?.endpoint ?? "");
  const [key, setKey] = useState(config?.key ?? "");
  const [meiliUrl, setMeiliUrl] = useState(config?.meiliUrl ?? "");
  const [meiliKey, setMeiliKey] = useState(config?.meiliKey ?? "");
  const [busy, setBusy] = useState(false);

  const onSave = async () => {
    if (!endpoint.trim() || !key.trim()) {
      Alert.alert("Missing fields", "Enter both the API endpoint and key.");
      return;
    }
    setBusy(true);
    try {
      const ok = await api.ping({ endpoint, key });
      if (!ok) {
        Alert.alert(
          "Could not connect",
          "The endpoint responded but rejected the key. Check both values.",
        );
        return;
      }
      await save({ endpoint, key, meiliUrl, meiliKey });
      await queryClient.invalidateQueries();
      Alert.alert("Connected", "Your API is set up.");
    } catch (err) {
      const msg =
        err instanceof ApiError ? `${err.status}: ${err.message}` : String(err);
      Alert.alert("Connection failed", msg);
    } finally {
      setBusy(false);
    }
  };

  const onClear = () => {
    Alert.alert(
      "Clear API key?",
      "You will need to re-enter it to use the app.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear",
          style: "destructive",
          onPress: async () => {
            await clear();
            await queryClient.clear();
            setEndpoint("");
            setKey("");
            setMeiliUrl("");
            setMeiliKey("");
          },
        },
      ],
    );
  };

  return (
    <ScrollView
      className="flex-1 bg-bg"
      contentContainerStyle={{
        paddingTop: insets.top + 8,
        paddingHorizontal: 20,
        paddingBottom: insets.bottom + 90,
      }}
      keyboardShouldPersistTaps="handled"
    >
      <Text className="text-[30px] font-semibold text-ink">Settings</Text>

      <Text className="mt-6 text-xs font-bold tracking-wide text-text-muted">
        CONNECTION
      </Text>

      <Text className="mt-3 mb-2 text-xs font-medium text-text-secondary">
        API endpoint
      </Text>
      <TextInput
        value={endpoint}
        onChangeText={setEndpoint}
        placeholder="https://your-worker.workers.dev"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        className="rounded-xl border border-border bg-surface px-4 py-3.5 text-base text-ink"
      />

      <Text className="mt-4 mb-2 text-xs font-medium text-text-secondary">
        API key
      </Text>
      <TextInput
        value={key}
        onChangeText={setKey}
        placeholder="master key"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        className="rounded-xl border border-border bg-surface px-4 py-3.5 text-base text-ink"
      />

      {configured && (
        <View className="mt-4 flex-row items-center gap-1.5 self-start rounded-full bg-[#16271E] px-3 py-1.5">
          <View className="h-1.5 w-1.5 rounded-full bg-st-done" />
          <Text className="text-xs font-semibold text-st-done">
            Connected · key saved
          </Text>
        </View>
      )}

      <Text className="mt-8 text-xs font-bold tracking-wide text-text-muted">
        SEARCH (OPTIONAL)
      </Text>
      <Text className="mt-1 mb-3 text-xs text-text-muted">
        Meilisearch URL + read-only key to enable the Search tab.
      </Text>

      <Text className="mb-2 text-xs font-medium text-text-secondary">
        Meilisearch URL
      </Text>
      <TextInput
        value={meiliUrl}
        onChangeText={setMeiliUrl}
        placeholder="https://your-search.fly.dev"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        className="rounded-xl border border-border bg-surface px-4 py-3.5 text-base text-ink"
      />

      <Text className="mt-4 mb-2 text-xs font-medium text-text-secondary">
        Search key (read-only)
      </Text>
      <TextInput
        value={meiliKey}
        onChangeText={setMeiliKey}
        placeholder="read-only search key"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        className="rounded-xl border border-border bg-surface px-4 py-3.5 text-base text-ink"
      />

      <Pressable
        onPress={onSave}
        disabled={busy}
        className="mt-6 items-center justify-center rounded-xl bg-accent py-4"
        style={{ opacity: busy ? 0.6 : 1 }}
      >
        <Text className="text-base font-bold text-accent-ink">
          {busy ? "Testing…" : "Test & save"}
        </Text>
      </Pressable>

      {configured && (
        <Pressable
          onPress={onClear}
          className="mt-3 h-12 flex-row items-center justify-center gap-2 rounded-xl border border-st-fail"
        >
          <Text className="text-sm font-semibold text-st-fail">
            Clear API key
          </Text>
        </Pressable>
      )}
    </ScrollView>
  );
}
