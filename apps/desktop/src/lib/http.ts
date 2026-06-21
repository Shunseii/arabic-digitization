import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

/**
 * The deployed Worker sets no CORS headers, so a browser-origin `fetch` from
 * the webview would be blocked by preflight. The Tauri HTTP plugin performs
 * the request from the Rust side instead, bypassing CORS entirely. We install
 * it as the global `fetch` so the shared API client (lib/api.ts) needs no
 * awareness of the runtime. Falls back to the native fetch outside Tauri
 * (e.g. `vite preview` in a plain browser during development).
 */
export const installTauriFetch = (): void => {
  const inTauri =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (inTauri) {
    window.fetch = tauriFetch as typeof window.fetch;
  }
};
