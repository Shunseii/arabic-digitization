import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, api } from "@/lib/api";
import { useConfigState } from "@/lib/config-context";
import { colors } from "@/theme";

export const SettingsScreen = () => {
  const { config, configured, save, clear } = useConfigState();
  const queryClient = useQueryClient();

  const [endpoint, setEndpoint] = useState(config?.endpoint ?? "");
  const [key, setKey] = useState(config?.key ?? "");
  const [meiliUrl, setMeiliUrl] = useState(config?.meiliUrl ?? "");
  const [meiliKey, setMeiliKey] = useState(config?.meiliKey ?? "");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{
    kind: "ok" | "err";
    text: string;
  } | null>(null);

  const onSave = async () => {
    if (!endpoint.trim() || !key.trim()) {
      setNotice({ kind: "err", text: "Enter both the API endpoint and key." });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const ok = await api.ping({ endpoint, key });
      if (!ok) {
        setNotice({
          kind: "err",
          text: "The endpoint responded but rejected the key. Check both values.",
        });
        return;
      }
      await save({ endpoint, key, meiliUrl, meiliKey });
      await queryClient.invalidateQueries();
      setNotice({ kind: "ok", text: "Connected. Your API is set up." });
    } catch (err) {
      const msg =
        err instanceof ApiError ? `${err.status}: ${err.message}` : String(err);
      setNotice({ kind: "err", text: `Connection failed — ${msg}` });
    } finally {
      setBusy(false);
    }
  };

  const onClear = async () => {
    if (!window.confirm("Clear API key? You will need to re-enter it.")) return;
    await clear();
    await queryClient.clear();
    setEndpoint("");
    setKey("");
    setMeiliUrl("");
    setMeiliKey("");
    setNotice(null);
  };

  return (
    <div className="flex-1 overflow-y-auto px-10 py-8">
      <div className="mx-auto max-w-xl">
        <h1 className="text-[30px] font-semibold text-ink">Settings</h1>

        <p className="mt-6 text-xs font-bold tracking-wide text-text-muted">
          CONNECTION
        </p>

        <span className="mt-3 mb-2 block text-xs font-medium text-text-secondary">
          API endpoint
        </span>
        <input
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          placeholder="https://your-worker.workers.dev"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="w-full rounded-xl border border-border bg-surface px-4 py-3.5 text-base text-ink outline-none placeholder:text-text-muted focus:border-accent"
        />

        <span className="mt-4 mb-2 block text-xs font-medium text-text-secondary">
          API key
        </span>
        <input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="master key"
          type="password"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="w-full rounded-xl border border-border bg-surface px-4 py-3.5 text-base text-ink outline-none placeholder:text-text-muted focus:border-accent"
        />

        {configured && (
          <div className="mt-4 flex w-fit flex-row items-center gap-1.5 rounded-full bg-[#16271E] px-3 py-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-st-done" />
            <span className="text-xs font-semibold text-st-done">
              Connected · key saved
            </span>
          </div>
        )}

        <p className="mt-8 text-xs font-bold tracking-wide text-text-muted">
          SEARCH (OPTIONAL)
        </p>
        <p className="mt-1 text-xs text-text-muted">
          Meilisearch URL + read-only key to enable the Search tab.
        </p>

        <span className="mt-3 mb-2 block text-xs font-medium text-text-secondary">
          Meilisearch URL
        </span>
        <input
          value={meiliUrl}
          onChange={(e) => setMeiliUrl(e.target.value)}
          placeholder="https://your-search.fly.dev"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="w-full rounded-xl border border-border bg-surface px-4 py-3.5 text-base text-ink outline-none placeholder:text-text-muted focus:border-accent"
        />

        <span className="mt-4 mb-2 block text-xs font-medium text-text-secondary">
          Search key (read-only)
        </span>
        <input
          value={meiliKey}
          onChange={(e) => setMeiliKey(e.target.value)}
          placeholder="read-only search key"
          type="password"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="w-full rounded-xl border border-border bg-surface px-4 py-3.5 text-base text-ink outline-none placeholder:text-text-muted focus:border-accent"
        />

        {notice && (
          <p
            className="mt-4 text-sm"
            style={{
              color: notice.kind === "ok" ? colors.accent : "#EE6A4D",
            }}
          >
            {notice.text}
          </p>
        )}

        <button
          type="button"
          onClick={onSave}
          disabled={busy}
          className="mt-6 flex w-full items-center justify-center rounded-xl bg-accent py-4 disabled:opacity-60"
        >
          <span className="text-base font-bold text-accent-ink">
            {busy ? "Testing…" : "Test & save"}
          </span>
        </button>

        {configured && (
          <button
            type="button"
            onClick={onClear}
            className="mt-3 flex h-12 w-full flex-row items-center justify-center gap-2 rounded-xl border border-st-fail"
          >
            <span className="text-sm font-semibold text-st-fail">
              Clear API key
            </span>
          </button>
        )}
      </div>
    </div>
  );
};
