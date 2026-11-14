import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { ApiError, api } from "./api";
import type { ApiConfig } from "./config";
import { useConfigState } from "./config-context";

export type ConnectionFailure = { title: string; message: string };

export type ConnectionResult =
  | { ok: true }
  | ({ ok: false } & ConnectionFailure);

export const MISSING_FIELDS: ConnectionFailure = {
  title: "Missing fields",
  message: "Enter both the API endpoint and key.",
};

/** Ping the library API with an endpoint + key pair without saving anything. */
export const testConnection = async ({
  endpoint,
  key,
}: {
  endpoint: string;
  key: string;
}): Promise<ConnectionResult> => {
  try {
    const ok = await api.ping({ endpoint, key });
    if (!ok) {
      return {
        ok: false,
        title: "Could not connect",
        message:
          "The endpoint responded but rejected the key. Check both values.",
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, ...describeError(err) };
  }
};

const describeError = (err: unknown): ConnectionFailure => ({
  title: "Connection failed",
  message:
    err instanceof ApiError ? `${err.status}: ${err.message}` : String(err),
});

/**
 * Test the API connection and, if it works, persist the config and refresh
 * every query so screens pick up the new connection.
 */
export const useConnect = () => {
  const { save } = useConfigState();
  const queryClient = useQueryClient();

  return useCallback(
    async (config: ApiConfig): Promise<ConnectionResult> => {
      if (!config.endpoint.trim() || !config.key.trim()) {
        return { ok: false, ...MISSING_FIELDS };
      }
      const result = await testConnection(config);
      if (!result.ok) return result;
      try {
        await save(config);
        await queryClient.invalidateQueries();
        return result;
      } catch (err) {
        return { ok: false, ...describeError(err) };
      }
    },
    [save, queryClient],
  );
};
