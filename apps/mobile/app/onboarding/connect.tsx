import { useRouter } from "expo-router";
import { useState } from "react";
import { OnboardingStep } from "@/components/onboarding-step";
import { Button, TextField } from "@/components/ui";
import { useConfigState } from "@/lib/config-context";
import { useConnect } from "@/lib/connection";

export default function ConnectScreen() {
  const router = useRouter();
  const { config } = useConfigState();
  const connect = useConnect();

  const [endpoint, setEndpoint] = useState(config?.endpoint ?? "");
  const [key, setKey] = useState(config?.key ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onConnect = async () => {
    setBusy(true);
    try {
      const result = await connect({
        endpoint,
        key,
        meiliUrl: config?.meiliUrl,
        meiliKey: config?.meiliKey,
      });
      if (!result.ok) {
        setError(`${result.title}: ${result.message}`);
        return;
      }
      setError(null);
      router.push("/onboarding/search");
    } finally {
      setBusy(false);
    }
  };

  return (
    <OnboardingStep
      step={1}
      total={2}
      eyebrow="Step 1 of 2"
      title="Connect your API"
      body="Pages upload to your own Cloudflare worker, which runs the OCR. Paste its address and key."
      actions={
        <Button
          label={busy ? "Testing…" : error ? "Try again" : "Test & connect"}
          loading={busy}
          onPress={onConnect}
        />
      }
    >
      <TextField
        label="API endpoint"
        helper="Your worker's URL"
        error={error}
        value={endpoint}
        onChangeText={setEndpoint}
        placeholder="https://your-worker.workers.dev"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />
      <TextField
        label="API key"
        helper="Saved in this phone's secure storage"
        value={key}
        onChangeText={setKey}
        placeholder="master key"
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
      />
    </OnboardingStep>
  );
}
