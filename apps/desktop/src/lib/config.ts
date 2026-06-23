const ENDPOINT_KEY = "qiraa.endpoint";
const TOKEN_KEY = "qiraa.key";
const MEILI_URL_KEY = "qiraa.meiliUrl";
const MEILI_KEY_KEY = "qiraa.meiliKey";

export interface ApiConfig {
  endpoint: string;
  key: string;
  // Optional: direct search against Meilisearch (read-only key). Search is
  // gated on both being present; the rest of the app works without them.
  meiliUrl?: string;
  meiliKey?: string;
}

let cache: ApiConfig | null = null;

const normalizeEndpoint = (endpoint: string): string =>
  endpoint.trim().replace(/\/+$/, "");

/**
 * Persisted in the webview's localStorage (per-app data dir). Mobile uses the
 * OS keychain via expo-secure-store; on desktop this is the equivalent
 * app-private store. Keep the API surface identical so config-context.tsx is
 * shared verbatim with the mobile app.
 */
export const loadConfig = async (): Promise<ApiConfig | null> => {
  const endpoint = localStorage.getItem(ENDPOINT_KEY);
  const key = localStorage.getItem(TOKEN_KEY);
  const meiliUrl = localStorage.getItem(MEILI_URL_KEY);
  const meiliKey = localStorage.getItem(MEILI_KEY_KEY);
  cache =
    endpoint && key
      ? {
          endpoint,
          key,
          meiliUrl: meiliUrl ?? undefined,
          meiliKey: meiliKey ?? undefined,
        }
      : null;
  return cache;
};

export const saveConfig = async (config: ApiConfig): Promise<void> => {
  const next: ApiConfig = {
    endpoint: normalizeEndpoint(config.endpoint),
    key: config.key.trim(),
    meiliUrl: config.meiliUrl?.trim()
      ? normalizeEndpoint(config.meiliUrl)
      : undefined,
    meiliKey: config.meiliKey?.trim() || undefined,
  };
  localStorage.setItem(ENDPOINT_KEY, next.endpoint);
  localStorage.setItem(TOKEN_KEY, next.key);
  if (next.meiliUrl) localStorage.setItem(MEILI_URL_KEY, next.meiliUrl);
  else localStorage.removeItem(MEILI_URL_KEY);
  if (next.meiliKey) localStorage.setItem(MEILI_KEY_KEY, next.meiliKey);
  else localStorage.removeItem(MEILI_KEY_KEY);
  cache = next;
};

export const clearConfig = async (): Promise<void> => {
  localStorage.removeItem(ENDPOINT_KEY);
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(MEILI_URL_KEY);
  localStorage.removeItem(MEILI_KEY_KEY);
  cache = null;
};

/** Throws if not configured — use inside API calls. */
export const getConfig = (): ApiConfig => {
  if (!cache)
    throw new Error(
      "API is not configured. Add your endpoint and key in Settings.",
    );
  return cache;
};

/** Non-throwing read of the cache (for gating UI). */
export const peekConfig = (): ApiConfig | null => cache;

/** Search config, or null if Meilisearch isn't set up. */
export const peekSearchConfig = (): { url: string; key: string } | null => {
  if (cache?.meiliUrl && cache.meiliKey)
    return { url: cache.meiliUrl, key: cache.meiliKey };
  return null;
};
