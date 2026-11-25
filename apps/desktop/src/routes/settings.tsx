import { useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Dialog,
  ErrorBanner,
  PageHeader,
  TextField,
} from "@/components/ui";
import { api } from "@/lib/api";
import { useConfigState } from "@/lib/config-context";
import { errorMessage } from "@/lib/errors";

const noAutocorrect = {
  autoCapitalize: "none",
  autoCorrect: "off",
  spellCheck: false,
} as const;

const Card = ({
  title,
  sub,
  children,
}: {
  title: string;
  sub: string;
  children: ReactNode;
}) => (
  <section className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-6">
    <div className="flex flex-col gap-0.5">
      <h2 className="font-display text-section font-semibold leading-[1.2] tracking-[-0.01em] text-ink">
        {title}
      </h2>
      <p className="text-small text-ink-2">{sub}</p>
    </div>
    {children}
  </section>
);

type Problem =
  | { kind: "rejected" }
  | { kind: "unreachable"; message: string }
  | { kind: "missing" };

export const SettingsScreen = () => {
  const { config, configured, ready, save, clear } = useConfigState();
  const queryClient = useQueryClient();

  const [endpoint, setEndpoint] = useState(config?.endpoint ?? "");
  const [key, setKey] = useState(config?.key ?? "");
  const [meiliUrl, setMeiliUrl] = useState(config?.meiliUrl ?? "");
  const [meiliKey, setMeiliKey] = useState(config?.meiliKey ?? "");
  const [testing, setTesting] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [clearing, setClearing] = useState(false);

  // The saved config loads asynchronously; fill the fields once it arrives
  // (opening Settings first thing would otherwise show them empty).
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once, when ready
  useEffect(() => {
    if (!ready || !config) return;
    setEndpoint(config.endpoint);
    setKey(config.key);
    setMeiliUrl(config.meiliUrl ?? "");
    setMeiliKey(config.meiliKey ?? "");
  }, [ready]);

  const onSave = async () => {
    if (!endpoint.trim() || !key.trim()) {
      setProblem({ kind: "missing" });
      return;
    }
    setTesting(true);
    setProblem(null);
    try {
      const ok = await api.ping({ endpoint, key });
      if (!ok) {
        setProblem({ kind: "rejected" });
        return;
      }
      await save({ endpoint, key, meiliUrl, meiliKey });
      await queryClient.invalidateQueries();
    } catch (err) {
      setProblem({ kind: "unreachable", message: errorMessage(err) });
    } finally {
      setTesting(false);
    }
  };

  const onClear = async () => {
    setClearing(false);
    await clear();
    queryClient.clear();
    setEndpoint("");
    setKey("");
    setMeiliUrl("");
    setMeiliKey("");
    setProblem(null);
  };

  return (
    <>
      <PageHeader title="Settings" />
      <div className="flex min-h-0 flex-1 justify-center overflow-y-auto">
        <form
          className="flex w-[640px] flex-col gap-5 pb-10"
          onSubmit={(e) => {
            e.preventDefault();
            onSave();
          }}
        >
          <Card
            title="API"
            sub="The Cloudflare Worker that stores books and runs OCR"
          >
            <TextField
              label="Endpoint"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="https://your-worker.workers.dev"
              error={problem?.kind === "missing" && !endpoint.trim()}
              {...noAutocorrect}
            />
            <TextField
              label="Key"
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="master key"
              error={
                problem?.kind === "rejected" ||
                (problem?.kind === "missing" && !key.trim())
              }
              helper={
                problem?.kind === "rejected"
                  ? "The endpoint responded but rejected the key. Check both values."
                  : problem?.kind === "missing"
                    ? "Enter both the endpoint and the key."
                    : undefined
              }
              {...noAutocorrect}
            />
            {configured && !problem && (
              <div className="self-start">
                <Badge tone="ok">Connected</Badge>
              </div>
            )}
          </Card>

          <Card
            title="Search"
            sub="Meilisearch, for full-text search. Optional."
          >
            <TextField
              label="Search URL"
              value={meiliUrl}
              onChange={(e) => setMeiliUrl(e.target.value)}
              placeholder="https://your-search.fly.dev"
              {...noAutocorrect}
            />
            <TextField
              label="Search key"
              type="password"
              value={meiliKey}
              onChange={(e) => setMeiliKey(e.target.value)}
              placeholder="read-only search key"
              {...noAutocorrect}
            />
          </Card>

          {problem?.kind === "rejected" && (
            <ErrorBanner title="The API rejected the key">
              Check the key, then test again.
            </ErrorBanner>
          )}
          {problem?.kind === "unreachable" && (
            <ErrorBanner title="Couldn't reach the API">
              {problem.message}
            </ErrorBanner>
          )}

          <div className="flex items-center gap-3">
            <Button type="submit" className="w-[200px]" loading={testing}>
              {testing ? "Testing…" : "Test & save"}
            </Button>
            {configured && (
              <Button
                variant="danger"
                icon={Trash2}
                className="ml-auto"
                onClick={() => setClearing(true)}
              >
                Clear API key
              </Button>
            )}
          </div>
        </form>
      </div>

      <Dialog
        open={clearing}
        onClose={() => setClearing(false)}
        title="Clear the API key?"
        width="w-[420px]"
      >
        <p className="text-body text-ink-2">
          You'll need to enter it again to use the app.
        </p>
        <div className="mt-2 flex items-center gap-3">
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => setClearing(false)}
          >
            Cancel
          </Button>
          <Button size="sm" variant="danger" icon={Trash2} onClick={onClear}>
            Clear API key
          </Button>
        </div>
      </Dialog>
    </>
  );
};
