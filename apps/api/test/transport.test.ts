import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isTransient } from "../src/effect/errors";
import { postJson } from "../src/effect/services";

afterEach(() => {
  vi.unstubAllGlobals();
});

function post({ timeoutMs }: { timeoutMs?: number } = {}) {
  return Effect.runPromise(
    Effect.flip(
      postJson({
        provider: "inkling",
        url: "https://provider.test/chat",
        headers: {},
        body: {},
        timeoutMs,
      }),
    ),
  );
}

function respond(response: Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response),
  );
}

describe("postJson", () => {
  it("maps 429 to RateLimited with the retry-after hint", async () => {
    respond(
      new Response("slow down", {
        status: 429,
        headers: { "retry-after": "7" },
      }),
    );
    const error = await post();
    expect(error).toMatchObject({ _tag: "RateLimited", retryAfterSeconds: 7 });
    expect(error.message).toBe("Inkling 429: slow down");
    expect(isTransient(error)).toBe(true);
  });

  it("maps 5xx to a transient ServerError", async () => {
    respond(new Response("upstream", { status: 503 }));
    const error = await post();
    expect(error).toMatchObject({ _tag: "ServerError", status: 503 });
    expect(isTransient(error)).toBe(true);
  });

  it("maps other 4xx to a terminal ProviderRejected", async () => {
    respond(new Response("no such model", { status: 400 }));
    const error = await post();
    expect(error).toMatchObject({ _tag: "ProviderRejected", status: 400 });
    expect(isTransient(error)).toBe(false);
  });

  it("maps a 2xx that isn't JSON to BadResponse", async () => {
    respond(new Response("<html>", { status: 200 }));
    expect(await post()).toMatchObject({ _tag: "BadResponse" });
  });

  it("maps a rejected fetch to NetworkError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const error = await post();
    expect(error).toMatchObject({ _tag: "NetworkError" });
    expect(isTransient(error)).toBe(true);
  });

  it("times out a call that never answers and aborts the request", async () => {
    let aborted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>(() => {
            init.signal?.addEventListener("abort", () => {
              aborted = true;
            });
          }),
      ),
    );
    const error = await post({ timeoutMs: 20 });
    expect(error).toMatchObject({ _tag: "ProviderTimeout", timeoutMs: 20 });
    expect(isTransient(error)).toBe(true);
    expect(aborted).toBe(true);
  });
});
