const ENDPOINT_KEY = "qiraa.endpoint";
const TOKEN_KEY = "qiraa.key";

export interface ApiConfig {
  endpoint: string;
  key: string;
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
  cache = endpoint && key ? { endpoint, key } : null;
  return cache;
};

export const saveConfig = async (config: ApiConfig): Promise<void> => {
  const next: ApiConfig = {
    endpoint: normalizeEndpoint(config.endpoint),
    key: config.key.trim(),
  };
  localStorage.setItem(ENDPOINT_KEY, next.endpoint);
  localStorage.setItem(TOKEN_KEY, next.key);
  cache = next;
};

export const clearConfig = async (): Promise<void> => {
  localStorage.removeItem(ENDPOINT_KEY);
  localStorage.removeItem(TOKEN_KEY);
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
