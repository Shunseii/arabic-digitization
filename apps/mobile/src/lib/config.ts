import * as SecureStore from "expo-secure-store";

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

/** Load persisted config into the in-memory cache. Call once at boot. */
export const loadConfig = async (): Promise<ApiConfig | null> => {
  const [endpoint, key, meiliUrl, meiliKey] = await Promise.all([
    SecureStore.getItemAsync(ENDPOINT_KEY),
    SecureStore.getItemAsync(TOKEN_KEY),
    SecureStore.getItemAsync(MEILI_URL_KEY),
    SecureStore.getItemAsync(MEILI_KEY_KEY),
  ]);
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
  await Promise.all([
    SecureStore.setItemAsync(ENDPOINT_KEY, next.endpoint),
    SecureStore.setItemAsync(TOKEN_KEY, next.key),
    next.meiliUrl
      ? SecureStore.setItemAsync(MEILI_URL_KEY, next.meiliUrl)
      : SecureStore.deleteItemAsync(MEILI_URL_KEY),
    next.meiliKey
      ? SecureStore.setItemAsync(MEILI_KEY_KEY, next.meiliKey)
      : SecureStore.deleteItemAsync(MEILI_KEY_KEY),
  ]);
  cache = next;
};

export const clearConfig = async (): Promise<void> => {
  await Promise.all([
    SecureStore.deleteItemAsync(ENDPOINT_KEY),
    SecureStore.deleteItemAsync(TOKEN_KEY),
    SecureStore.deleteItemAsync(MEILI_URL_KEY),
    SecureStore.deleteItemAsync(MEILI_KEY_KEY),
  ]);
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
