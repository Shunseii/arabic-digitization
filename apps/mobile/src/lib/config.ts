import * as SecureStore from "expo-secure-store";

const ENDPOINT_KEY = "qiraa.endpoint";
const TOKEN_KEY = "qiraa.key";

export interface ApiConfig {
  endpoint: string;
  key: string;
}

let cache: ApiConfig | null = null;

const normalizeEndpoint = (endpoint: string): string =>
  endpoint.trim().replace(/\/+$/, "");

/** Load persisted config into the in-memory cache. Call once at boot. */
export const loadConfig = async (): Promise<ApiConfig | null> => {
  const [endpoint, key] = await Promise.all([
    SecureStore.getItemAsync(ENDPOINT_KEY),
    SecureStore.getItemAsync(TOKEN_KEY),
  ]);
  cache = endpoint && key ? { endpoint, key } : null;
  return cache;
};

export const saveConfig = async (config: ApiConfig): Promise<void> => {
  const next: ApiConfig = {
    endpoint: normalizeEndpoint(config.endpoint),
    key: config.key.trim(),
  };
  await Promise.all([
    SecureStore.setItemAsync(ENDPOINT_KEY, next.endpoint),
    SecureStore.setItemAsync(TOKEN_KEY, next.key),
  ]);
  cache = next;
};

export const clearConfig = async (): Promise<void> => {
  await Promise.all([
    SecureStore.deleteItemAsync(ENDPOINT_KEY),
    SecureStore.deleteItemAsync(TOKEN_KEY),
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
