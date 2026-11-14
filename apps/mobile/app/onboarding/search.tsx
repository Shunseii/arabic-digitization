import { useRouter } from "expo-router";
import { useState } from "react";
import { Alert } from "react-native";
import { OnboardingStep } from "@/components/onboarding-step";
import { Button, TextField } from "@/components/ui";
import { useConfigState } from "@/lib/config-context";

export default function SearchSetupScreen() {
  const router = useRouter();
  const { config, save } = useConfigState();

  const [meiliUrl, setMeiliUrl] = useState(config?.meiliUrl ?? "");
  const [meiliKey, setMeiliKey] = useState(config?.meiliKey ?? "");
  const [busy, setBusy] = useState(false);

  const finish = () => router.replace("/onboarding/done");

  const onSave = async () => {
    if (!config) {
      router.replace("/onboarding/connect");
      return;
    }
    setBusy(true);
    try {
      await save({ ...config, meiliUrl, meiliKey });
      finish();
    } catch (err) {
      Alert.alert("Could not save", String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <OnboardingStep
      step={2}
      total={2}
      eyebrow="Step 2 of 2 · Optional"
      title="Turn on search"
      body="Add your Meilisearch URL and a read-only key to search inside every page. You can do this later in Settings."
      actions={
        <>
          <Button
            label="Save & finish"
            loading={busy}
            disabled={!meiliUrl.trim() || !meiliKey.trim()}
            onPress={onSave}
          />
          <Button label="Skip for now" variant="ghost" onPress={finish} />
        </>
      }
    >
      <TextField
        label="Meilisearch URL"
        value={meiliUrl}
        onChangeText={setMeiliUrl}
        placeholder="https://your-search.fly.dev"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />
      <TextField
        label="Search key (read-only)"
        helper="Search never changes your library"
        value={meiliKey}
        onChangeText={setMeiliKey}
        placeholder="read-only search key"
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
      />
    </OnboardingStep>
  );
}
