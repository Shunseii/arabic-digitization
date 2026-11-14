import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Badge, Button, Card, T, TextField } from "@/components/ui";
import { useConfigState } from "@/lib/config-context";
import { useConnect } from "@/lib/connection";

const URL_INPUT = {
  autoCapitalize: "none",
  autoCorrect: false,
  keyboardType: "url",
} as const;

const SECRET_INPUT = {
  autoCapitalize: "none",
  autoCorrect: false,
  secureTextEntry: true,
} as const;

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { config, configured, clear } = useConfigState();
  const queryClient = useQueryClient();
  const connect = useConnect();

  const [endpoint, setEndpoint] = useState(config?.endpoint ?? "");
  const [key, setKey] = useState(config?.key ?? "");
  const [meiliUrl, setMeiliUrl] = useState(config?.meiliUrl ?? "");
  const [meiliKey, setMeiliKey] = useState(config?.meiliKey ?? "");
  const [busy, setBusy] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const searchEnabled = Boolean(config?.meiliUrl && config?.meiliKey);

  const onSave = async () => {
    if (!endpoint.trim() || !key.trim()) {
      Alert.alert("Missing fields", "Enter both the API endpoint and key.");
      return;
    }
    setBusy(true);
    try {
      const result = await connect({ endpoint, key, meiliUrl, meiliKey });
      if (!result.ok) {
        setConnectionError(`${result.title}: ${result.message}`);
        Alert.alert(result.title, result.message);
        return;
      }
      setConnectionError(null);
      Alert.alert("Connected", "Your API is set up.");
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
            setConnectionError(null);
          },
        },
      ],
    );
  };

  return (
    <ScrollView
      className="flex-1 bg-bg"
      contentContainerStyle={{
        paddingTop: insets.top + 16,
        paddingHorizontal: 24,
        paddingBottom: insets.bottom + 90,
        gap: 12,
      }}
      keyboardShouldPersistTaps="handled"
    >
      <T variant="display" className="mb-2">
        Settings
      </T>

      <Card className="gap-3.5 p-4">
        <View className="flex-row items-center justify-between">
          <T variant="heading">Library API</T>
          {connectionError ? (
            <Badge label="Failed" tone="danger" />
          ) : configured ? (
            <Badge label="Connected" tone="ok" />
          ) : null}
        </View>
        <TextField
          label="Endpoint"
          value={endpoint}
          onChangeText={setEndpoint}
          placeholder="https://your-worker.workers.dev"
          error={connectionError}
          {...URL_INPUT}
        />
        <TextField
          label="Key"
          value={key}
          onChangeText={setKey}
          placeholder="master key"
          {...SECRET_INPUT}
        />
      </Card>

      <Card className="gap-3.5 p-4">
        <View className="gap-1.5">
          <View className="flex-row items-center justify-between">
            <T variant="heading">Search</T>
            {searchEnabled ? <Badge label="Enabled" tone="ok" /> : null}
          </View>
          <T variant="caption" className="font-body text-ink-3">
            Meilisearch URL and a read-only key enable the Search tab.
          </T>
        </View>
        <TextField
          label="Meilisearch URL"
          value={meiliUrl}
          onChangeText={setMeiliUrl}
          placeholder="https://your-search.fly.dev"
          {...URL_INPUT}
        />
        <TextField
          label="Search key (read-only)"
          value={meiliKey}
          onChangeText={setMeiliKey}
          placeholder="read-only search key"
          {...SECRET_INPUT}
        />
      </Card>

      <Button
        label={
          busy ? "Testing…" : connectionError ? "Try again" : "Test & save"
        }
        onPress={onSave}
        loading={busy}
      />

      {configured ? (
        <Button label="Clear API key" variant="ghost" onPress={onClear} />
      ) : null}
    </ScrollView>
  );
}
